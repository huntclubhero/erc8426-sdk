import { describe, expect, it } from "vitest";
import {
  DEFAULT_RATE_LIMITS,
  IssuerConfigError,
  REMOTE_ADDRESS_HEADER,
  defaultClientKey,
  kvRateLimiter,
  memoryKv,
  memoryRateLimiter,
  resolveConfig,
  toFetchRequest,
  type KeyValueStore,
  type RateLimiter,
} from "@erc8426/issuer";

import { CONTRACT, TOKEN_ID, buildHarness, createClock, issuePassTo, newSigner, signChallenge, type Harness } from "./helpers.js";

const CHALLENGE = (tokenId = TOKEN_ID) => `/wallet-pass/${tokenId}/challenge?address=${newSigner().address}`;
const MANIFEST = (tokenId = TOKEN_ID) => `/wallet-pass/${tokenId}`;
const RULE = { limit: 3, windowSeconds: 60 };

async function expectLimited(res: Response, family: string) {
  expect(res.status).toBe(429);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const retry = res.headers.get("retry-after");
  expect(retry).toMatch(/^[0-9]+$/);
  expect(Number(retry)).toBeGreaterThanOrEqual(1);
  const body = (await res.json()) as { error: string; message: string };
  expect(body.error).toBe("rate_limited");
  expect(body.message).toContain(family);
}

function limiterSuite(name: string, make: (now: () => number) => RateLimiter) {
  describe(`${name}`, () => {
    it("allows up to the limit, then refuses with a Retry-After of at least one second", async () => {
      const clock = createClock();
      const l = make(clock.now);
      for (let i = 1; i <= RULE.limit; i++) {
        const d = await l.hit("k", RULE, clock.now());
        expect(d.allowed).toBe(true);
        expect(d.retryAfterSeconds).toBe(0);
        expect(d.remaining).toBe(RULE.limit - i);
      }
      const refused = await l.hit("k", RULE, clock.now());
      expect(refused.allowed).toBe(false);
      expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(RULE.windowSeconds);
      expect(refused.remaining).toBe(0);
    });

    it("keys are independent", async () => {
      const clock = createClock();
      const l = make(clock.now);
      for (let i = 0; i < RULE.limit; i++) expect((await l.hit("a", RULE, clock.now())).allowed).toBe(true);
      expect((await l.hit("a", RULE, clock.now())).allowed).toBe(false);
      expect((await l.hit("b", RULE, clock.now())).allowed).toBe(true);
    });

    it("allows again once the window has passed", async () => {
      const clock = createClock();
      const l = make(clock.now);
      for (let i = 0; i < RULE.limit; i++) await l.hit("k", RULE, clock.now());
      const refused = await l.hit("k", RULE, clock.now());
      expect(refused.allowed).toBe(false);
      clock.advance(refused.retryAfterSeconds * 1000);
      expect((await l.hit("k", RULE, clock.now())).allowed).toBe(true);
    });

    it("a refused attempt does not extend the lockout", async () => {
      const clock = createClock();
      const l = make(clock.now);
      for (let i = 0; i < RULE.limit; i++) await l.hit("k", RULE, clock.now());
      const first = await l.hit("k", RULE, clock.now());
      clock.advance(10_000);
      for (let i = 0; i < 20; i++) await l.hit("k", RULE, clock.now());
      const later = await l.hit("k", RULE, clock.now());
      expect(later.allowed).toBe(false);
      // Hammering for ten seconds did not push the reset further out.
      expect(later.retryAfterSeconds).toBeLessThanOrEqual(first.retryAfterSeconds - 10);
    });
  });
}

limiterSuite("memoryRateLimiter", () => memoryRateLimiter());
limiterSuite("kvRateLimiter (store with incr)", (now) => kvRateLimiter(memoryKv({ now })));
limiterSuite("kvRateLimiter (store without incr)", (now) => {
  const inner = memoryKv({ now });
  const plain: KeyValueStore = { get: (k) => inner.get(k), set: (k, v, o) => inner.set(k, v, o), getDel: (k) => inner.getDel(k), del: (k) => inner.del(k) };
  return kvRateLimiter(plain);
});

describe("memoryRateLimiter", () => {
  it("is an exact sliding window: the window follows the attempts, not a fixed boundary", async () => {
    const clock = createClock();
    const l = memoryRateLimiter();
    await l.hit("k", RULE, clock.now());
    clock.advance(30_000);
    await l.hit("k", RULE, clock.now());
    await l.hit("k", RULE, clock.now());
    const refused = await l.hit("k", RULE, clock.now());
    expect(refused.allowed).toBe(false);
    // The oldest attempt leaves the window 30 s from now.
    expect(refused.retryAfterSeconds).toBe(30);
    clock.advance(29_000);
    expect((await l.hit("k", RULE, clock.now())).allowed).toBe(false);
    clock.advance(1_001);
    expect((await l.hit("k", RULE, clock.now())).allowed).toBe(true);
  });

  it("bounds its memory by dropping the least recently seen key", async () => {
    const l = memoryRateLimiter({ maxKeys: 2 });
    const now = Date.now();
    for (let i = 0; i < RULE.limit; i++) await l.hit("a", RULE, now);
    expect((await l.hit("a", RULE, now)).allowed).toBe(false);
    await l.hit("b", RULE, now);
    await l.hit("c", RULE, now);
    // "a" was evicted to make room for "c", so it starts a fresh window.
    expect((await l.hit("a", RULE, now)).allowed).toBe(true);
  });
});

describe("kvRateLimiter", () => {
  it("shares one count across limiters on the same store, under the prefix", async () => {
    const clock = createClock();
    const kv = memoryKv({ now: clock.now });
    const a = kvRateLimiter(kv, { prefix: "col:rl:" });
    const b = kvRateLimiter(kv, { prefix: "col:rl:" });
    for (let i = 0; i < RULE.limit; i++) expect((await (i % 2 ? a : b).hit("k", RULE, clock.now())).allowed).toBe(true);
    expect((await a.hit("k", RULE, clock.now())).allowed).toBe(false);
    expect((await b.hit("k", RULE, clock.now())).allowed).toBe(false);
    // Another prefix is another collection.
    expect((await kvRateLimiter(kv, { prefix: "other:" }).hit("k", RULE, clock.now())).allowed).toBe(true);
    expect(kv.size()).toBe(2);
  });

  it("expires the counter with its window", async () => {
    const clock = createClock();
    const kv = memoryKv({ now: clock.now });
    const l = kvRateLimiter(kv);
    for (let i = 0; i < RULE.limit; i++) await l.hit("k", RULE, clock.now());
    const refused = await l.hit("k", RULE, clock.now());
    clock.advance((refused.retryAfterSeconds + 2) * 1000);
    expect((await l.hit("k", RULE, clock.now())).allowed).toBe(true);
    expect(kv.size()).toBe(1);
  });
});

describe("rate limiting on the HTTP surface", () => {
  function limited(overrides: Parameters<typeof buildHarness>[0] = {}): Harness {
    return buildHarness({ rateLimit: { challenge: RULE, manifest: RULE, capability: RULE }, ...overrides });
  }

  it("is on by default with the documented limits", () => {
    const c = resolveConfig({ domain: "issuer.example", baseUrl: "https://issuer.example", chainId: 1, contract: CONTRACT, mode: "gated" });
    expect(c.rateLimit.challenge).toEqual(DEFAULT_RATE_LIMITS.challenge);
    expect(c.rateLimit.manifest).toEqual(DEFAULT_RATE_LIMITS.manifest);
    expect(c.rateLimit.capability).toEqual(DEFAULT_RATE_LIMITS.capability);
    expect(DEFAULT_RATE_LIMITS).toEqual({ challenge: { limit: 30, windowSeconds: 60 }, manifest: { limit: 60, windowSeconds: 60 }, capability: { limit: 60, windowSeconds: 60 } });
    expect(c.rateLimit.clientKey).toBe(defaultClientKey);
    expect(() => resolveConfig({ domain: "issuer.example", baseUrl: "https://issuer.example", chainId: 1, contract: CONTRACT, mode: "gated", rateLimit: { challenge: { limit: 0, windowSeconds: 60 } } })).toThrowError(IssuerConfigError);
  });

  it("challenge: under the limit passes, over it answers 429 rate_limited with Retry-After, and the window resets", async () => {
    const h = limited();
    for (let i = 0; i < RULE.limit; i++) expect((await h.get(CHALLENGE())).status).toBe(200);
    const res = await h.get(CHALLENGE());
    await expectLimited(res, "challenge");
    // No nonce was issued for the refused request.
    const issued = Number(res.headers.get("retry-after"));
    h.clock.advance(issued * 1000);
    expect((await h.get(CHALLENGE())).status).toBe(200);
  });

  it("keys by client address and token, so one client or one token cannot exhaust the endpoint for others", async () => {
    const h = limited();
    const ip = (a: string) => ({ "X-Forwarded-For": `${a}, 10.0.0.1` });
    for (let i = 0; i < RULE.limit; i++) expect((await h.get(CHALLENGE(), ip("203.0.113.5"))).status).toBe(200);
    expect((await h.get(CHALLENGE(), ip("203.0.113.5"))).status).toBe(429);
    // Another client, same token.
    expect((await h.get(CHALLENGE(), ip("203.0.113.6"))).status).toBe(200);
    // Same client, another token.
    expect((await h.get(CHALLENGE("413"), ip("203.0.113.5"))).status).toBe(200);
    // A client naming no address at all is counted as one unknown client.
    for (let i = 0; i < RULE.limit; i++) expect((await h.get(CHALLENGE())).status).toBe(200);
    expect((await h.get(CHALLENGE())).status).toBe(429);
  });

  it("manifest: the gated manifest is limited before any proof is checked", async () => {
    const h = limited();
    const owner = newSigner();
    h.chain.setOwner(TOKEN_ID, owner.address);
    for (let i = 0; i < RULE.limit; i++) expect((await h.get(MANIFEST())).status).toBe(401);
    await expectLimited(await h.get(MANIFEST()), "manifest");
    // The challenge family is separate: a proof can still be obtained...
    const p = await signChallenge(h, owner);
    // ...but the manifest stays refused until the window passes, proof or not, with no chain read spent.
    const reads = h.chain.reads;
    const res = await h.get(MANIFEST(), { "X-Wallet-Pass-Proof": "e30", "X-Wallet-Pass-Signature": p.signature });
    expect(res.status).toBe(429);
    expect(h.chain.reads).toBe(reads);
    h.clock.advance(RULE.windowSeconds * 1000);
    expect((await h.get(MANIFEST())).status).toBe(401);
  });

  it("capability: GET and POST on a link share one count per client and link; downloads are limited too", async () => {
    const h = limited();
    const links = await issuePassTo(h, newSigner());
    expect((await h.get(links.feed!)).status).toBe(200);
    expect((await h.post(links.feed!)).status).toBe(200);
    expect((await h.get(links.feed!)).status).toBe(200);
    const res = await h.post(links.feed!);
    await expectLimited(res, "capability");
    expect(h.executed).toHaveLength(1);
    // The other link has its own count.
    expect((await h.post(links.water!)).status).toBe(200);
    // A browser form POST gets the result page, with the status and Retry-After.
    const page = await h.issuer.handler(
      new Request(`https://issuer.example${links.feed}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" }, body: "" }),
    );
    expect(page.status).toBe(429);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("retry-after")).toMatch(/^[0-9]+$/);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    // Downloads.
    const record = await h.issuer.stores.passes.get(TOKEN_ID);
    const download = `/wallet-pass/passes/${record!.downloads.apple}`;
    for (let i = 0; i < RULE.limit; i++) expect((await h.get(download)).status).toBe(200);
    await expectLimited(await h.get(download), "capability");
    const head = await h.issuer.handler(new Request(`https://issuer.example${download}`, { method: "HEAD" }));
    expect(head.status).toBe(429);
    expect(head.headers.get("retry-after")).toMatch(/^[0-9]+$/);
  });

  it("a store-backed limiter enforces one limit across two issuers sharing the store", async () => {
    const clock = createClock();
    const kv = memoryKv({ now: clock.now });
    const make = () => buildHarness({ now: clock.now, rateLimit: { challenge: RULE, limiter: kvRateLimiter(kv) } });
    const a = make();
    const b = make();
    expect((await a.get(CHALLENGE())).status).toBe(200);
    expect((await b.get(CHALLENGE())).status).toBe(200);
    expect((await a.get(CHALLENGE())).status).toBe(200);
    await expectLimited(await b.get(CHALLENGE()), "challenge");
    clock.advance(RULE.windowSeconds * 1000 + 1000);
    expect((await b.get(CHALLENGE())).status).toBe(200);
  });

  it("a family set to false, or rateLimit: false, never refuses", async () => {
    const off = buildHarness({ rateLimit: false });
    for (let i = 0; i < 200; i++) expect((await off.get(CHALLENGE())).status).toBe(200);
    for (let i = 0; i < 100; i++) expect((await off.get(MANIFEST())).status).toBe(401);
    const links = await issuePassTo(off, newSigner());
    for (let i = 0; i < 100; i++) expect((await off.get(links.feed!)).status).toBe(200);
    const partial = limited({ rateLimit: { challenge: false, manifest: RULE } });
    for (let i = 0; i < 50; i++) expect((await partial.get(CHALLENGE())).status).toBe(200);
    for (let i = 0; i < RULE.limit; i++) expect((await partial.get(MANIFEST())).status).toBe(401);
    expect((await partial.get(MANIFEST())).status).toBe(429);
  });

  it("uses a custom clientKey and a custom limiter when given", async () => {
    const seen: string[] = [];
    const limiter: RateLimiter = {
      async hit(key, rule) {
        seen.push(key);
        return { allowed: false, retryAfterSeconds: 42, remaining: 0 };
      },
    };
    const h = buildHarness({ rateLimit: { limiter, clientKey: (r) => r.headers.get("x-api-key") } });
    const res = await h.get(CHALLENGE(), { "x-api-key": "abc" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(seen).toEqual([`challenge:abc:${TOKEN_ID}`]);
  });

  it("defaultClientKey prefers proxy headers, then the socket address the Node adapter records, and drops a forged one", async () => {
    const key = (headers: Record<string, string>) => defaultClientKey(new Request("https://issuer.example/", { headers }));
    expect(key({})).toBeNull();
    expect(key({ "x-forwarded-for": " 203.0.113.9 , 10.0.0.1" })).toBe("203.0.113.9");
    expect(key({ "x-forwarded-for": "203.0.113.9", "x-real-ip": "198.51.100.1" })).toBe("198.51.100.1");
    expect(key({ "x-real-ip": "198.51.100.1", "cf-connecting-ip": "192.0.2.1" })).toBe("192.0.2.1");
    expect(key({ [REMOTE_ADDRESS_HEADER]: "::1" })).toBe("::1");
    const fromSocket = await toFetchRequest({ method: "GET", url: "/wallet-pass/1", headers: { [REMOTE_ADDRESS_HEADER]: "1.2.3.4" }, socket: { remoteAddress: "127.0.0.1" }, async *[Symbol.asyncIterator]() {} });
    expect(defaultClientKey(fromSocket)).toBe("127.0.0.1");
    const noSocket = await toFetchRequest({ method: "GET", url: "/wallet-pass/1", headers: { [REMOTE_ADDRESS_HEADER]: "1.2.3.4" }, async *[Symbol.asyncIterator]() {} });
    expect(defaultClientKey(noSocket)).toBeNull();
  });
});
