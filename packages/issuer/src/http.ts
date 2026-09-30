import { isAddress, type Address, type Hex } from "viem";
import {
  ACQUIRE_ACTION,
  PROOF_HEADER,
  ROTATE_ACTION,
  SIGNATURE_HEADER,
  normalizeTokenId,
  readProofHeaders,
  type AuthError,
  type ControlProof,
  type PassFileProvider,
} from "@erc8426/core";

import { defaultConfirmPage, resultPage } from "./capability.js";
import type { ActionDefinition, LinkPageContext } from "./config.js";
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

const MAX_BODY_BYTES = 64 * 1024;
const UINT256_LIMIT = 1n << 256n;

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

function parseTokenId(segment: string): string | null {
  try {
    const id = normalizeTokenId(segment);
    return BigInt(id) < UINT256_LIMIT ? id : null;
  } catch {
    return null;
  }
}

async function readBody(request: Request): Promise<Json | null> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
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

/// A proof from the two headers (the Gated acquisition transport), or, for
///  POST routes, from a JSON body `{ message, signature }`.
function readProof(request: Request, body: Json | null): ProofRead {
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
    else if (origin && cors.origins.includes(origin)) allow = origin;
    else return {};
    const h: Record<string, string> = { "Access-Control-Allow-Origin": allow, "Access-Control-Expose-Headers": "Retry-After" };
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
        // The proof travels in these two headers, so a browser client can only
        // resolve a gated manifest if the preflight admits them.
        "Access-Control-Allow-Headers": `Content-Type, ${PROOF_HEADER}, ${SIGNATURE_HEADER}`,
        "Access-Control-Max-Age": String(config.cors ? config.cors.maxAgeSeconds : 600),
      },
    });
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
      if (owner === null) return error("not_found", { message: "token does not exist" });
      const record = await x.recordIssuance(tokenId, owner);
      return json(200, await x.buildManifest(record, owner));
    }

    // Gated configuration.
    const challenge = x.challengeUri(tokenId);
    const proof = readProofHeaders(request.headers);
    // No proof: 401, the challenge URI, and no acquisition URLs.
    if (proof.kind === "absent") return json(401, { error: "proof_required", challenge });
    if (proof.kind === "malformed") return error("malformed_proof", { message: `proof headers could not be decoded (${proof.reason})` });
    // Only an acquire proof resolves the manifest: a proof for any other
    // action fails the binding check.
    const result = await x.authorize({ ...proof.proof, tokenId, action: ACQUIRE_ACTION });
    if (!result.ok) return refuse(result.error, challenge);
    // A first claim rotates before the manifest is built.
    const record = await x.recordIssuance(tokenId, result.account);
    return json(200, await x.buildManifest(record, result.account));
  }

  // GET {base}/:tokenId/challenge?address=&action=
  async function challenge(url: URL, tokenId: string): Promise<Response> {
    const address = url.searchParams.get("address");
    if (!address || !isAddress(address, { strict: false })) {
      return error("invalid_address", { message: "the address query parameter must be a valid account address" });
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
    const body = await readBody(request);
    if (body === null) return error("invalid_request", { message: "body must be a JSON object" });
    const challengeUri = x.challengeUri(tokenId, action);
    const proof = readProof(request, body);
    if (proof.kind === "absent") return json(401, { error: "proof_required", challenge: challengeUri });
    if (proof.kind === "malformed") return error("malformed_proof");
    const result = await x.authorize({ ...proof.proof, tokenId, action });
    if (!result.ok) return refuse(result.error, challengeUri);
    return execute(def, { tokenId, action, account: result.account, via: result.via, path: "signed", params: body.params, request });
  }

  // POST {base}/:tokenId/rotate
  async function rotate(request: Request, tokenId: string): Promise<Response> {
    const body = await readBody(request);
    if (body === null) return error("invalid_request", { message: "body must be a JSON object" });
    const challengeUri = x.challengeUri(tokenId, ROTATE_ACTION);
    const proof = readProof(request, body);
    if (proof.kind === "absent") return json(401, { error: "proof_required", challenge: challengeUri });
    if (proof.kind === "malformed") return error("malformed_proof");
    // A rotate proof, and only a rotate proof; its fresh read means only the
    // entitled holder can retire the links.
    const result = await x.authorize({ ...proof.proof, tokenId, action: ROTATE_ACTION });
    if (!result.ok) return refuse(result.error, challengeUri);
    const record = await x.rotateOnRequest(tokenId, result.account);
    return json(200, { ok: true, rotated: true, ...(await x.buildManifest(record, result.account)) });
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
  async function describeLink(request: Request, linkToken: string): Promise<Response> {
    const resolved = await resolveActionLink(linkToken);
    if (!resolved) return error("link_invalid");
    const { binding, def } = resolved;
    const ctx: LinkPageContext = {
      token: x.token(binding.tokenId),
      action: binding.name,
      description: def.description,
      bound: def.bound ?? "",
      postUrl: x.linkUrl(linkToken),
      request,
    };
    if (config.capability.confirmPage) return config.capability.confirmPage(ctx);
    if (wantsHtml(request)) return defaultConfirmPage(ctx);
    return json(200, {
      tokenId: binding.tokenId,
      action: binding.name,
      description: def.description,
      bound: def.bound,
      method: "POST",
      executed: false,
    });
  }

  // POST {base}/links/:link. The capability URL stands in for check (1);
  // check (2), the fresh entitlement read of the holder the link was issued
  // to, runs unconditionally.
  async function followLink(request: Request, linkToken: string): Promise<Response> {
    const resolved = await resolveActionLink(linkToken);
    if (!resolved) return error("link_invalid");
    const { binding, record, def } = resolved;
    const body = await readBody(request);
    if (body === null) return error("invalid_request", { message: "body must be a JSON object or a form" });
    // The link decides the action. A request naming another is refused, as
    // a proof for action A is refused for action B.
    if (body.action !== undefined && body.action !== binding.name) return error("binding_mismatch");
    const holder = record.lastIssuedTo;
    // A link minted since a transfer and not yet issued to anyone authorizes
    // no one.
    if (!holder) return error("not_owner");
    let entitled;
    try {
      entitled = await x.entitled(binding.tokenId, holder, binding.name);
    } catch {
      return error("read_failed");
    }
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
  }

  // GET {base}/passes/:link. A file provider's pass, at a rotating
  // capability URL, re-checked against a fresh entitlement read.
  async function download(linkToken: string): Promise<Response> {
    const resolved = await x.resolveLink(linkToken, "download");
    if (!resolved || !resolved.record.lastIssuedTo) return error("link_invalid");
    const { binding, record } = resolved;
    const provider = x.providers.find((p) => p.format === binding.name) as PassFileProvider | undefined;
    if (!provider || typeof provider.passFile !== "function") return error("link_invalid");
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
    page.headers.set("Cache-Control", "no-store");
    return page;
  }

  async function dispatch(request: Request, url: URL, segments: string[]): Promise<Response> {
    const method = request.method.toUpperCase();
    const [first, second, third] = segments;
    if (first === undefined) return error("not_found");

    if (first === "links" && segments.length === 2) {
      if (method === "GET") return describeLink(request, second!);
      if (method === "POST") return asHtml(request, await followLink(request, second!));
      return methodNotAllowed("GET, POST, OPTIONS");
    }
    if (first === "passes" && segments.length === 2) {
      // HEAD lets a client (or the conformance suite) check the pkpass media
      // type before downloading; it runs the same checks as GET.
      if (method === "GET") return download(second!);
      if (method === "HEAD") {
        const res = await download(second!);
        return new Response(null, { status: res.status, headers: res.headers });
      }
      return methodNotAllowed("GET, HEAD, OPTIONS");
    }

    const tokenId = parseTokenId(first);
    if (tokenId === null) return error("invalid_token", { message: `invalid token id: ${first}` });

    if (segments.length === 1) {
      return method === "GET" ? manifest(request, tokenId) : methodNotAllowed("GET, OPTIONS");
    }
    if (segments.length === 2 && second === "challenge") {
      return method === "GET" ? challenge(url, tokenId) : methodNotAllowed("GET, OPTIONS");
    }
    if (segments.length === 2 && second === "rotate") {
      return method === "POST" ? rotate(request, tokenId) : methodNotAllowed("POST, OPTIONS");
    }
    if (segments.length === 3 && second === "actions") {
      return method === "POST" ? signedAction(request, tokenId, third!) : methodNotAllowed("POST, OPTIONS");
    }
    return error("not_found");
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
