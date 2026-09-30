// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeEventLog,
  http,
  parseEther,
  type Abi,
  type Address,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
  type Transport,
  type Chain,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { walletPassAbi, erc721Abi } from "@erc8426/core";

const require = createRequire(import.meta.url);

/// A deployable artifact exported by @erc8426/contracts (`artifacts/<Name>.json`).
export interface Artifact {
  contractName: string;
  abi: Abi;
  bytecode: Hex;
}

export function artifact(name: string): Artifact {
  const path = require.resolve(`@erc8426/contracts/artifacts/${name}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as Artifact;
}

/// One person or service in the story, with a key generated at runtime.
export interface Actor {
  name: string;
  account: PrivateKeyAccount;
  address: Address;
  wallet: WalletClient<Transport, Chain, PrivateKeyAccount>;
}

/// Receives the pass freshness events and transfers found in receipts. In
///  production this is an indexer webhook or `watchTransfers` /
///  `watchPassUpdates`; the demos forward straight from receipts so the
///  narrative is deterministic.
export interface ChainIndexer {
  onTransfer(contract: Address, tokenId: bigint, from: Address, to: Address): Promise<void>;
  onPassUpdate(contract: Address, fromTokenId: bigint, toTokenId: bigint): Promise<void>;
  onLog?(contract: Address, eventName: string, args: Record<string, unknown>): Promise<void>;
}

export interface Chain8426 {
  rpcUrl: string;
  publicClient: PublicClient<Transport, Chain>;
  /// Create an actor with a fresh random key and 100 test ETH.
  actor(name: string): Promise<Actor>;
  /// Deploy an @erc8426/contracts artifact by name, or any artifact object.
  deploy(from: Actor, contract: string | Artifact, args: readonly unknown[]): Promise<Address>;
  /// Send a transaction, wait for it, and forward freshness events.
  send(from: Actor, address: Address, abi: Abi, functionName: string, args: readonly unknown[], value?: bigint): Promise<TransactionReceipt>;
  read<T>(address: Address, abi: Abi, functionName: string, args?: readonly unknown[]): Promise<T>;
  /// Move chain time forward (seconds) and mine a block.
  warp(seconds: number): Promise<void>;
  now(): Promise<bigint>;
  setIndexer(indexer: ChainIndexer): void;
}

export function connect(rpcUrl: string): Chain8426 {
  const chain = { ...foundry, rpcUrls: { default: { http: [rpcUrl] } } } as const;
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain, transport }) as PublicClient<Transport, Chain>;
  const test = createTestClient({ chain, transport, mode: "anvil" });
  let indexer: ChainIndexer | undefined;

  const events = [...walletPassAbi, ...erc721Abi].filter((x) => x.type === "event") as Abi;

  async function forward(receipt: TransactionReceipt, extraAbi: Abi) {
    if (!indexer) return;
    const abi = [...events, ...extraAbi.filter((x) => x.type === "event")] as Abi;
    for (const log of receipt.logs) {
      let decoded: { eventName: string; args: unknown };
      try {
        decoded = decodeEventLog({ abi, data: log.data, topics: log.topics }) as { eventName: string; args: unknown };
      } catch {
        continue;
      }
      const args = (decoded.args ?? {}) as Record<string, unknown>;
      const contract = log.address as Address;
      if (decoded.eventName === "Transfer" && log.topics.length === 4) {
        const from = args.from as Address;
        const to = args.to as Address;
        // Transfers and burns retire the holder's links; a mint has no holder yet.
        if (from !== "0x0000000000000000000000000000000000000000") {
          await indexer.onTransfer(contract, args.tokenId as bigint, from, to);
        }
      } else if (decoded.eventName === "PassUpdate") {
        await indexer.onPassUpdate(contract, args.tokenId as bigint, args.tokenId as bigint);
      } else if (decoded.eventName === "BatchPassUpdate") {
        await indexer.onPassUpdate(contract, args.fromTokenId as bigint, args.toTokenId as bigint);
      }
      if (indexer.onLog) await indexer.onLog(contract, decoded.eventName, args);
    }
  }

  return {
    rpcUrl,
    publicClient,
    async actor(name) {
      const account = privateKeyToAccount(generatePrivateKey());
      await test.setBalance({ address: account.address, value: parseEther("100") });
      const wallet = createWalletClient({ account, chain, transport });
      return { name, account, address: account.address, wallet };
    },
    async deploy(from, contract, args) {
      const a = typeof contract === "string" ? artifact(contract) : contract;
      const name = a.contractName;
      const hash = await from.wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args: args as unknown[] });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (!receipt.contractAddress) throw new Error(`deploy of ${name} failed`);
      return receipt.contractAddress;
    },
    async send(from, address, abi, functionName, args, value) {
      // Simulate first so a revert surfaces as a decoded contract error.
      const { request } = await publicClient.simulateContract({
        account: from.account,
        address,
        abi,
        functionName,
        args: args as unknown[],
        ...(value !== undefined ? { value } : {}),
      });
      const hash = await from.wallet.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
      await forward(receipt, abi);
      return receipt;
    },
    read<T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
      return publicClient.readContract({ address, abi, functionName, args: args as unknown[] }) as Promise<T>;
    },
    async warp(seconds) {
      await test.increaseTime({ seconds });
      await test.mine({ blocks: 1 });
    },
    async now() {
      return (await publicClient.getBlock()).timestamp;
    },
    setIndexer(i) {
      indexer = i;
    },
  };
}

/// The custom error name of a reverted contract call, or null.
export function revertName(error: unknown): string | null {
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) return revert.data?.errorName ?? revert.reason ?? "revert";
  }
  return null;
}

/// Run `fn`, expecting a revert. Returns the custom error name, or throws if
///  the call went through.
export async function expectRevert(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    const name = revertName(e);
    if (name) return name;
    throw e;
  }
  throw new Error("expected the call to revert, but it succeeded");
}
