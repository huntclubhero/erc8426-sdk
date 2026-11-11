import http2 from "node:http2";

import { importPKCS8, SignJWT } from "jose";

import type { DeviceRegistrationStore } from "./store.js";
import { MAX_PUSH_TOKENS_PER_PASS } from "./store.js";

/// APNs for Wallet passes. A pass update push goes to each registered push
///  token with the Pass Type ID as `apns-topic` and an empty `{}` payload; the
///  device then calls the web service for the fresh pass. A changed field that
///  has a `changeMessage` can raise a lock-screen line; several at once collapse
///  to a generic "Pass changed" (docs/platforms/apple.md, Lock-screen notifications).
///
/// Two ways to authenticate:
///  - certificate (mutual TLS with the Pass Type ID certificate and key).
///    This is the path both production deployments this package learned
///    from run, and the one Apple documents for Wallet.
///  - token (an ES256 JWT from an APNs .p8 key). Supported for providers who
///    only hold a .p8; verify it against your topic before relying on it,
///    because Apple has historically accepted only certificates for pass
///    type topics.
///
/// Wallet pass pushes use the production gateway even for development
///  passes, so `production` defaults to true.

export interface PushOutcome {
  token: string;
  ok: boolean;
  status?: number;
  /// APNs `reason`, for example "Unregistered", or a transport error.
  reason?: string;
  /// How many times this push was sent before it settled to this outcome.
  attempts?: number;
  /// On a failure: whether pushing again LATER can land. True for a push
  ///  that got no answer, a 429, a 5xx and a stale provider token; false for
  ///  an answer a resend cannot change (400, other 403s, 404, 405, 410, 413).
  ///  A queue-backed caller re-pushes the serial when any outcome carries
  ///  `retryable: true`.
  retryable?: boolean;
  /// With `retryable: true`: how long to wait before pushing again, in
  ///  seconds. 900 for a 5xx is Apple's figure; the others are this SDK's
  ///  suggestions (see `APNS_RETRY_AFTER_SECONDS`).
  retryAfterSeconds?: number;
}

/// Bounded resend of a push inside one `send`. OFF unless `retry` is given.
///  Only a push that got no HTTP answer at all (a failed connect, a stream
///  error or timeout) is resent, plus one resend after a stale provider
///  token. A 429 and a 5xx are never resent here: Apple describes a 429 as
///  too many consecutive requests to one device token, to be retried "with a
///  delay", and asks for 15 minutes before retrying a 5xx. Both settle with
///  `retryable: true` and a suggested delay for the caller's queue.
export interface ApnsRetryOptions {
  /// Total sends per push token, the first included. Default 3.
  attempts?: number;
  /// Delay before the second send; it doubles for each one after. Default 500.
  baseDelayMs?: number;
  /// Ceiling for one delay. Default 5000.
  maxDelayMs?: number;
  /// No resend starts later than this after the first attempt settled.
  ///  Default 10000. A resend already started still runs to its own connect
  ///  and stream timeouts, so the most a failing `send` is lengthened by is
  ///  `maxAddedMs + connectTimeoutMs + streamTimeoutMs` (25 seconds with the
  ///  defaults).
  maxAddedMs?: number;
}

export const DEFAULT_APNS_RETRY = { attempts: 3, baseDelayMs: 500, maxDelayMs: 5_000, maxAddedMs: 10_000 } as const;

/// Suggested waits before pushing again, by kind of failure. `serverError`
///  is Apple's ("After 15 minutes, you can retry ... 5XX") and
///  `providerTokenUpdates` follows Apple's "no more than once every 20
///  minutes". Apple gives no figure for `TooManyRequests` ("retry with a
///  delay") or for a push that got no answer: those two are this SDK's choice.
export const APNS_RETRY_AFTER_SECONDS = { noAnswer: 30, tooManyRequests: 60, providerTokenUpdates: 1200, serverError: 900 } as const;

/// What Apple's documentation ("Handling notification responses from APNs")
///  supports about sending a push again, by its outcome:
///  - "now": may be resent after a short delay. No HTTP answer at all, or a
///    403 `ExpiredProviderToken` (the client has dropped its cached token, so
///    the next send carries a new one). A pass push is an empty payload that
///    tells the device to ask the web service, so a duplicate costs the
///    device one list call.
///  - "later": not at once, but a later push can land. Any 429 (Apple: too
///    many requests for the same device token, and 4xx answers slow a
///    provider's sending) and any 5xx (Apple: retry after 15 minutes).
///  - "never": a resend cannot change the answer (400, other 403s, 404, 405,
///    410, 413), or the push landed.
export function apnsRetryAdvice(outcome: PushOutcome): "now" | "later" | "never" {
  if (outcome.ok) return "never";
  if (outcome.status === undefined || outcome.status === 0) return "now";
  if (outcome.status === 403) return outcome.reason === "ExpiredProviderToken" ? "now" : "never";
  if (outcome.status === 429 || outcome.status >= 500) return "later";
  return "never";
}

function retryAfterSecondsFor(outcome: PushOutcome): number {
  if (outcome.status === 429) {
    return outcome.reason === "TooManyProviderTokenUpdates" ? APNS_RETRY_AFTER_SECONDS.providerTokenUpdates : APNS_RETRY_AFTER_SECONDS.tooManyRequests;
  }
  if (outcome.status !== undefined && outcome.status >= 500) return APNS_RETRY_AFTER_SECONDS.serverError;
  return APNS_RETRY_AFTER_SECONDS.noAnswer;
}

export interface ApnsTokenAuth {
  keyId: string;
  teamId: string;
  /// Contents of the AuthKey_<keyId>.p8 file (PKCS#8 PEM).
  privateKeyP8: string;
}

export interface ApnsCertificateAuth {
  certificate: { cert: string | Uint8Array; key: string | Uint8Array; passphrase?: string };
}

export type ApnsClientOptions = (ApnsTokenAuth | ApnsCertificateAuth) & {
  /// Defaults to true (api.push.apple.com).
  production?: boolean;
  /// Override the gateway origin, for example a local test server.
  origin?: string;
  /// Extra TLS or HTTP/2 options for the connection (a test CA, for example).
  connectOptions?: http2.SecureClientSessionOptions;
  /// The Pass Type ID, used as `apns-topic`. Required for pushPassUpdate.
  passTypeIdentifier?: string;
  /// Where pushPassUpdate reads push tokens, and where a 410 removes them.
  store?: DeviceRegistrationStore;
  connectTimeoutMs?: number;
  streamTimeoutMs?: number;
  idleCloseMs?: number;
  /// Resend a push that got no answer (see `ApnsRetryOptions`). Off by
  ///  default: without it every push is sent exactly once, as before 0.4.0,
  ///  and a lost push stays lost unless the caller pushes again. Give an
  ///  object to turn it on; a member left out or undefined takes its default.
  retry?: ApnsRetryOptions | false;
  /// Diagnostic hook: session drops, non-200 answers, token refreshes.
  onEvent?(event: { type: string; detail?: string; token?: string; status?: number }): void;
};

export interface ApnsClient {
  /// Push an empty payload to each token. Never rejects: every token settles
  ///  to exactly one outcome, after the bounded resends of `retry`. A failed
  ///  outcome says whether a later push can land (`retryable`).
  send(pushTokens: string[], options?: { topic?: string }): Promise<PushOutcome[]>;
  /// Push to every device registered for this serial, and drop tokens APNs
  ///  answers 410 Unregistered for. Safe to call again for the same serial:
  ///  it is how a caller re-pushes after a `retryable` failure, and it
  ///  reaches superseded registrations for as long as the store returns them.
  pushPassUpdate(serial: string): Promise<PushOutcome[]>;
  /// Close the held session.
  close(): void;
  /// Sessions opened so far, for observability and tests.
  readonly connects: number;
}

/// Apple rejects a provider token older than an hour and throttles refreshes
///  more often than every twenty minutes, so a token is reused for 50.
const JWT_TTL_MS = 50 * 60_000;

export function createApnsClient(options: ApnsClientOptions): ApnsClient {
  const production = options.production ?? true;
  const origin = options.origin ?? (production ? "https://api.push.apple.com:443" : "https://api.sandbox.push.apple.com:443");
  const connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
  const streamTimeoutMs = options.streamTimeoutMs ?? 10_000;
  const idleCloseMs = options.idleCloseMs ?? 10 * 60_000;
  const emit = options.onEvent ?? (() => undefined);
  const asked = options.retry ? options.retry : null;
  const retry = {
    attempts: asked?.attempts ?? DEFAULT_APNS_RETRY.attempts,
    baseDelayMs: asked?.baseDelayMs ?? DEFAULT_APNS_RETRY.baseDelayMs,
    maxDelayMs: asked?.maxDelayMs ?? DEFAULT_APNS_RETRY.maxDelayMs,
    maxAddedMs: asked?.maxAddedMs ?? DEFAULT_APNS_RETRY.maxAddedMs,
  };
  const maxAttempts = asked ? Math.max(1, Math.floor(retry.attempts)) : 1;
  const tokenAuth = "privateKeyP8" in options ? options : null;
  const certAuth = "certificate" in options ? options.certificate : null;

  // ONE SESSION, REUSED. Apple asks providers to keep the connection open and
  // multiplex; connecting per push is the pattern they throttle, and each
  // connect is a TLS handshake (mutual, in certificate mode) on the event loop.
  // The session is retired on error, close, GOAWAY, a stalled stream (the only
  // symptom of a socket that died without a FIN), or a quiet spell.
  let session: http2.ClientHttp2Session | null = null;
  let connecting: Promise<http2.ClientHttp2Session> | null = null;
  let activeBatches = 0;
  let connects = 0;

  let jwtCache: { value: string; mintedAt: number } | null = null;
  let keyPromise: ReturnType<typeof importPKCS8> | null = null;

  async function providerToken(): Promise<string> {
    if (!tokenAuth) throw new Error("no token auth configured");
    if (jwtCache && Date.now() - jwtCache.mintedAt < JWT_TTL_MS) return jwtCache.value;
    if (!keyPromise) {
      keyPromise = importPKCS8(tokenAuth.privateKeyP8, "ES256");
      keyPromise.catch(() => {
        keyPromise = null;
      });
    }
    const key = await keyPromise;
    const mintedAt = Date.now();
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: tokenAuth.keyId })
      .setIssuer(tokenAuth.teamId)
      .setIssuedAt(Math.floor(mintedAt / 1000))
      .sign(key);
    jwtCache = { value, mintedAt };
    emit({ type: "provider_token_minted" });
    return value;
  }

  function usable(s: http2.ClientHttp2Session | null): s is http2.ClientHttp2Session {
    return Boolean(s && !s.closed && !s.destroyed);
  }

  function dropSession(why: string, s: http2.ClientHttp2Session): void {
    if (session === s) {
      session = null;
      emit({ type: "session_dropped", detail: why });
    }
    try {
      s.close();
    } catch {
      /* already gone */
    }
  }

  function connect(): Promise<http2.ClientHttp2Session> {
    if (usable(session)) return Promise.resolve(session);
    if (connecting) return connecting;
    connecting = new Promise<http2.ClientHttp2Session>((resolve, reject) => {
      const client = http2.connect(origin, {
        ...options.connectOptions,
        // No custom `ca` by default: the system store verifies Apple's server
        // certificate. The WWDR intermediate issues OUR client certificate and
        // is not Apple's server chain; passing it as `ca` breaks verification.
        ...(certAuth
          ? {
              cert: typeof certAuth.cert === "string" ? certAuth.cert : Buffer.from(certAuth.cert),
              key: typeof certAuth.key === "string" ? certAuth.key : Buffer.from(certAuth.key),
              ...(certAuth.passphrase ? { passphrase: certAuth.passphrase } : {}),
            }
          : {}),
      });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        client.destroy();
        reject(new Error(`APNs connect timed out after ${connectTimeoutMs}ms`));
      }, connectTimeoutMs);
      // Attached at once: an http2 session with no error listener crashes the
      // process on its first socket error.
      client.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          client.destroy();
          reject(err);
          return;
        }
        dropSession(`error: ${String(err)}`, client);
      });
      client.once("connect", () => {
        if (settled) {
          client.destroy();
          return;
        }
        settled = true;
        clearTimeout(timer);
        connects += 1;
        session = client;
        client.on("close", () => dropSession("close", client));
        client.on("goaway", () => dropSession("goaway", client));
        client.setTimeout(idleCloseMs, () => dropSession("idle", client));
        if (activeBatches === 0) client.unref();
        resolve(client);
      });
    }).finally(() => {
      connecting = null;
    });
    return connecting;
  }

  function pushOnSession(
    client: http2.ClientHttp2Session,
    tokens: string[],
    topic: string,
    auth: string | null,
  ): Promise<{ outcomes: PushOutcome[]; sessionDead: string[] }> {
    const outcomes: PushOutcome[] = [];
    const sessionDead: string[] = [];
    return Promise.all(
      tokens.map(
        (token) =>
          new Promise<void>((resolve) => {
            let req: http2.ClientHttp2Stream;
            try {
              req = client.request({
                ":method": "POST",
                ":path": `/3/device/${token}`,
                "apns-topic": topic,
                "apns-push-type": "background",
                "apns-priority": "5",
                "content-type": "application/json",
                ...(auth ? { authorization: `bearer ${auth}` } : {}),
              });
            } catch (err) {
              // The session died between the check and this call. No stream
              // exists, so nothing was sent and a retry cannot double-push.
              dropSession(`request failed: ${String(err)}`, client);
              sessionDead.push(token);
              resolve();
              return;
            }
            let status = 0;
            let body = "";
            let settled = false;
            const settle = (o: PushOutcome) => {
              if (settled) return;
              settled = true;
              outcomes.push(o);
              resolve();
            };
            req.on("response", (headers) => {
              status = Number(headers[":status"] ?? 0);
            });
            req.setEncoding("utf8");
            req.on("data", (chunk: string) => {
              if (body.length < 4096) body += chunk;
            });
            req.on("end", () => {
              if (status === 200) return settle({ token, ok: true, status });
              let reason = body;
              try {
                reason = (JSON.parse(body) as { reason?: string }).reason ?? body;
              } catch {
                /* keep raw */
              }
              emit({ type: "push_rejected", token, status, detail: reason });
              settle({ token, ok: false, status, reason });
            });
            req.on("error", (err) => {
              settle({ token, ok: false, reason: err.message });
              if (client.closed || client.destroyed) dropSession(`stream error: ${err.message}`, client);
            });
            req.setTimeout(streamTimeoutMs, () => {
              settle({ token, ok: false, reason: "stream timeout" });
              req.close(http2.constants.NGHTTP2_CANCEL);
              dropSession("stream timeout", client);
            });
            req.end("{}");
          }),
      ),
    ).then(() => ({ outcomes, sessionDead }));
  }

  async function send(pushTokens: string[], sendOpts: { topic?: string } = {}): Promise<PushOutcome[]> {
    const topic = sendOpts.topic ?? options.passTypeIdentifier;
    if (!topic) throw new Error("APNs topic required: pass the Pass Type ID as passTypeIdentifier or topic");
    const tokens = [...new Set(pushTokens)];
    if (tokens.length === 0) return [];
    const settled: PushOutcome[] = [];
    const settle = (outcome: PushOutcome, attempts: number) => {
      const advice = apnsRetryAdvice(outcome);
      settled.push({
        ...outcome,
        attempts,
        ...(outcome.ok ? {} : advice === "never" ? { retryable: false } : { retryable: true, retryAfterSeconds: retryAfterSecondsFor(outcome) }),
      });
    };
    // The last outcome of each push still waiting for a resend.
    const waiting = new Map<string, PushOutcome>();
    // A stale provider token earns one resend per push, whatever `attempts` allows.
    const refreshed = new Set<string>();
    let firstSettledAt = 0;
    let pending = tokens;
    for (let attempt = 1; pending.length > 0; attempt++) {
      if (attempt > 1) {
        const delay = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 2));
        if (Date.now() - firstSettledAt + delay > retry.maxAddedMs) {
          for (const token of pending) settle(waiting.get(token)!, attempt - 1);
          break;
        }
        await new Promise((r) => setTimeout(r, delay));
      }
      const outcomes = await sendOnce(pending, topic);
      if (attempt === 1) firstSettledAt = Date.now();
      const again: string[] = [];
      for (const outcome of outcomes) {
        const staleToken = outcome.status === 403;
        if (apnsRetryAdvice(outcome) === "now" && attempt < maxAttempts && !(staleToken && refreshed.has(outcome.token))) {
          if (staleToken) refreshed.add(outcome.token);
          emit({ type: "push_retry", token: outcome.token, status: outcome.status, detail: outcome.reason });
          waiting.set(outcome.token, outcome);
          again.push(outcome.token);
        } else {
          settle(outcome, attempt);
        }
      }
      pending = again;
    }
    return settled;
  }

  /// One pass over the tokens: every token gets at most one stream.
  async function sendOnce(tokens: string[], topic: string): Promise<PushOutcome[]> {
    activeBatches += 1;
    const held: http2.ClientHttp2Session[] = [];
    try {
      const results: PushOutcome[] = [];
      let pending = tokens;
      // Attempt 0 may land on a held session Apple just retired; attempt 1 is
      // a fresh one. Only tokens that never got a stream are retried.
      for (let attempt = 0; attempt < 2 && pending.length > 0; attempt++) {
        let client: http2.ClientHttp2Session;
        let auth: string | null = null;
        try {
          client = await connect();
          if (tokenAuth) auth = await providerToken();
        } catch (err) {
          const reason = `connect: ${err instanceof Error ? err.message : String(err)}`;
          for (const token of pending) results.push({ token, ok: false, reason });
          pending = [];
          break;
        }
        client.ref();
        held.push(client);
        const { outcomes, sessionDead } = await pushOnSession(client, pending, topic, auth);
        // A rejected provider token is dropped so the next batch mints a new
        // one, rather than failing for the rest of its cached life.
        if (auth && outcomes.some((o) => o.status === 403 && /ProviderToken/.test(o.reason ?? ""))) {
          if (jwtCache?.value === auth) jwtCache = null;
        }
        results.push(...outcomes);
        pending = sessionDead;
      }
      for (const token of pending) results.push({ token, ok: false, reason: "session closed before the stream opened" });
      return results;
    } finally {
      activeBatches -= 1;
      if (activeBatches === 0) for (const s of held) if (!s.destroyed) s.unref();
    }
  }

  async function pushPassUpdate(serial: string): Promise<PushOutcome[]> {
    const store = options.store;
    const passType = options.passTypeIdentifier;
    if (!store || !passType) throw new Error("pushPassUpdate needs both store and passTypeIdentifier");
    // A conforming store returns at most the live set plus as many recently superseded
    // registrations; this bounds the work even for one that does not (newest last, as
    // the memory store orders them).
    const all = await store.pushTokensForSerial(passType, serial);
    const tokens = all.length > MAX_PUSH_TOKENS_PER_PASS ? all.slice(-MAX_PUSH_TOKENS_PER_PASS) : all;
    const outcomes = await send(tokens, { topic: passType });
    // 410: the device removed the pass (or the token is no longer valid for
    // the topic). Pushing it again is wasted work that Apple counts against us.
    await Promise.all(outcomes.filter((o) => o.status === 410).map((o) => store.removePushToken(o.token)));
    return outcomes;
  }

  return {
    send,
    pushPassUpdate,
    close() {
      if (session) dropSession("closed by caller", session);
    },
    get connects() {
      return connects;
    },
  };
}
