import type { Account, Address, Chain, Hex, Transport, WalletClient } from "viem";

/// Anything that can sign an ERC-4361 challenge for one account. A viem
///  LocalAccount (`privateKeyToAccount`, `mnemonicToAccount`) satisfies it as
///  is; wrap a WalletClient (browser wallet, embedded signer) with
///  `fromWalletClient`.
export interface WalletPassSigner {
  address: Address;
  signMessage(args: { message: string }): Promise<Hex>;
}

/// Adapt a viem WalletClient to a WalletPassSigner. The account is the
///  client's hoisted account unless one is given, since a challenge is issued
///  to one claimed account and must be signed by that same account.
export function fromWalletClient<TTransport extends Transport, TChain extends Chain | undefined>(
  walletClient: WalletClient<TTransport, TChain, Account | undefined>,
  account?: Address | Account,
): WalletPassSigner {
  const chosen = account ?? walletClient.account;
  if (!chosen) {
    throw new Error("fromWalletClient: the wallet client has no account; pass one explicitly");
  }
  const address = typeof chosen === "string" ? chosen : chosen.address;
  return {
    address,
    signMessage: ({ message }) => walletClient.signMessage({ account: chosen, message }),
  };
}
