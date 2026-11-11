import { PKPASS_MEDIA_TYPE } from "@erc8426/core";

import { createHash } from "node:crypto";

import { retiredAtFor, retiredReasonFor, type ApplePassRecord, type ApplePassStore } from "./store.js";
import { readJsonCapped, responseBody, safeEqual } from "./util.js";

/// Apple's PassKit Web Service as one Fetch API handler, so it mounts in any
///  runtime that speaks Request and Response (Node 20+, Next.js route
///  handlers, Hono, Bun, Workers with a node:crypto shim). Apple calls these
///  routes under the pass's `webServiceURL`:
///
///    POST   /v1/devices/:device/registrations/:passTypeId/:serial   register
///    DELETE /v1/devices/:device/registrations/:passTypeId/:serial   unregister
///    GET    /v1/devices/:device/registrations/:passTypeId           updated serials
///    GET    /v1/passes/:passTypeId/:serial                          latest pass
///    POST   /v1/log                                                 device log

/// Which token a request authenticated with.
export type PassAuthResult = "current" | "retired" | null;

export interface BuildPassArgs {
  serial: string;
  record: ApplePassRecord;
  /// True when the device presented a retired token: the holder's pass was
  ///  superseded by a transfer or a reset, so serve a rendering that says so
  ///  and carries no live links.
  retired: boolean;
  /// The token to embed. For a retired request this is the retired token the
  ///  device presented, never the current one, which would hand the previous
  ///  holder the new holder's credential.
  authenticationToken: string;
}

export interface PassKitWebServiceOptions {
  store: ApplePassStore;
  passTypeIdentifier: string;
  /// Produce the signed .pkpass bytes for a refresh.
  buildPass(args: BuildPassArgs): Promise<Uint8Array>;
  /// Override token checking. The default compares the presented token, in
  ///  constant time, against the record's current and retired tokens.
  authenticate?(args: { serial: string; token: string; record: ApplePassRecord }): Promise<PassAuthResult> | PassAuthResult;
  /// Path prefix the handler is mounted under, matching the path part of
  ///  `webServiceURL`, for example "/wallet/apple". Defaults to "".
  basePath?: string;
  /// Receives sanitized device log lines. The log route is unauthenticated
  ///  by Apple's design, so lines are capped in count and length and stripped
  ///  of control characters before they reach you.
  onLog?(lines: string[]): void;
}

/// Body caps. The log route is unauthenticated by Apple's design, so its
///  body is bounded before it is parsed; a registration body is one push
///  token and needs far less.
export const MAX_LOG_BODY_BYTES = 16 * 1024;
export const MAX_REGISTRATION_BODY_BYTES = 1024;
const MAX_LOG_ENTRIES = 20;
const MAX_LOG_CHARS = 300;
/// Apple push tokens are hex; bound the length so the store never holds junk.
const PUSH_TOKEN_RE = /^[0-9a-fA-F]{32,200}$/;
// Apple's device library identifier is a hex string; this also admits test ids. Bounded and path-safe.
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function empty(status: number, headers?: Record<string, string>): Response {
  return new Response(null, { status, headers });
}

export function defaultAuthenticate(token: string, record: ApplePassRecord): PassAuthResult {
  if (safeEqual(record.authenticationToken, token)) return "current";
  // Every retired token is compared, with no early exit on a match position
  // that would leak which generation the caller holds.
  let retired = false;
  for (const t of record.retiredAuthenticationTokens) if (safeEqual(t, token)) retired = true;
  return retired ? "retired" : null;
}

/// The entity tag of the pass a token is served. It is derived from the same
///  value that drives `Last-Modified` and the 304 decision, the record's
///  `updatedAt` (at its full millisecond resolution), so the two validators
///  cannot disagree about whether the record changed; and from the token, so
///  a tag is only ever good for the pass that token is entitled to. A retired
///  token's superseded rendering has a tag of its own (it also covers why and
///  when the token was retired), which the live pass's tag never equals.
///  Like `Last-Modified`, the tag follows the record: a change to how passes
///  are rendered that leaves the record untouched does not change it, so
///  push such a change with `notifyUpdate`, which touches the record.
export function passEtag(record: ApplePassRecord, token: string, retired: boolean): string {
  const parts = retired
    ? ["superseded", record.serial, token, String(record.updatedAt.getTime()), retiredReasonFor(record, token) ?? "", String(retiredAtFor(record, token) ?? "")]
    : ["current", record.serial, token, String(record.updatedAt.getTime())];
  return `"${createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32)}"`;
}

/// RFC 9110, 13.1.2: `If-None-Match` carries a list of entity tags, compared
///  weakly (a `W/` prefix is ignored). The `*` form is deliberately not
///  honoured: it claims "any representation", and a device holding the live
///  pass under a token since retired would be told 304 and keep it.
function noneMatchHolds(header: string, etag: string): boolean {
  return header.split(",").some((candidate) => candidate.trim().replace(/^W\//, "") === etag);
}

export function applePassKitWebService(opts: PassKitWebServiceOptions): (request: Request) => Promise<Response> {
  const base = (opts.basePath ?? "").replace(/\/+$/, "");

  async function auth(req: Request, serial: string): Promise<{ result: PassAuthResult; record: ApplePassRecord | null; token: string }> {
    const m = /^ApplePass\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
    if (!m) return { result: null, record: null, token: "" };
    const token = m[1]!;
    const record = await opts.store.getPass(serial);
    // Unknown serials answer exactly like a wrong token, so the endpoint is
    // not an oracle for which serials exist.
    if (!record) return { result: null, record: null, token };
    const result = opts.authenticate ? await opts.authenticate({ serial, token, record }) : defaultAuthenticate(token, record);
    return { result, record, token };
  }

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    let path = url.pathname;
    if (base) {
      if (!path.startsWith(`${base}/`)) return empty(404);
      path = path.slice(base.length);
    }
    const seg = path.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
    if (seg[0] !== "v1") return empty(404);
    const method = req.method.toUpperCase();

    // POST /v1/log
    if (seg.length === 2 && seg[1] === "log") {
      if (method !== "POST") return empty(405);
      const parsed = await readJsonCapped(req, MAX_LOG_BODY_BYTES);
      if (parsed === "too_large") return empty(413);
      const body = parsed as { logs?: unknown } | null;
      const logs = Array.isArray(body?.logs) ? body.logs : [];
      const safe = logs
        .slice(0, MAX_LOG_ENTRIES)
        .filter((l): l is string => typeof l === "string")
        // eslint-disable-next-line no-control-regex
        .map((l) => l.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_LOG_CHARS));
      if (safe.length) opts.onLog?.(safe);
      return empty(200);
    }

    // /v1/devices/:device/registrations/:passTypeId[/:serial]
    if (seg[1] === "devices" && seg[3] === "registrations" && (seg.length === 5 || seg.length === 6)) {
      const device = seg[2]!;
      const passType = seg[4]!;
      if (passType !== opts.passTypeIdentifier) return empty(404);
      if (!DEVICE_ID_RE.test(device)) return empty(400);

      if (seg.length === 5) {
        if (method !== "GET") return empty(405);
        const sinceRaw = url.searchParams.get("passesUpdatedSince");
        const since = sinceRaw && /^[0-9]+$/.test(sinceRaw) ? Number(sinceRaw) : null;
        const serials = await opts.store.serialsForDevice(device, passType);
        if (serials.length === 0) return empty(204);
        const records = (await Promise.all(serials.map((s) => opts.store.getPass(s)))).filter(
          (r): r is ApplePassRecord => r !== null,
        );
        // The tag is opaque to Apple and echoed back as passesUpdatedSince. It
        // is milliseconds so two updates inside one second are not merged.
        const changed = records.filter((r) => since === null || r.updatedAt.getTime() > since);
        if (changed.length === 0) return empty(204);
        const lastUpdated = Math.max(...records.map((r) => r.updatedAt.getTime()));
        return Response.json({ serialNumbers: changed.map((r) => r.serial), lastUpdated: String(lastUpdated) });
      }

      const serial = seg[5]!;
      if (method === "POST") {
        // Registration needs the CURRENT token: a superseded pass cannot attach
        // new devices to the serial it no longer represents.
        const a = await auth(req, serial);
        if (a.result !== "current") return empty(401);
        const parsed = await readJsonCapped(req, MAX_REGISTRATION_BODY_BYTES);
        if (parsed === "too_large") return empty(413);
        const body = parsed as { pushToken?: unknown } | null;
        const pushToken = body?.pushToken;
        if (typeof pushToken !== "string" || !PUSH_TOKEN_RE.test(pushToken)) return empty(400);
        const created = await opts.store.register({ deviceLibraryIdentifier: device, passTypeIdentifier: passType, serial, pushToken });
        // At the cap a new device is refused, never let in by evicting another (store.ts).
        if (created === "full") return empty(403);
        return empty(created ? 201 : 200);
      }
      if (method === "DELETE") {
        // A superseded pass may still unregister its own device.
        const a = await auth(req, serial);
        if (!a.result) return empty(401);
        await opts.store.unregister(device, passType, serial);
        return empty(200);
      }
      return empty(405);
    }

    // GET /v1/passes/:passTypeId/:serial
    if (seg[1] === "passes" && seg.length === 4) {
      if (method !== "GET") return empty(405);
      const passType = seg[2]!;
      const serial = seg[3]!;
      if (passType !== opts.passTypeIdentifier) return empty(404);
      const a = await auth(req, serial);
      if (!a.result || !a.record) return empty(401);
      const record = a.record;
      const retired = a.result === "retired";
      // HTTP dates have one-second resolution, so compare at that grain.
      const modifiedSec = Math.floor(record.updatedAt.getTime() / 1000);
      const etag = passEtag(record, a.token, retired);
      const validators = { ETag: etag, "Last-Modified": record.updatedAt.toUTCString() };
      // RFC 9110, 13.2.2: when If-None-Match is present it is evaluated and
      // If-Modified-Since is ignored. The tag is bound to the token, so a
      // device that still holds the live pass under a token since retired
      // never matches the superseded rendering it is now owed.
      const noneMatch = req.headers.get("if-none-match");
      const since = req.headers.get("if-modified-since");
      if (noneMatch !== null) {
        if (noneMatchHolds(noneMatch, etag)) return empty(304, validators);
      } else if (!retired && since) {
        const sinceMs = Date.parse(since);
        if (Number.isFinite(sinceMs) && modifiedSec <= Math.floor(sinceMs / 1000)) {
          return empty(304, validators);
        }
      }
      const bytes = await opts.buildPass({ serial, record, retired, authenticationToken: a.token });
      return new Response(responseBody(bytes), {
        status: 200,
        headers: {
          "Content-Type": PKPASS_MEDIA_TYPE,
          ...validators,
          "Cache-Control": "no-store",
        },
      });
    }

    return empty(404);
  };
}
