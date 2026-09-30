import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createWalletPassClient, type WalletPassClient, type WalletPassClientOptions } from "@erc8426/client";

const WalletPassContext = createContext<WalletPassClient | null>(null);

export type WalletPassProviderProps =
  | { client: WalletPassClient; options?: never; children?: ReactNode }
  | { client?: never; options: WalletPassClientOptions; children?: ReactNode };

/// Holds one WalletPassClient for the hooks and the button below it. Pass a
///  client you built, or the options to build one. Creating the client does
///  no I/O, so the provider is safe to render on the server.
export function WalletPassProvider(props: WalletPassProviderProps) {
  const { client, options } = props;
  // Keyed on the collaborators rather than the options object, so an inline
  // `options={{ publicClient }}` does not rebuild the client every render.
  const value = useMemo(
    () => client ?? createWalletPassClient(options as WalletPassClientOptions),
    [client, options?.publicClient, options?.fetch, options?.ipfsGateway, options?.arweaveGateway],
  );
  return <WalletPassContext.Provider value={value}>{props.children}</WalletPassContext.Provider>;
}

/// The client from the nearest WalletPassProvider.
export function useWalletPassClient(): WalletPassClient {
  const client = useContext(WalletPassContext);
  if (!client) throw new Error("useWalletPassClient must be used inside a WalletPassProvider");
  return client;
}
