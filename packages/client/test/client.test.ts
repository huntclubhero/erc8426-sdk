import { describe, expect, it, vi } from "vitest";
import { createWalletClient, custom, getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { WALLET_PASS_INTERFACE_ID, WalletPassError, buildChallenge, generateNonce, tokenRef } from "@erc8426/core";
import {
  WalletPassClientError,
  checkChallengeScope,
  createWalletPassClient,
  decodeDataUri,
  detectPlatform,
  errorFromResponse,
  fromWalletClient,
  originMatches,
  parseRetryAfter,
  passUpdateCovers,
  resolveUri,
  shortAddress,
} from "@erc8426/client";

import { fakeChain, fakeIssuer } from "./fixtures.js";

const CONTRACT = getAddress("0x5F9B5a1cdED9d6B3f5E8a2C47B0e13d6A8F4c2e1");
const PLAIN = getAddress("0x1111111111111111111111111111111111111111");
const NO165 = getAddress("0x2222222222222222222222222222222222222222");

const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

function setup(mode: "public" | "gated", issuerOpts: Partial<Parameters<typeof fakeIssuer>[0]> = {}) {
  const owner = privateKeyToAccount(generatePrivateKey());
  const issuer = fakeIssuer({ contract: CONTRACT, mode, ownerOf: () => owner.address, ...issuerOpts });
  const chain = fakeChain({
    contracts: {
      [CONTRACT]: {
        interfaces: [WALLET_PASS_INTERFACE_ID],
        passURI: (id) => issuer.passUri(id),
        tokenURI: () =>
          `data:application/json;base64,${btoa(JSON.stringify({ name: "x", wallet_pass: { formats: { google: "https://pay.google.com/gp/v/save/abc" } } }))}`,
      },
      [PLAIN]: { interfaces: [] },
      [NO165]: { interfaces: null },
    },
  });
  const client = createWalletPassClient({ publicClient: chain.client, fetch: issuer.fetch });
  return { owner, issuer, chain, client };
}

describe("discovery", () => {
  it("detects the interface and returns false for contracts without it or without ERC-165", async () => {
    const { client } = setup("public");
    expect(await client.supportsWalletPass(CONTRACT)).toBe(true);
    expect(await client.supportsWalletPass(PLAIN)).toBe(false);
    expect(await client.supportsWalletPass(NO165)).toBe(false);
    expect(await client.supportsWalletPass("0x3333333333333333333333333333333333333333")).toBe(false);
  });

  it("returns false when a permissive contract claims 0xffffffff", async () => {
    // A contract that answers true for everything, including 0xffffffff.
    const always = fakeChain({ contracts: {} });
    const client = createWalletPassClient({
      publicClient: {
        ...always.client,
        request: (async (args: { method: string; params?: unknown }) => {
          if (args.method === "eth_call") return `0x${"0".repeat(63)}1`;
          return always.request(args);
        }) as never,
      },
    });
    expect(await client.supportsWalletPass(CONTRACT)).toBe(false);
  });

  it("reads passURI and resolves ipfs, ar and data URIs", () => {
    expect(resolveUri("ipfs://bafy/pass/1")).toBe("https://ipfs.io/ipfs/bafy/pass/1");
    expect(resolveUri("ipfs://ipfs/bafy/x", { ipfsGateway: "https://gw.example/" })).toBe("https://gw.example/ipfs/bafy/x");
    expect(resolveUri("ar://abc/def", { arweaveGateway: "https://ar.example" })).toBe("https://ar.example/abc/def");
    expect(resolveUri("https://a.example/p")).toBe("https://a.example/p");
    expect(() => resolveUri("file:///etc/passwd")).toThrow(/unsupported/);
    expect(() => resolveUri("javascript:alert(1)")).toThrow();
    expect(decodeDataUri("data:application/json,%7B%22a%22%3A1%7D")).toEqual({ mediaType: "application/json", text: '{"a":1}' });
    expect(decodeDataUri(`data:application/json;base64,${btoa('{"b":2}')}`).text).toBe('{"b":2}');
  });

  it("issuerDisplay presents the contract and the origin of passURI", async () => {
    const { client } = setup("public");
    const d = await client.issuerDisplay({ contract: CONTRACT, tokenId: 412n });
    expect(d).toMatchObject({ chainId: 1, contract: CONTRACT, contractShort: "0x5F9B...c2e1", tokenId: "412", origin: "https://issuer.test" });
    expect(shortAddress(CONTRACT.toLowerCase())).toBe("0x5F9B...c2e1");
    expect(originMatches("https://issuer.test/pass/1", ["https://issuer.test"])).toBe(true);
    expect(originMatches("https://issuer.test/pass/1", ["https://issuer.test/some/page"])).toBe(true);
    expect(originMatches("https://issuer.test.evil.com/pass/1", ["https://issuer.test"])).toBe(false);
    expect(originMatches("https://pass.brand.com/1", ["*.brand.com"])).toBe(true);
    expect(originMatches("https://brand.com/1", ["*.brand.com"])).toBe(true);
    expect(originMatches("http://pass.brand.com/1", ["*.brand.com"])).toBe(false);
    expect(originMatches("ipfs://bafy", ["https://ipfs.io"])).toBe(false);
  });

  it("detects platforms from user agents without touching navigator", () => {
    expect(detectPlatform(UA.iphone)).toBe("apple");
    expect(detectPlatform(UA.macSafari)).toBe("apple");
    expect(detectPlatform(UA.macChrome)).toBe(null);
    expect(detectPlatform(UA.android)).toBe("google");
    expect(detectPlatform(UA.windows)).toBe(null);
    expect(detectPlatform(undefined)).toBe(null);
  });
});

describe("public manifest", () => {
  it("fetches and validates, reporting the public configuration", async () => {
    const { client, issuer } = setup("public");
    const r = await client.getManifest({ contract: CONTRACT, tokenId: 7 });
    expect(r.configuration).toBe("public");
    expect(r.manifest.formats.google).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\//);
    expect(r.url).toBe("https://issuer.test/pass/7");
    // Fetched at the moment of use: a second call hits the network again.
    await client.getManifest({ contract: CONTRACT, tokenId: 7 });
    expect(issuer.requests.filter((q) => q.url.endsWith("/pass/7"))).toHaveLength(2);
  });

  it("rejects an invalid manifest with invalid_manifest", async () => {
    const { client } = setup("public", { faults: { badGoogleLink: true } });
    await expect(client.getManifest({ contract: CONTRACT, tokenId: 7 })).rejects.toMatchObject({ code: "invalid_manifest" });
  });

  it("accepts an inline data: manifest", async () => {
    const manifest = { formats: { apple: "https://x.example/a.pkpass" } };
    const chain = fakeChain({ contracts: { [CONTRACT]: { interfaces: [WALLET_PASS_INTERFACE_ID], passURI: () => `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}` } } });
    const client = createWalletPassClient({ publicClient: chain.client, fetch: vi.fn() as never });
    const r = await client.getManifest({ contract: CONTRACT, tokenId: 1 });
    expect(r.manifest.formats.apple).toBe("https://x.example/a.pkpass");
  });

  it("addToWallet picks the platform from the user agent and falls back to google", async () => {
    const { client } = setup("public");
    const t = { contract: CONTRACT, tokenId: 3 };
    expect((await client.addToWallet(t, { userAgent: UA.iphone })).platform).toBe("apple");
    expect((await client.addToWallet(t, { userAgent: UA.android })).platform).toBe("google");
    expect((await client.addToWallet(t, { userAgent: UA.windows })).platform).toBe("google");
    const forced = await client.addToWallet(t, { platform: "apple", userAgent: UA.android });
    expect(forced.url).toMatch(/\.pkpass$/);
    await expect(client.addToWallet(t, { platform: "samsung" })).rejects.toMatchObject({ code: "unsupported" });
    expect(await client.getAcquisitionUrl(t, "google")).toMatch(/pay\.google\.com/);
  });

  it("reads the metadata mirror as non-authoritative", async () => {
    const { client } = setup("public");
    const m = await client.readMetadataMirror({ contract: CONTRACT, tokenId: 1 });
    expect(m.authoritative).toBe(false);
    expect(m.result?.ok).toBe(true);
  });

  it("maps a missing token to not_found", async () => {
    const issuer = fakeIssuer({ contract: CONTRACT, mode: "public", ownerOf: () => null });
    const chain = fakeChain({ contracts: { [CONTRACT]: { passURI: (id) => issuer.passUri(id) } } });
    const client = createWalletPassClient({ publicClient: chain.client, fetch: issuer.fetch });
    await expect(client.getManifest({ contract: CONTRACT, tokenId: 1 })).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("wraps network failures as retryable", async () => {
    const chain = fakeChain({ contracts: { [CONTRACT]: { passURI: () => "https://down.example/p" } } });
    const client = createWalletPassClient({ publicClient: chain.client, fetch: (async () => { throw new TypeError("fetch failed"); }) as never });
    await expect(client.getManifest({ contract: CONTRACT, tokenId: 1 })).rejects.toMatchObject({ code: "network", retryable: true });
  });
});

describe("gated manifest", () => {
  it("throws proof_required with the challenge URL when no signer is given, leaking nothing", async () => {
    const { client } = setup("gated");
    const err = await client.getManifest({ contract: CONTRACT, tokenId: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(WalletPassClientError);
    expect(err).toBeInstanceOf(WalletPassError);
    expect(err.code).toBe("proof_required");
    expect(err.challenge).toBe("https://issuer.test/pass/5/challenge");
  });

  it("signs the acquire challenge and resolves the manifest", async () => {
    const { client, owner, issuer } = setup("gated");
    const r = await client.getManifest({ contract: CONTRACT, tokenId: 5 }, { signer: owner });
    expect(r.configuration).toBe("gated");
    expect(r.manifest.formats.apple).toMatch(/\.pkpass$/);
    const challengeReq = issuer.requests.find((q) => q.url.includes("/challenge"))!;
    expect(new URL(challengeReq.url).searchParams.get("address")).toBe(owner.address);
    const proven = issuer.requests.at(-1)!;
    expect(proven.headers.get("x-wallet-pass-proof")).toBeTruthy();
    expect(proven.headers.get("x-wallet-pass-signature")).toMatch(/^0x/);
  });

  it("works with a WalletClient through fromWalletClient", async () => {
    const { client, owner } = setup("gated");
    const walletClient = createWalletClient({
      account: owner,
      transport: custom({ request: async () => { throw new Error("no rpc needed"); } }),
    });
    const r = await client.getManifest({ contract: CONTRACT, tokenId: 5 }, { signer: fromWalletClient(walletClient) });
    expect(r.configuration).toBe("gated");
    const bare = createWalletClient({ transport: custom({ request: async () => null }) });
    expect(() => fromWalletClient(bare)).toThrow(/no account/);
  });

  it("maps a non-owner to not_owner (403)", async () => {
    const { client } = setup("gated");
    const stranger = privateKeyToAccount(generatePrivateKey());
    await expect(client.getManifest({ contract: CONTRACT, tokenId: 5 }, { signer: stranger })).rejects.toMatchObject({ code: "not_owner", status: 403, retryable: false });
  });

  it("maps a failed fresh read to a retryable read_failed with Retry-After", async () => {
    const { client, owner } = setup("gated", { readFails: true });
    await expect(client.getManifest({ contract: CONTRACT, tokenId: 5 }, { signer: owner })).rejects.toMatchObject({
      code: "read_failed",
      status: 503,
      retryable: true,
      retryAfterSeconds: 5,
    });
  });

  it.each([
    ["wrongDomain", { wrongDomain: "evil.example" }, "domain_mismatch"],
    ["wrongTokenInChallenge", { wrongTokenInChallenge: true }, "binding_mismatch"],
    ["expiredChallenge", { expiredChallenge: true }, "challenge_expired"],
  ] as const)("refuses to sign an off-scope challenge (%s)", async (_name, faults, code) => {
    const { client, owner } = setup("gated", { faults });
    const sign = vi.fn(owner.signMessage);
    const err = await client.getManifest({ contract: CONTRACT, tokenId: 5 }, { signer: { address: owner.address, signMessage: sign } }).catch((e) => e);
    expect(err).toMatchObject({ code, source: "client" });
    expect(sign).not.toHaveBeenCalled();
  });

  it("accepts a configured trusted domain for development setups", async () => {
    const { owner, issuer, chain } = setup("gated", { faults: { wrongDomain: "issuer.example" } });
    // The fake issuer verifies against its own (wrong) domain, so this resolves.
    const client = createWalletPassClient({ publicClient: chain.client, fetch: issuer.fetch, trustedChallengeDomains: ["issuer.example"] });
    expect((await client.getManifest({ contract: CONTRACT, tokenId: 5 }, { signer: owner })).configuration).toBe("gated");
  });
});

describe("challenge scope", () => {
  const account = privateKeyToAccount(generatePrivateKey()).address;
  const token = tokenRef(1, CONTRACT, 9);
  const now = new Date();
  const make = (over: Partial<Parameters<typeof buildChallenge>[0]> = {}) =>
    buildChallenge({
      domain: "issuer.test",
      uri: "https://issuer.test/pass/9",
      account,
      token,
      action: "acquire",
      nonce: generateNonce(),
      issuedAt: now,
      expirationTime: new Date(now.getTime() + 300_000),
      ...over,
    });
  const expected = { token, action: "acquire", account, domains: ["issuer.test"], now };

  it("accepts an in-scope challenge", () => {
    expect(checkChallengeScope(make(), expected).ok).toBe(true);
  });
  it("refuses another account, chain, action, and overlong expiry", () => {
    const other = privateKeyToAccount(generatePrivateKey()).address;
    expect(checkChallengeScope(make({ account: other }), expected)).toMatchObject({ ok: false, code: "binding_mismatch" });
    expect(checkChallengeScope(make({ token: tokenRef(5, CONTRACT, 9) }), expected)).toMatchObject({ ok: false, code: "binding_mismatch" });
    expect(checkChallengeScope(make({ action: "feed" }), expected)).toMatchObject({ ok: false, code: "binding_mismatch" });
    expect(checkChallengeScope(make({ expirationTime: new Date(now.getTime() + 7200_000) }), expected)).toMatchObject({ ok: false, code: "challenge_expired" });
    expect(checkChallengeScope("hello", expected)).toMatchObject({ ok: false, code: "invalid_message" });
  });
});

describe("signed actions", () => {
  it("requests a scoped challenge and POSTs the proof to {passBase}/actions/{action}", async () => {
    const seen: string[] = [];
    const { client, owner, issuer } = setup("gated", { onAction: (a, id, _acct, params) => (seen.push(`${a}:${id}:${JSON.stringify(params)}`), { fed: true }) });
    const r = await client.signedAction({ token: { contract: CONTRACT, tokenId: 5 }, action: "feed", signer: owner, params: { amount: 1 } });
    expect(r).toEqual({ status: 200, body: { ok: true, result: { fed: true } } });
    expect(seen).toEqual(['feed:5:{"amount":1}']);
    const post = issuer.requests.find((q) => q.method === "POST")!;
    expect(post.url).toBe("https://issuer.test/pass/5/actions/feed");
    const challengeReq = issuer.requests.find((q) => q.url.includes("/challenge"))!;
    expect(new URL(challengeReq.url).searchParams.get("action")).toBe("feed");
  });

  it("requestChallenge returns a parsed, scoped challenge", async () => {
    const { client, owner } = setup("gated");
    const c = await client.requestChallenge({ contract: CONTRACT, tokenId: 5 }, "feed", owner.address);
    expect(c.parsed.action).toBe("feed");
    expect(c.parsed.token?.tokenId).toBe("5");
  });

  it("rotates links with a rotate proof, and adds params to a challenge URL that already has a query", async () => {
    const { client, owner, issuer } = setup("gated");
    const before = await client.getManifest({ contract: CONTRACT, tokenId: 5 }, { signer: owner });
    const r = await client.rotatePassLinks({ contract: CONTRACT, tokenId: 5 }, { signer: owner, challengeEndpoint: "https://issuer.test/pass/5/challenge?action=rotate" });
    expect(r.body).toMatchObject({ ok: true, rotated: true });
    expect((r.body as { formats: { apple: string } }).formats.apple).not.toBe(before.manifest.formats.apple);
    const challengeReq = new URL(issuer.requests.filter((q) => q.url.includes("/challenge")).at(-1)!.url);
    expect(challengeReq.searchParams.getAll("action")).toEqual(["rotate"]);
    expect(challengeReq.searchParams.get("address")).toBe(owner.address);
    expect(issuer.requests.at(-1)!.url).toBe("https://issuer.test/pass/5/rotate");
    await expect(client.signedAction({ token: { contract: CONTRACT, tokenId: 5 }, action: "rotate", signer: owner })).rejects.toMatchObject({ code: "unknown_action" });
  });

  it("keeps an issuer's custom error code in serverCode", async () => {
    const { client, owner } = setup("gated", { customActionError: "out_of_food" });
    await expect(client.signedAction({ token: { contract: CONTRACT, tokenId: 5 }, action: "feed", signer: owner })).rejects.toMatchObject({ status: 422, serverCode: "out_of_food" });
  });

  it("refuses the acquire action and invalid names", async () => {
    const { client, owner } = setup("gated");
    await expect(client.signedAction({ token: { contract: CONTRACT, tokenId: 5 }, action: "acquire", signer: owner })).rejects.toMatchObject({ code: "unknown_action" });
    await expect(client.signedAction({ token: { contract: CONTRACT, tokenId: 5 }, action: "no spaces", signer: owner })).rejects.toMatchObject({ code: "unknown_action" });
  });

  it("surfaces a non-owner as not_owner", async () => {
    const { client } = setup("gated");
    const stranger = privateKeyToAccount(generatePrivateKey());
    await expect(client.signedAction({ token: { contract: CONTRACT, tokenId: 5 }, action: "feed", signer: stranger })).rejects.toMatchObject({ code: "not_owner" });
  });
});

describe("errors", () => {
  it("treats 403 as not_owner whatever the body says and parses Retry-After", () => {
    expect(errorFromResponse(403, new Headers(), { error: "invalid_message" }).code).toBe("not_owner");
    expect(errorFromResponse(401, new Headers(), { error: "nonce_invalid", challenge: "https://x/c" })).toMatchObject({ code: "nonce_invalid", challenge: "https://x/c" });
    expect(errorFromResponse(418, new Headers(), "teapot").code).toBe("action_refused");
    expect(parseRetryAfter("7")).toBe(7);
    expect(parseRetryAfter(new Date(Date.now() + 10_000).toUTCString())).toBeGreaterThanOrEqual(9);
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe("honest codes for issuer answers outside the core set", () => {
  it("an integrator's 4xx refusal is action_refused, never network, and keeps serverCode", () => {
    const e = errorFromResponse(429, new Headers({ "retry-after": "60" }), { error: "cooldown", message: "fed an hour ago" });
    expect(e).toMatchObject({ code: "action_refused", serverCode: "cooldown", status: 429, retryable: true, retryAfterSeconds: 60, source: "server" });
    expect(errorFromResponse(409, new Headers(), { error: "invalid_params" })).toMatchObject({ code: "action_refused", serverCode: "invalid_params", retryable: false });
  });

  it("a 5xx outside the core set is server_error; core codes pass through", () => {
    expect(errorFromResponse(502, new Headers(), "bad gateway")).toMatchObject({ code: "server_error", retryable: true });
    expect(errorFromResponse(500, new Headers(), { error: "action_failed" }).code).toBe("action_failed");
    expect(errorFromResponse(503, new Headers(), {}).code).toBe("read_failed");
  });

  it("keeps network for a fetch that failed", async () => {
    const chain = fakeChain({ contracts: { [CONTRACT]: { passURI: () => "https://down.example/p" } } });
    const client = createWalletPassClient({ publicClient: chain.client, fetch: (async () => { throw new TypeError("fetch failed"); }) as never });
    await expect(client.getManifest({ contract: CONTRACT, tokenId: 1 })).rejects.toMatchObject({ code: "network", source: "server", retryable: true });
  });
});

describe("chain reads", () => {
  it("a passURI revert (nonexistent or burned token) is a typed not_found from the chain", async () => {
    const chain = fakeChain({ contracts: { [CONTRACT]: { interfaces: [WALLET_PASS_INTERFACE_ID] } } });
    const client = createWalletPassClient({ publicClient: chain.client });
    const e = await client.getManifest({ contract: CONTRACT, tokenId: 99 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(WalletPassClientError);
    expect(e).toMatchObject({ code: "not_found", source: "chain", retryable: false });
    await expect(client.getPassURI({ contract: CONTRACT, tokenId: 99 })).rejects.toMatchObject({ code: "not_found" });
    await expect(client.issuerDisplay({ contract: CONTRACT, tokenId: 99 })).rejects.toMatchObject({ code: "not_found" });
    await expect(client.readMetadataMirror({ contract: CONTRACT, tokenId: 99 })).rejects.toMatchObject({ code: "not_found" });
  });

  it("an address with no contract is unsupported", async () => {
    const chain = fakeChain({ contracts: {} });
    const client = createWalletPassClient({ publicClient: chain.client });
    await expect(client.getManifest({ contract: PLAIN, tokenId: 1 })).rejects.toMatchObject({ code: "unsupported", source: "chain" });
  });

  it("an RPC that cannot answer is a retryable network error, not a verdict on the token", async () => {
    const chain = fakeChain({
      contracts: {
        [CONTRACT]: {
          passURI: () => {
            throw new Error("upstream timeout");
          },
        },
      },
    });
    const client = createWalletPassClient({ publicClient: chain.client });
    const e = await client.getManifest({ contract: CONTRACT, tokenId: 1 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(WalletPassClientError);
    expect(e).toMatchObject({ code: "network", source: "chain", retryable: true });
  });
});

describe("pass updates", () => {
  it("normalizes PassUpdate and BatchPassUpdate for backfill", async () => {
    const other = getAddress("0x4444444444444444444444444444444444444444");
    const chain = fakeChain({
      contracts: {},
      logs: [
        { address: CONTRACT, event: "PassUpdate", args: [7n], blockNumber: 10n },
        { address: CONTRACT, event: "BatchPassUpdate", args: [100n, 200n], blockNumber: 11n },
        { address: other, event: "PassUpdate", args: [1n], blockNumber: 12n },
      ],
    });
    const client = createWalletPassClient({ publicClient: chain.client });
    const mine = await client.getPassUpdates({ contract: CONTRACT, fromBlock: 0n, toBlock: 20n });
    expect(mine.map((u) => u.tokenIds)).toEqual([[7n], { from: 100n, to: 200n }]);
    expect(mine[1]!.kind).toBe("batch");
    expect(passUpdateCovers(mine[1]!, 100n)).toBe(true);
    expect(passUpdateCovers(mine[1]!, 200)).toBe(true);
    expect(passUpdateCovers(mine[1]!, 201n)).toBe(false);
    expect(passUpdateCovers(mine[0]!, "7")).toBe(true);
    const all = await client.getPassUpdates({ fromBlock: 0n, toBlock: 20n });
    expect(all).toHaveLength(3);
  });

  it("watches both events through one callback", async () => {
    const chain = fakeChain({ contracts: {} });
    const client = createWalletPassClient({ publicClient: chain.client });
    const got: unknown[] = [];
    const unwatch = client.watchPassUpdates(CONTRACT, (u) => got.push(u.tokenIds), { pollingInterval: 10 });
    await new Promise((r) => setTimeout(r, 50));
    chain.mine({ address: CONTRACT, event: "PassUpdate", args: [3n] });
    chain.mine({ address: CONTRACT, event: "BatchPassUpdate", args: [1n, 4n] });
    await vi.waitFor(() => expect(got).toHaveLength(2), { timeout: 2000 });
    unwatch();
    expect(got).toEqual([[3n], { from: 1n, to: 4n }]);
  });
});

