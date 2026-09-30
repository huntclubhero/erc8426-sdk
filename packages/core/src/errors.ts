/// Refusal reasons, one per hole the authorization model closes, and the HTTP
///  statuses they map to. Shared by the issuer (which produces them) and the
///  client and conformance suite (which interpret them).

export type AuthError =
  | "invalid_message" // not a parseable challenge carrying the floor fields
  | "domain_mismatch" // verifier identity is not this verifier
  | "nonce_invalid" // unknown, already spent, or evicted nonce
  | "challenge_expired" // Expiration Time missing or in the past
  | "not_yet_valid" // Not Before in the future
  | "binding_mismatch" // resources or chain id do not bind this exact token and action
  | "signature_invalid" // signature not valid for the claimed account
  | "not_owner" // verified proof, but the account is not entitled (fresh read)
  | "read_failed"; // the fresh entitlement read could not be taken

/// Codes a gated manifest or action endpoint answers with in `error`.
export type WalletPassErrorCode =
  | AuthError
  | "proof_required"
  | "malformed_proof"
  | "invalid_address"
  | "invalid_token"
  | "unknown_action"
  | "link_invalid"
  | "not_found";

/// 400 for malformed or mis-scoped input, 401 for a failed possession or
///  freshness check, 403 ONLY for a verified proof from a non-entitled
///  account, 503 for a read that could not be taken. The 403 is reserved by
///  the spec (Gated acquisition), so nothing else may borrow it.
export function statusForError(error: WalletPassErrorCode): number {
  switch (error) {
    case "invalid_message":
    case "domain_mismatch":
    case "binding_mismatch":
    case "malformed_proof":
    case "invalid_address":
    case "invalid_token":
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
    case "link_invalid":
    case "not_found":
      return 404;
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

/// Thrown by client helpers for a refusal the caller should handle.
export class WalletPassError extends Error {
  readonly code: WalletPassErrorCode | "network" | "invalid_manifest" | "unsupported";
  readonly status: number | undefined;
  constructor(code: WalletPassError["code"], message: string, status?: number) {
    super(message);
    this.name = "WalletPassError";
    this.code = code;
    this.status = status;
  }
}
