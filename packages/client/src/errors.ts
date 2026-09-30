import { WalletPassError, isWalletPassErrorCode } from "@erc8426/core";

/// Where a refusal came from. `server` is an issuer response; `client` is this
///  SDK declining to proceed, most importantly refusing to have the user sign
///  a challenge that is not scoped to what they asked for.
export type ErrorSource = "server" | "client";

/// The client's error. Still a WalletPassError (so `instanceof` checks and
///  `code` switches written against core keep working), plus what a UI needs
///  to decide its next step.
export class WalletPassClientError extends WalletPassError {
  readonly source: ErrorSource;
  /// True when trying again later can succeed: 503 (the issuer could not take
  ///  the fresh ownership read), 429, other 5xx, and network failures.
  readonly retryable: boolean;
  /// Seconds from the Retry-After header, when the issuer sent one.
  readonly retryAfterSeconds: number | undefined;
  /// The challenge endpoint an issuer named in a 401, when present.
  readonly challenge: string | undefined;
  /// The issuer's own `error` string, verbatim. Issuers may add codes beyond
  ///  the core set (for example `invalid_request` or an integrator's custom
  ///  code); those map to a generic `code` and survive here.
  readonly serverCode: string | undefined;
  /// The parsed JSON error body, for diagnostics.
  readonly body: unknown;

  constructor(
    code: WalletPassError["code"],
    message: string,
    init: {
      status?: number;
      source?: ErrorSource;
      retryable?: boolean;
      retryAfterSeconds?: number;
      challenge?: string;
      serverCode?: string;
      body?: unknown;
    } = {},
  ) {
    super(code, message, init.status);
    this.name = "WalletPassClientError";
    this.source = init.source ?? "server";
    this.retryable = init.retryable ?? false;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.challenge = init.challenge;
    this.serverCode = init.serverCode;
    this.body = init.body;
  }
}

/// Parse Retry-After, which is either delta seconds or an HTTP date.
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const trimmed = value.trim();
  if (/^[0-9]+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/// Map an issuer's error response to a typed error. A 403 is always
///  `not_owner` whatever the body says: the spec reserves that status for a
///  verified proof from an account that is not entitled, so it is the one
///  refusal a client can act on without trusting the body.
export function errorFromResponse(status: number, headers: Headers, body: unknown): WalletPassClientError {
  const bodyCode =
    typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : undefined;
  const challenge =
    typeof body === "object" && body !== null && typeof (body as { challenge?: unknown }).challenge === "string"
      ? (body as { challenge: string }).challenge
      : undefined;
  const retryAfterSeconds = parseRetryAfter(headers.get("retry-after"));
  const retryable = status === 503 || status === 429 || status >= 500;

  let code: WalletPassError["code"];
  if (status === 403) code = "not_owner";
  else if (isWalletPassErrorCode(bodyCode)) code = bodyCode;
  else if (status === 503) code = "read_failed";
  else if (status === 404) code = "not_found";
  else code = "network";

  const message =
    status === 403
      ? "this account is not entitled to the pass for this token"
      : status === 503
        ? "the issuer could not verify ownership right now; try again shortly"
        : `issuer refused the request (HTTP ${status}${bodyCode ? `, ${bodyCode}` : ""})`;
  return new WalletPassClientError(code, message, {
    status,
    source: "server",
    retryable,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    ...(challenge !== undefined ? { challenge } : {}),
    ...(bodyCode !== undefined ? { serverCode: bodyCode } : {}),
    body,
  });
}
