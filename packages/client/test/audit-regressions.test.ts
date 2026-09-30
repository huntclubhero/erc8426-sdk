// Regressions for the TypeScript audit findings against @erc8426/client
// (tests/audit/client.audit.test.ts): unsafe URLs, cross-verifier proofs,
// inexact challenge scope, port-less domains, and SSRF through issuer URLs.
import { describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { WALLET_PASS_INTERFACE_ID, assetId, buildChallenge, generateNonce, readProofHeaders, tokenRef } from "@erc8426/core";
import { checkChallengeScope, createWalletPassClient, domainsForUrl, isAllowedUrl, isSafeNavigationUrl } from "@erc8426/client";

import { fakeChain, fakeIssuer } from "./fixtures.js";

const CONTRACT = getAddress("0x5F9B5a1cdED9d6B3f5E8a2C47B0e13d6A8F4c2e1");

function clientFor(passUri: string, fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  const chain = fakeChain({ contracts: { [CONTRACT]: { interfaces: [WALLET_PASS_INTERFACE_ID], passURI: () => passUri } } });
  return createWalletPassClient({ publicClient: chain.client, fetch: fetchImpl, ...extra });
}

const challengeFor = (domain: string, account: `0x${string}`, resources?: string[]) => {
  const now = new Date();
  if (resources) {
    return createSiweMessage({
      domain,
      address: account,
      uri: `https://${domain}/wallet-pass/actions`,
      version: "1",
      chainId: 1,
      nonce: generateNonce(),
      issuedAt: now,
      expirationTime: new Date(now.getTime() + 60_000),
      resources,
    });
  }
  return buildChallenge({
    domain,
    uri: `https://${domain}/wallet-pass/actions`,
    account,
    token: tokenRef(1, CONTRACT, 1n),
    action: "acquire",
    nonce: generateNonce(),
    issuedAt: now,
    expirationTime: new Date(now.getTime() + 300_000),
  });
};

describe("audit #2: never navigate to a non-https URL", () => {
  it("refuses a javascript: acquisition URL", async () => {
    const fetchImpl = (async () => Response.json({ formats: { apple: "javascript:alert(document.cookie)//" } })) as unknown as typeof fetch;
    const client = clientFor("https://issuer.example/wallet-pass/1", fetchImpl);
    await expect(client.addToWallet({ contract: CONTRACT, tokenId: 1n }, { platform: "apple" })).rejects.toMatchObject({ code: "invalid_manifest" });
    await expect(client.getAcquisitionUrl({ contract: CONTRACT, tokenId: 1n }, "apple")).rejects.toMatchObject({ code: "invalid_manifest" });
  });

  it("classifies navigation targets", () => {
    expect(isSafeNavigationUrl("https://issuer.example/p.pkpass")).toBe(true);
    expect(isSafeNavigationUrl("http://localhost:3000/p.pkpass")).toBe(true);
    expect(isSafeNavigationUrl("http://127.0.0.1/p")).toBe(true);
    expect(isSafeNavigationUrl("http://issuer.example/p.pkpass")).toBe(false);
    expect(isSafeNavigationUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeNavigationUrl("data:text/html,<script>1</script>")).toBe(false);
    expect(isSafeNavigationUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeNavigationUrl("not a url")).toBe(false);
  });
});

describe("audit #4: a proof is only signed for the verifier it is sent to", () => {
  it("does not sign or send when the 401 names a challenge on another origin", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const sentTo: string[] = [];
    const fetched: string[] = [];
    const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      fetched.push(url.host);
      if (url.host === "a.example" && readProofHeaders(new Headers(init.headers)).kind === "present") {
        sentTo.push(url.host);
        return Response.json({ formats: { apple: "https://a.example/p.pkpass" } });
      }
      if (url.host === "a.example") {
        return Response.json({ error: "proof_required", challenge: "https://b.example/wallet-pass/1/challenge" }, { status: 401 });
      }
      return Response.json({ message: challengeFor("b.example", owner.address) });
    }) as unknown as typeof fetch;
    const client = clientFor("https://a.example/wallet-pass/1", fetchImpl);
    const sign = vi.fn(owner.signMessage);
    const err = await client.getManifest({ contract: CONTRACT, tokenId: 1n }, { signer: { address: owner.address, signMessage: sign } }).catch((e) => e);
    expect(err).toMatchObject({ code: "domain_mismatch", source: "client" });
    expect(sign).not.toHaveBeenCalled();
    expect(sentTo).toEqual([]);
    // The foreign challenge URL is not even fetched.
    expect(fetched).not.toContain("b.example");
  });

  it("refuses a same-origin challenge that names another verifier", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const fetchImpl = (async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/challenge")) return Response.json({ message: challengeFor("b.example", owner.address) });
      return Response.json({ error: "proof_required", challenge: "/wallet-pass/1/challenge" }, { status: 401 });
    }) as unknown as typeof fetch;
    const client = clientFor("https://a.example/wallet-pass/1", fetchImpl);
    await expect(client.getManifest({ contract: CONTRACT, tokenId: 1n }, { signer: owner })).rejects.toMatchObject({ code: "domain_mismatch" });
  });

  it("signedAction refuses an endpoint on another origin than the challenge", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const issuer = fakeIssuer({ contract: CONTRACT, mode: "gated", ownerOf: () => owner.address });
    const chain = fakeChain({ contracts: { [CONTRACT]: { passURI: (id) => issuer.passUri(id) } } });
    const client = createWalletPassClient({ publicClient: chain.client, fetch: issuer.fetch });
    await expect(
      client.signedAction({ token: { contract: CONTRACT, tokenId: 5 }, action: "feed", signer: owner, endpoint: "https://elsewhere.example/actions/feed" }),
    ).rejects.toMatchObject({ code: "domain_mismatch", source: "client" });
    await expect(
      client.rotatePassLinks({ contract: CONTRACT, tokenId: 5 }, { signer: owner, endpoint: "https://elsewhere.example/rotate" }),
    ).rejects.toMatchObject({ code: "domain_mismatch", source: "client" });
  });

  it("allowCrossOriginChallenge relaxes the origin rule only when asked", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.host === "b.example") return Response.json({ message: challengeFor("a.example", owner.address) });
      if (readProofHeaders(new Headers(init.headers)).kind === "present") return Response.json({ formats: { apple: "https://a.example/p.pkpass" } });
      return Response.json({ error: "proof_required", challenge: "https://b.example/c" }, { status: 401 });
    }) as unknown as typeof fetch;
    const client = clientFor("https://a.example/wallet-pass/1", fetchImpl, { allowCrossOriginChallenge: true });
    expect((await client.getManifest({ contract: CONTRACT, tokenId: 1n }, { signer: owner })).configuration).toBe("gated");
  });
});

describe("audit #9: the challenge scope is exact", () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const token = tokenRef(1, CONTRACT, 1n);
  const expected = { token, action: "acquire", account: owner.address, domains: ["issuer.example"] };

  it("refuses an extra resource such as a ReCap", () => {
    const message = challengeFor("issuer.example", owner.address, [assetId(token), "urn:wallet-pass:action:acquire", "urn:recap:eyJhdHQiOnt9fQ"]);
    expect(checkChallengeScope(message, expected)).toMatchObject({ ok: false, code: "binding_mismatch" });
  });

  it("refuses the two resources in the wrong order", () => {
    const message = challengeFor("issuer.example", owner.address, ["urn:wallet-pass:action:acquire", assetId(token)]);
    expect(checkChallengeScope(message, expected)).toMatchObject({ ok: false, code: "binding_mismatch" });
  });

  it("accepts exactly token then action, whatever the statement says", () => {
    const message = challengeFor("issuer.example", owner.address, [assetId(token), "urn:wallet-pass:action:acquire"]);
    expect(checkChallengeScope(message, expected).ok).toBe(true);
  });
});

describe("audit #10: the domain includes a non-default port", () => {
  it("does not accept the port-less host", () => {
    expect(domainsForUrl("https://issuer.example:8443/wallet-pass/1/challenge")).toEqual(["issuer.example:8443"]);
    expect(domainsForUrl("https://issuer.example:443/x")).toEqual(["issuer.example"]);
    expect(domainsForUrl("http://localhost:3000/x")).toEqual(["localhost:3000"]);
  });
});

describe("audit B: no SSRF through contract or issuer URLs", () => {
  it("refuses a plain-http passURI on a non-loopback host without fetching it", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ formats: { google: "https://pay.google.com/gp/v/save/x" } }));
    const client = clientFor("http://169.254.169.254/latest/meta-data", fetchImpl as unknown as typeof fetch);
    await expect(client.getManifest({ contract: CONTRACT, tokenId: 1n })).rejects.toMatchObject({ code: "unsupported", source: "client" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows http on loopback, and anywhere only with allowInsecureHttp", async () => {
    const fetchImpl = (async () => Response.json({ formats: { google: "https://pay.google.com/gp/v/save/x" } })) as unknown as typeof fetch;
    expect((await clientFor("http://localhost:3000/wallet-pass/1", fetchImpl).getManifest({ contract: CONTRACT, tokenId: 1n })).configuration).toBe("public");
    const relaxed = clientFor("http://devbox.internal/wallet-pass/1", fetchImpl, { allowInsecureHttp: true });
    expect((await relaxed.getManifest({ contract: CONTRACT, tokenId: 1n })).configuration).toBe("public");
    expect(isAllowedUrl("http://devbox.internal/x")).toBe(false);
    expect(isAllowedUrl("http://devbox.internal/x", { allowInsecureHttp: true })).toBe(true);
    expect(isAllowedUrl("ftp://x/y", { allowInsecureHttp: true })).toBe(false);
  });
});
