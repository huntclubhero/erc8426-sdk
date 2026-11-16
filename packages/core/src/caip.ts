import { getAddress, isAddress, type Address } from "viem";

import { ACTION_URN_PREFIX } from "./constants.js";

/// Token ids travel as canonical decimal strings so ids above 2^53 survive.
export type TokenId = string;

/// The largest ERC-721 token id: uint256 max, 2^256 - 1.
export const MAX_TOKEN_ID = (1n << 256n) - 1n;

/// The token standard a reference is read under, which is also its CAIP-19
///  asset namespace.
export type TokenStandard = "erc721" | "erc1155";

/// The (chain, contract, token) triple a challenge and a capability link bind.
export interface TokenRef {
  chainId: number;
  contract: Address;
  tokenId: TokenId;
  /// Absent means "erc721". "erc1155" belongs to the working draft of the
  ///  ERC-1155 binding: there the triple names an id many accounts can hold,
  ///  and entitlement is a balance, not an owner.
  standard?: TokenStandard;
}

/// The standard a reference is read under: "erc721" unless it says otherwise.
export function tokenStandard(ref: Pick<TokenRef, "standard">): TokenStandard {
  return ref.standard ?? "erc721";
}

/// Canonical decimal form of a token id. Throws for anything that is not a
///  non-negative integer in uint256 range: a negative or fractional number, a
///  string with any character but digits, or a value above 2^256 - 1 (such an
///  id cannot exist on chain, and an asset id built from it would never match
///  any token).
export function normalizeTokenId(value: string | number | bigint): TokenId {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error(`invalid token id: ${value} is not a safe integer, pass a bigint or string`);
  }
  const asString = typeof value === "string" ? value.trim() : value.toString();
  if (!/^[0-9]+$/.test(asString)) throw new Error(`invalid token id: ${asString}`);
  // Canonical decimal with no leading zeros, so "007" and "7" can never
  // produce two different asset ids for one token.
  const digits = asString.replace(/^0+(?=[0-9])/, "");
  // uint256 max has 78 decimal digits; a longer string is refused before
  // BigInt parses it, so an oversized request value costs nothing to reject.
  if (digits.length > 78) throw new Error(`invalid token id: ${digits.slice(0, 16)}... exceeds uint256`);
  const id = BigInt(digits);
  if (id > MAX_TOKEN_ID) throw new Error(`invalid token id: ${digits} exceeds uint256`);
  return id.toString();
}

export function tokenRef(
  chainId: number,
  contract: string,
  tokenId: string | number | bigint,
  standard?: TokenStandard,
): TokenRef {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error(`invalid chain id: ${chainId}`);
  if (!isAddress(contract, { strict: false })) throw new Error(`invalid contract address: ${contract}`);
  if (standard !== undefined && standard !== "erc721" && standard !== "erc1155") {
    throw new Error(`invalid token standard: ${String(standard)}`);
  }
  const ref: TokenRef = { chainId, contract: getAddress(contract), tokenId: normalizeTokenId(tokenId) };
  // Only the non-default standard is recorded, so an ERC-721 reference keeps
  // the shape it has always had.
  if (standard === "erc1155") ref.standard = "erc1155";
  return ref;
}

/// CAIP-19 asset id for a token, with the contract checksummed so the string
///  built at issuance matches the one recomputed at verification byte for
///  byte. The namespace is the reference's standard, "erc721" unless it says
///  "erc1155". Example: eip155:1/erc721:0x5F9B...c2e1/412
export function assetId(ref: TokenRef): string;
export function assetId(chainId: number, contract: string, tokenId: string | number | bigint): string;
export function assetId(a: TokenRef | number, contract?: string, tokenId?: string | number | bigint): string {
  const ref =
    typeof a === "number"
      ? tokenRef(a, contract as string, tokenId as string | number | bigint)
      : tokenRef(a.chainId, a.contract, a.tokenId, a.standard);
  return `eip155:${ref.chainId}/${tokenStandard(ref)}:${ref.contract}/${ref.tokenId}`;
}

const ASSET_RE = /^eip155:([0-9]+)\/(erc721|erc1155):(0x[0-9a-fA-F]{40})\/([0-9]+)$/;

/// Parse a CAIP-19 ERC-721 or ERC-1155 asset id. Returns null for anything
///  else. An ERC-1155 id parses to a reference whose `standard` is "erc1155".
export function parseAssetId(value: string): TokenRef | null {
  const m = ASSET_RE.exec(value);
  if (!m) return null;
  try {
    return tokenRef(Number(m[1]), m[3]!, m[4]!, m[2] as TokenStandard);
  } catch {
    return null;
  }
}

const ACTION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/// True for an action name that can be carried in the action URN.
export function isValidActionName(action: string): boolean {
  return ACTION_NAME_RE.test(action);
}

/// Build the action URN, for example urn:wallet-pass:action:feed.
export function actionUrn(action: string): string {
  if (!isValidActionName(action)) throw new Error(`invalid action name: ${action}`);
  return `${ACTION_URN_PREFIX}${action}`;
}

/// Parse an action URN back to its name. Returns null for anything else.
export function parseActionUrn(value: string): string | null {
  if (!value.startsWith(ACTION_URN_PREFIX)) return null;
  const name = value.slice(ACTION_URN_PREFIX.length);
  return isValidActionName(name) ? name : null;
}

/// Two references name the same token only under the same standard: a proof
///  scoped to an ERC-721 token never matches an ERC-1155 id of the same
///  contract and number, or the reverse.
export function sameToken(a: TokenRef, b: TokenRef): boolean {
  return (
    tokenStandard(a) === tokenStandard(b) &&
    a.chainId === b.chainId &&
    a.contract.toLowerCase() === b.contract.toLowerCase() &&
    normalizeTokenId(a.tokenId) === normalizeTokenId(b.tokenId)
  );
}
