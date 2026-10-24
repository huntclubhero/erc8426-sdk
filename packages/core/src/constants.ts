/// Protocol literals defined by ERC-8426. Every other package imports these
///  rather than restating them, so a spec revision changes one file.

/// The ERC-165 identifier of `IERC721WalletPass`
///  (`passURI(uint256)`, the only function in the interface).
export const WALLET_PASS_INTERFACE_ID = "0xef5f1e71" as const;

/// Prefix of the action URN carried as the second SIWE resource.
export const ACTION_URN_PREFIX = "urn:wallet-pass:action:" as const;

/// The action a gated manifest request proves. An `acquire` proof MUST NOT
///  authorize any other action, and no other proof resolves the manifest.
export const ACQUIRE_ACTION = "acquire" as const;

/// The action a signed rotation request carries. Kept separate from `acquire`
///  because rotating every live link is a different action.
export const ROTATE_ACTION = "rotate" as const;

/// Headers a client sends to resolve a gated manifest (Gated acquisition).
///  Named without the X- prefix per RFC 6648 (ethereum/ERCs PR #2036). The
///  X- names of earlier drafts are still read by issuers, and `proofHeaders`
///  still sends them beside the new ones for this release, so a 0.3.0 client
///  resolves a 0.2.x issuer's manifest; a later minor stops sending them.
export const PROOF_HEADER = "Wallet-Pass-Proof" as const;
export const SIGNATURE_HEADER = "Wallet-Pass-Signature" as const;
/// @deprecated The pre-0.3.0 header names. Still accepted on read; sent
///  alongside the new names until a later minor drops them.
export const LEGACY_PROOF_HEADER = "X-Wallet-Pass-Proof" as const;
/// @deprecated The pre-0.3.0 header names. Still accepted on read; sent
///  alongside the new names until a later minor drops them.
export const LEGACY_SIGNATURE_HEADER = "X-Wallet-Pass-Signature" as const;
/// Every header name that may carry a proof, in the order an issuer reads
///  them (the new name wins when both are present). For CORS allow lists.
export const PROOF_HEADER_NAMES = [PROOF_HEADER, SIGNATURE_HEADER, LEGACY_PROOF_HEADER, LEGACY_SIGNATURE_HEADER] as const;

/// The manifest's optional `version` member. 1 is the only value defined.
export const MANIFEST_VERSION = 1 as const;

/// Media type an `apple` acquisition URL MUST be served with.
export const PKPASS_MEDIA_TYPE = "application/vnd.apple.pkpass" as const;

/// Top-level `tokenURI` metadata key of the optional metadata mirror.
export const METADATA_MIRROR_KEY = "wallet_pass" as const;

/// Manifest format keys the standard names. Others MAY appear and clients
///  MUST ignore the ones they do not recognize.
export const FORMAT_APPLE = "apple" as const;
export const FORMAT_GOOGLE = "google" as const;

/// Prefix of a Save to Google Wallet link.
export const GOOGLE_SAVE_URL_PREFIX = "https://pay.google.com/gp/v/save/" as const;
