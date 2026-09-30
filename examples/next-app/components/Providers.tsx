"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createPublicClient, defineChain, http, type Chain, type PublicClient } from "viem";
import { WalletPassProvider } from "@erc8426/react";
import { createWalletPassClient } from "@erc8426/client";

import type { PublicConfig } from "@/lib/config";
import { WalletProvider } from "./wallet";

interface AppContextValue {
  config: PublicConfig;
  chain: Chain;
  publicClient: PublicClient;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside Providers");
  return ctx;
}

/// Browser-side plumbing. Chain reads go through /api/rpc, a same-origin
/// proxy, so a testnet RPC key never reaches the page. Nothing here does I/O
/// during render, so it server-renders cleanly.
export function Providers({ config, children }: { config: PublicConfig; children: ReactNode }) {
  const value = useMemo(() => {
    const chain = defineChain({
      id: config.chainId,
      name: config.chainId === 31337 ? "Local anvil" : `Chain ${config.chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: ["/api/rpc"] } },
    });
    const publicClient = createPublicClient({ chain, transport: http("/api/rpc"), pollingInterval: 1_500 }) as PublicClient;
    return { config, chain, publicClient };
  }, [config]);
  const passClient = useMemo(() => createWalletPassClient({ publicClient: value.publicClient }), [value.publicClient]);

  return (
    <AppContext.Provider value={value}>
      <WalletPassProvider client={passClient}>
        <WalletProvider>{children}</WalletProvider>
      </WalletPassProvider>
    </AppContext.Provider>
  );
}
