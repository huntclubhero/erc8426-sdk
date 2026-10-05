import type { Address } from "viem";

import type { TokenRef } from "./caip.js";

/// The delivery seam. The standard leaves generation, signing and push out of
///  scope; the SDK still needs one shape that both wallet platforms render
///  from, so an issuer describes a pass once and gets an Apple pass and a
///  Google object that say the same thing.

/// An image, either fetched from a public https URL or supplied as bytes.
///  Google Wallet requires a public https URL; Apple embeds bytes in the
///  bundle, so a URL is fetched at build time.
export interface ImageSource {
  url?: string;
  data?: Uint8Array;
  /// Optional @2x and @3x variants for Apple. Ignored by Google.
  data2x?: Uint8Array;
  data3x?: Uint8Array;
}

export interface PassField {
  /// Stable key, unique within the pass. Apple uses it to diff updates.
  key: string;
  label: string;
  value: string | number;
  /// Apple lock-screen message on change. `%@` is replaced with the new value,
  ///  for example "Balance is now %@".
  changeMessage?: string;
}

export interface PassLink {
  key: string;
  label: string;
  /// Usually a capability URL for a pass-reachable action, or a deep link into
  ///  a partner app (universal link / app link).
  url: string;
}

export type BarcodeFormat = "qr" | "pdf417" | "aztec" | "code128";

/// The layout family. Each maps to the nearest native style on each platform:
///  Apple `generic` / `eventTicket` / `storeCard` / `coupon`, and Google
///  `genericObject` / `eventTicketObject` / `loyaltyObject` / `offerObject`.
///
///  `posterGeneric` is Apple's iOS 27 poster face: full-height `artwork`, a
///  `primaryLogo`, ONE header field, up to FOUR primary fields, one footer
///  field, back fields, square QR. On Apple the pass carries BOTH the poster
///  dictionary and a legacy one (`posterFallback`, default `generic`), so iOS 26
///  and earlier render the legacy layout; Google uses the generic vertical.
export type PassStyle = "generic" | "eventTicket" | "storeCard" | "coupon" | "posterGeneric";

/// The legacy Apple dictionary shipped next to `posterGeneric` for devices
///  before iOS 27.
export type PosterFallbackStyle = Exclude<PassStyle, "posterGeneric">;

export interface PassContent {
  /// Opaque, random pass identifier. MUST NOT be derived from holder personal
  ///  information or an account id (Issuer requirements). Stable per token for
  ///  the life of a holder's pass so platform updates land on the same card.
  serial: string;
  style?: PassStyle;
  organizationName: string;
  /// Accessibility description (Apple `description`).
  description: string;
  /// Card title (Apple `logoText`, Google `cardTitle`).
  title: string;
  /// Large headline (Google `header`). Defaults to the first primary field.
  headline?: string;
  colors?: {
    /// Hex colors, for example "#101418".
    background: string;
    foreground: string;
    label?: string;
  };
  images?: {
    icon?: ImageSource;
    logo?: ImageSource;
    /// A wide banner: Apple `strip`, Google `heroImage`.
    hero?: ImageSource;
    thumbnail?: ImageSource;
    /// Apple `posterGeneric` only: the full-height poster image, 358x448 points
    ///  (provide @2x and @3x). A material strip and the QR cover its bottom edge.
    artwork?: ImageSource;
    /// Apple `posterGeneric` only: the mark in the top-leading corner, 30 points
    ///  tall and 30 to 126 wide.
    primaryLogo?: ImageSource;
  };
  header?: PassField[];
  primary?: PassField[];
  secondary?: PassField[];
  auxiliary?: PassField[];
  /// Apple `posterGeneric` only: the one footer field on the poster face.
  ///  Refused on other styles, which have no footer row.
  footer?: PassField[];
  /// Apple `posterGeneric` only: which legacy dictionary rides along for iOS 26
  ///  and earlier. Default `generic`, Apple's own example. The fallback gets the
  ///  full field set (secondary and auxiliary included); the poster face gets
  ///  header, primary, footer and back.
  posterFallback?: PosterFallbackStyle;
  /// Back of the pass on Apple, text modules on Google.
  back?: PassField[];
  /// Action links and deep links. Apple renders them as back fields with
  ///  detected links; Google renders a links module.
  links?: PassLink[];
  barcode?: { format: BarcodeFormat; message: string; altText?: string };
  /// When set in the past or `voided` is true, the pass presents as expired,
  ///  which is how an issuer marks a previous owner's pass as superseded.
  expiresAt?: Date;
  voided?: boolean;
  /// With `voided`: why this pass was superseded. Platform providers use it
  ///  to say why on the old pass and where the holder gets the current one,
  ///  which the spec asks of a pass presented as superseded.
  supersededReason?: SupersededReason;
  relevantDate?: Date;
  locations?: Array<{ latitude: number; longitude: number; relevantText?: string }>;
  /// Event details for the eventTicket style.
  event?: { name: string; venue?: string; startsAt?: Date; endsAt?: Date };
}

/// Why a pass was superseded. "transfer": the token changed hands (a new
///  owner's claim included), so whoever holds the old pass is likely the
///  previous owner. "reset": the pass links were rotated under an unchanged
///  owner, so the holder is likely still the owner and should add the
///  current pass.
export type SupersededReason = "transfer" | "reset";

/// What a format provider knows when it produces an acquisition URL.
export interface PassContext {
  token: TokenRef;
  /// The account the pass is being issued to (the proven owner in the gated
  ///  configuration, the current owner read in the public one).
  owner: Address;
  content: PassContent;
}

/// One wallet platform. The issuer calls every provider when it builds a
///  manifest, and calls `notifyUpdate` when a token's pass content changed
///  (for example on a PassUpdate event).
export interface PassFormatProvider {
  /// The manifest format key, for example "apple" or "google".
  readonly format: string;
  /// Return the acquisition URL for this platform. MAY be short-lived (a
  ///  Save to Google Wallet JWT) or a capability URL the provider serves.
  acquisitionUrl(ctx: PassContext): Promise<string>;
  /// Push updated content to installed passes where the platform supports it.
  notifyUpdate?(ctx: PassContext): Promise<void>;
}

/// A pass file the issuer serves itself.
export interface PassFile {
  body: Uint8Array | string;
  contentType: string;
  filename?: string;
}

/// A platform whose pass is a file (Apple's .pkpass). The issuer hosts the
///  download at a rotating capability URL it owns, so the provider never has
///  to host or rotate download links: rotation stays in one place.
export interface PassFileProvider {
  readonly format: string;
  passFile(ctx: PassContext): Promise<PassFile>;
  notifyUpdate?(ctx: PassContext): Promise<void>;
}

/// Either kind of delivery provider.
export type PassDeliveryProvider = PassFormatProvider | PassFileProvider;

export function isPassFileProvider(p: PassDeliveryProvider): p is PassFileProvider {
  return typeof (p as PassFileProvider).passFile === "function";
}
