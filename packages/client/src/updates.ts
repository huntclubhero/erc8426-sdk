import type { Address, Hex, Log } from "viem";

/// One freshness signal, whether it came from PassUpdate or BatchPassUpdate.
///  A single update carries the token id in a list; a batch carries its
///  inclusive range as `{ from, to }` rather than an expanded list, because a
///  batch can span millions of ids.
export interface PassUpdateNotice {
  contract: Address;
  kind: "single" | "batch";
  tokenIds: bigint[] | { from: bigint; to: bigint };
  blockNumber: bigint | null;
  transactionHash: Hex | null;
  logIndex: number | null;
}

/// True when an update covers a token. Batch ranges are inclusive of both
///  ends (Contract interface), and a reversed range is read as the same span.
export function passUpdateCovers(update: PassUpdateNotice, tokenId: bigint | number | string): boolean {
  const id = BigInt(tokenId);
  if (Array.isArray(update.tokenIds)) return update.tokenIds.includes(id);
  const { from, to } = update.tokenIds;
  const lo = from <= to ? from : to;
  const hi = from <= to ? to : from;
  return id >= lo && id <= hi;
}

type DecodedWalletPassLog = Log & {
  eventName?: string;
  args?: { tokenId?: bigint; fromTokenId?: bigint; toTokenId?: bigint };
};

/// Normalize a decoded viem log of either event. Returns null for anything
///  else so a caller can pass mixed logs through.
export function normalizePassUpdateLog(log: DecodedWalletPassLog): PassUpdateNotice | null {
  const base = {
    contract: log.address,
    blockNumber: log.blockNumber ?? null,
    transactionHash: log.transactionHash ?? null,
    logIndex: log.logIndex ?? null,
  };
  if (log.eventName === "PassUpdate" && typeof log.args?.tokenId === "bigint") {
    return { ...base, kind: "single", tokenIds: [log.args.tokenId] };
  }
  if (
    log.eventName === "BatchPassUpdate" &&
    typeof log.args?.fromTokenId === "bigint" &&
    typeof log.args?.toTokenId === "bigint"
  ) {
    return { ...base, kind: "batch", tokenIds: { from: log.args.fromTokenId, to: log.args.toTokenId } };
  }
  return null;
}
