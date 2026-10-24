import { describe, expect, it } from "vitest";
import { IssuerConfigError, LinkKeyring, createIssuer, kvStores, linkDigest, memoryKv, memoryStores, type KeyValueStore } from "@erc8426/issuer";

import { CONTRACT, FakeChain, HARNESS_LINK_SECRET, TOKEN_ID, buildHarness, fakeProviders, issuePassTo, newSigner } from "./helpers.js";

/// A KV that remembers every key and value ever written or deleted, so a
///  test can scan the whole store for a token string.
function recordingKv(): KeyValueStore & { written: Map<string, string>; deleted: string[] } {
  const inner = memoryKv();
  const written = new Map<string, string>();
  const deleted: string[] = [];
  return {
    written,
    deleted,
    get: (k) => inner.get(k),
    async set(k, v, o) {
      written.set(k, v);
      return inner.set(k, v, o);
    },
    getDel: (k) => inner.getDel(k),
    async del(k) {
      deleted.push(k);
      return inner.del(k);
    },
  };
}

const SCOPE = { chainId: 1, contract: CONTRACT };
const tokenOf = (path: string) => path.split("/").pop()!;

describe("a read of the store yields no usable capability", () => {
  it("a link presented in a URL resolves, while the store holds no token in any key or value", async () => {
    const kv = recordingKv();
    const h = buildHarness({ rateLimit: false, stores: kvStores(kv, SCOPE) });
    const links = await issuePassTo(h, newSigner());
    const record = (await h.issuer.stores.passes.get(TOKEN_ID))!;
    const manifest = await h.issuer.capabilityLinksFor(TOKEN_ID);
    expect(Object.keys(manifest).sort()).toEqual(["feed", "water"]);
    // The token works.
    expect((await h.post(links.feed!)).status).toBe(200);
    expect((await h.get(links.water!)).status).toBe(200);
    // And appears nowhere in the store: not as a key, not inside a value.
    const tokens = Object.values(links).map(tokenOf);
    expect(tokens).toHaveLength(2);
    for (const t of tokens) {
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
      for (const [k, v] of kv.written) {
        expect(k, `key ${k}`).not.toContain(t);
        expect(v, `value under ${k}`).not.toContain(t);
      }
      // The link record lives under the token's digest.
      expect(await kv.get(`erc8426:1:${CONTRACT.toLowerCase()}:link:${await linkDigest(t)}`)).not.toBeNull();
    }
    // What the record holds are seeds, and a seed is not a token.
    for (const seed of Object.values(record.links)) {
      expect(tokens).not.toContain(seed);
      expect((await h.post(`/wallet-pass/links/${seed}`)).status).toBe(404);
    }
    expect(h.executed).toHaveLength(1);
  });

  it("the pass download link is derived the same way and its token is not stored either", async () => {
    const kv = recordingKv();
    const h = buildHarness({ rateLimit: false, stores: kvStores(kv, SCOPE) });
    const owner = newSigner();
    await issuePassTo(h, owner);
    const record = (await h.issuer.stores.passes.get(TOKEN_ID))!;
    const seed = record.downloads.apple!;
    const token = await new LinkKeyring(new TextEncoder().encode(HARNESS_LINK_SECRET)).token(seed);
    expect((await h.get(`/wallet-pass/passes/${token}`)).status).toBe(200);
    expect((await h.get(`/wallet-pass/passes/${seed}`)).status).toBe(404);
    for (const [k, v] of kv.written) {
      expect(k).not.toContain(token);
      expect(v).not.toContain(token);
    }
  });

  it("a wrong token of the right shape does not resolve", async () => {
    const h = buildHarness({ rateLimit: false });
    const links = await issuePassTo(h, newSigner());
    const real = tokenOf(links.feed!);
    const flipped = `${real.slice(0, -1)}${real.endsWith("A") ? "B" : "A"}`;
    expect((await h.post(`/wallet-pass/links/${flipped}`)).status).toBe(404);
    expect((await h.post(`/wallet-pass/links/${"A".repeat(43)}`)).status).toBe(404);
    expect(h.executed).toHaveLength(0);
  });

  it("rotation retires links by digest: the old token is gone from the store and stops resolving", async () => {
    const kv = recordingKv();
    const h = buildHarness({ rateLimit: false, stores: kvStores(kv, SCOPE) });
    const owner = newSigner();
    const links = await issuePassTo(h, owner);
    const old = tokenOf(links.feed!);
    const oldKey = `erc8426:1:${CONTRACT.toLowerCase()}:link:${await linkDigest(old)}`;
    expect(await kv.get(oldKey)).not.toBeNull();
    await h.issuer.rotate(TOKEN_ID);
    expect(kv.deleted).toContain(oldKey);
    expect(await kv.get(oldKey)).toBeNull();
    expect((await h.post(links.feed!)).status).toBe(404);
    const fresh = tokenOf((await h.issuer.capabilityLinksFor(TOKEN_ID)).feed!);
    expect(fresh).not.toBe(old);
    expect((await h.post(`/wallet-pass/links/${fresh}`)).status).toBe(200);
  });

  it("two instances with the same secret and store render and resolve the same links; another secret resolves nothing", async () => {
    const kv = memoryKv();
    const stores = kvStores(kv, SCOPE);
    const owner = newSigner();
    const a = buildHarness({ rateLimit: false, stores });
    const links = await issuePassTo(a, owner);
    const b = buildHarness({ rateLimit: false, stores });
    b.chain.setOwner(TOKEN_ID, owner.address);
    expect(await b.issuer.capabilityLinksFor(TOKEN_ID)).toEqual(await a.issuer.capabilityLinksFor(TOKEN_ID));
    expect((await b.post(links.feed!)).status).toBe(200);
    const other = buildHarness({ rateLimit: false, stores, linkSecret: "a different secret of at least thirty-two bytes" });
    other.chain.setOwner(TOKEN_ID, owner.address);
    expect((await other.post(links.feed!)).status).toBe(404);
    expect(await other.issuer.capabilityLinksFor(TOKEN_ID)).not.toEqual(links);
  });

  it("derives deterministically and never stores what it derives", async () => {
    const secret = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
    const k1 = new LinkKeyring(secret);
    const k2 = new LinkKeyring(secret);
    expect(await k1.token("seed")).toBe(await k2.token("seed"));
    expect(await k1.token("seed")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await k1.token("seed")).not.toBe(await k1.token("seed2"));
    expect(await k1.digestOfSeed("seed")).toBe(await linkDigest(await k1.token("seed")));
    expect(await linkDigest("x")).toMatch(/^[0-9a-f]{64}$/);
    expect(() => new LinkKeyring(new Uint8Array(16))).toThrow(/32 bytes/);
  });

  describe("linkSecret configuration", () => {
    const minimal = () => ({
      domain: "issuer.example",
      baseUrl: "https://issuer.example",
      chainId: 31337,
      contract: CONTRACT,
      mode: "gated" as const,
      chain: new FakeChain(),
      providers: fakeProviders([]),
      stores: memoryStores(),
      render: () => ({ serial: "s", organizationName: "o", description: "d", title: "t" }),
    });

    it("is required in production and must be at least 32 bytes", () => {
      expect(() => createIssuer({ ...minimal(), environment: "production" })).toThrowError(IssuerConfigError);
      expect(() => createIssuer({ ...minimal(), environment: "production" })).toThrowError(/no linkSecret/);
      expect(() => createIssuer({ ...minimal(), environment: "production", linkSecret: "short" })).toThrowError(/at least 32 bytes/);
      expect(() => createIssuer({ ...minimal(), environment: "production", linkSecret: new Uint8Array(31) })).toThrowError(/at least 32 bytes/);
      expect(() => createIssuer({ ...minimal(), environment: "production", linkSecret: new Uint8Array(32) })).not.toThrow();
      expect(() => createIssuer({ ...minimal(), environment: "production", linkSecret: "x".repeat(32) })).not.toThrow();
    });

    it("in development falls back to a random per-process secret with one warning", async () => {
      const messages: string[] = [];
      const issuer = createIssuer({ ...minimal(), environment: "development", onWarning: (m) => messages.push(m) });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatch(/no linkSecret/);
      expect(issuer.config.linkSecret).toBeNull();
      // Two such issuers over one store do not share links.
      const stores = memoryStores();
      const quiet = () => undefined;
      const owner = newSigner();
      const a = buildHarness({ rateLimit: false, stores, linkSecret: undefined, onWarning: quiet });
      const links = await issuePassTo(a, owner);
      const b = buildHarness({ rateLimit: false, stores, linkSecret: undefined, onWarning: quiet });
      b.chain.setOwner(TOKEN_ID, owner.address);
      expect((await a.post(links.feed!)).status).toBe(200);
      expect((await b.post(links.feed!)).status).toBe(404);
    });
  });
});
