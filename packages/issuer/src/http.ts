import { isAddress, isAddressEqual, type Address, type Hex } from "viem";
import {
  ACQUIRE_ACTION,
  PROOF_HEADER_NAMES,
  ROTATE_ACTION,
  normalizeTokenId,
  parseChallenge,
  readProofHeaders,
  type AuthError,
  type ControlProof,
  type PassFileProvider,
} from "@erc8426/core";

import { defaultConfirmPage, resultPage, withLinkPageHeaders } from "./capability.js";
import type { AuthorizeInput } from "./authorize.js";
import { normalizeOrigin, type ActionDefinition, type LinkPageContext } from "./config.js";
import type { EntitlementResult } from "./entitlement.js";
import type { RateLimitRule } from "./rateLimit.js";
import { RepeatCoalescer, errorCodeOf, memoryRepeatStore, sha256Hex, type RecordedOutcome } from "./repeat.js";
import { ActionError, IssuerError, statusForIssuerError, type IssuerErrorCode } from "./errors.js";
import type { IssuerInternals } from "./issuer.js";

/// The HTTP surface, on the WHATWG Fetch API so one handler serves Next.js
///  route handlers, Hono, Bun, Deno, Cloudflare Workers and (through node.ts)
///  Node and Express. Routes, under basePath:
///
///    GET  /:tokenId                   manifest (public or gated)
///    GET  /:tokenId/challenge         fresh challenge (?address=&action=)
///    POST /:tokenId/actions/:action   signed action
///    POST /:tokenId/rotate            signed rotation on owner request
///    GET  /links/:link                describe a capability link (no effect)
///    POST /links/:link                perform a capability link's action
///    GET  /passes/:link               download a pass file (file providers)
///    HEAD /passes/:link               the same checks and headers, no body
///
///  Every response is `Cache-Control: no-store`: clients MUST NOT durably
///  cache acquisition URLs, and a challenge is single-use.

/// Largest request body read before authentication, in bytes.
export const MAX_BODY_BYTES = 64 * 1024;
/// Largest proof header accepted, in characters. A SIWE challenge is well
///  under 2 KiB; base64url adds a third.
const MAX_PROOF_HEADER_CHARS = 8 * 1024;

type Json = Record<string, unknown>;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function wantsHtml(request: Request): boolean {
  return (request.headers.get("Accept") ?? "").includes("text/html");
}

/// A path segment as a token id, or null. normalizeTokenId refuses anything
///  outside uint256 (and an over-long string before parsing it).
function parseTokenId(segment: string): string | null {
  try {
    return normalizeTokenId(segment);
  } catch {
    return null;
  }
}

/// Read the body with a running byte count and stop past MAX_BODY_BYTES, so
///  an anonymous request cannot make the issuer buffer an unbounded body
///  (a chunked body carries no Content-Length to refuse up front).
async function readText(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(joined);
  } catch {
    return null;
  }
}

async function readBody(request: Request): Promise<Json | null> {
  const text = await readText(request);
  if (text === null) return null;
  return parseBodyText(request, text);
}

/// The body text as a JSON object (or a form), or null when it is neither.
function parseBodyText(request: Request, text: string): Json | null {
  if (text.trim() === "") return {};
  if ((request.headers.get("Content-Type") ?? "").includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
  } catch {
    return null;
  }
}

type ProofRead = { kind: "absent" } | { kind: "malformed" } | { kind: "present"; proof: ControlProof };

/// A proof from the proof headers (the Gated acquisition transport, under
///  the RFC 6648 names or the X- names), or, for POST routes, from a JSON
///  body `{ message, signature }`.
function proofHeadersTooLarge(headers: Headers): boolean {
  return PROOF_HEADER_NAMES.some((name) => (headers.get(name)?.length ?? 0) > MAX_PROOF_HEADER_CHARS);
}

function readProof(request: Request, body: Json | null): ProofRead {
  if (proofHeadersTooLarge(request.headers)) return { kind: "malformed" };
  const fromHeaders = readProofHeaders(request.headers);
  if (fromHeaders.kind !== "absent") return fromHeaders.kind === "present" ? fromHeaders : { kind: "malformed" };
  if (!body || (body.message === undefined && body.signature === undefined)) return { kind: "absent" };
  const { message, signature } = body;
  if (typeof message !== "string" || typeof signature !== "string" || !/^0x([0-9a-fA-F]{2})+$/.test(signature)) {
    return { kind: "malformed" };
  }
  return { kind: "present", proof: { message, signature: signature as Hex } };
}

export function createRouter(x: IssuerInternals): (request: Request) => Promise<Response | null> {
  const { config } = x;
  // Identical repeats of a POST get the first outcome (repeat.ts). The key
  // covers the link or nonce and a hash of every byte that matters, so only
  // a presentation that differs from the first is a new request (or, on the
  // nonce path, a replay).
  // Every rate-limit and repeat key starts with the collection the issuer
  // serves, so two issuers sharing one kvRateLimiter or kvRepeatStore (and
  // their default prefixes) never read or count each other's rows.
  const scope = `${config.chainId}:${config.contract.toLowerCase()}`;
  const repeats = config.repeat ? new RepeatCoalescer(config.repeat.store ?? memoryRepeatStore({ now: x.now }), config.repeat.windowSeconds) : null;
  async function coalesce(key: string | null, run: () => Promise<Response>, recordIf?: (outcome: RecordedOutcome) => boolean): Promise<Response> {
    if (!repeats || key === null) return run();
    const { response, repeated } = await repeats.run(key, run, recordIf);
    if (repeated) response.headers.set("X-Wallet-Pass-Repeat", "true");
    return response;
  }
  // The bytes that make two POSTs the same request: the body and the media
  // type it was sent as (the same text parses differently as JSON, a form or
  // plain text).
  const bodyHash = (request: Request, text: string) => sha256Hex(`${(request.headers.get("content-type") ?? "").toLowerCase()}\n${text}`);
  // On the signed route an outcome is recorded only once the nonce was
  // spent: a refusal before that point (no challenge, wrong verifier, an
  // unknown or spent nonce) costs the issuer nothing to re-judge and would
  // otherwise let anonymous garbage fill the repeat store.
  const NOT_SPENT = new Set(["invalid_message", "domain_mismatch", "nonce_invalid"]);
  const recordIfNonceSpent = (outcome: RecordedOutcome) => {
    const code = errorCodeOf(outcome);
    return code === undefined || !NOT_SPENT.has(code);
  };

  function error(code: IssuerErrorCode, extra: Json = {}): Response {
    const status = statusForIssuerError(code);
    // A failed fresh read is retryable and never a verdict on the account.
    const headers: Record<string, string> = status === 503 ? { "Retry-After": String(config.retryAfterSeconds) } : {};
    return json(status, { error: code, ...extra }, headers);
  }

  // Refuse a proof that failed the floor. Every 401 carries the challenge
  // URI, since the client's next step is the same fresh challenge. A 403
  // means only one thing: a verified proof from a non-entitled account.
  function refuse(authError: AuthError, challenge: string): Response {
    return statusForIssuerError(authError) === 401 ? error(authError, { challenge }) : error(authError);
  }

  function corsHeaders(request: Request): Record<string, string> {
    const cors = config.cors;
    if (!cors) return {};
    const origin = request.headers.get("Origin");
    let allow: string;
    if (cors.origins === "*") allow = "*";
    else {
      const normalized = origin ? normalizeOrigin(origin) : null;
      if (normalized !== null && cors.origins.includes(normalized)) allow = origin!;
      else return {};
    }
    const h: Record<string, string> = { "Access-Control-Allow-Origin": allow, "Access-Control-Expose-Headers": "Retry-After, X-Wallet-Pass-Repeat" };
    if (allow !== "*") h["Vary"] = "Origin";
    return h;
  }

  function preflight(request: Request): Response {
    const cors = corsHeaders(request);
    if (Object.keys(cors).length === 0) return new Response(null, { status: 204 });
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        // The proof travels in these headers (new names and the X- names a
        // 0.2.x client sends), so a browser client can only resolve a gated
        // manifest if the preflight admits them.
        "Access-Control-Allow-Headers": `Content-Type, ${PROOF_HEADER_NAMES.join(", ")}`,
        "Access-Control-Max-Age": String(config.cors ? config.cors.maxAgeSeconds : 600),
      },
    });
  }

  // Count one attempt for `family` under the client and the path token, and
  // answer 429 rate_limited with Retry-After when it is over the limit. The
  // attempt is counted before any work, so a refused request costs the
  // issuer nothing but the count. Null when the request may proceed.
  async function throttle(request: Request, family: "challenge" | "manifest" | "capability" | "action" | "rotate", pathToken: string): Promise<Response | null> {
    const rule: RateLimitRule | false = config.rateLimit[family];
    const perClient = config.rateLimit.perClient;
    if (rule === false && perClient === false) return null;
    const client = config.rateLimit.clientKey(request) ?? "unknown";
    const now = x.now();
    // Two buckets: the client alone (so naming a new token id or link does
    // not start a fresh bucket) and the client with the path token (so one
    // token hammered from one place is bounded tighter still). The client
    // bucket is checked first, so a client past it costs one counter write.
    const perClientDecision = perClient === false ? null : await config.rateLimit.limiter.hit(`${scope}:${family}:client:${client}`, perClient, now);
    const decision =
      perClientDecision && !perClientDecision.allowed ? perClientDecision : rule === false ? null : await config.rateLimit.limiter.hit(`${scope}:${family}:${client}:${pathToken}`, rule, now);
    if (!decision || decision.allowed) return null;
    return json(429, { error: "rate_limited", message: `too many ${family} requests; retry after ${decision.retryAfterSeconds} s` }, { "Retry-After": String(decision.retryAfterSeconds) });
  }

  function methodNotAllowed(allow: string): Response {
    return json(405, { error: "method_not_allowed" }, { Allow: allow });
  }

  async function execute(
    def: ActionDefinition,
    input: { tokenId: string; action: string; account: Address; via: string; path: "signed" | "capability"; params: unknown; request: Request },
  ): Promise<Response> {
    try {
      const result = await def.execute({
        token: x.token(input.tokenId),
        action: input.action,
        account: input.account,
        via: input.via,
        path: input.path,
        params: input.params,
        request: input.request,
        notifyUpdate: async () => {
          await x.onPassUpdate(input.tokenId);
        },
      });
      return json(200, {
        ok: true,
        executed: true,
        action: input.action,
        tokenId: input.tokenId,
        account: input.account,
        via: input.via,
        result: result ?? null,
      });
    } catch (e) {
      if (e instanceof ActionError) return json(e.status, { error: e.code, message: e.message });
      x.onError(e, { operation: `action:${input.action}`, tokenId: input.tokenId });
      return error("action_failed");
    }
  }

  // GET {base}/:tokenId
  async function manifest(request: Request, tokenId: string): Promise<Response> {
    if (config.mode === "public") {
      // Public configuration: served to anyone, rendered for the current
      // owner by a fresh read. A holder change seen here is an observed
      // transfer, so recordIssuance rotates.
      let owner: Address | null;
      try {
        owner = await x.ownerOf(tokenId);
      } catch {
        return error("read_failed");
      }
      if (owner === null) return error("unknown_capability", { message: "token does not exist" });
      const record = await x.recordIssuance(tokenId, owner);
      return json(200, await x.buildManifest(record, owner));
    }

    // Gated configuration.
    const challenge = x.challengeUri(tokenId);
    if (proofHeadersTooLarge(request.headers)) return error("invalid_request", { message: "proof header too large" });
    const proof = readProofHeaders(request.headers);
    // No proof: 401, the challenge URI, and no acquisition URLs.
    if (proof.kind === "absent") return json(401, { error: "proof_required", challenge });
    if (proof.kind === "malformed") return error("invalid_request", { message: `proof headers could not be decoded (${proof.reason})` });
    // Only an acquire proof resolves the manifest: a proof for any other
    // action fails the binding check.
    const result = await x.authorize({ ...proof.proof, tokenId, action: ACQUIRE_ACTION });
    if (!result.ok) return refuse(result.error, challenge);
    // A first claim rotates before the manifest is built. Another entitled
    // account under an additive policy shares the holder of record's pass,
    // so the pass is always rendered for the holder of record.
    const record = await x.recordIssuance(tokenId, result.account);
    return json(200, await x.buildManifest(record, record.lastIssuedTo ?? result.account));
  }

  // GET {base}/:tokenId/challenge?address=&action=
  async function challenge(url: URL, tokenId: string): Promise<Response> {
    const address = url.searchParams.get("address");
    if (!address || !isAddress(address, { strict: false })) {
      return error("invalid_request", { message: "the address query parameter must be a valid account address" });
    }
    try {
      return json(200, await x.issueChallenge({ tokenId, account: address, action: url.searchParams.get("action") ?? ACQUIRE_ACTION }));
    } catch (e) {
      if (e instanceof IssuerError) return error(e.code, { message: e.message });
      throw e;
    }
  }

  // POST {base}/:tokenId/actions/:action
  async function signedAction(request: Request, tokenId: string, action: string): Promise<Response> {
    // acquire and rotate are never registered actions, so an acquire proof
    // can never be spent here, and a rotate proof only on the rotate route.
    const def = Object.hasOwn(config.actions, action) ? config.actions[action] : undefined;
    if (!def) return error("unknown_action", { message: `unknown action: ${action}` });
    const text = await readText(request);
    if (text === null) return error("invalid_request", { message: "body must be a JSON object" });
    const body = parseBodyText(request, text);
    if (body === null) return error("invalid_request", { message: "body must be a JSON object" });
    const challengeUri = x.challengeUri(tokenId, action);
    const proof = readProof(request, body);
    if (proof.kind === "absent") return json(401, { error: "proof_required", challenge: challengeUri });
    if (proof.kind === "malformed") return error("invalid_request", { message: "the proof could not be decoded" });
    // Keyed by the nonce, every byte of the presentation, and the fresh
    // entitlement read for the claimed account: an identical repeat (the
    // phone resending an aborted POST) gets the first outcome instead of
    // nonce_invalid, but once ownership has changed the read differs, so
    // the repeat is a new request and is judged afresh. A different request
    // carrying the same nonce keys differently and is refused by the floor
    // as the replay it is. The read is taken once: authorize reuses it.
    const parsed = parseChallenge(proof.proof.message);
    const nonce = parsed?.nonce ?? "-";
    let freshRead: AuthorizeInput["freshRead"];
    let readKey = "unread";
    if (parsed) {
      try {
        const result = await x.entitled(tokenId, parsed.address, action);
        freshRead = { account: parsed.address, result };
        readKey = result.entitled ? `${result.via}:${parsed.address.toLowerCase()}` : "none";
      } catch {
        // Left to authorize, which spends the nonce and answers read_failed.
      }
    }
    const key = `${scope}:nonce:${tokenId}:${action}:${nonce}:${readKey}:${await sha256Hex(`${proof.proof.message}\n${proof.proof.signature}\n`)}:${await bodyHash(request, text)}`;
    return coalesce(
      key,
      async () => {
        const result = await x.authorize({ ...proof.proof, tokenId, action, ...(freshRead ? { freshRead } : {}) });
        if (!result.ok) return refuse(result.error, challengeUri);
        return execute(def, { tokenId, action, account: result.account, via: result.via, path: "signed", params: body.params, request });
      },
      recordIfNonceSpent,
    );
  }

  // POST {base}/:tokenId/rotate
  async function rotate(request: Request, tokenId: string): Promise<Response> {
    const body = await readBody(request);
    if (body === null) return error("invalid_request", { message: "body must be a JSON object" });
    const challengeUri = x.challengeUri(tokenId, ROTATE_ACTION);
    const proof = readProof(request, body);
    if (proof.kind === "absent") return json(401, { error: "proof_required", challenge: challengeUri });
    if (proof.kind === "malformed") return error("invalid_request", { message: "the proof could not be decoded" });
    // A rotate proof, and only a rotate proof, with its own fresh read.
    const result = await x.authorize({ ...proof.proof, tokenId, action: ROTATE_ACTION });
    if (!result.ok) return refuse(result.error, challengeUri);
    // Rotation retires the holder's links, so the prover must be the holder
    // of record or entitled to acquire right now. An account entitled to
    // rotate but excluded from acquire (an owner during an exclusive rental)
    // cannot use it to disturb the renter's pass.
    const holder = await x.holderOf(tokenId);
    if (!holder || !isAddressEqual(holder, result.account)) {
      let entitled;
      try {
        entitled = await x.entitled(tokenId, result.account, ACQUIRE_ACTION);
      } catch {
        return error("read_failed");
      }
      if (!entitled.entitled) return error("not_owner");
    }
    // The response never carries the manifest: a proof for any other action
    // MUST NOT resolve it. The holder re-adds the new pass with an acquire
    // proof, and the holder of record is unchanged.
    await x.rotateOnRequest(tokenId);
    return json(200, { ok: true, rotated: true });
  }

  // Resolve an action link: capability configuration only, current links
  // only, actions still registered as capability actions only.
  async function resolveActionLink(linkToken: string) {
    if (config.mode !== "gated" || !config.capability.enabled) return null;
    const resolved = await x.resolveLink(linkToken, "action");
    if (!resolved) return null;
    const def = config.actions[resolved.binding.name];
    if (!def || !config.capabilityActions.includes(resolved.binding.name)) return null;
    return { ...resolved, def };
  }

  // GET {base}/links/:link. Side-effect free: no read, no execution, no
  // state change. Devices, previewers and crawlers prefetch pass links.
  // Every answer, page or JSON, built in or custom, carries the link page
  // headers (no-store, noindex, no-referrer, frame-ancestors 'none').
  async function describeLink(request: Request, linkToken: string): Promise<Response> {
    const resolved = await resolveActionLink(linkToken);
    if (!resolved) return withLinkPageHeaders(error("unknown_capability"));
    const { binding, def } = resolved;
    const ctx: LinkPageContext = {
      token: x.token(binding.tokenId),
      action: binding.name,
      description: def.description,
      bound: def.bound ?? "",
      postUrl: x.linkUrl(linkToken),
      request,
    };
    if (config.capability.confirmPage) return withLinkPageHeaders(await config.capability.confirmPage(ctx));
    if (wantsHtml(request)) return withLinkPageHeaders(defaultConfirmPage(ctx));
    return withLinkPageHeaders(
      json(200, {
        tokenId: binding.tokenId,
        action: binding.name,
        description: def.description,
        bound: def.bound,
        method: "POST",
        executed: false,
      }),
    );
  }

  // POST {base}/links/:link. The capability URL stands in for check (1);
  // check (2), the fresh entitlement read of the holder the link was issued
  // to, runs unconditionally.
  async function followLink(request: Request, linkToken: string): Promise<Response> {
    const text = await readText(request);
    if (text === null) return error("invalid_request", { message: "body must be a JSON object or a form" });
    // The fresh read wins: the link is resolved and check (2), the fresh
    // entitlement read of the holder it was issued to, is taken BEFORE the
    // repeat store is consulted. A link that no longer resolves is refused
    // here; a read that cannot be taken is 503 here, untouched by the store.
    // The key carries the link, its binding, the holder and the read's
    // result, plus a hash of the body, so a recorded answer is never served
    // once the binding changed or ownership moved: a repeat after a transfer
    // is a new request and meets the fresh read (403 not_owner), while the
    // phone resending an aborted POST, same body and same world, runs the
    // action once and gets one answer twice. A body that differs in any
    // byte (the confirm page's per-tap `attempt` field) is a new request.
    const resolved = await resolveActionLink(linkToken);
    if (!resolved) return error("unknown_capability");
    const { binding, record, def } = resolved;
    const holder = record.lastIssuedTo;
    let entitled: EntitlementResult | null = null;
    if (holder) {
      try {
        entitled = await x.entitled(binding.tokenId, holder, binding.name);
      } catch {
        return error("read_failed");
      }
    }
    const readKey = entitled?.entitled ? `${entitled.via}:${holder!.toLowerCase()}` : "none";
    const key = `${scope}:link:${linkToken}:${binding.tokenId}:${binding.name}:${binding.generation}:${record.serial}:${holder ?? "-"}:${readKey}:${await bodyHash(request, text)}`;
    return coalesce(key, async () => {
      const body = parseBodyText(request, text);
      if (body === null) return error("invalid_request", { message: "body must be a JSON object or a form" });
      // The link decides the action. A request naming another is refused, as
      // a proof for action A is refused for action B.
      if (body.action !== undefined && body.action !== binding.name) return error("binding_mismatch");
      // A link minted since a transfer and not yet issued to anyone authorizes
      // no one. It is not a verified non-entitled account, so not a 403.
      if (!holder || !entitled) return error("unknown_capability");
      // A sold token behind a still-live link stops acting here, before any
      // rotation catches up. What this does NOT close is forwarding under an
      // unchanged owner: the residual the capability configuration discloses.
      if (!entitled.entitled) return error("not_owner");
      return execute(def, {
        tokenId: binding.tokenId,
        action: binding.name,
        account: holder,
        via: entitled.via,
        path: "capability",
        params: body.params,
        request,
      });
    });
  }

  // GET {base}/passes/:link. A file provider's pass, at a rotating
  // capability URL, re-checked against a fresh entitlement read.
  async function download(linkToken: string): Promise<Response> {
    const resolved = await x.resolveLink(linkToken, "download");
    if (!resolved || !resolved.record.lastIssuedTo) return error("unknown_capability");
    const { binding, record } = resolved;
    const provider = x.providers.find((p) => p.format === binding.name) as PassFileProvider | undefined;
    if (!provider || typeof provider.passFile !== "function") return error("unknown_capability");
    const holder = record.lastIssuedTo!;
    let entitled;
    try {
      entitled = await x.entitled(record.tokenId, holder, ACQUIRE_ACTION);
    } catch {
      return error("read_failed");
    }
    if (!entitled.entitled) return error("not_owner");
    const content = await x.renderContent(record, holder, false);
    const file = await provider.passFile({ token: x.token(record.tokenId), owner: holder, content });
    const headers: Record<string, string> = { "Content-Type": file.contentType, "Cache-Control": "no-store" };
    if (file.filename) headers["Content-Disposition"] = `attachment; filename="${file.filename.replace(/["\\\r\n]/g, "")}"`;
    return new Response(typeof file.body === "string" ? file.body : new Uint8Array(file.body), { status: 200, headers });
  }

  // For a browser that posted the confirm page's form, answer with a page.
  async function asHtml(request: Request, response: Response): Promise<Response> {
    if (!wantsHtml(request)) return response;
    const body = (await response.clone().json().catch(() => ({}))) as Json;
    const message = response.ok ? "The action ran." : typeof body.message === "string" ? body.message : String(body.error ?? "Refused");
    const page = resultPage(response.ok, message, response.status);
    const retry = response.headers.get("Retry-After");
    if (retry) page.headers.set("Retry-After", retry);
    return withLinkPageHeaders(page);
  }

  async function dispatch(request: Request, url: URL, segments: string[]): Promise<Response> {
    const method = request.method.toUpperCase();
    const [first, second, third] = segments;
    if (first === undefined) return error("unknown_capability");

    if (first === "links" && segments.length === 2) {
      if (method !== "GET" && method !== "POST") return methodNotAllowed("GET, POST, OPTIONS");
      const limited = await throttle(request, "capability", second!);
      if (limited) return method === "POST" ? asHtml(request, limited) : withLinkPageHeaders(limited);
      if (method === "GET") return describeLink(request, second!);
      return asHtml(request, await followLink(request, second!));
    }
    if (first === "passes" && segments.length === 2) {
      // HEAD lets a client (or the conformance suite) check the pkpass media
      // type before downloading; it runs the same checks as GET.
      if (method !== "GET" && method !== "HEAD") return methodNotAllowed("GET, HEAD, OPTIONS");
      const limited = await throttle(request, "capability", second!);
      if (limited) return method === "HEAD" ? new Response(null, { status: limited.status, headers: limited.headers }) : limited;
      if (method === "GET") return download(second!);
      const res = await download(second!);
      return new Response(null, { status: res.status, headers: res.headers });
    }

    const tokenId = parseTokenId(first);
    if (tokenId === null) return error("invalid_request", { message: `invalid token id: ${first}` });

    if (segments.length === 1) {
      if (method !== "GET") return methodNotAllowed("GET, OPTIONS");
      return (await throttle(request, "manifest", tokenId)) ?? manifest(request, tokenId);
    }
    if (segments.length === 2 && second === "challenge") {
      if (method !== "GET") return methodNotAllowed("GET, OPTIONS");
      return (await throttle(request, "challenge", tokenId)) ?? challenge(url, tokenId);
    }
    if (segments.length === 2 && second === "rotate") {
      if (method !== "POST") return methodNotAllowed("POST, OPTIONS");
      return (await throttle(request, "rotate", tokenId)) ?? rotate(request, tokenId);
    }
    if (segments.length === 3 && second === "actions") {
      if (method !== "POST") return methodNotAllowed("POST, OPTIONS");
      return (await throttle(request, "action", tokenId)) ?? signedAction(request, tokenId, third!);
    }
    return error("unknown_capability");
  }

  return async function route(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const base = config.basePath;
    if (base !== "" && url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return null;

    let response: Response;
    try {
      const segments = url.pathname
        .slice(base.length)
        .split("/")
        .filter((s) => s !== "")
        .map((s) => decodeURIComponent(s));
      response = request.method.toUpperCase() === "OPTIONS" ? preflight(request) : await dispatch(request, url, segments);
    } catch (e) {
      if (e instanceof URIError) {
        response = error("invalid_request", { message: "malformed path" });
      } else if (e instanceof IssuerError) {
        response = error(e.code, { message: e.message });
      } else {
        x.onError(e, { operation: `${request.method} ${url.pathname}` });
        response = error("internal_error");
      }
    }

    // Re-wrap so headers are mutable whatever produced the response (a
    // custom confirm page may return a fetched one), then add CORS.
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(corsHeaders(request))) headers.set(k, v);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}
