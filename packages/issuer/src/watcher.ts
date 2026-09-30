import type { Address } from "viem";
import { erc721Abi, walletPassAbi } from "@erc8426/core";

import type { Issuer } from "./issuer.js";

/// Live subscriptions that feed the issuer's two chain-driven hooks. They are
///  conveniences: a deployment driven by an indexer webhook (Alchemy,
///  QuickNode, Goldsky) calls `issuer.onTransfer` and `issuer.onPassUpdate`
///  directly and needs neither.
///
///  Rotation on an observed transfer narrows the window in which a previous
///  owner's links remain cryptographically valid. It is not the boundary: the
///  fresh entitlement read refuses those links in the meantime. So a watcher
///  that lags or misses a log degrades hygiene, never authorization.

/// The part of a viem PublicClient the watchers use, typed structurally.
export interface WatchEventClient {
  watchContractEvent(parameters: any): () => void;
}

interface EventLog {
  eventName?: string;
  removed?: boolean;
  args: Record<string, unknown>;
}

export interface WatchOptions {
  client: WatchEventClient;
  issuer: Pick<Issuer, "config" | "onTransfer" | "onPassUpdate">;
  /// Called for a failed hook or subscription error. Default console.error.
  onError?(error: unknown): void;
  /// Forwarded to viem (polling transports).
  pollingInterval?: number;
}

const report = (e: unknown) => console.error("[erc8426/issuer] watcher", e);

/// Subscribe to ERC-721 Transfer logs of the issuer's contract and call
///  `issuer.onTransfer(tokenId, from, to)` for each, in log order. Returns
///  the unsubscribe function.
export function watchTransfers(options: WatchOptions): () => void {
  const onError = options.onError ?? report;
  return options.client.watchContractEvent({
    address: options.issuer.config.contract,
    abi: erc721Abi,
    eventName: "Transfer",
    pollingInterval: options.pollingInterval,
    onError,
    onLogs: async (logs: EventLog[]) => {
      for (const log of logs) {
        // A log dropped by a reorganization: the rotation it caused already
        // retired links, which is harmless, so nothing is undone.
        if (log.removed) continue;
        const { from, to, tokenId } = log.args as { from: Address; to: Address; tokenId: bigint };
        try {
          await options.issuer.onTransfer(tokenId, from, to);
        } catch (e) {
          onError(e);
        }
      }
    },
  });
}

/// Subscribe to PassUpdate and BatchPassUpdate logs of the issuer's contract
///  and call `issuer.onPassUpdate` (the batch range is inclusive of both
///  ends). Returns the unsubscribe function.
export function watchPassUpdates(options: WatchOptions): () => void {
  const onError = options.onError ?? report;
  return options.client.watchContractEvent({
    address: options.issuer.config.contract,
    abi: walletPassAbi,
    pollingInterval: options.pollingInterval,
    onError,
    onLogs: async (logs: EventLog[]) => {
      for (const log of logs) {
        if (log.removed) continue;
        try {
          if (log.eventName === "PassUpdate") {
            await options.issuer.onPassUpdate(log.args.tokenId as bigint);
          } else if (log.eventName === "BatchPassUpdate") {
            await options.issuer.onPassUpdate(log.args.fromTokenId as bigint, log.args.toTokenId as bigint);
          }
        } catch (e) {
          onError(e);
        }
      }
    },
  });
}
