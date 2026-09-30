import { isAddressEqual, type Address } from "viem";
import { parseChallenge, sameToken, type ParsedChallenge, type TokenRef } from "@erc8426/core";

/// What the user asked to sign for. The challenge an issuer returns must be
///  scoped to exactly this before the SDK lets a signer see it.
export interface ExpectedScope {
  token: TokenRef;
  action: string;
  account: Address;
  /// Acceptable SIWE `domain` values. Normally the host of the URL the
  ///  challenge was fetched from.
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
  if (!parsed.token || !sameToken(parsed.token, expected.token)) {
    return { ok: false, code: "binding_mismatch", detail: "challenge does not name exactly the requested token" };
  }
  if (parsed.action !== expected.action) {
    return { ok: false, code: "binding_mismatch", detail: `challenge action is ${parsed.action ?? "missing"}, not ${expected.action}` };
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

/// The SIWE domains a challenge fetched from `url` may name: its host with
///  and without the port.
export function domainsForUrl(url: string): string[] {
  const u = new URL(url);
  return u.host === u.hostname ? [u.host] : [u.host, u.hostname];
}
