import { useCallback, useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import {
  detectPlatform,
  passUpdateCovers,
  type AddToWalletResult,
  type FormatKey,
  type PassUpdateNotice,
  type WalletPassSigner,
  type WalletPlatform,
} from "@erc8426/client";

import { useWalletPassClient } from "./context.js";

export type AsyncStatus = "idle" | "loading" | "success" | "error";

/// Navigate the page to an acquisition URL. A .pkpass response hands off to
///  Wallet and a Save to Google Wallet link opens the save flow, so a plain
///  top-level navigation is the right primitive for both.
export function defaultNavigate(url: string): void {
  if (typeof window !== "undefined") window.location.assign(url);
}

/// ERC-165 support for a contract. `supported` is undefined until the check
///  has run. The check runs in an effect, never during render.
export function useSupportsWalletPass(contract: Address | string | undefined) {
  const client = useWalletPassClient();
  const [state, setState] = useState<{ status: AsyncStatus; supported: boolean | undefined; error: Error | null }>({
    status: "idle",
    supported: undefined,
    error: null,
  });
  useEffect(() => {
    if (!contract) {
      setState({ status: "idle", supported: undefined, error: null });
      return;
    }
    let cancelled = false;
    setState({ status: "loading", supported: undefined, error: null });
    client.supportsWalletPass(contract).then(
      (supported) => !cancelled && setState({ status: "success", supported, error: null }),
      (error: Error) => !cancelled && setState({ status: "error", supported: undefined, error }),
    );
    return () => {
      cancelled = true;
    };
  }, [client, contract]);
  return state;
}

/// The platform of the current device, detected after mount so that server
///  and first client render agree (both null).
export function useDetectedPlatform(): WalletPlatform | null {
  const [platform, setPlatform] = useState<WalletPlatform | null>(null);
  useEffect(() => {
    setPlatform(detectPlatform(typeof navigator !== "undefined" ? navigator.userAgent : undefined));
  }, []);
  return platform;
}

export interface UseWalletPassOptions {
  contract: Address | string;
  tokenId: bigint | number | string;
  /// Required for gated passes; ignored by public ones.
  signer?: WalletPassSigner | null;
  /// Force a platform instead of detecting it.
  platform?: FormatKey;
  /// Also check ERC-165 support on mount. Off by default to save an RPC call
  ///  when the caller already knows the contract is compliant.
  checkSupport?: boolean;
  /// Override navigation (tests, in-app browsers, custom routing).
  navigate?: (url: string) => void;
  /// Called after navigation starts.
  onAdded?: (result: AddToWalletResult) => void;
  /// Called with every failure of `addToWallet`.
  onError?: (error: Error) => void;
}

export type WalletPassStatus = "idle" | "adding" | "added" | "error";

export interface UseWalletPassResult {
  status: WalletPassStatus;
  /// ERC-165 result when `checkSupport` is on, otherwise undefined.
  supported: boolean | undefined;
  /// The forced platform, or the detected one after mount.
  platform: FormatKey | null;
  error: Error | null;
  /// Fetch the manifest now (never earlier: Client requirements), pick the
  ///  platform's URL and navigate to it. Resolves to the result, or null on
  ///  failure (the error is also in `error`).
  addToWallet: () => Promise<AddToWalletResult | null>;
  reset: () => void;
}

export function useWalletPass(options: UseWalletPassOptions): UseWalletPassResult {
  const client = useWalletPassClient();
  const detected = useDetectedPlatform();
  const support = useSupportsWalletPass(options.checkSupport ? options.contract : undefined);
  const [status, setStatus] = useState<WalletPassStatus>("idle");
  const [error, setError] = useState<Error | null>(null);
  // The latest options, read at click time so a changed signer is honoured
  // without re-creating the callback on every render.
  const latest = useRef(options);
  latest.current = options;
  const inFlight = useRef(false);

  const addToWallet = useCallback(async () => {
    if (inFlight.current) return null;
    inFlight.current = true;
    const o = latest.current;
    setStatus("adding");
    setError(null);
    try {
      const result = await client.addToWallet(
        { contract: o.contract, tokenId: o.tokenId },
        {
          ...(o.signer ? { signer: o.signer } : {}),
          ...(o.platform ? { platform: o.platform } : {}),
        },
      );
      (o.navigate ?? defaultNavigate)(result.url);
      setStatus("added");
      o.onAdded?.(result);
      return result;
    } catch (e) {
      setError(e as Error);
      setStatus("error");
      o.onError?.(e as Error);
      return null;
    } finally {
      inFlight.current = false;
    }
  }, [client]);

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
  }, []);

  return {
    status,
    supported: support.supported,
    platform: options.platform ?? detected,
    error,
    addToWallet,
    reset,
  };
}

export interface UsePassUpdatesOptions {
  /// Only report updates that cover this token.
  tokenId?: bigint | number | string;
  pollingInterval?: number;
  onUpdate?: (update: PassUpdateNotice) => void;
}

/// Subscribe to PassUpdate and BatchPassUpdate for a contract. Returns the
///  latest matching update and a running count, which is enough to re-render
///  a pass preview or refetch pass state.
export function usePassUpdates(contract: Address | string | undefined, options: UsePassUpdatesOptions = {}) {
  const client = useWalletPassClient();
  const [state, setState] = useState<{ lastUpdate: PassUpdateNotice | null; count: number; error: Error | null }>({
    lastUpdate: null,
    count: 0,
    error: null,
  });
  const onUpdate = useRef(options.onUpdate);
  onUpdate.current = options.onUpdate;
  const tokenKey = options.tokenId === undefined ? undefined : BigInt(options.tokenId).toString();

  useEffect(() => {
    if (!contract) return;
    const unwatch = client.watchPassUpdates(
      contract,
      (update) => {
        if (tokenKey !== undefined && !passUpdateCovers(update, tokenKey)) return;
        onUpdate.current?.(update);
        setState((s) => ({ lastUpdate: update, count: s.count + 1, error: null }));
      },
      {
        onError: (error) => setState((s) => ({ ...s, error })),
        ...(options.pollingInterval !== undefined ? { pollingInterval: options.pollingInterval } : {}),
      },
    );
    return unwatch;
  }, [client, contract, tokenKey, options.pollingInterval]);

  return state;
}
