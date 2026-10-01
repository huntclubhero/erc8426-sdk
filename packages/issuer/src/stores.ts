import type { Address } from "viem";

/// Storage seams. Every store is async so the same issuer runs on one
///  process with the in-memory stores and on many instances with a shared
///  key-value store behind `kvStores`.

/// What the verifier recorded when it issued a nonce: the challenge it went
///  into. `authorize` compares the presented message against this, so a nonce
///  is only good for the account, token and action it was issued for.
export interface NonceRecord {
  account: Address;
  tokenId: string;
  action: string;
  /// The issued challenge's Expiration Time, epoch milliseconds.
  expiresAt: number;
}

export interface NonceStore {
  /// Record a freshly issued nonce, retained for `ttlSeconds`.
  issue(nonce: string, record: NonceRecord, ttlSeconds: number): Promise<void>;
  /// Atomically spend a nonce: returns its record at most once, and null for
  ///  a nonce that was never issued, was already spent, or was evicted. Two
  ///  concurrent presentations of one nonce MUST NOT both succeed.
  consume(nonce: string): Promise<NonceRecord | null>;
}

/// Per-token pass state.
export interface PassRecord {
  tokenId: string;
  /// Random pass serial (PassContent.serial). Stable for one holder so
  ///  platform updates land on the same card, replaced when the holder
  ///  changes. Never derived from the token id or the holder.
  serial: string;
  /// Rotation counter. Incremented by every rotation.
  generation: number;
  /// The account passes were last issued to. Null before the first issuance
  ///  and after an observed transfer. A proven claim by any other account is
  ///  that account's first claim (Gated acquisition).
  lastIssuedTo: Address | null;
  /// Capability action name to its current link token.
  links: Record<string, string>;
  /// Format key to its current download token, for providers the issuer
  ///  serves pass files for.
  downloads: Record<string, string>;
  /// Unix seconds of the last content change (the manifest's `updatedAt`).
  updatedAt: number;
  /// Unix seconds of the last rotation, or of creation.
  rotatedAt: number;
}

export interface PassStore {
  get(tokenId: string): Promise<PassRecord | null>;
  put(record: PassRecord): Promise<void>;
  /// OPTIONAL index of every token with a record, used to serve a
  ///  BatchPassUpdate range wider than `maxBatchRange`.
  tokenIds?(): Promise<string[]>;
}

/// What a link token resolves to. `authorize` never trusts this alone: the
///  pass record must still list the token as current, so an orphaned entry
///  (for example from two racing rotations) resolves to nothing.
export interface LinkBinding {
  kind: "action" | "download";
  tokenId: string;
  /// The action name (kind "action") or format key (kind "download").
  name: string;
  generation: number;
}

export interface LinkStore {
  get(linkToken: string): Promise<LinkBinding | null>;
  put(linkToken: string, binding: LinkBinding): Promise<void>;
  delete(linkTokens: string[]): Promise<void>;
}

export interface IssuerStores {
  nonces: NonceStore;
  passes: PassStore;
  links: LinkStore;
}

export interface MemoryStoreOptions {
  now?: () => number;
  /// Most unconsumed nonces held at once. Past it the oldest are dropped
  ///  (their challenges then fail as nonce_invalid). Default 100000.
  maxNonces?: number;
}

/// Sweep expired entries at most this often, so issuing stays O(1) amortized.
const SWEEP_INTERVAL_MS = 1000;

/// In-memory stores for a single process: development, tests, and
///  deployments that run exactly one instance. With more than one instance
///  the nonce store MUST be shared, or a nonce spent on one instance is
///  still live on another; use `kvStores`.
///
///  Anyone can ask the challenge endpoint for a nonce, so issued but never
///  presented nonces are swept once their retention passes, and the store is
///  capped at `maxNonces`. The cap bounds memory, not abuse: rate limit the
///  challenge endpoint (per IP or per address) in front of the issuer, since
///  a flood past the cap evicts honest users' pending challenges.
export function memoryStores(options: MemoryStoreOptions = {}): IssuerStores {
  const now = options.now ?? Date.now;
  const maxNonces = options.maxNonces ?? 100_000;
  const nonces = new Map<string, { record: NonceRecord; evictAt: number }>();
  let lastSweep = now();
  const sweep = () => {
    const t = now();
    if (t - lastSweep < SWEEP_INTERVAL_MS && nonces.size < maxNonces) return;
    lastSweep = t;
    for (const [k, v] of nonces) if (t >= v.evictAt) nonces.delete(k);
    // Still full: drop the oldest (Map iteration is insertion order).
    for (const k of nonces.keys()) {
      if (nonces.size < maxNonces) break;
      nonces.delete(k);
    }
  };
  const passes = new Map<string, PassRecord>();
  const links = new Map<string, LinkBinding>();
  return {
    nonces: {
      async issue(nonce, record, ttlSeconds) {
        sweep();
        nonces.set(nonce, { record: { ...record }, evictAt: now() + ttlSeconds * 1000 });
      },
      async consume(nonce) {
        const entry = nonces.get(nonce);
        if (!entry) return null;
        // Delete before checking eviction so a spent nonce is never revived.
        // Node runs this synchronously, so it cannot interleave with another
        // consume of the same nonce.
        nonces.delete(nonce);
        return now() < entry.evictAt ? entry.record : null;
      },
    },
    passes: {
      async get(tokenId) {
        const r = passes.get(tokenId);
        return r ? structuredClone(r) : null;
      },
      async put(record) {
        passes.set(record.tokenId, structuredClone(record));
      },
      async tokenIds() {
        return [...passes.keys()];
      },
    },
    links: {
      async get(linkToken) {
        const b = links.get(linkToken);
        return b ? { ...b } : null;
      },
      async put(linkToken, binding) {
        links.set(linkToken, { ...binding });
      },
      async delete(linkTokens) {
        for (const t of linkTokens) links.delete(t);
      },
    },
  };
}

export interface KvSetOptions {
  /// Expire the key after this many seconds.
  ttlSeconds?: number;
  /// Write only when the key does not exist (Redis SET NX).
  onlyIfAbsent?: boolean;
}

/// The minimal key-value surface the issuer needs. Redis, Upstash and
///  Vercel KV provide every method natively; see the README for 10 line
///  shims. `getDel` MUST be atomic (Redis GETDEL, 6.2+): it is what makes a
///  nonce single-use across instances. A store without an atomic read and
///  delete (Cloudflare Workers KV is eventually consistent) MUST NOT back the
///  nonce store; put nonces in a Durable Object or Redis instead.
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  /// Returns false when `onlyIfAbsent` was set and the key existed.
  set(key: string, value: string, options?: KvSetOptions): Promise<boolean>;
  /// Atomically read and delete. Null when the key does not exist.
  getDel(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
}

/// Build all three stores on a key-value store. Keys are namespaced under
///  `prefix` (default "erc8426:"); give each collection its own prefix when
///  one Redis serves several.
export function kvStores(kv: KeyValueStore, options: { prefix?: string } = {}): IssuerStores {
  const prefix = options.prefix ?? "erc8426:";
  const nonceKey = (n: string) => `${prefix}nonce:${n}`;
  const passKey = (t: string) => `${prefix}pass:${t}`;
  const linkKey = (l: string) => `${prefix}link:${l}`;
  // A client that parses JSON on read (@upstash/redis does by default, as
  // does Vercel KV) hands back the object rather than the string we wrote.
  // Accept both, so a shim written either way works.
  const parse = <T>(value: unknown): T | null => {
    if (value === null || value === undefined) return null;
    return (typeof value === "string" ? JSON.parse(value) : value) as T;
  };
  return {
    nonces: {
      async issue(nonce, record, ttlSeconds) {
        // NX: a nonce collision (never expected at 96 bits) must not
        // overwrite a live record.
        const ok = await kv.set(nonceKey(nonce), JSON.stringify(record), { ttlSeconds, onlyIfAbsent: true });
        if (!ok) throw new Error("nonce collision: refusing to reissue a live nonce");
      },
      async consume(nonce) {
        // One atomic GETDEL: of two concurrent presentations exactly one sees
        // the value. A get followed by a del would let both through.
        return parse<NonceRecord>(await kv.getDel(nonceKey(nonce)));
      },
    },
    passes: {
      async get(tokenId) {
        return parse<PassRecord>(await kv.get(passKey(tokenId)));
      },
      async put(record) {
        await kv.set(passKey(record.tokenId), JSON.stringify(record));
      },
    },
    links: {
      async get(linkToken) {
        return parse<LinkBinding>(await kv.get(linkKey(linkToken)));
      },
      async put(linkToken, binding) {
        await kv.set(linkKey(linkToken), JSON.stringify(binding));
      },
      async delete(linkTokens) {
        await Promise.all(linkTokens.map((t) => kv.del(linkKey(t))));
      },
    },
  };
}

/// A `KeyValueStore` in process memory with TTLs, for tests and as the
///  reference for what a shim must do.
export function memoryKv(options: { now?: () => number } = {}): KeyValueStore & { size(): number } {
  const now = options.now ?? Date.now;
  const map = new Map<string, { value: string; expiresAt: number | null }>();
  // Expired keys are dropped on access and by a periodic sweep on write, as
  // Redis expires keys nobody reads again.
  let lastSweep = now();
  const sweep = () => {
    const t = now();
    if (t - lastSweep < SWEEP_INTERVAL_MS) return;
    lastSweep = t;
    for (const [k, e] of map) if (e.expiresAt !== null && t >= e.expiresAt) map.delete(k);
  };
  const live = (key: string) => {
    const e = map.get(key);
    if (!e) return null;
    if (e.expiresAt !== null && now() >= e.expiresAt) {
      map.delete(key);
      return null;
    }
    return e;
  };
  return {
    async get(key) {
      return live(key)?.value ?? null;
    },
    async set(key, value, opts = {}) {
      sweep();
      if (opts.onlyIfAbsent && live(key)) return false;
      map.set(key, { value, expiresAt: opts.ttlSeconds ? now() + opts.ttlSeconds * 1000 : null });
      return true;
    },
    async getDel(key) {
      const e = live(key);
      map.delete(key);
      return e?.value ?? null;
    },
    async del(key) {
      map.delete(key);
    },
    size() {
      return map.size;
    },
  };
}
