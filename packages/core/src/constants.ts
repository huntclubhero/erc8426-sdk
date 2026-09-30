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
export const PROOF_HEADER = "X-Wallet-Pass-Proof" as const;
export const SIGNATURE_HEADER = "X-Wallet-Pass-Signature" as const;

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
