import { getAddress, isAddress, type Address } from "viem";

import { ACTION_URN_PREFIX } from "./constants.js";

/// Token ids travel as canonical decimal strings so ids above 2^53 survive.
export type TokenId = string;

/// The (chain, contract, token) triple a challenge and a capability link bind.
export interface TokenRef {
  chainId: number;
  contract: Address;
  tokenId: TokenId;
}

export function normalizeTokenId(value: string | number | bigint): TokenId {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error(`invalid token id: ${value} is not a safe integer, pass a bigint or string`);
  }
  const asString = typeof value === "string" ? value.trim() : value.toString();
  if (!/^[0-9]+$/.test(asString)) throw new Error(`invalid token id: ${asString}`);
  // Canonical decimal with no leading zeros, so "007" and "7" can never
  // produce two different asset ids for one token.
  return BigInt(asString).toString();
}

export function tokenRef(chainId: number, contract: string, tokenId: string | number | bigint): TokenRef {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error(`invalid chain id: ${chainId}`);
  if (!isAddress(contract, { strict: false })) throw new Error(`invalid contract address: ${contract}`);
  return { chainId, contract: getAddress(contract), tokenId: normalizeTokenId(tokenId) };
}

/// CAIP-19 asset id for an ERC-721 token, with the contract checksummed so the
///  string built at issuance matches the one recomputed at verification byte
///  for byte. Example: eip155:1/erc721:0x5F9B...c2e1/412
export function assetId(ref: TokenRef): string;
export function assetId(chainId: number, contract: string, tokenId: string | number | bigint): string;
export function assetId(a: TokenRef | number, contract?: string, tokenId?: string | number | bigint): string {
  const ref =
    typeof a === "number"
      ? tokenRef(a, contract as string, tokenId as string | number | bigint)
      : tokenRef(a.chainId, a.contract, a.tokenId);
  return `eip155:${ref.chainId}/erc721:${ref.contract}/${ref.tokenId}`;
}

const ASSET_RE = /^eip155:([0-9]+)\/erc721:(0x[0-9a-fA-F]{40})\/([0-9]+)$/;

/// Parse a CAIP-19 ERC-721 asset id. Returns null for anything else.
export function parseAssetId(value: string): TokenRef | null {
  const m = ASSET_RE.exec(value);
  if (!m) return null;
  try {
    return tokenRef(Number(m[1]), m[2]!, m[3]!);
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

export function sameToken(a: TokenRef, b: TokenRef): boolean {
  return (
    a.chainId === b.chainId &&
    a.contract.toLowerCase() === b.contract.toLowerCase() &&
    normalizeTokenId(a.tokenId) === normalizeTokenId(b.tokenId)
  );
}
