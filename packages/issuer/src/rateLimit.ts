import type { KeyValueStore } from "./stores.js";

/// Rate limiting for the anonymous surface (Refusal responses: `rate_limited`,
///  429, `Retry-After`). Anyone can ask the challenge endpoint for a nonce,
///  fetch a manifest, or poke a capability link, and each costs the issuer a
///  store write or a chain read. A limiter bounds what one client can spend
///  per token; it is not an authorization control and never replaces the
///  floor or the fresh read.

/// One rule: at most `limit` attempts per `windowSeconds`.
export interface RateLimitRule {
  limit: number;
  windowSeconds: number;
}

export interface RateLimitDecision {
  /// False when the attempt is over the limit. The attempt is counted either
  ///  way, so a client that keeps hammering keeps being refused.
  allowed: boolean;
  /// Whole seconds until an attempt will be allowed again (at least 1 when
  ///  refused, 0 when allowed).
  retryAfterSeconds: number;
  /// Attempts left in the window after this one, when the limiter knows.
  remaining?: number;
}

/// The pluggable seam. `hit` records one attempt under `key` and decides.
///  Implementations MUST be safe to call concurrently for one key and
///  SHOULD bound their memory (the default evicts least recently used keys).
export interface RateLimiter {
  hit(key: string, rule: RateLimitRule, nowMs: number): Promise<RateLimitDecision>;
}

export interface MemoryRateLimiterOptions {
  /// Most keys tracked at once; past it the least recently seen key is
  ///  dropped (its client gets a fresh window). Default 100000.
  maxKeys?: number;
}

/// In-process sliding window: the timestamps of the last `limit` attempts
///  per key, so the decision is exact (never the burst-at-the-boundary of a
///  fixed window). Memory is at most `maxKeys` times `limit` timestamps. For
///  one process; with several instances each enforces the limit on its own
///  share of traffic, which still bounds the total at instances times the
///  limit. Use `kvRateLimiter` for one limit across instances.
export function memoryRateLimiter(options: MemoryRateLimiterOptions = {}): RateLimiter {
  const maxKeys = options.maxKeys ?? 100_000;
  const windows = new Map<string, number[]>();
  return {
    async hit(key, rule, nowMs) {
      const windowMs = rule.windowSeconds * 1000;
      const floor = nowMs - windowMs;
      let stamps = windows.get(key);
      if (stamps) {
        // Refresh recency (Map iteration is insertion order).
        windows.delete(key);
        // Drop attempts that have left the window.
        let i = 0;
        while (i < stamps.length && stamps[i]! <= floor) i++;
        if (i > 0) stamps = stamps.slice(i);
      } else {
        stamps = [];
      }
      if (stamps.length >= rule.limit) {
        // Refused attempts are not remembered: remembering them would let a
        // client extend its own lockout forever, which the spec's "After
        // Retry-After" promise does not allow.
        windows.set(key, stamps);
        const oldest = stamps[0]!;
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000)), remaining: 0 };
      }
      stamps.push(nowMs);
      windows.set(key, stamps);
      if (windows.size > maxKeys) {
        const eldest = windows.keys().next().value;
        if (eldest !== undefined) windows.delete(eldest);
      }
      return { allowed: true, retryAfterSeconds: 0, remaining: rule.limit - stamps.length };
    },
  };
}

export interface KvRateLimiterOptions {
  /// Key prefix. Default "erc8426:rl:". The issuer already starts every key
  ///  it counts with its chain id and contract, so one limiter on one KV
  ///  serves several collections without a prefix of their own; set one to
  ///  separate environments.
  prefix?: string;
}

/// Store-backed fixed window: one counter per key and window, expiring with
///  the window, shared by every instance behind one KV. With a store that
///  implements the optional `incr` (Redis INCR with EXPIRE) the count is
///  exact under concurrency. Without it the counter is read and written
///  back, so two attempts that race may count as one; the limit then holds
///  approximately, which is enough for the abuse it bounds. A fixed window
///  admits up to twice the limit across a boundary; set the limit with that
///  in mind.
export function kvRateLimiter(kv: KeyValueStore, options: KvRateLimiterOptions = {}): RateLimiter {
  const prefix = options.prefix ?? "erc8426:rl:";
  return {
    async hit(key, rule, nowMs) {
      const windowMs = rule.windowSeconds * 1000;
      const windowIndex = Math.floor(nowMs / windowMs);
      const resetAt = (windowIndex + 1) * windowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - nowMs) / 1000));
      // The window's own lifetime, plus a second so a clock at the boundary
      // never sees the counter vanish early.
      const ttlSeconds = retryAfterSeconds + 1;
      const k = `${prefix}${key}:${windowIndex}`;
      let count: number;
      if (typeof kv.incr === "function") {
        count = await kv.incr(k, ttlSeconds);
      } else {
        const current = Number((await kv.get(k)) ?? "0");
        count = (Number.isFinite(current) ? current : 0) + 1;
        await kv.set(k, String(count), { ttlSeconds });
      }
      if (count > rule.limit) return { allowed: false, retryAfterSeconds, remaining: 0 };
      return { allowed: true, retryAfterSeconds: 0, remaining: rule.limit - count };
    },
  };
}

/// A limiter that never refuses. What `rateLimit: false` resolves to, so the
///  router has one code path.
export const unlimited: RateLimiter = {
  async hit(_key, rule) {
    return { allowed: true, retryAfterSeconds: 0, remaining: rule.limit };
  },
};

/// Header the Node adapter sets from the socket's remote address. The
///  adapter overwrites whatever a client sent under this name, so it is
///  trustworthy where the adapter is in use.
export const REMOTE_ADDRESS_HEADER = "x-erc8426-remote-address" as const;

export type ClientKeyFn = (request: Request) => string | null;

/// The socket address the Node adapter recorded, else null. Nothing a client
///  can send is consulted: every proxy header is client-supplied unless a
///  proxy the operator controls overwrites it, and a limiter keyed on a
///  header the client picks is no limiter (rotate the value, start a fresh
///  bucket; name a victim's address, burn theirs). Behind a proxy, the
///  socket address is the proxy's, so every client shares one bucket until
///  the operator says which header to trust: see `forwardedClientKey` and
///  `trustedHeaderClientKey`.
export function defaultClientKey(request: Request): string | null {
  const remote = request.headers.get(REMOTE_ADDRESS_HEADER);
  return remote && remote.trim() !== "" ? remote.trim() : null;
}

/// Client address from `X-Forwarded-For` behind a known number of trusted
///  proxies: the hop `trustedHops` from the right is the address the
///  outermost trusted proxy saw, and everything left of it is whatever the
///  client sent. With one proxy in front, `forwardedClientKey(1)` takes the
///  last hop. Falls back to the socket address, then null.
export function forwardedClientKey(trustedHops: number): ClientKeyFn {
  if (!Number.isInteger(trustedHops) || trustedHops < 1) throw new Error(`forwardedClientKey: trustedHops must be a positive integer, got ${String(trustedHops)}`);
  return (request) => {
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) {
      const hops = forwarded
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
      const hop = hops[hops.length - trustedHops];
      if (hop !== undefined) return hop;
    }
    return defaultClientKey(request);
  };
}

/// Client address from one named header a trusted proxy sets, for example
///  `trustedHeaderClientKey("cf-connecting-ip")` behind Cloudflare or
///  `"fly-client-ip"` on Fly. Opt-in by name: the operator knows which
///  proxy fronts the issuer and that it overwrites the header. Falls back
///  to the socket address, then null.
export function trustedHeaderClientKey(headerName: string): ClientKeyFn {
  if (typeof headerName !== "string" || headerName.trim() === "") throw new Error("trustedHeaderClientKey: headerName is required");
  const name = headerName.trim();
  return (request) => {
    const value = request.headers.get(name);
    if (value && value.trim() !== "") return value.split(",")[0]!.trim();
    return defaultClientKey(request);
  };
}
