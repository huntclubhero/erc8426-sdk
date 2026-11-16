import { getAddress, isAddress } from "viem";
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

/// The key a pass record is stored under. ERC-721: the token id, one record
///  per token. ERC-1155 binding (working draft): the id and the holding
///  account, one record per pair, since two accounts that hold the same id
///  hold two passes.
export function passKeyFor(tokenId: string, account?: string | null): string {
  return account ? `${tokenId}:${account.toLowerCase()}` : tokenId;
}

/// The key of a record: what `PassStore.put` MUST store it under and
///  `PassStore.get` is called with.
export function passRecordKey(record: Pick<PassRecord, "tokenId" | "account">): string {
  return passKeyFor(record.tokenId, record.account);
}

/// Pass state: per token (ERC-721), or per id and account (ERC-1155 draft).
export interface PassRecord {
  tokenId: string;
  /// ERC-1155 binding only: the account this record belongs to. Absent on
  ///  an ERC-721 record. Part of the record's key (`passRecordKey`).
  account?: Address;
  /// ERC-1155 binding only, and only for an issuer with no capability
  ///  links: the account fell below the minimum holding and its installed
  ///  pass was told so. The serial is kept, so the same card comes back when
  ///  the holding returns. The acquisition URLs were retired when it went
  ///  dark.
  dark?: boolean;
  /// ERC-1155 binding only: the newest block the node had when this account
  ///  was last issued the pass (decimal string), when the chain reader can
  ///  tell. A transfer log from an earlier block says nothing about this
  ///  pass: whatever the balance did then, the account was read as holding
  ///  afterwards and only then got its URLs.
  issuedAtBlock?: string;
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
  /// Capability action name to the SEED of its current link. The token in
  ///  the holder's URL is derived from the seed with `linkSecret` and is
  ///  never stored, so a read of this record yields no link.
  links: Record<string, string>;
  /// Format key to the seed of its current download link, for providers the
  ///  issuer serves pass files for. Same derivation as `links`.
  downloads: Record<string, string>;
  /// Set by `kvStores` when the record was just read through from a 0.2.x
  ///  row (`${prefix}pass:${tokenId}`): its links were tokens, not seeds,
  ///  and are gone, and its installed passes still show them. The issuer
  ///  settles such a record on first use: a new serial with fresh links, and
  ///  the old serial pushed as superseded ("Links reset", re-add the pass).
  ///  Cleared by that rotation.
  migratedFrom?: "0.2";
  /// Fingerprint (`LinkKeyring.id`) of the `linkSecret` the link bindings
  ///  were last written under. When it differs from the running issuer's
  ///  (the secret was rotated, or a development process restarted with an
  ///  ephemeral one), the bindings are rewritten under the current secret
  ///  on the next load, so the holder's next claim gets working links
  ///  instead of a record whose links are dead forever. Absent on records
  ///  written before 0.3.1, which are re-bound the same way.
  linkKeyring?: string;
  /// Unix seconds of the last content change (the manifest's `updatedAt`).
  updatedAt: number;
  /// Unix seconds of the last rotation, or of creation.
  rotatedAt: number;
}

export interface PassStore {
  /// `key` is a token id for ERC-721 and `passKeyFor(id, account)` for the
  ///  ERC-1155 binding.
  get(key: string): Promise<PassRecord | null>;
  /// Store under `passRecordKey(record)`. A store that keys on
  ///  `record.tokenId` alone serves ERC-721 only: under ERC-1155 every holder
  ///  of an id would overwrite the last.
  put(record: PassRecord): Promise<void>;
  /// OPTIONAL index of every token with a record, used to serve a
  ///  BatchPassUpdate range wider than `maxBatchRange`.
  tokenIds?(): Promise<string[]>;
  /// The accounts currently issued a pass of `tokenId`: those with a record
  ///  whose `lastIssuedTo` is set (a dark pass counts, a retired one does
  ///  not). REQUIRED for the ERC-1155 binding (the issuer refuses to start
  ///  without it) and unused for ERC-721. It is what lets the issuer push a
  ///  PassUpdate to every pass of an id and read the balances of the
  ///  accounts it issued to, with no index of the chain's holders. A store
  ///  MAY return more (accounts whose pass was retired); the issuer skips
  ///  them. It must not return fewer.
  accounts?(tokenId: string): Promise<Address[]>;
}

/// What a link resolves to. Stored under the SHA-256 digest of the token
///  (`linkDigest`), never under the token, so a dump of the link store is a
///  list of hashes. `authorize` never trusts this alone: the pass record's
///  seed must still derive to the presented token, so an orphaned entry (for
///  example from two racing rotations) resolves to nothing.
export interface LinkBinding {
  kind: "action" | "download";
  tokenId: string;
  /// ERC-1155 binding only: the account whose record holds the link.
  account?: Address;
  /// The action name (kind "action") or format key (kind "download").
  name: string;
  generation: number;
}

/// Keyed by link digest (lowercase hex SHA-256 of the token), not by token.
export interface LinkStore {
  get(linkDigest: string): Promise<LinkBinding | null>;
  put(linkDigest: string, binding: LinkBinding): Promise<void>;
  delete(linkDigests: string[]): Promise<void>;
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
      async get(key) {
        const r = passes.get(key);
        return r ? structuredClone(r) : null;
      },
      async put(record) {
        passes.set(passRecordKey(record), structuredClone(record));
      },
      async tokenIds() {
        return [...new Set([...passes.values()].map((r) => r.tokenId))];
      },
      async accounts(tokenId) {
        return [...passes.values()].filter((r) => r.tokenId === tokenId && r.account && r.lastIssuedTo !== null).map((r) => r.account!);
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
  /// OPTIONAL. Atomically add one to an integer counter, creating it at 1
  ///  with the given expiry (Redis INCR, then EXPIRE on first create), and
  ///  return the new value. `kvRateLimiter` uses it for an exact count
  ///  across instances; without it the limiter reads and writes the counter
  ///  back and may undercount racing attempts.
  incr?(key: string, ttlSeconds: number): Promise<number>;
  /// OPTIONAL, all three or none: an unordered set of strings under a key
  ///  (Redis SADD, SREM, SMEMBERS). `kvStores` keeps the accounts issued a
  ///  pass of an ERC-1155 id in one. Adding and removing must each be
  ///  atomic. Without them the list is a JSON array that is read and written
  ///  back, which two claims racing each other can get wrong; give an
  ///  ERC-1155 issuer behind more than one instance the set operations.
  setAdd?(key: string, member: string): Promise<void>;
  setRemove?(key: string, member: string): Promise<void>;
  setMembers?(key: string): Promise<string[]>;
}

export interface KvStoresOptions {
  /// The chain the collection lives on. Part of every key.
  chainId: number;
  /// The collection's contract address. Part of every key, lowercased.
  contract: string;
  /// Literal key prefix. Default "erc8426:".
  prefix?: string;
  /// Read through to 0.2.x rows (`${prefix}pass:${tokenId}`) on a miss:
  ///  the record is copied under the scoped key with its links dropped and
  ///  `migratedFrom: "0.2"` set, the old pass row and its link rows are
  ///  deleted, and the issuer supersedes the old serial on first use so the
  ///  installed pass gets the "Links reset, re-add" push. Default true; set
  ///  false once no 0.2.x row can remain.
  legacy?: boolean;
}

/// Build the namespace every key of a collection lives under:
///  `${prefix}${chainId}:${contract}:`, with the contract lowercased so the
///  checksum casing of the configured address never splits one collection
///  into two namespaces.
export function kvKeyNamespace(options: KvStoresOptions): string {
  if (!Number.isSafeInteger(options.chainId) || options.chainId <= 0) throw new Error(`kvStores: chainId must be a positive integer, got ${String(options.chainId)}`);
  if (typeof options.contract !== "string" || !isAddress(options.contract, { strict: false })) {
    throw new Error(`kvStores: contract must be an address, got "${String(options.contract)}"`);
  }
  return `${options.prefix ?? "erc8426:"}${options.chainId}:${getAddress(options.contract).toLowerCase()}:`;
}

/// Build all three stores on a key-value store. Every key carries the chain
///  id and contract address, `${prefix}${chainId}:${contract}:pass:${tokenId}`
///  (and `...:link:${token}`, `...:nonce:${nonce}`), so two collections on one
///  Redis never share a row even when they share token ids, and a collection
///  redeployed on another chain starts clean. `prefix` (default "erc8426:")
///  is a further literal namespace, for example per environment.
///
///  Rows written by 0.2.x live under the old shape `${prefix}pass:${tokenId}`
///  and are not read; see the 0.3.0 changelog for the one-off rekey.
export function kvStores(kv: KeyValueStore, options: KvStoresOptions): IssuerStores {
  const ns = kvKeyNamespace(options);
  const nonceKey = (n: string) => `${ns}nonce:${n}`;
  const passKey = (t: string) => `${ns}pass:${t}`;
  const linkKey = (l: string) => `${ns}link:${l}`;
  // ERC-1155 binding: the accounts currently issued a pass of an id (a
  // record whose `lastIssuedTo` is set; a dark pass counts). An account is
  // added when it is issued to and removed when its pass is retired, so the
  // list is the live passes and not every account that ever claimed.
  //
  // With the store's set operations each change is one atomic call. Without
  // them the list is one JSON array per id, read and written back, and two
  // changes racing each other can lose one: the write is re-read and retried
  // a few times, which narrows that and does not close it. An account
  // missing from the list is still refused by the fresh entitlement read,
  // and is still found when a transfer names it; what it misses is the
  // PassUpdate push and the periodic holdings check.
  const issuedKey = (t: string) => `${ns}issued:${t}`;
  const holdersKey = (t: string) => `${ns}holders:${t}`;
  const hasSets = typeof kv.setAdd === "function" && typeof kv.setRemove === "function" && typeof kv.setMembers === "function";
  const readIssued = async (tokenId: string) => parse<string[]>(await kv.get(issuedKey(tokenId))) ?? [];
  const setIssued = async (tokenId: string, account: string, member: boolean): Promise<void> => {
    if (hasSets) {
      if (member) await kv.setAdd!(holdersKey(tokenId), account);
      else await kv.setRemove!(holdersKey(tokenId), account);
      return;
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const issued = await readIssued(tokenId);
      if (issued.includes(account) === member) return;
      await kv.set(issuedKey(tokenId), JSON.stringify(member ? [...issued, account] : issued.filter((a) => a !== account)));
    }
  };
  // A client that parses JSON on read (@upstash/redis does by default, as
  // does Vercel KV) hands back the object rather than the string we wrote.
  // Accept both, so a shim written either way works.
  const parse = <T>(value: unknown): T | null => {
    if (value === null || value === undefined) return null;
    return (typeof value === "string" ? JSON.parse(value) : value) as T;
  };
  const legacyPrefix = options.prefix ?? "erc8426:";
  const readLegacy = options.legacy !== false;
  // A 0.2.x pass row, moved under the scoped key the first time it is
  // missed there. Its `links` and `downloads` held raw tokens that nothing
  // can resolve under the digest scheme, so they are dropped (and their
  // `${prefix}link:` rows deleted) and the record is marked for the issuer
  // to settle: a new serial, and the old one superseded, so every installed
  // pass learns it was replaced instead of freezing with dead links.
  const migrateLegacy = async (tokenId: string): Promise<PassRecord | null> => {
    const old = parse<PassRecord>(await kv.get(`${legacyPrefix}pass:${tokenId}`));
    if (!old || typeof old !== "object" || typeof old.serial !== "string") return null;
    const migrated: PassRecord = {
      tokenId,
      serial: old.serial,
      generation: typeof old.generation === "number" ? old.generation : 0,
      lastIssuedTo: old.lastIssuedTo ?? null,
      links: {},
      downloads: {},
      updatedAt: typeof old.updatedAt === "number" ? old.updatedAt : 0,
      rotatedAt: typeof old.rotatedAt === "number" ? old.rotatedAt : 0,
      migratedFrom: "0.2",
    };
    await kv.set(passKey(tokenId), JSON.stringify(migrated));
    const oldTokens = [...Object.values(old.links ?? {}), ...Object.values(old.downloads ?? {})].filter((t): t is string => typeof t === "string");
    await Promise.all([kv.del(`${legacyPrefix}pass:${tokenId}`), ...oldTokens.map((t) => kv.del(`${legacyPrefix}link:${t}`))]);
    return migrated;
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
      async get(key) {
        const record = parse<PassRecord>(await kv.get(passKey(key)));
        // 0.2.x rows are ERC-721 rows: a key that names an account has none.
        if (record || !readLegacy || key.includes(":")) return record;
        return migrateLegacy(key);
      },
      async put(record) {
        await kv.set(passKey(passRecordKey(record)), JSON.stringify(record));
        if (!record.account) return;
        await setIssued(record.tokenId, record.account.toLowerCase(), record.lastIssuedTo !== null);
      },
      async accounts(tokenId) {
        const members = hasSets ? await kv.setMembers!(holdersKey(tokenId)) : await readIssued(tokenId);
        return members.map((a) => getAddress(a));
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
  const sets = new Map<string, Set<string>>();
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
    async setAdd(key, member) {
      let set = sets.get(key);
      if (!set) sets.set(key, (set = new Set()));
      set.add(member);
    },
    async setRemove(key, member) {
      sets.get(key)?.delete(member);
    },
    async setMembers(key) {
      return [...(sets.get(key) ?? [])];
    },
    async incr(key, ttlSeconds) {
      sweep();
      const e = live(key);
      const next = (e ? Number(e.value) : 0) + 1;
      map.set(key, { value: String(next), expiresAt: e ? e.expiresAt : now() + ttlSeconds * 1000 });
      return next;
    },
    size() {
      return map.size;
    },
  };
}
