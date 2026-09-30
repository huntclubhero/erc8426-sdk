import { getAddress, type Address } from "viem";
import { createSiweMessage, generateSiweNonce, parseSiweMessage } from "viem/siwe";

import { actionUrn, assetId, parseActionUrn, parseAssetId, type TokenRef } from "./caip.js";

/// Everything the challenge floor requires (Authorization of pass-reachable
///  actions, check 1), plus the SIWE fields that carry it.
export interface ChallengeParams {
  /// Verifier identity: the SIWE `domain` on the first line.
  domain: string;
  /// The RFC 3986 URI that is the subject of the signing (SIWE `URI`).
  uri: string;
  /// The claimed account (SIWE `address`).
  account: Address;
  /// The token the proof is scoped to, carried as the first resource.
  token: TokenRef;
  /// The action the proof is scoped to, carried as the second resource.
  action: string;
  /// Single-use nonce issued by the verifier. At least 8 alphanumerics (SIWE).
  nonce: string;
  issuedAt: Date;
  expirationTime: Date;
  /// Optional override for the human statement line. Defaults to the wording
  ///  of the spec's worked example.
  statement?: string;
}

/// The statement line of the spec's worked example:
///  "Authorize the feed action for wallet pass token 412 on issuer.example."
export function defaultStatement(action: string, tokenId: string, domain: string): string {
  return `Authorize the ${action} action for wallet pass token ${tokenId} on ${domain}.`;
}

/// Serialize a challenge as an ERC-4361 message, the RECOMMENDED form. The
///  token is the first resource (CAIP-19) and the action the second (URN), in
///  the fixed places the spec's example gives them.
export function buildChallenge(params: ChallengeParams): string {
  if (params.expirationTime.getTime() <= params.issuedAt.getTime()) {
    throw new Error("expirationTime must be after issuedAt");
  }
  return createSiweMessage({
    domain: params.domain,
    address: getAddress(params.account),
    statement: params.statement ?? defaultStatement(params.action, params.token.tokenId, params.domain),
    uri: params.uri,
    version: "1",
    chainId: params.token.chainId,
    nonce: params.nonce,
    issuedAt: params.issuedAt,
    expirationTime: params.expirationTime,
    resources: [assetId(params.token), actionUrn(params.action)],
  });
}

/// A parsed challenge. `token` and `action` are null when the message does not
///  carry them in a recognizable form; a verifier refuses such a message.
export interface ParsedChallenge {
  domain: string;
  address: Address;
  uri: string | undefined;
  chainId: number;
  nonce: string;
  statement: string | undefined;
  issuedAt: Date | undefined;
  expirationTime: Date | undefined;
  notBefore: Date | undefined;
  resources: string[];
  token: TokenRef | null;
  action: string | null;
}

/// Parse an ERC-4361 challenge. Returns null when the message lacks any field
///  the floor needs (domain, address, chain id, nonce). Callers still compare
///  every field against what they hold: parsing is not verification.
export function parseChallenge(message: string): ParsedChallenge | null {
  let parsed: ReturnType<typeof parseSiweMessage>;
  try {
    parsed = parseSiweMessage(message);
  } catch {
    return null;
  }
  if (!parsed.domain || !parsed.address || parsed.chainId === undefined || !parsed.nonce) return null;
  const resources = parsed.resources ?? [];
  const tokens = resources.map(parseAssetId).filter((t): t is TokenRef => t !== null);
  const actions = resources.map(parseActionUrn).filter((a): a is string => a !== null);
  return {
    domain: parsed.domain,
    address: getAddress(parsed.address),
    uri: parsed.uri,
    chainId: parsed.chainId,
    nonce: parsed.nonce,
    statement: parsed.statement,
    issuedAt: parsed.issuedAt,
    expirationTime: parsed.expirationTime,
    notBefore: parsed.notBefore,
    resources,
    // Exactly one token and one action, or the scope is ambiguous.
    token: tokens.length === 1 ? tokens[0]! : null,
    action: actions.length === 1 ? actions[0]! : null,
  };
}

/// A SIWE-compatible single-use nonce (alphanumeric, 96 characters of entropy
///  headroom from viem's generator).
export function generateNonce(): string {
  return generateSiweNonce();
}
