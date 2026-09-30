import { isAddressEqual, type Address } from "viem";
import { actionUrn, parseAssetId, parseChallenge, sameToken, type ParsedChallenge, type TokenRef } from "@erc8426/core";

/// What the user asked to sign for. The challenge an issuer returns must be
///  scoped to exactly this before the SDK lets a signer see it.
export interface ExpectedScope {
  token: TokenRef;
  action: string;
  account: Address;
  /// Acceptable SIWE `domain` values. Normally exactly the host (with any
  ///  non-default port) of the URL the proof will be SENT to, since that is
  ///  the verifier the signature is meant for.
  domains: readonly string[];
  now?: Date;
  /// Refuse challenges that stay valid longer than this. A proof is a bearer
  ///  artifact until it expires, so an issuer asking for a long-lived one is
  ///  asking for more than a manifest fetch needs.
  maxTtlSeconds?: number;
}

export type ScopeFailure =
  | "invalid_message"
  | "domain_mismatch"
  | "binding_mismatch"
  | "challenge_expired";

export type ScopeResult =
  | { ok: true; parsed: ParsedChallenge }
  | { ok: false; code: ScopeFailure; detail: string };

export const DEFAULT_MAX_CHALLENGE_TTL_SECONDS = 3600;

/// Check an issuer-supplied challenge against the scope the user asked for.
///  This is the client half of the floor: the verifier checks every field
///  against what it holds, and the client checks every field against what the
///  user intends, so a hostile or buggy issuer cannot get a signature that
///  reaches a different token, action, account or verifier.
export function checkChallengeScope(message: string, expected: ExpectedScope): ScopeResult {
  const parsed = parseChallenge(message);
  if (!parsed) return { ok: false, code: "invalid_message", detail: "challenge is not a parseable ERC-4361 message" };

  const domain = parsed.domain.toLowerCase();
  if (!expected.domains.some((d) => d.toLowerCase() === domain)) {
    return {
      ok: false,
      code: "domain_mismatch",
      detail: `challenge names verifier ${parsed.domain}, expected ${expected.domains.join(" or ")}`,
    };
  }
  if (!isAddressEqual(parsed.address, expected.account)) {
    return { ok: false, code: "binding_mismatch", detail: `challenge is for account ${parsed.address}, not ${expected.account}` };
  }
  if (parsed.chainId !== expected.token.chainId) {
    return { ok: false, code: "binding_mismatch", detail: `challenge chain id ${parsed.chainId} is not ${expected.token.chainId}` };
  }
  // Exactly two resources, in the spec's fixed places: the CAIP-19 token
  // first and the action URN second. Anything more (an EIP-5573 ReCap, say)
  // would let the signature grant capabilities the user never asked for, so
  // an extra resource is refused, not ignored. The statement line is free
  // text for humans and is deliberately not relied on.
  if (parsed.resources.length !== 2) {
    return {
      ok: false,
      code: "binding_mismatch",
      detail: `challenge carries ${parsed.resources.length} resources; exactly the token and the action are allowed`,
    };
  }
  const first = parseAssetId(parsed.resources[0]!);
  if (!first || !sameToken(first, expected.token)) {
    return { ok: false, code: "binding_mismatch", detail: "the first resource is not the requested token" };
  }
  let urn: string;
  try {
    urn = actionUrn(expected.action);
  } catch {
    return { ok: false, code: "binding_mismatch", detail: `invalid action name: ${expected.action}` };
  }
  if (parsed.resources[1] !== urn) {
    return { ok: false, code: "binding_mismatch", detail: `the second resource is ${parsed.resources[1]}, not ${urn}` };
  }

  const now = (expected.now ?? new Date()).getTime();
  if (!parsed.expirationTime) {
    return { ok: false, code: "challenge_expired", detail: "challenge has no Expiration Time" };
  }
  const expiresAt = parsed.expirationTime.getTime();
  if (expiresAt <= now) {
    return { ok: false, code: "challenge_expired", detail: "challenge has already expired" };
  }
  const maxTtl = expected.maxTtlSeconds ?? DEFAULT_MAX_CHALLENGE_TTL_SECONDS;
  if (expiresAt - now > maxTtl * 1000) {
    return { ok: false, code: "challenge_expired", detail: `challenge stays valid longer than ${maxTtl} seconds` };
  }
  return { ok: true, parsed };
}

/// The SIWE domain a proof presented to `url` must name: its host, including
///  a non-default port (URL.host already drops a default one). The port-less
///  host is NOT accepted: another service on another port of the same host
///  is another verifier.
export function domainsForUrl(url: string): string[] {
  return [new URL(url).host];
}
