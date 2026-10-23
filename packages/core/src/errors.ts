/// Refusal reasons, one per hole the authorization model closes, and the HTTP
///  statuses they map to. Shared by the issuer (which produces them) and the
///  client and conformance suite (which interpret them). The names and
///  statuses follow the spec's refusal table (Refusal responses).

export type AuthError =
  | "invalid_message" // not a parseable challenge carrying the floor fields
  | "domain_mismatch" // verifier identity is not this verifier
  | "nonce_invalid" // unknown, already spent, or evicted nonce
  | "challenge_expired" // Expiration Time missing or in the past
  // Not Before in the future. Not yet in the spec's refusal table: it is
  // being added to the table in PR #2036, with status 401.
  | "not_yet_valid"
  | "binding_mismatch" // resources or chain id do not bind this exact token and action
  | "signature_invalid" // signature not valid for the claimed account
  | "not_owner" // verified proof, but the account is not entitled (fresh read)
  | "read_failed"; // the fresh entitlement read could not be taken

/// Codes retired in 0.3.0 and still accepted for one minor version. Each
///  resolves to the spec's name through `canonicalErrorCode`:
///  `malformed_proof`, `invalid_address` and `invalid_token` are all
///  `invalid_request` (400); `link_invalid` and `not_found` are both
///  `unknown_capability` (404).
/// @deprecated Use the spec's codes. These stop being accepted in a later minor.
export type DeprecatedWalletPassErrorCode = "malformed_proof" | "invalid_address" | "invalid_token" | "link_invalid" | "not_found";

/// Codes a gated manifest, challenge or action endpoint answers with in
///  `error`: the spec's refusal table, plus the SDK's own for requests outside
///  the protocol shape (an unregistered action, a wrong method, a failed
///  action). A client handles a code it does not recognize by its HTTP status.
export type WalletPassErrorCode =
  | AuthError
  | "invalid_request" // 400: the request is malformed (a missing or invalid address, token id or proof header)
  | "proof_required" // 401: no control proof was presented
  | "unknown_capability" // 404: the capability URL (or route) does not resolve, for example after rotation
  | "insufficient_balance" // 409: an account the token controls holds less than the action spends
  | "rate_limited" // 429: too many attempts for this token or action
  | "unknown_action" // 400 (SDK): the action is not registered with this issuer
  | "method_not_allowed" // 405 (SDK)
  | "action_failed" // 500 (SDK): the integrator's action threw
  | "internal_error" // 500 (SDK)
  | DeprecatedWalletPassErrorCode;

/// The codes the SDK emits: `WalletPassErrorCode` without the deprecated aliases.
export type CanonicalWalletPassErrorCode = Exclude<WalletPassErrorCode, DeprecatedWalletPassErrorCode>;

/// @deprecated Alias kept for one minor version; the code is now `invalid_request`.
export type MalformedProofCode = "malformed_proof";
/// @deprecated Alias kept for one minor version; the code is now `invalid_request`.
export type InvalidAddressCode = "invalid_address";
/// @deprecated Alias kept for one minor version; the code is now `invalid_request`.
export type InvalidTokenCode = "invalid_token";
/// @deprecated Alias kept for one minor version; the code is now `unknown_capability`.
export type LinkInvalidCode = "link_invalid";
/// @deprecated Alias kept for one minor version; the code is now `unknown_capability`.
export type NotFoundCode = "not_found";

/// The codes the SDK emits. Deprecated aliases are never produced, only read.
export const CANONICAL_WALLET_PASS_ERROR_CODES: readonly CanonicalWalletPassErrorCode[] = [
  "invalid_request",
  "invalid_message",
  "domain_mismatch",
  "binding_mismatch",
  "proof_required",
  "nonce_invalid",
  "challenge_expired",
  "not_yet_valid",
  "signature_invalid",
  "not_owner",
  "unknown_capability",
  "insufficient_balance",
  "rate_limited",
  "read_failed",
  "unknown_action",
  "method_not_allowed",
  "action_failed",
  "internal_error",
];

/// Deprecated name to the spec's name.
/// @deprecated Only exists so 0.2.x issuers keep being understood.
export const DEPRECATED_WALLET_PASS_ERROR_CODES: Readonly<Record<DeprecatedWalletPassErrorCode, CanonicalWalletPassErrorCode>> = {
  malformed_proof: "invalid_request",
  invalid_address: "invalid_request",
  invalid_token: "invalid_request",
  link_invalid: "unknown_capability",
  not_found: "unknown_capability",
};

/// Every code accepted at runtime, for validating an `error` member off the
///  wire: the codes the SDK emits plus the deprecated aliases a 0.2.x issuer
///  still sends.
export const WALLET_PASS_ERROR_CODES: readonly WalletPassErrorCode[] = [
  ...CANONICAL_WALLET_PASS_ERROR_CODES,
  ...(Object.keys(DEPRECATED_WALLET_PASS_ERROR_CODES) as DeprecatedWalletPassErrorCode[]),
];

export function isWalletPassErrorCode(value: unknown): value is WalletPassErrorCode {
  return typeof value === "string" && (WALLET_PASS_ERROR_CODES as readonly string[]).includes(value);
}

export function isDeprecatedWalletPassErrorCode(value: unknown): value is DeprecatedWalletPassErrorCode {
  return typeof value === "string" && Object.hasOwn(DEPRECATED_WALLET_PASS_ERROR_CODES, value);
}

/// The spec's name for a code: a deprecated alias resolves to its
///  replacement, every other code is returned unchanged.
export function canonicalErrorCode(code: WalletPassErrorCode): CanonicalWalletPassErrorCode {
  return isDeprecatedWalletPassErrorCode(code) ? DEPRECATED_WALLET_PASS_ERROR_CODES[code] : code;
}

/// The status the refusal table lists for each code: 400 for malformed or
///  mis-scoped input, 401 for a failed possession or freshness check, 403 ONLY
///  for a verified proof from a non-entitled account, 404 for a capability URL
///  that does not resolve, 409 for an account that cannot pay, 429 for a
///  throttled token or action, 503 for a read that could not be taken. The 403
///  is reserved by the spec (Gated acquisition), so nothing else may borrow it.
///  A deprecated alias gets the status of the code it resolves to.
export function statusForError(error: WalletPassErrorCode): number {
  switch (canonicalErrorCode(error)) {
    case "invalid_request":
    case "invalid_message":
    case "domain_mismatch":
    case "binding_mismatch":
    case "unknown_action":
      return 400;
    case "proof_required":
    case "nonce_invalid":
    case "challenge_expired":
    case "not_yet_valid":
    case "signature_invalid":
      return 401;
    case "not_owner":
      return 403;
    case "unknown_capability":
      return 404;
    case "method_not_allowed":
      return 405;
    case "insufficient_balance":
      return 409;
    case "rate_limited":
      return 429;
    case "action_failed":
    case "internal_error":
      return 500;
    case "read_failed":
      return 503;
  }
}

/// Body of the 401 a gated manifest returns to a request without a proof.
export interface ProofRequiredBody {
  error: "proof_required";
  /// URI of the challenge endpoint for this token.
  challenge: string;
}

/// Body of every other error response.
export interface ErrorBody {
  error: WalletPassErrorCode;
  /// Present on gated 401s so the client can fetch a fresh challenge.
  challenge?: string;
  message?: string;
}

/// Body of a challenge endpoint response.
export interface ChallengeBody {
  message: string;
}

export function isProofRequiredBody(value: unknown): value is ProofRequiredBody {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { error?: unknown }).error === "proof_required" &&
    typeof (value as { challenge?: unknown }).challenge === "string"
  );
}

/// Every code a WalletPassError can carry: the wire codes, plus client-side
///  kinds. `action_refused` is a 4xx outside the core set (an integrator's
///  own refusal such as a cooldown), `server_error` a 5xx outside it, and
///  `network` only a failed or timed out fetch.
export type WalletPassErrorKind =
  | WalletPassErrorCode
  | "network"
  | "invalid_manifest"
  | "unsupported"
  | "action_refused"
  | "server_error";

/// Thrown by client helpers for a refusal the caller should handle.
export class WalletPassError extends Error {
  readonly code: WalletPassErrorKind;
  readonly status: number | undefined;
  constructor(code: WalletPassError["code"], message: string, status?: number) {
    super(message);
    this.name = "WalletPassError";
    this.code = code;
    this.status = status;
  }
}
