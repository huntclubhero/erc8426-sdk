import { X509Certificate } from "node:crypto";

import type { BarcodeFormat, ImageSource, PassContent, PassField, PassLink, PassStyle } from "@erc8426/core";
import { PKPass } from "passkit-generator";

import { resolveImage, type ImageFetchOptions } from "./images.js";
import { passDate } from "./util.js";

/// Apple Wallet .pkpass building. `toPassJson` is the pure mapping from the
///  shared PassContent to pass.json; `buildPkpass` adds images and signs the
///  bundle with passkit-generator (manifest.json of SHA-1 digests plus a
///  detached PKCS#7 signature by the Pass Type ID certificate).

export interface AppleCertificates {
  /// The Pass Type ID certificate, PEM.
  signerCert: string | Uint8Array;
  /// Its private key, PEM. Encrypted keys need `signerKeyPassphrase`.
  signerKey: string | Uint8Array;
  signerKeyPassphrase?: string;
  /// Apple WWDR intermediate, PEM. Pass Type ID certificates issued today
  ///  chain to WWDR G4; a mismatched intermediate installs nowhere.
  wwdr: string | Uint8Array;
}

export interface PassJsonOptions {
  passTypeIdentifier: string;
  teamIdentifier: string;
  /// Base URL of the PassKit web service (Apple appends `/v1/...`). Omitted
  ///  when absent: a pass without it installs but can never update.
  webServiceURL?: string;
  /// Per-pass secret the device presents as `ApplePass <token>`. Required
  ///  with `webServiceURL`, at least 16 characters.
  authenticationToken?: string;
  /// Defaults to true, as both production deployments ship: a pass that
  ///  carries capability links should not be one tap from AirDrop.
  sharingProhibited?: boolean;
}

export interface BuildPkpassOptions extends PassJsonOptions {
  certificates: AppleCertificates;
  /// Images used when the content does not supply a slot, typically the
  ///  collection icon and logo. Apple refuses to open a pass without an icon.
  images?: PassContent["images"];
  imageFetch?: ImageFetchOptions;
}

const BARCODE_FORMATS: Record<BarcodeFormat, string> = {
  qr: "PKBarcodeFormatQR",
  pdf417: "PKBarcodeFormatPDF417",
  aztec: "PKBarcodeFormatAztec",
  code128: "PKBarcodeFormatCode128",
};

/// "#101418" or "#fff" to "rgb(16,20,24)". Apple documents the rgb() form;
///  hex happens to work on current iOS but is not promised.
export function hexToRgb(hex: string): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`invalid hex color: ${hex}`);
  let h = m[1]!;
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = Number.parseInt(h, 16);
  return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface AppleField {
  key: string;
  label?: string;
  value: string | number;
  changeMessage?: string;
  attributedValue?: string;
  dateStyle?: string;
  timeStyle?: string;
}

function field(f: PassField): AppleField {
  const out: AppleField = { key: f.key, label: f.label, value: f.value };
  if (f.changeMessage) out.changeMessage = f.changeMessage;
  return out;
}

/// A link on the pass back. The anchor in `attributedValue` is what makes it
///  tappable: Apple only auto-detects bare URLs in `value`, and a labelled
///  link reads better than a raw capability URL. `&` must be escaped inside
///  the href or the anchor is dropped.
function linkField(l: PassLink): AppleField {
  return {
    key: l.key,
    label: l.label,
    value: l.label,
    attributedValue: `<a href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a>`,
  };
}

const STYLE_KEY: Record<PassStyle, string> = {
  generic: "generic",
  eventTicket: "eventTicket",
  storeCard: "storeCard",
  coupon: "coupon",
  posterGeneric: "posterGeneric",
};

/// Apple's stated capacity of the iOS 27 poster face: one header field, up to
///  four primary fields, one visible footer. Overflow is dropped silently on the
///  device, so it is refused here instead, like a duplicate key.
const POSTER_MAX_HEADER = 1;
const POSTER_MAX_PRIMARY = 4;
const POSTER_MAX_FOOTER = 1;

/// Map PassContent to pass.json. Apple caps field counts per style and
///  silently drops overflow (a storeCard shows at most four secondary plus
///  auxiliary fields), so keep rows short rather than relying on truncation.
///
///  `posterGeneric` emits TWO dictionaries: `posterGeneric` (header, primary,
///  footer, back) and the legacy `posterFallback` style (default `generic`)
///  with the full field set, so iOS 26 and earlier render the legacy layout.
///  Wallet prefers the poster dictionary when it knows it. Needs
///  passkit-generator 3.6 or later at signing time: 3.5 strips the key.
export function toPassJson(content: PassContent, opts: PassJsonOptions): Record<string, unknown> {
  const style = content.style ?? "generic";
  if (content.footer?.length && style !== "posterGeneric") {
    throw new Error(`footer fields exist only on the posterGeneric style; "${style}" has no footer row and would drop them`);
  }
  const primary = (content.primary ?? []).map(field);
  const secondary = (content.secondary ?? []).map(field);
  const auxiliary = (content.auxiliary ?? []).map(field);
  const back = (content.back ?? []).map(field);

  if (content.event && style === "eventTicket") {
    if (primary.length === 0) primary.push({ key: "event", label: "EVENT", value: content.event.name });
    if (content.event.venue && !secondary.some((f) => f.key === "venue")) {
      secondary.push({ key: "venue", label: "VENUE", value: content.event.venue });
    }
    if (content.event.startsAt && !auxiliary.some((f) => f.key === "starts")) {
      auxiliary.push({
        key: "starts",
        label: "STARTS",
        value: passDate(content.event.startsAt),
        dateStyle: "PKDateStyleMedium",
        timeStyle: "PKDateStyleShort",
      });
    }
  }
  if (primary.length === 0 && content.headline) {
    primary.push({ key: "headline", label: "", value: content.headline });
  }

  const json: Record<string, unknown> = {
    formatVersion: 1,
    passTypeIdentifier: opts.passTypeIdentifier,
    teamIdentifier: opts.teamIdentifier,
    serialNumber: content.serial,
    organizationName: content.organizationName,
    description: content.description,
    logoText: content.title,
    sharingProhibited: opts.sharingProhibited ?? true,
  };
  if (opts.webServiceURL) {
    if (!opts.authenticationToken || opts.authenticationToken.length < 16) {
      throw new Error("webServiceURL requires an authenticationToken of at least 16 characters");
    }
    json.webServiceURL = opts.webServiceURL;
    json.authenticationToken = opts.authenticationToken;
  }
  if (content.colors) {
    json.backgroundColor = hexToRgb(content.colors.background);
    json.foregroundColor = hexToRgb(content.colors.foreground);
    if (content.colors.label) json.labelColor = hexToRgb(content.colors.label);
  }
  if (content.barcode) {
    json.barcodes = [
      {
        format: BARCODE_FORMATS[content.barcode.format],
        message: content.barcode.message,
        messageEncoding: "iso-8859-1",
        ...(content.barcode.altText ? { altText: content.barcode.altText } : {}),
      },
    ];
  }
  const relevant = content.relevantDate ?? (style === "eventTicket" ? content.event?.startsAt : undefined);
  if (relevant) json.relevantDate = passDate(relevant);
  if (content.expiresAt) json.expirationDate = passDate(content.expiresAt);
  if (content.voided) json.voided = true;
  if (content.locations?.length) {
    // Apple honours at most ten locations per pass.
    json.locations = content.locations.slice(0, 10).map((l) => ({
      latitude: l.latitude,
      longitude: l.longitude,
      ...(l.relevantText ? { relevantText: l.relevantText } : {}),
    }));
  }
  const fields = {
    headerFields: (content.header ?? []).map(field),
    primaryFields: primary,
    secondaryFields: secondary,
    auxiliaryFields: auxiliary,
    backFields: [...(content.links ?? []).map(linkField), ...back],
  };
  // Keys are unique across the WHOLE pass, links included. A duplicate is
  // dropped silently at signing time and the field never reaches the device,
  // so it is refused here instead.
  const seen = new Set<string>();
  for (const f of Object.values(fields).flat()) {
    if (seen.has(f.key)) throw new Error(`duplicate pass field key "${f.key}": keys must be unique across all fields and links`);
    seen.add(f.key);
  }
  if (style !== "posterGeneric") {
    json[STYLE_KEY[style]] = fields;
    return json;
  }

  const footer = (content.footer ?? []).map(field);
  for (const f of footer) {
    if (seen.has(f.key)) throw new Error(`duplicate pass field key "${f.key}": keys must be unique across all fields and links`);
    seen.add(f.key);
  }
  if (fields.headerFields.length > POSTER_MAX_HEADER) {
    throw new Error(`posterGeneric shows one header field; ${fields.headerFields.length} given (the device would drop the rest)`);
  }
  if (primary.length > POSTER_MAX_PRIMARY) {
    throw new Error(`posterGeneric shows up to four primary fields; ${primary.length} given (the device would drop the rest)`);
  }
  if (footer.length > POSTER_MAX_FOOTER) {
    throw new Error(`posterGeneric shows one footer field; ${footer.length} given (the device would drop the rest)`);
  }
  // The same field objects serve both dictionaries; keys may repeat across them
  // (Apple's own example does). The poster face has no secondary or auxiliary
  // row, so those fields live only in the fallback.
  json.posterGeneric = {
    headerFields: fields.headerFields,
    primaryFields: primary,
    ...(footer.length ? { footerFields: footer } : {}),
    backFields: fields.backFields,
  };
  json[STYLE_KEY[content.posterFallback ?? "generic"]] = fields;
  return json;
}

/// Which image slots each style renders. Apple ignores the rest, so they are
///  not shipped: `hero` becomes the strip where a strip exists and nothing on
///  generic, which has no strip.
const SLOTS: Record<PassStyle, Array<[keyof NonNullable<PassContent["images"]>, string]>> = {
  generic: [["icon", "icon"], ["logo", "logo"], ["thumbnail", "thumbnail"]],
  eventTicket: [["icon", "icon"], ["logo", "logo"], ["hero", "strip"]],
  storeCard: [["icon", "icon"], ["logo", "logo"], ["hero", "strip"]],
  coupon: [["icon", "icon"], ["logo", "logo"], ["hero", "strip"]],
  // The poster face draws artwork and primaryLogo; the legacy fallback's slots
  // are added at build time so iOS 26 has its logo, strip or thumbnail too.
  posterGeneric: [["icon", "icon"], ["logo", "logo"], ["primaryLogo", "primaryLogo"], ["artwork", "artwork"]],
};

function slotsFor(content: PassContent): Array<[keyof NonNullable<PassContent["images"]>, string]> {
  const style = content.style ?? "generic";
  if (style !== "posterGeneric") return SLOTS[style];
  const seen = new Set<string>();
  return [...SLOTS.posterGeneric, ...SLOTS[content.posterFallback ?? "generic"]].filter(([, name]) => {
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

export async function passImages(
  content: PassContent,
  fallback: PassContent["images"] = {},
  fetchOpts: ImageFetchOptions = {},
): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  await Promise.all(
    slotsFor(content).map(async ([slot, name]) => {
      const source: ImageSource | undefined = content.images?.[slot] ?? fallback?.[slot];
      if (source) Object.assign(out, await resolveImage(name, source, fetchOpts));
    }),
  );
  if (!out["icon.png"] && !out["icon@2x.png"] && !out["icon@3x.png"]) {
    throw new Error("an icon image is required: Apple Wallet will not open a pass without one");
  }
  return out;
}

function pem(value: string | Uint8Array): string | Buffer {
  return typeof value === "string" ? value : Buffer.from(value);
}

/// Refuse a signer certificate that was not issued for this pass. An Apple Pass
///  Type ID certificate carries the pass type identifier as the subject's UID
///  (OID 0.9.2342.19200300.100.1.1) and the team identifier as its OU. A pass
///  signed with a certificate for another type or team is accepted by every
///  signing library and then installs nowhere, with no error anyone sees.
///  Apple's own Pass Builder compares exactly these two attributes
///  (PassCertificate.validateAttributes) but only when asked; passkit-generator
///  never does. A certificate without a UID (a bare development certificate)
///  carries nothing to compare and passes through.
export function validateSignerCertificate(
  signerCert: string | Uint8Array,
  opts: Pick<PassJsonOptions, "passTypeIdentifier" | "teamIdentifier">,
): void {
  const cert = new X509Certificate(pem(signerCert));
  const attrs = new Map<string, string>();
  for (const line of cert.subject.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) attrs.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  const uid = attrs.get("UID");
  const ou = attrs.get("OU");
  if (uid !== undefined && uid !== opts.passTypeIdentifier) {
    throw new Error(`signer certificate is for pass type "${uid}", not "${opts.passTypeIdentifier}": a pass it signs would never install`);
  }
  if (ou !== undefined && ou !== opts.teamIdentifier) {
    throw new Error(`signer certificate belongs to team "${ou}", not "${opts.teamIdentifier}": a pass it signs would never install`);
  }
}

/// Build and sign a .pkpass. Returns the zip bytes, ready to serve with
///  `Content-Type: application/vnd.apple.pkpass`.
export async function buildPkpass(content: PassContent, options: BuildPkpassOptions): Promise<Uint8Array> {
  const c = options.certificates;
  validateSignerCertificate(c.signerCert, options);
  const images = await passImages(content, options.images, options.imageFetch);
  const files: Record<string, Buffer> = {
    "pass.json": Buffer.from(JSON.stringify(toPassJson(content, options))),
  };
  for (const [name, bytes] of Object.entries(images)) files[name] = Buffer.from(bytes);
  const pass = new PKPass(files, {
    wwdr: pem(c.wwdr),
    signerCert: pem(c.signerCert),
    signerKey: pem(c.signerKey),
    ...(c.signerKeyPassphrase ? { signerKeyPassphrase: c.signerKeyPassphrase } : {}),
  });
  return new Uint8Array(pass.getAsBuffer());
}
