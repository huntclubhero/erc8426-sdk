import { statusForError, type WalletPassErrorCode } from "@erc8426/core";

/// Every `error` code the issuer's HTTP surface answers with: the shared
///  protocol codes from core, plus the issuer's own for requests outside the
///  protocol (a bad body, a route that does not exist, a failed action).
export type IssuerErrorCode = WalletPassErrorCode | "invalid_request" | "method_not_allowed" | "action_failed" | "internal_error";

export function statusForIssuerError(code: IssuerErrorCode): number {
  switch (code) {
    case "invalid_request":
      return 400;
    case "method_not_allowed":
      return 405;
    case "action_failed":
    case "internal_error":
      return 500;
    default:
      return statusForError(code);
  }
}

/// Thrown by the programmatic API (`issueChallenge`, `onPassUpdate`) for input
///  the protocol refuses. The HTTP layer maps it to its status.
export class IssuerError extends Error {
  readonly code: IssuerErrorCode;
  readonly status: number;
  constructor(code: IssuerErrorCode, message: string) {
    super(message);
    this.name = "IssuerError";
    this.code = code;
    this.status = statusForIssuerError(code);
  }
}

/// Throw from an action's `execute` to refuse with a chosen status and code,
///  for example a cooldown: `throw new ActionError(429, "cooldown", "Fed
///  less than an hour ago")`. Never use 403: the spec reserves it for a
///  verified proof from a non-entitled account.
export class ActionError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    if (status === 403) throw new Error("ActionError must not use 403: it is reserved for the entitlement refusal");
    if (!Number.isInteger(status) || status < 400 || status > 599) throw new Error(`ActionError status must be 4xx or 5xx, got ${status}`);
    this.name = "ActionError";
    this.status = status;
    this.code = code;
  }
}
