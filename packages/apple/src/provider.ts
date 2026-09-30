import {
  FORMAT_APPLE,
  PKPASS_MEDIA_TYPE,
  type PassContent,
  type PassContext,
  type PassFile,
  type PassFileProvider,
  type PassFormatProvider,
} from "@erc8426/core";

import type { ApnsClient, PushOutcome } from "./apns.js";
import type { ImageFetchOptions } from "./images.js";
import { buildPkpass, type AppleCertificates } from "./pkpass.js";
import { MemoryApplePassStore, newPassRecord, rotatedRecord, type ApplePassRecord, type ApplePassStore } from "./store.js";
import { hmacHex, responseBody, safeEqual } from "./util.js";
import { applePassKitWebService, type BuildPassArgs } from "./webservice.js";

/// The Apple format provider: the issuer's `apple` manifest entry, the
///  download route that serves it, the PassKit web service that keeps it
///  current, and APNs pushes when content changes.

export interface AppleFormatProviderOptions {
  passTypeIdentifier: string;
  teamIdentifier: string;
  certificates: AppleCertificates;
  /// The issuer origin, for example "https://issuer.example". Acquisition
  ///  URLs and the web service live here. The spec asks that pass endpoints
  ///  share an origin with the collection's published web presence.
  origin: string;
  /// Where `handle` is mounted. Defaults to "/apple", outside the issuer's "/wallet-pass" route tree so the two never overlap.
  basePath?: string;
  /// Server-only secret, at least 32 bytes, that standalone download
  ///  capabilities are derived with. Kept out of the store on purpose: a
  ///  read-only dump of the store alone must not yield working download URLs.
  ///  Not needed with @erc8426/issuer, which hosts the file from passFile at
  ///  its own rotating capability URL; required for acquisitionUrl and
  ///  handleDownload.
  linkSecret?: string | Uint8Array;
  store?: ApplePassStore;
  /// Pushes pass updates. Without it passes still refresh on pull.
  apns?: ApnsClient;
  /// Fallback images (collection icon and logo) for content without them.
  images?: PassContent["images"];
  imageFetch?: ImageFetchOptions;
  sharingProhibited?: boolean;
  /// How a superseded pass renders for a device still holding a retired
  ///  token. Defaults to `supersededContent`.
  supersede?(content: PassContent): PassContent;
  /// Called with push outcomes; a push failure never fails the caller.
  onPush?(serial: string, outcomes: PushOutcome[] | Error): void;
}

/// Implements both delivery shapes. With @erc8426/issuer the issuer calls
///  passFile and hosts the download itself, and only `webService` needs
///  mounting. Standalone, acquisitionUrl returns a capability URL this
///  provider serves through `handle`.
export interface AppleFormatProvider extends PassFormatProvider, PassFileProvider {
  readonly format: typeof FORMAT_APPLE;
  /// The signed .pkpass for this context, after the same owner sync as
  ///  acquisitionUrl (a new owner rotates the token and pushes the previous
  ///  holder their superseded pass).
  passFile(ctx: PassContext): Promise<PassFile>;
  notifyUpdate(ctx: PassContext): Promise<void>;
  /// Routes both the download capability and the PassKit web service.
  handle(request: Request): Promise<Response>;
  /// Only the download route (`<basePath>/passes/<serial>/<capability>.pkpass`).
  handleDownload(request: Request): Promise<Response>;
  /// Only the PassKit web service (`<basePath>/v1/...`).
  webService(request: Request): Promise<Response>;
  /// Rotate a pass's token on the owner's request, for integrators without
  ///  the issuer. Every installed copy, a leaked one included, refreshes into
  ///  the superseded rendering and can no longer register devices, and every
  ///  download URL dies. Pass the re-rendered content (with your freshly
  ///  rotated links) as `content`, or the owner's fresh pass would carry the
  ///  leaked links again. Returns the new download URL when `linkSecret` is
  ///  set. Under an unchanged owner this is the only remedy for a leaked
  ///  link, so the spec makes it mandatory in the capability configuration.
  ///  (The issuer does this itself: it mints a new serial and supersedes the
  ///  old one, which arrives here as voided content.)
  rotate(serial: string, content?: PassContent): Promise<string | undefined>;
  /// The acquisition URL for a stored record.
  downloadUrl(record: ApplePassRecord): string;
  /// The base URL written into passes as `webServiceURL`, when https.
  readonly webServiceURL: string | undefined;
  readonly store: ApplePassStore;
}

/// Default rendering for a superseded pass, served to any device holding a
///  retired token. Keeps the identity of the card (title, art, colors,
///  header) and drops everything live: values, links, barcode, relevance.
///  Values are dropped rather than frozen because the record may now hold a
///  NEW holder's content, which a superseded copy must not keep receiving.
///  The wording claims only what is true in every case: this copy is
///  replaced and carries no live details or links.
export function supersededContent(content: PassContent): PassContent {
  return {
    serial: content.serial,
    style: content.style,
    organizationName: content.organizationName,
    description: content.description,
    title: content.title,
    colors: content.colors,
    images: content.images,
    header: content.header,
    primary: [{ key: "supersededStatus", label: "STATUS", value: "No longer current" }],
    back: [
      {
        key: "supersededNote",
        label: "This pass was replaced",
        value:
          "A newer pass replaced this one, after the token changed hands or its pass links were reset. This copy no longer shows live details or links. If you hold the token, add the current pass from the issuer.",
      },
    ],
    voided: true,
  };
}

/// Stable fingerprint of content, so an unchanged acquisition does not bump
///  `updatedAt` and trigger needless device refreshes.
function fingerprint(content: PassContent | undefined): string {
  if (!content) return "";
  return JSON.stringify(content, (_k, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v));
}

const DOWNLOAD_CONTEXT = "erc8426-pkpass-download-v1";

export function appleFormatProvider(opts: AppleFormatProviderOptions): AppleFormatProvider {
  if (opts.linkSecret !== undefined) {
    const secretLength = typeof opts.linkSecret === "string" ? Buffer.byteLength(opts.linkSecret) : opts.linkSecret.byteLength;
    if (secretLength < 32) throw new Error("linkSecret must be at least 32 bytes");
  }
  const origin = new URL(opts.origin).origin;
  const basePath = `/${(opts.basePath ?? "/apple").replace(/^\/+|\/+$/g, "")}`;
  // Apple only calls an https web service; an http origin (local dev) gets
  // passes that install but never update, rather than passes that fail.
  const webServiceURL = origin.startsWith("https://") ? `${origin}${basePath}` : undefined;
  const store = opts.store ?? new MemoryApplePassStore();
  const supersede = opts.supersede ?? supersededContent;
  const secret = opts.linkSecret === undefined ? null : typeof opts.linkSecret === "string" ? opts.linkSecret : Buffer.from(opts.linkSecret);

  /// The download capability is derived from the pass's current random token
  ///  under the server secret, so it rotates for free whenever the token does
  ///  and needs no table of its own.
  function capability(record: ApplePassRecord): string {
    if (!secret) throw new Error("linkSecret is required for standalone download URLs; with @erc8426/issuer use passFile instead");
    return hmacHex(secret, `${DOWNLOAD_CONTEXT}:${record.serial}:${record.authenticationToken}`);
  }

  function downloadUrl(record: ApplePassRecord): string {
    return `${origin}${basePath}/passes/${encodeURIComponent(record.serial)}/${capability(record)}.pkpass`;
  }

  async function build(record: ApplePassRecord, retired: boolean, authenticationToken: string): Promise<Uint8Array> {
    if (!record.content) throw new Error(`no stored content for serial ${record.serial}`);
    const content = retired ? supersede(record.content) : record.content;
    return buildPkpass(content, {
      passTypeIdentifier: opts.passTypeIdentifier,
      teamIdentifier: opts.teamIdentifier,
      certificates: opts.certificates,
      ...(webServiceURL ? { webServiceURL, authenticationToken } : {}),
      images: opts.images,
      imageFetch: opts.imageFetch,
      sharingProhibited: opts.sharingProhibited,
    });
  }

  async function push(serial: string): Promise<void> {
    if (!opts.apns) return;
    try {
      const outcomes = await opts.apns.pushPassUpdate(serial);
      opts.onPush?.(serial, outcomes);
    } catch (err) {
      opts.onPush?.(serial, err instanceof Error ? err : new Error(String(err)));
    }
  }

  /// Bring the stored record in line with the context. A different owner is
  ///  a transfer: the token rotates, so the previous holder's download URL
  ///  dies and their installed pass refreshes into the superseded rendering.
  ///  Content turning voided is a supersede (the issuer voids the old serial
  ///  when it mints a new one, on transfer or on the owner's rotation): the
  ///  token is retired the same way, so every copy of the old serial, a
  ///  leaked one included, can refresh into the voided card but can no
  ///  longer register a device or fetch anything live.
  async function sync(ctx: PassContext, forceTouch: boolean): Promise<{ record: ApplePassRecord; rotated: boolean }> {
    const serial = ctx.content.serial;
    const owner = ctx.owner.toLowerCase();
    let record = await store.getPass(serial);
    let rotated = false;
    if (!record) {
      record = newPassRecord(serial, owner);
    } else if (record.owner && record.owner !== owner) {
      record = rotatedRecord(record, owner);
      rotated = true;
    } else if (!record.owner) {
      record = { ...record, owner };
    }
    if (!rotated && ctx.content.voided && record.content && !record.content.voided) {
      record = rotatedRecord(record);
      rotated = true;
    }
    if (forceTouch || rotated || fingerprint(record.content) !== fingerprint(ctx.content)) {
      record = { ...record, content: ctx.content, updatedAt: new Date() };
    }
    await store.putPass(record);
    return { record, rotated };
  }

  const webService = applePassKitWebService({
    store,
    passTypeIdentifier: opts.passTypeIdentifier,
    basePath,
    buildPass: (args: BuildPassArgs) => build(args.record, args.retired, args.authenticationToken),
  });

  async function handleDownload(request: Request): Promise<Response> {
    // Issuer mode hosts downloads elsewhere; without a secret there is no
    // standalone route to serve.
    if (!secret) return new Response(null, { status: 404 });
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") return new Response(null, { status: 405 });
    const path = new URL(request.url).pathname;
    const prefix = `${basePath}/passes/`;
    if (!path.startsWith(prefix)) return new Response(null, { status: 404 });
    const m = /^([^/]+)\/([0-9a-f]{64})\.pkpass$/.exec(path.slice(prefix.length));
    if (!m) return new Response(null, { status: 404 });
    const serial = decodeURIComponent(m[1]!);
    const record = await store.getPass(serial);
    // Unknown serial and wrong capability are indistinguishable by design.
    if (!record || !record.content || !safeEqual(capability(record), m[2]!)) {
      return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    const headers = {
      "Content-Type": PKPASS_MEDIA_TYPE,
      "Content-Disposition": `attachment; filename="pass.pkpass"`,
      "Last-Modified": record.updatedAt.toUTCString(),
      "Cache-Control": "no-store",
    };
    if (method === "HEAD") return new Response(null, { status: 200, headers });
    const bytes = await build(record, false, record.authenticationToken);
    return new Response(responseBody(bytes), { status: 200, headers });
  }

  return {
    format: FORMAT_APPLE,
    store,
    webServiceURL,
    downloadUrl,
    webService,
    handleDownload,

    async handle(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (path.startsWith(`${basePath}/v1/`)) return webService(request);
      if (path.startsWith(`${basePath}/passes/`)) return handleDownload(request);
      return new Response(null, { status: 404 });
    },

    async passFile(ctx: PassContext): Promise<PassFile> {
      const { record, rotated } = await sync(ctx, false);
      if (rotated) await push(record.serial);
      const body = await build(record, false, record.authenticationToken);
      return { body, contentType: PKPASS_MEDIA_TYPE, filename: "pass.pkpass" };
    },

    async acquisitionUrl(ctx: PassContext): Promise<string> {
      const { record, rotated } = await sync(ctx, false);
      if (rotated) await push(record.serial);
      return downloadUrl(record);
    },

    async notifyUpdate(ctx: PassContext): Promise<void> {
      await sync(ctx, true);
      await push(ctx.content.serial);
    },

    async rotate(serial: string, content?: PassContent): Promise<string | undefined> {
      const record = await store.getPass(serial);
      if (!record) throw new Error(`unknown serial ${serial}`);
      const next = { ...rotatedRecord(record), ...(content ? { content } : {}) };
      await store.putPass(next);
      await push(serial);
      return secret ? downloadUrl(next) : undefined;
    },
  };
}
