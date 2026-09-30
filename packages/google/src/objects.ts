import type { BarcodeFormat, ImageSource, PassContent, PassField, PassStyle } from "@erc8426/core";

import { assertSuffix, resourceId, suffixForSerial } from "./ids.js";

/// Mapping from the shared PassContent to Google Wallet class and object
///  resources. Each PassStyle maps to the nearest vertical: generic to
///  generic, eventTicket to eventTicket, storeCard to loyalty, coupon to
///  offer.

export type GoogleVertical = "generic" | "eventTicket" | "loyalty" | "offer";
export type GoogleClassType = `${GoogleVertical}Class`;
export type GoogleObjectType = `${GoogleVertical}Object`;
export type GoogleResourceType = GoogleClassType | GoogleObjectType;

export type GoogleResource = Record<string, unknown> & { id: string };

export interface GoogleObject {
  vertical: GoogleVertical;
  resource: GoogleResource & { classId: string };
}

export interface GoogleClass {
  vertical: GoogleVertical;
  resource: GoogleResource;
}

export function verticalFor(style: PassStyle | undefined): GoogleVertical {
  switch (style ?? "generic") {
    case "eventTicket":
      return "eventTicket";
    case "storeCard":
      return "loyalty";
    case "coupon":
      return "offer";
    default:
      return "generic";
  }
}

export class GoogleImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleImageError";
  }
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (h.includes(":")) return h === "::1" || h === "::" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("::ffff:");
  return false;
}

/// Google fetches images itself, from its own servers, so a URL must be
///  public https. A localhost or private address answers 400 on insert, and
///  an unreachable one is dropped silently and the pass shows no art. Byte
///  sources cannot be sent at all.
export function assertPublicImageUrl(source: ImageSource | undefined, slot: string): string {
  if (!source?.url) {
    throw new GoogleImageError(`${slot} image has no url: Google Wallet needs a public https URL, image bytes cannot be uploaded`);
  }
  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    throw new GoogleImageError(`${slot} image url is not a valid URL: ${source.url}`);
  }
  if (url.protocol !== "https:") throw new GoogleImageError(`${slot} image url must be https: ${source.url}`);
  if (isPrivateHost(url.hostname)) {
    throw new GoogleImageError(`${slot} image url must be publicly reachable by Google, not ${url.hostname}: ${source.url}`);
  }
  return url.toString();
}

export interface MappingOptions {
  issuerId: string;
  classSuffix: string;
  /// Defaults to a suffix derived from the serial.
  objectSuffix?: string;
  /// BCP 47 language of every localized string. Defaults to "en-US".
  language?: string;
  /// What to do with an image slot that is not public https. Defaults to
  ///  "throw", so a missing hero is a visible error rather than a blank card.
  unhostedImages?: "throw" | "omit";
  /// Clock for the expired check. Defaults to now.
  now?: Date;
}

const BARCODE_TYPES: Record<BarcodeFormat, string> = {
  qr: "QR_CODE",
  pdf417: "PDF_417",
  aztec: "AZTEC",
  code128: "CODE_128",
};

/// Google renders at most ten text modules on a pass.
export const MAX_TEXT_MODULES = 10;

function localized(value: string, language: string) {
  return { defaultValue: { language, value } };
}

function image(source: ImageSource | undefined, slot: string, description: string, opts: MappingOptions) {
  if (!source) return undefined;
  try {
    const uri = assertPublicImageUrl(source, slot);
    return { sourceUri: { uri }, contentDescription: localized(description, opts.language ?? "en-US") };
  } catch (err) {
    if (opts.unhostedImages === "omit") return undefined;
    throw err;
  }
}

/// ACTIVE, or the state that visibly supersedes a pass: EXPIRED once
///  `expiresAt` has passed, INACTIVE when voided. Either moves the pass out
///  of the holder's active list, which is how a previous owner's copy stops
///  presenting itself as current.
export function stateFor(content: PassContent, now = new Date()): "ACTIVE" | "EXPIRED" | "INACTIVE" {
  if (content.voided) return "INACTIVE";
  if (content.expiresAt && content.expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  return "ACTIVE";
}

function modules(fields: PassField[]) {
  return fields.map((f) => ({ id: f.key, header: f.label, body: String(f.value) }));
}

export function classIdFor(opts: Pick<MappingOptions, "issuerId" | "classSuffix">): string {
  return resourceId(opts.issuerId, opts.classSuffix);
}

export function objectIdFor(content: Pick<PassContent, "serial">, opts: Pick<MappingOptions, "issuerId" | "objectSuffix">): string {
  const suffix = opts.objectSuffix ?? suffixForSerial(content.serial);
  assertSuffix(suffix, "object suffix");
  return resourceId(opts.issuerId, suffix);
}

/// Map PassContent to a Google Wallet object of the matching vertical.
///  Google has no counterpart to Apple's changeMessage on fields; a
///  notification is a separate addMessage call.
export function toGoogleObject(content: PassContent, opts: MappingOptions): GoogleObject {
  const vertical = verticalFor(content.style);
  const lang = opts.language ?? "en-US";
  const primary = content.primary ?? [];
  const resource: GoogleResource & { classId: string } = {
    id: objectIdFor(content, opts),
    classId: classIdFor(opts),
    state: stateFor(content, opts.now),
  };

  // Fields a vertical renders natively are consumed; the rest become text
  // modules, in front-of-card order, so nothing on the Apple pass is lost.
  let consumed = 0;
  if (vertical === "generic") {
    resource.cardTitle = localized(content.title, lang);
    const first = primary[0];
    if (content.headline) {
      resource.header = localized(content.headline, lang);
    } else if (first) {
      resource.header = localized(String(first.value), lang);
      resource.subheader = localized(first.label, lang);
      consumed = 1;
    } else {
      resource.header = localized(content.title, lang);
    }
    const logo = image(content.images?.logo ?? content.images?.icon, "logo", content.title, opts);
    if (logo) resource.logo = logo;
    if (content.colors) resource.hexBackgroundColor = content.colors.background;
  } else if (vertical === "loyalty") {
    resource.accountId = content.serial;
    resource.accountName = content.headline ?? content.title;
    const [a, b] = primary;
    if (a) resource.loyaltyPoints = { label: a.label, balance: { string: String(a.value) } };
    if (b) resource.secondaryLoyaltyPoints = { label: b.label, balance: { string: String(b.value) } };
    consumed = Math.min(primary.length, 2);
  } else if (vertical === "eventTicket") {
    if (content.colors) resource.hexBackgroundColor = content.colors.background;
  }

  const hero = image(content.images?.hero, "hero", content.title, opts);
  if (hero) resource.heroImage = hero;

  if (content.barcode) {
    resource.barcode = {
      type: BARCODE_TYPES[content.barcode.format],
      value: content.barcode.message,
      ...(content.barcode.altText ? { alternateText: content.barcode.altText } : {}),
    };
  }

  const eventFields: PassField[] =
    vertical === "eventTicket" && content.event?.venue ? [{ key: "venue", label: "Venue", value: content.event.venue }] : [];
  const text = modules([
    ...primary.slice(consumed),
    ...eventFields,
    ...(content.header ?? []),
    ...(content.secondary ?? []),
    ...(content.auxiliary ?? []),
    ...(content.back ?? []),
  ]).slice(0, MAX_TEXT_MODULES);
  if (text.length) resource.textModulesData = text;

  // Google never linkifies text: the links module is the only tappable
  // surface on a Google pass, so every action link goes here.
  if (content.links?.length) {
    resource.linksModuleData = { uris: content.links.map((l) => ({ id: l.key, uri: l.url, description: l.label })) };
  }
  if (content.expiresAt) resource.validTimeInterval = { end: { date: content.expiresAt.toISOString() } };
  if (content.locations?.length) {
    resource.locations = content.locations.slice(0, 10).map((l) => ({ latitude: l.latitude, longitude: l.longitude }));
  }
  return { vertical, resource };
}

export interface ClassOptions extends Pick<MappingOptions, "issuerId" | "classSuffix" | "language" | "unhostedImages"> {
  /// Merged over the generated class, for fields PassContent does not carry
  ///  (callbackOptions, classTemplateInfo, a venue address, and so on).
  overrides?: Record<string, unknown>;
  /// Offer classes only. Defaults to "ONLINE".
  redemptionChannel?: "INSTORE" | "ONLINE" | "BOTH" | "TEMPORARY_PRICE_REDUCTION";
}

/// A class for the content's vertical. Generic classes need no review and
///  work at once; eventTicket, loyalty and offer classes are created
///  UNDER_REVIEW and save only to test accounts until Google approves the
///  issuer for publishing.
export function toGoogleClass(content: PassContent, opts: ClassOptions): GoogleClass {
  const vertical = verticalFor(content.style);
  const lang = opts.language ?? "en-US";
  const mapOpts: MappingOptions = { ...opts, unhostedImages: opts.unhostedImages };
  const resource: GoogleResource = {
    id: classIdFor(opts),
    // One holder per object: a second account cannot save the same object,
    // so a save link that leaks after a transfer cannot put the live card in
    // another account.
    multipleDevicesAndHoldersAllowedStatus: "ONE_USER_ALL_DEVICES",
  };
  if (vertical !== "generic") {
    resource.issuerName = content.organizationName;
    resource.reviewStatus = "UNDER_REVIEW";
    if (content.colors) resource.hexBackgroundColor = content.colors.background;
  }
  const logo = () => image(content.images?.logo ?? content.images?.icon, "logo", content.organizationName, mapOpts);
  if (vertical === "loyalty") {
    resource.programName = content.title;
    const l = logo();
    if (!l) throw new GoogleImageError("a loyalty class requires a logo (or icon) image with a public https url");
    resource.programLogo = l;
  } else if (vertical === "eventTicket") {
    resource.eventName = localized(content.event?.name ?? content.title, lang);
    const l = logo();
    if (l) resource.logo = l;
    if (content.event?.startsAt || content.event?.endsAt) {
      resource.dateTime = {
        ...(content.event.startsAt ? { start: content.event.startsAt.toISOString() } : {}),
        ...(content.event.endsAt ? { end: content.event.endsAt.toISOString() } : {}),
      };
    }
  } else if (vertical === "offer") {
    resource.title = content.headline ?? content.title;
    resource.provider = content.organizationName;
    resource.redemptionChannel = opts.redemptionChannel ?? "ONLINE";
    const l = logo();
    if (l) resource.titleImage = l;
  }
  return { vertical, resource: { ...resource, ...opts.overrides, id: resource.id } };
}
