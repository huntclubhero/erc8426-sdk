import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";

/// Google Wallet save and delete callbacks. When `callbackOptions.url` is set
///  on a class, Google POSTs a signed message to it every time a holder saves
///  ("save") or removes ("del") an object of that class. The body is a Google
///  Pay signed message, protocol ECv2SigningOnly, verified here the way
///  Tink's PaymentMethodTokenRecipient does for sender "GooglePayPasses" and
///  recipient = the issuer id: a root key from Google signs an intermediate
///  key, the intermediate key signs the message, both with ECDSA P-256 over
///  SHA-256, and each signed string is the length-prefixed concatenation of
///  its components.
///
///  What a verified event proves: Google says an object of yours was saved
///  to, or removed from, some Google account. What it does not prove: who
///  that account belongs to (no account identity is included), that the
///  pass is on a device right now (delivery is best effort and events can
///  arrive late or out of order), or anything about on-chain entitlement.
///  Use it for display state (a "saved" badge, counting installs, tidying
///  stores), never for authorization.

export const GOOGLE_PAY_PASSES_SENDER_ID = "GooglePayPasses" as const;
export const CALLBACK_PROTOCOL_VERSION = "ECv2SigningOnly" as const;
export const GOOGLE_ROOT_KEYS_URL = "https://pay.google.com/gp/m/issuer/keys" as const;

/// One of Google's root signing keys, as served at GOOGLE_ROOT_KEYS_URL.
export interface GoogleRootKey {
  /// Base64 DER SubjectPublicKeyInfo of a P-256 key.
  keyValue: string;
  protocolVersion: string;
  /// Epoch milliseconds, as a string.
  keyExpiration: string;
}

export interface GoogleRootKeys {
  keys: GoogleRootKey[];
  /// How long the set may be cached, when known (from Cache-Control max-age).
  maxAgeSeconds?: number;
}

/// The signed envelope Google POSTs.
export interface SignedCallbackBody {
  protocolVersion: string;
  signature: string;
  intermediateSigningKey: { signedKey: string; signatures: string[] };
  signedMessage: string;
}

export type CallbackEventType = "save" | "del";

export interface CallbackEvent {
  classId: string;
  objectId: string;
  eventType: CallbackEventType;
  /// Epoch milliseconds the message stops being valid.
  expTimeMillis: number;
  /// Random per message. Deduplicate on it (see `nonceStore`).
  nonce: string;
  /// Any further members Google adds, untouched.
  raw: Record<string, unknown>;
}

export type CallbackRefusal =
  | "invalid_body" // not the JSON envelope
  | "unsupported_protocol" // protocolVersion is not ECv2SigningOnly
  | "keys_unavailable" // the root keys could not be fetched
  | "intermediate_key_unverified" // no root key signs the intermediate key
  | "intermediate_key_expired" // the intermediate key's keyExpiration has passed
  | "signature_invalid" // the intermediate key does not sign the message (for this recipient)
  | "message_invalid" // signedMessage is not the JSON Google sends
  | "message_expired" // expTimeMillis has passed
  | "nonce_replayed"; // this nonce was already accepted

export type CallbackVerification = { ok: true; event: CallbackEvent } | { ok: false; reason: CallbackRefusal; detail?: string };

/// Where accepted nonces are remembered for deduplication. Structurally a
///  subset of `@erc8426/issuer`'s `KeyValueStore` (Redis SET NX EX), so the
///  same store serves both; `set` returns false when the key already exists.
export interface CallbackNonceStore {
  set(key: string, value: string, options: { ttlSeconds: number; onlyIfAbsent: true }): Promise<boolean>;
}

/// An in-process nonce store, for one instance.
export function memoryCallbackNonceStore(options: { now?: () => number; maxEntries?: number } = {}): CallbackNonceStore {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 100_000;
  const seen = new Map<string, number>();
  return {
    async set(key, _value, opts) {
      const t = now();
      for (const [k, exp] of seen) if (t >= exp) seen.delete(k);
      if (seen.has(key)) return false;
      seen.set(key, t + opts.ttlSeconds * 1000);
      while (seen.size > maxEntries) {
        const eldest = seen.keys().next().value;
        if (eldest === undefined) break;
        seen.delete(eldest);
      }
      return true;
    },
  };
}

export interface CallbackVerifierOptions {
  /// The numeric issuer id: the recipient id every message is signed for.
  issuerId: string;
  /// Supplies Google's root keys. Default: GET GOOGLE_ROOT_KEYS_URL with
  ///  `fetch`. Tests inject their own.
  fetchKeys?: () => Promise<GoogleRootKeys>;
  fetch?: typeof fetch;
  /// How long a fetched key set is reused when the response names no
  ///  max-age. Default 3600.
  keyCacheSeconds?: number;
  /// Clock, epoch milliseconds. Default Date.now.
  now?: () => number;
  /// Remember accepted nonces until the message would have expired, so a
  ///  redelivered callback is refused as `nonce_replayed`. Default: none,
  ///  the caller deduplicates.
  nonceStore?: CallbackNonceStore;
  /// Advisory findings that do not refuse (an unexpected User-Agent).
  ///  Default console.warn.
  onWarning?(message: string): void;
}

export interface CallbackVerifier {
  readonly issuerId: string;
  verify(bodyText: string, headers?: Headers | Record<string, string | string[] | undefined>): Promise<CallbackVerification>;
}

/// Tink's signed-string encoding: each component as its UTF-8 byte length
///  (4 bytes, little endian) followed by the bytes, concatenated.
export function toSignedString(...components: string[]): Uint8Array {
  const parts = components.map((c) => new TextEncoder().encode(c));
  const total = parts.reduce((n, p) => n + 4 + p.byteLength, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const p of parts) {
    view.setUint32(offset, p.byteLength, true);
    offset += 4;
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function publicKeyFrom(keyValueBase64: string): KeyObject | null {
  try {
    return createPublicKey({ key: Buffer.from(keyValueBase64, "base64"), format: "der", type: "spki" });
  } catch {
    return null;
  }
}

function verifies(key: KeyObject, data: Uint8Array, signatureBase64: string): boolean {
  try {
    return verifySignature("sha256", data, { key, dsaEncoding: "der" }, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

function headerValue(headers: Headers | Record<string, string | string[] | undefined> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

/// Parse the max-age of a Cache-Control header, or undefined.
export function maxAgeOf(cacheControl: string | null | undefined): number | undefined {
  const m = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl ?? "");
  return m ? Number(m[1]) : undefined;
}

function defaultKeyFetcher(doFetch: typeof fetch): () => Promise<GoogleRootKeys> {
  return async () => {
    const res = await doFetch(GOOGLE_ROOT_KEYS_URL, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Google root keys answered ${res.status}`);
    const body = (await res.json()) as { keys?: unknown };
    if (!Array.isArray(body.keys)) throw new Error("Google root keys body has no keys array");
    const maxAgeSeconds = maxAgeOf(res.headers.get("cache-control"));
    return { keys: body.keys as GoogleRootKey[], ...(maxAgeSeconds !== undefined ? { maxAgeSeconds } : {}) };
  };
}

export function createCallbackVerifier(options: CallbackVerifierOptions): CallbackVerifier {
  if (!/^[0-9]+$/.test(options.issuerId)) throw new Error(`issuerId must be the numeric Google Wallet issuer id, got "${options.issuerId}"`);
  const now = options.now ?? Date.now;
  const warn = options.onWarning ?? ((m: string) => console.warn(m));
  const fetchKeys = options.fetchKeys ?? defaultKeyFetcher(options.fetch ?? ((input, init) => globalThis.fetch(input, init)));
  const keyCacheMs = (options.keyCacheSeconds ?? 3600) * 1000;

  // The root key set, fetched once and reused until its max-age (or the
  // configured TTL) passes. Concurrent callers share one fetch.
  let cached: { keys: KeyObject[]; expiresAt: number } | null = null;
  let pending: Promise<KeyObject[]> | null = null;
  async function rootKeys(): Promise<KeyObject[]> {
    if (cached && now() < cached.expiresAt) return cached.keys;
    pending ??= (async () => {
      try {
        const set = await fetchKeys();
        const t = now();
        const keys: KeyObject[] = [];
        for (const k of set.keys) {
          if (k.protocolVersion !== CALLBACK_PROTOCOL_VERSION) continue;
          if (Number(k.keyExpiration) <= t) continue;
          const key = publicKeyFrom(k.keyValue);
          if (key) keys.push(key);
        }
        cached = { keys, expiresAt: t + (set.maxAgeSeconds !== undefined ? set.maxAgeSeconds * 1000 : keyCacheMs) };
        return keys;
      } finally {
        pending = null;
      }
    })();
    return pending;
  }

  return {
    issuerId: options.issuerId,
    async verify(bodyText, headers) {
      const ua = headerValue(headers, "user-agent");
      if (ua !== undefined && !/Googlebot|Google-Valuables/i.test(ua)) {
        warn(`[erc8426/google] Wallet callback from an unexpected User-Agent "${ua}": verifying the signature anyway`);
      }

      let body: SignedCallbackBody;
      try {
        const parsed: unknown = JSON.parse(bodyText);
        if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "invalid_body" };
        body = parsed as SignedCallbackBody;
      } catch {
        return { ok: false, reason: "invalid_body" };
      }
      if (
        typeof body.signature !== "string" ||
        typeof body.signedMessage !== "string" ||
        typeof body.intermediateSigningKey !== "object" ||
        body.intermediateSigningKey === null ||
        typeof body.intermediateSigningKey.signedKey !== "string" ||
        !Array.isArray(body.intermediateSigningKey.signatures)
      ) {
        return { ok: false, reason: "invalid_body" };
      }
      if (body.protocolVersion !== CALLBACK_PROTOCOL_VERSION) {
        return { ok: false, reason: "unsupported_protocol", detail: String(body.protocolVersion) };
      }

      let roots: KeyObject[];
      try {
        roots = await rootKeys();
      } catch (e) {
        return { ok: false, reason: "keys_unavailable", detail: (e as Error).message };
      }

      // The intermediate key: signed by a root key over (sender, protocol, signedKey).
      const signedKeyBytes = toSignedString(GOOGLE_PAY_PASSES_SENDER_ID, CALLBACK_PROTOCOL_VERSION, body.intermediateSigningKey.signedKey);
      const intermediateSigned = roots.some((root) =>
        body.intermediateSigningKey.signatures.some((sig) => typeof sig === "string" && verifies(root, signedKeyBytes, sig)),
      );
      if (!intermediateSigned) return { ok: false, reason: "intermediate_key_unverified" };
      let signedKey: { keyValue?: unknown; keyExpiration?: unknown };
      try {
        signedKey = JSON.parse(body.intermediateSigningKey.signedKey) as typeof signedKey;
      } catch {
        return { ok: false, reason: "intermediate_key_unverified", detail: "signedKey is not JSON" };
      }
      if (typeof signedKey.keyValue !== "string") return { ok: false, reason: "intermediate_key_unverified", detail: "signedKey has no keyValue" };
      if (Number(signedKey.keyExpiration) <= now()) return { ok: false, reason: "intermediate_key_expired" };
      const intermediate = publicKeyFrom(signedKey.keyValue);
      if (!intermediate) return { ok: false, reason: "intermediate_key_unverified", detail: "keyValue is not a P-256 public key" };

      // The message: signed by the intermediate key over (sender, recipient, protocol, message).
      const messageBytes = toSignedString(GOOGLE_PAY_PASSES_SENDER_ID, options.issuerId, CALLBACK_PROTOCOL_VERSION, body.signedMessage);
      if (!verifies(intermediate, messageBytes, body.signature)) return { ok: false, reason: "signature_invalid" };

      let raw: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(body.signedMessage);
        if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "message_invalid" };
        raw = parsed as Record<string, unknown>;
      } catch {
        return { ok: false, reason: "message_invalid" };
      }
      const { classId, objectId, eventType, nonce } = raw;
      const expTimeMillis = Number(raw.expTimeMillis);
      if (typeof classId !== "string" || typeof objectId !== "string" || typeof nonce !== "string" || nonce === "" || !Number.isFinite(expTimeMillis)) {
        return { ok: false, reason: "message_invalid" };
      }
      if (eventType !== "save" && eventType !== "del") return { ok: false, reason: "message_invalid", detail: `eventType ${String(eventType)}` };
      if (expTimeMillis <= now()) return { ok: false, reason: "message_expired" };

      if (options.nonceStore) {
        const ttlSeconds = Math.max(1, Math.ceil((expTimeMillis - now()) / 1000));
        const fresh = await options.nonceStore.set(`erc8426:google:callback:${options.issuerId}:${nonce}`, "1", { ttlSeconds, onlyIfAbsent: true });
        if (!fresh) return { ok: false, reason: "nonce_replayed" };
      }

      return { ok: true, event: { classId, objectId, eventType, expTimeMillis, nonce, raw } };
    },
  };
}

/// A WHATWG fetch handler for the callback URL: verifies the POST, hands the
///  event to `onEvent`, and answers 200 (Google retries anything else for a
///  while, so a refusal that would never pass answers 4xx, and a transient
///  one, no keys or a thrown handler, answers 503). Mount it on the path
///  named in the class's `callbackOptions.url`; serve it through
///  `toNodeHandler` from `@erc8426/issuer` on Node.
export function callbackHandler(verifier: CallbackVerifier, onEvent: (event: CallbackEvent, request: Request) => void | Promise<void>): (request: Request) => Promise<Response> {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  return async (request) => {
    if (request.method.toUpperCase() !== "POST") return json(405, { error: "method_not_allowed" });
    const text = await request.text();
    const result = await verifier.verify(text, request.headers);
    if (!result.ok) {
      const status = result.reason === "keys_unavailable" ? 503 : result.reason === "nonce_replayed" ? 200 : 400;
      return json(status, { ok: false, error: result.reason, ...(result.detail ? { detail: result.detail } : {}) });
    }
    try {
      await onEvent(result.event, request);
    } catch {
      return json(503, { ok: false, error: "handler_failed" });
    }
    return json(200, { ok: true });
  };
}
