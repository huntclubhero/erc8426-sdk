import { describe, expect, it } from "vitest";
import {
  DEFAULT_RATE_LIMITS,
  IssuerConfigError,
  REMOTE_ADDRESS_HEADER,
  TRUSTED_PROXY_HEADERS,
  defaultClientKey,
  forwardedClientKey,
  kvRateLimiter,
  proxyClientKey,
  memoryKv,
  memoryRateLimiter,
  resolveConfig,
  toFetchRequest,
  trustedHeaderClientKey,
  type KeyValueStore,
  type RateLimiter,
} from "@erc8426/issuer";

import { CONTRACT, TOKEN_ID, buildHarness, createClock, issuePassTo, linkTokenFor, newSigner, signChallenge, type Harness } from "./helpers.js";
import { kvRepeatStore } from "@erc8426/issuer";

const CHALLENGE = (tokenId = TOKEN_ID) => `/wallet-pass/${tokenId}/challenge?address=${newSigner().address}`;
const MANIFEST = (tokenId = TOKEN_ID) => `/wallet-pass/${tokenId}`;
const RULE = { limit: 3, windowSeconds: 60 };
const baseConfig = { domain: "issuer.example", baseUrl: "https://issuer.example", chainId: 1, contract: CONTRACT, mode: "gated" as const };

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
    return buildHarness({ rateLimit: { challenge: RULE, manifest: RULE, capability: RULE, perClient: false }, ...overrides });
  }

  it("is on by default with the documented limits", () => {
    const c = resolveConfig({ domain: "issuer.example", baseUrl: "https://issuer.example", chainId: 1, contract: CONTRACT, mode: "gated" });
    expect(c.rateLimit.challenge).toEqual(DEFAULT_RATE_LIMITS.challenge);
    expect(c.rateLimit.manifest).toEqual(DEFAULT_RATE_LIMITS.manifest);
    expect(c.rateLimit.capability).toEqual(DEFAULT_RATE_LIMITS.capability);
    expect(c.rateLimit.perClient).toEqual(DEFAULT_RATE_LIMITS.perClient);
    expect(DEFAULT_RATE_LIMITS).toEqual({
      challenge: { limit: 30, windowSeconds: 60 },
      manifest: { limit: 60, windowSeconds: 60 },
      capability: { limit: 60, windowSeconds: 60 },
      action: { limit: 30, windowSeconds: 60 },
      rotate: { limit: 10, windowSeconds: 60 },
      perClient: { limit: 120, windowSeconds: 60 },
    });
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
    const ip = (a: string) => ({ [REMOTE_ADDRESS_HEADER]: a });
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

  it("a client cannot start a fresh bucket by naming another token id or link: the per-client bucket bounds it", async () => {
    // Per-token limits generous, per-client bucket small: distinct ids are
    // what the attacker varies (one client minting nonces for 200 ids).
    const h = buildHarness({ rateLimit: { challenge: { limit: 1000, windowSeconds: 60 }, perClient: { limit: 5, windowSeconds: 60 } } });
    const addr = newSigner().address;
    const ip = { [REMOTE_ADDRESS_HEADER]: "203.0.113.9" };
    let ok = 0;
    for (let i = 0; i < 20; i++) if ((await h.get(`/wallet-pass/${1000 + i}/challenge?address=${addr}`, ip)).status === 200) ok++;
    expect(ok).toBe(5);
    const refused = await h.get(`/wallet-pass/5000/challenge?address=${addr}`, ip);
    await expectLimited(refused, "challenge");
    // Another client is unaffected, and each family has its own client bucket.
    expect((await h.get(`/wallet-pass/1/challenge?address=${addr}`, { [REMOTE_ADDRESS_HEADER]: "203.0.113.10" })).status).toBe(200);
    expect((await h.get(`/wallet-pass/1`, ip)).status).toBe(401);
    // The window resets.
    h.clock.advance(60_000);
    expect((await h.get(`/wallet-pass/6000/challenge?address=${addr}`, ip)).status).toBe(200);
    // perClient: false leaves only the per-token buckets.
    const noClientBucket = buildHarness({ rateLimit: { challenge: { limit: 2, windowSeconds: 60 }, perClient: false } });
    for (let i = 0; i < 10; i++) expect((await noClientBucket.get(`/wallet-pass/${100 + i}/challenge?address=${addr}`, ip)).status).toBe(200);
    expect((await noClientBucket.get(`/wallet-pass/100/challenge?address=${addr}`, ip)).status).toBe(200);
    expect((await noClientBucket.get(`/wallet-pass/100/challenge?address=${addr}`, ip)).status).toBe(429);
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
    const download = `/wallet-pass/passes/${await linkTokenFor(record!.downloads.apple!)}`;
    for (let i = 0; i < RULE.limit; i++) expect((await h.get(download)).status).toBe(200);
    await expectLimited(await h.get(download), "capability");
    const head = await h.issuer.handler(new Request(`https://issuer.example${download}`, { method: "HEAD" }));
    expect(head.status).toBe(429);
    expect(head.headers.get("retry-after")).toMatch(/^[0-9]+$/);
  });

  it("signed action and rotate routes are limited too, and garbage presentations never fill the repeat store", async () => {
    const repeatKv = memoryKv();
    const h = buildHarness({ rateLimit: { action: RULE, rotate: RULE, perClient: false }, repeat: { store: kvRepeatStore(repeatKv) } });
    const s = newSigner();
    const p = await signChallenge(h, s, TOKEN_ID, "levelUp");
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      // A proof rewritten around a nonce the issuer never issued: refused as nonce_invalid, nothing to record.
      const forged = { message: p.message.replace(/Nonce: \w+/, `Nonce: x${i}abcdefgh`), signature: p.signature };
      statuses.push((await h.post(`/wallet-pass/${TOKEN_ID}/actions/levelUp`, { ...forged, junk: i })).status);
    }
    expect(statuses.slice(0, RULE.limit)).toEqual([401, 401, 401]);
    expect(statuses.slice(RULE.limit).every((st) => st === 429)).toBe(true);
    expect(repeatKv.size()).toBe(0);
    const rotates: number[] = [];
    for (let i = 0; i < 6; i++) rotates.push((await h.post(`/wallet-pass/${TOKEN_ID}/rotate`, { message: "m", signature: "0x00", i })).status);
    expect(rotates.filter((st) => st === 429)).toHaveLength(3);
    expect(repeatKv.size()).toBe(0);
    // Another token id is its own bucket for these families too.
    expect((await h.post(`/wallet-pass/413/actions/levelUp`, { message: "m", signature: "0x00" })).status).not.toBe(429);
  });

  it("two collections sharing one kvRateLimiter and one kvRepeatStore with default prefixes never share a bucket or a row", async () => {
    const clock = createClock();
    const kv = memoryKv({ now: clock.now });
    const limiter = kvRateLimiter(kv);
    const repeatKv = memoryKv({ now: clock.now });
    const other = newSigner().address;
    const a = buildHarness({ now: clock.now, rateLimit: { challenge: RULE, perClient: false, limiter }, repeat: { store: kvRepeatStore(repeatKv) } });
    const b = buildHarness({ now: clock.now, contract: other, rateLimit: { challenge: RULE, perClient: false, limiter }, repeat: { store: kvRepeatStore(repeatKv) } });
    const addr = newSigner().address;
    for (let i = 0; i < RULE.limit; i++) expect((await a.get(`/wallet-pass/1/challenge?address=${addr}`)).status).toBe(200);
    expect((await a.get(`/wallet-pass/1/challenge?address=${addr}`)).status).toBe(429);
    // Same client, same token id, another collection: its own bucket.
    expect((await b.get(`/wallet-pass/1/challenge?address=${addr}`)).status).toBe(200);
    // Repeat rows carry the collection too.
    const ownerA = newSigner();
    const linksA = await issuePassTo(a, ownerA);
    expect((await a.post(linksA.feed!, {})).status).toBe(200);
    expect(repeatKv.size()).toBe(1);
    expect(a.executed).toHaveLength(1);
    expect(b.executed).toHaveLength(0);
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
    // The per-client bucket is consulted first; a refusal there costs one hit.
    // Every key starts with the collection the issuer serves.
    const scope = `1:${CONTRACT.toLowerCase()}`;
    expect(seen).toEqual([`${scope}:challenge:client:abc`]);
    seen.length = 0;
    const tokenOnly = buildHarness({ rateLimit: { limiter, perClient: false, clientKey: (r) => r.headers.get("x-api-key") } });
    expect((await tokenOnly.get(CHALLENGE(), { "x-api-key": "abc" })).status).toBe(429);
    expect(seen).toEqual([`${scope}:challenge:abc:${TOKEN_ID}`]);
  });

  it("a client cannot spread its attempts across made-up addresses: the default key is the socket address alone", async () => {
    const h = buildHarness({ rateLimit: { challenge: RULE, perClient: false } });
    const addr = newSigner().address;
    let ok = 0;
    for (let i = 0; i < 20; i++) {
      const r = await h.get(`/wallet-pass/1/challenge?address=${addr}`, {
        "x-forwarded-for": `10.0.${i}.1, 203.0.113.7`,
        "x-real-ip": `10.1.${i}.1`,
        "cf-connecting-ip": `10.2.${i}.1`,
        [REMOTE_ADDRESS_HEADER]: "203.0.113.7",
      });
      if (r.status === 200) ok++;
    }
    expect(ok).toBe(RULE.limit);
  });

  it("forwardedClientKey takes the hop the trusted proxy appended, never one the client sent", async () => {
    const req = (xff: string, socket = "10.0.0.2") => new Request("https://issuer.example/", { headers: { "x-forwarded-for": xff, [REMOTE_ADDRESS_HEADER]: socket } });
    expect(forwardedClientKey(1)(req("1.1.1.1, 2.2.2.2, 203.0.113.9"))).toBe("203.0.113.9");
    expect(forwardedClientKey(2)(req("1.1.1.1, 2.2.2.2, 203.0.113.9"))).toBe("2.2.2.2");
    // Fewer hops than trusted proxies: the client sent nothing usable, fall back to the socket.
    expect(forwardedClientKey(3)(req("2.2.2.2, 203.0.113.9"))).toBe("10.0.0.2");
    expect(forwardedClientKey(1)(new Request("https://issuer.example/"))).toBeNull();
    expect(() => forwardedClientKey(0)).toThrow(/positive integer/);
    // Behind one proxy, the attacker's rotating first hop changes nothing.
    const h = buildHarness({ rateLimit: { challenge: RULE, perClient: false, clientKey: forwardedClientKey(1) } });
    const addr = newSigner().address;
    let ok = 0;
    for (let i = 0; i < 20; i++) {
      const r = await h.get(`/wallet-pass/1/challenge?address=${addr}`, { "x-forwarded-for": `10.0.${i}.1, 203.0.113.7` });
      if (r.status === 200) ok++;
    }
    expect(ok).toBe(RULE.limit);
  });

  it("trustProxy names the proxy that fronts the issuer: on Vercel that is x-real-ip, and CDN headers it passes through are ignored", async () => {
    const h = buildHarness({ rateLimit: { challenge: RULE, perClient: false, trustProxy: "vercel" } });
    const addr = newSigner().address;
    let ok = 0;
    // The attacker rotates cf-connecting-ip and true-client-ip (Vercel passes them through from the client) while Vercel's x-real-ip stays theirs.
    for (let i = 0; i < 20; i++) {
      const r = await h.get(`/wallet-pass/1/challenge?address=${addr}`, { "cf-connecting-ip": `10.0.${i}.1`, "true-client-ip": `10.1.${i}.1`, "x-real-ip": "203.0.113.7" });
      if (r.status === 200) ok++;
    }
    expect(ok).toBe(RULE.limit);
    // Another real client is its own bucket.
    expect((await h.get(`/wallet-pass/1/challenge?address=${addr}`, { "x-real-ip": "203.0.113.8" })).status).toBe(200);
    expect(TRUSTED_PROXY_HEADERS).toEqual({ vercel: "x-real-ip", cloudflare: "cf-connecting-ip", fly: "fly-client-ip", akamai: "true-client-ip" });
    expect(proxyClientKey("cloudflare")(new Request("https://issuer.example/", { headers: { "cf-connecting-ip": "192.0.2.1" } }))).toBe("192.0.2.1");
    expect(resolveConfig({ ...baseConfig, rateLimit: { trustProxy: { header: "x-client" } } }).rateLimit.clientKey(new Request("https://x/", { headers: { "x-client": "a" } }))).toBe("a");
    expect(resolveConfig({ ...baseConfig, rateLimit: { trustProxy: { forwardedHops: 1 } } }).rateLimit.clientKey(new Request("https://x/", { headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" } }))).toBe("2.2.2.2");
    expect(() => resolveConfig({ ...baseConfig, rateLimit: { trustProxy: "nope" as unknown as "vercel" } })).toThrowError(IssuerConfigError);
    // An explicit clientKey wins over trustProxy.
    const custom = resolveConfig({ ...baseConfig, rateLimit: { trustProxy: "vercel", clientKey: () => "fixed" } });
    expect(custom.rateLimit.clientKey(new Request("https://x/", { headers: { "x-real-ip": "203.0.113.7" } }))).toBe("fixed");
  });

  it("trustedHeaderClientKey reads only the named header, then the socket", () => {
    const key = trustedHeaderClientKey("cf-connecting-ip");
    const req = (headers: Record<string, string>) => new Request("https://issuer.example/", { headers });
    expect(key(req({ "cf-connecting-ip": "192.0.2.1", "x-real-ip": "198.51.100.1" }))).toBe("192.0.2.1");
    expect(key(req({ "x-real-ip": "198.51.100.1", [REMOTE_ADDRESS_HEADER]: "10.0.0.2" }))).toBe("10.0.0.2");
    expect(key(req({}))).toBeNull();
    expect(() => trustedHeaderClientKey("")).toThrow(/required/);
  });

  it("defaultClientKey is the socket address the Node adapter records, dropping a forged one, and nothing else", async () => {
    const key = (headers: Record<string, string>) => defaultClientKey(new Request("https://issuer.example/", { headers }));
    expect(key({})).toBeNull();
    expect(key({ "x-forwarded-for": " 203.0.113.9 , 10.0.0.1" })).toBeNull();
    expect(key({ "x-real-ip": "198.51.100.1", "cf-connecting-ip": "192.0.2.1", "true-client-ip": "192.0.2.2", "fly-client-ip": "192.0.2.3" })).toBeNull();
    expect(key({ [REMOTE_ADDRESS_HEADER]: "::1" })).toBe("::1");
    const fromSocket = await toFetchRequest({ method: "GET", url: "/wallet-pass/1", headers: { [REMOTE_ADDRESS_HEADER]: "1.2.3.4" }, socket: { remoteAddress: "127.0.0.1" }, async *[Symbol.asyncIterator]() {} });
    expect(defaultClientKey(fromSocket)).toBe("127.0.0.1");
    const noSocket = await toFetchRequest({ method: "GET", url: "/wallet-pass/1", headers: { [REMOTE_ADDRESS_HEADER]: "1.2.3.4" }, async *[Symbol.asyncIterator]() {} });
    expect(defaultClientKey(noSocket)).toBeNull();
  });
});
