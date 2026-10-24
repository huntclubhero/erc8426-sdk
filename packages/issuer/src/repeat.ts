import type { KeyValueStore } from "./stores.js";

/// Identical repeats are not replays. iOS in-app browsers send a GET, then a
///  POST the phone aborts, then the same POST again, on every tap; a proxy
///  retries a timed-out POST the same way. The spec revision therefore says
///  an issuer SHOULD answer a repeat of an identical request, arriving while
///  the first is in flight or shortly after it completed, with the first
///  request's outcome rather than with a refusal. Only a presentation that
///  differs from the first is a replay. This module records outcomes by a
///  key that covers the whole request (link or nonce plus a hash of every
///  byte that matters) and replays them for a short window.

/// A completed response, in a shape a store can hold and a Response can be
///  rebuilt from any number of times.
export interface RecordedOutcome {
  status: number;
  /// Response headers worth replaying (content type, cache control, Retry-After).
  headers: Record<string, string>;
  /// The body text (JSON).
  body: string;
}

/// Where completed outcomes live for the repeat window. The in-memory store
///  serves one process; `kvRepeatStore` shares outcomes across instances.
///  Requests still in flight are shared inside one process only.
export interface RepeatStore {
  get(key: string): Promise<RecordedOutcome | null>;
  put(key: string, outcome: RecordedOutcome, ttlSeconds: number): Promise<void>;
}

export interface MemoryRepeatStoreOptions {
  /// Most outcomes kept at once; past it the least recently used is dropped. Default 10000.
  maxEntries?: number;
  /// Clock, epoch milliseconds. Default Date.now.
  now?: () => number;
}

/// In-process store, bounded and least recently used first out.
export function memoryRepeatStore(options: MemoryRepeatStoreOptions = {}): RepeatStore {
  const maxEntries = options.maxEntries ?? 10_000;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { outcome: RecordedOutcome; expiresAt: number }>();
  // Expired entries are dropped on read, and swept at most once a second on
  // write (or when the map is full), so a write stays O(1) amortized rather
  // than a scan of the whole map.
  let lastSweep = now();
  const sweep = (t: number) => {
    if (t - lastSweep < 1000 && entries.size <= maxEntries) return;
    lastSweep = t;
    for (const [k, e] of entries) if (t >= e.expiresAt) entries.delete(k);
  };
  return {
    async get(key) {
      const e = entries.get(key);
      if (!e) return null;
      if (now() >= e.expiresAt) {
        entries.delete(key);
        return null;
      }
      // Refresh recency (Map iteration is insertion order).
      entries.delete(key);
      entries.set(key, e);
      return { status: e.outcome.status, headers: { ...e.outcome.headers }, body: e.outcome.body };
    },
    async put(key, outcome, ttlSeconds) {
      const t = now();
      sweep(t);
      entries.delete(key);
      entries.set(key, { outcome: { status: outcome.status, headers: { ...outcome.headers }, body: outcome.body }, expiresAt: t + ttlSeconds * 1000 });
      while (entries.size > maxEntries) {
        const eldest = entries.keys().next().value;
        if (eldest === undefined) break;
        entries.delete(eldest);
      }
    },
  };
}

export interface KvRepeatStoreOptions {
  /// Key prefix. Default "erc8426:repeat:". The issuer already starts every
  ///  repeat key with its chain id and contract, so one store on one KV
  ///  serves several collections without a prefix of their own; set one to
  ///  separate environments.
  prefix?: string;
}

/// Outcomes on the shared `KeyValueStore`, expiring with the window, so an
///  identical repeat that lands on another instance after the first
///  completed still gets the first outcome. (A repeat that lands on another
///  instance while the first is still in flight is not shared: it runs as a
///  new request, which for the nonce path means `nonce_invalid`.)
export function kvRepeatStore(kv: KeyValueStore, options: KvRepeatStoreOptions = {}): RepeatStore {
  const prefix = options.prefix ?? "erc8426:repeat:";
  return {
    async get(key) {
      const raw = await kv.get(`${prefix}${key}`);
      if (raw === null || raw === undefined) return null;
      const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as RecordedOutcome;
      return typeof parsed === "object" && parsed !== null && typeof parsed.status === "number" && typeof parsed.body === "string"
        ? { status: parsed.status, headers: parsed.headers ?? {}, body: parsed.body }
        : null;
    },
    async put(key, outcome, ttlSeconds) {
      await kv.set(`${prefix}${key}`, JSON.stringify(outcome), { ttlSeconds });
    },
  };
}

/// Lowercase hex SHA-256 of a string, through Web Crypto (Node 20+,
///  browsers, Bun, Deno, Workers).
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function toOutcome(response: Response): Promise<RecordedOutcome> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return { status: response.status, headers, body: await response.text() };
}

export function fromOutcome(outcome: RecordedOutcome): Response {
  return new Response(outcome.body, { status: outcome.status, headers: outcome.headers });
}

/// Whether a completed outcome may be recorded for the window. A 5xx, or any
///  answer carrying Retry-After, says the request could not be judged, not
///  how it was judged (the reference server records no 503 either): a retry
///  after Retry-After must meet a fresh read, not the recorded failure. The
///  caller may narrow this further per route (the signed route records
///  nothing until the nonce was spent).
export function isRecordableOutcome(outcome: RecordedOutcome): boolean {
  if (outcome.status >= 500) return false;
  for (const name of Object.keys(outcome.headers)) if (name.toLowerCase() === "retry-after") return false;
  return true;
}

/// The `error` member of a JSON error body, or undefined.
export function errorCodeOf(outcome: RecordedOutcome): string | undefined {
  try {
    const parsed: unknown = JSON.parse(outcome.body);
    const code = (parsed as { error?: unknown } | null)?.error;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

/// Coalesce identical requests: one key, one execution. A request whose key
///  is in flight awaits the same promise; one whose key completed within the
///  window gets the recorded outcome; anything else runs and is recorded
///  when `isRecordableOutcome` (and the caller's `recordIf`) allow.
export class RepeatCoalescer {
  private readonly inflight = new Map<string, Promise<RecordedOutcome>>();
  constructor(
    private readonly store: RepeatStore,
    private readonly windowSeconds: number,
  ) {}

  async run(key: string, execute: () => Promise<Response>, recordIf?: (outcome: RecordedOutcome) => boolean): Promise<{ response: Response; repeated: boolean }> {
    const pending = this.inflight.get(key);
    if (pending) return { response: fromOutcome(await pending), repeated: true };
    const recorded = await this.store.get(key);
    if (recorded) return { response: fromOutcome(recorded), repeated: true };
    const promise = (async () => {
      // Every judged outcome is recorded, refusals included, as the reference
      // server does: the repeat gets THAT request's answer, so a refused
      // presentation repeats its refusal and never turns into nonce_invalid.
      // An outcome that is no judgment (a 5xx, a Retry-After) is not, nor
      // one the caller excludes. State that moved on (a rotation, a claim, a
      // transfer) changes the key, so a stale answer is never served.
      const outcome = await toOutcome(await execute());
      if (isRecordableOutcome(outcome) && (!recordIf || recordIf(outcome))) await this.store.put(key, outcome, this.windowSeconds);
      return outcome;
    })();
    this.inflight.set(key, promise);
    try {
      return { response: fromOutcome(await promise), repeated: false };
    } finally {
      this.inflight.delete(key);
    }
  }
}
