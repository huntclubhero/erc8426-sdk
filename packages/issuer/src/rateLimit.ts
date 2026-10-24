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
  /// Key prefix. Default "erc8426:rl:". Give the limiter the same
  ///  chain-and-contract scope as `kvStores` if one KV serves several
  ///  collections (for example `${kvKeyNamespace(scope)}rl:`).
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

/// The client address a request arrived from, best effort: the platform
///  headers a trusted proxy sets (Cloudflare, then the usual reverse-proxy
///  names, with the first X-Forwarded-For hop), then the socket address the
///  Node adapter recorded, else null. A deployment with no proxy in front
///  should pass its own `clientKey`, since X-Forwarded-For is then
///  client-supplied and a client could spread its attempts across made-up
///  addresses; one that fronts the issuer with a proxy should make sure the
///  proxy overwrites these headers rather than appending to them.
export function defaultClientKey(request: Request): string | null {
  const h = request.headers;
  const direct = h.get("cf-connecting-ip") ?? h.get("true-client-ip") ?? h.get("x-real-ip") ?? h.get("fly-client-ip");
  if (direct && direct.trim() !== "") return direct.trim();
  const forwarded = h.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]!.trim();
    if (first !== "") return first;
  }
  const remote = h.get(REMOTE_ADDRESS_HEADER);
  if (remote && remote.trim() !== "") return remote.trim();
  return null;
}
