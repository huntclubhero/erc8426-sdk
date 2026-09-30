"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createWalletClient, custom, http, type Account, type Address, type Chain, type EIP1193Provider, type Transport, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { fromWalletClient, type WalletPassSigner } from "@erc8426/client";

import { shortHex } from "@/lib/pet";
import { useApp } from "./Providers";

type Kind = "injected" | "dev";

interface WalletContextValue {
  kind: Kind | null;
  address: Address | null;
  signer: WalletPassSigner | null;
  walletClient: WalletClient<Transport, Chain, Account> | null;
  hasInjected: boolean;
  busy: boolean;
  error: string | null;
  connectInjected(): Promise<void>;
  connectDev(): Promise<void>;
  disconnect(): void;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet outside WalletProvider");
  return ctx;
}

/// The dev wallet key lives in localStorage on purpose: it is a throwaway
/// burner for a local anvil chain, funded by a faucet that refuses any other
/// chain. Never do this with a key that matters.
const DEV_KEY = "erc8426-example:dev-wallet-key";

function injected(): EIP1193Provider | undefined {
  return typeof window === "undefined" ? undefined : (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const { chain, config } = useApp();
  const [kind, setKind] = useState<Kind | null>(null);
  const [walletClient, setWalletClient] = useState<WalletClient<Transport, Chain, Account> | null>(null);
  const [hasInjected, setHasInjected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connectDev = useCallback(async () => {
    if (!config.devWallet) return;
    setBusy(true);
    setError(null);
    try {
      let key = window.localStorage.getItem(DEV_KEY) as `0x${string}` | null;
      if (!key) {
        key = generatePrivateKey();
        window.localStorage.setItem(DEV_KEY, key);
      }
      const account = privateKeyToAccount(key);
      const res = await fetch("/api/dev/fund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: account.address }),
      });
      if (!res.ok) throw new Error("The dev faucet refused. Is this a local anvil chain?");
      setWalletClient(createWalletClient({ account, chain, transport: http("/api/rpc") }));
      setKind("dev");
      window.localStorage.setItem("erc8426-example:wallet", "dev");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [chain, config.devWallet]);

  const connectInjected = useCallback(async () => {
    const eth = injected();
    if (!eth) {
      setError("No browser wallet found.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const probe = createWalletClient({ chain, transport: custom(eth) });
      const [address] = await probe.requestAddresses();
      if (!address) throw new Error("The wallet returned no account.");
      try {
        await probe.switchChain({ id: chain.id });
      } catch {
        // Unknown chain in the wallet: add it, pointing at this app's proxy.
        await probe.addChain({
          chain: { ...chain, rpcUrls: { default: { http: [`${window.location.origin}/api/rpc`] } } },
        });
      }
      setWalletClient(createWalletClient({ account: address, chain, transport: custom(eth) }) as WalletClient<Transport, Chain, Account>);
      setKind("injected");
      window.localStorage.setItem("erc8426-example:wallet", "injected");
    } catch (e) {
      setError((e as Error).message.split("\n")[0] ?? "Could not connect.");
    } finally {
      setBusy(false);
    }
  }, [chain]);

  const disconnect = useCallback(() => {
    setWalletClient(null);
    setKind(null);
    window.localStorage.removeItem("erc8426-example:wallet");
  }, []);

  // Detect a browser wallet and restore the last choice, after mount only.
  useEffect(() => {
    setHasInjected(Boolean(injected()));
    const last = window.localStorage.getItem("erc8426-example:wallet");
    if (last === "dev" && config.devWallet) void connectDev();
    // An injected wallet is not reconnected silently; the user clicks again.
  }, [config.devWallet, connectDev]);

  const signer = useMemo(() => (walletClient ? fromWalletClient(walletClient) : null), [walletClient]);
  return (
    <WalletContext.Provider
      value={{
        kind,
        address: walletClient?.account.address ?? null,
        signer,
        walletClient,
        hasInjected,
        busy,
        error,
        connectInjected,
        connectDev,
        disconnect,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function ConnectButton() {
  const w = useWallet();
  const { config } = useApp();
  if (w.address) {
    return (
      <div className="wallet">
        <span className="wallet-address" title={w.address}>
          {w.kind === "dev" ? <span className="tag tag-warn">Dev wallet</span> : null} {shortHex(w.address)}
        </span>
        <button type="button" className="btn btn-quiet" onClick={w.disconnect}>
          Disconnect
        </button>
      </div>
    );
  }
  return (
    <div className="wallet">
      <button type="button" className="btn" onClick={() => void w.connectInjected()} disabled={w.busy || !w.hasInjected} title={w.hasInjected ? undefined : "No browser wallet detected"}>
        Connect wallet
      </button>
      {config.devWallet ? (
        <button type="button" className="btn btn-quiet" onClick={() => void w.connectDev()} disabled={w.busy}>
          Use dev wallet
        </button>
      ) : null}
      {w.error ? (
        <span role="alert" className="error-text">
          {w.error}
        </span>
      ) : null}
    </div>
  );
}

/// A prompt shown in place of wallet-only content.
export function NeedWallet({ what }: { what: string }) {
  const { config } = useApp();
  return (
    <div className="notice">
      <p>Connect a wallet to {what}.</p>
      {config.devWallet ? (
        <p className="muted">
          No browser wallet? <strong>Use dev wallet</strong> creates a throwaway key in this browser and funds it on the local chain. It is for local development only and is disabled on any other chain.
        </p>
      ) : null}
      <ConnectButton />
    </div>
  );
}
