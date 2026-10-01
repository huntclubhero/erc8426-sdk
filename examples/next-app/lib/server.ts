import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { after } from "next/server";
import { assetId, erc721Abi, walletPassAbi, type PassContent } from "@erc8426/core";
import {
  ActionError,
  createIssuer,
  kvStores,
  watchPassUpdates,
  watchTransfers,
  type ActionDefinition,
  type Issuer,
  type IssuerProvider,
} from "@erc8426/issuer";

import petPassFullAbi from "@erc8426/contracts/abi/PetPass.json";

import type { Redis } from "@upstash/redis";

import { loadConfig, type ServerConfig } from "./config";
import { redisApplePassStore, redisFromEnv, redisGoogleObjectStore, upstashKv, withLock } from "./kv";
import { CARE_ACTIONS, petPassAbi, type CareAction } from "./petAbi";
import { mood, petColor, petName, relativeTime, shortHex, type PetState } from "./pet";
import { previewProvider } from "./previewProvider";

/// Everything the server holds for one configuration. Kept on globalThis so
/// Next.js dev reloads and separate route bundles share one issuer: its
/// in-memory stores (nonces, links, pass records) must be a single instance,
/// or a nonce spent in one copy would stay live in another.
export interface Runtime {
  config: ServerConfig;
  chain: Chain;
  publicClient: PublicClient;
  operator: WalletClient<Transport, Chain, Account>;
  issuer: Issuer;
  /// Serializes operator transactions so concurrent requests never race on
  ///  the nonce: in process, and across instances through a Redis lease.
  ///  `fn` gets the nonce to send with and must send exactly one
  ///  transaction with it.
  withOperator<T>(fn: (nonce: number) => Promise<T>): Promise<T>;
  /// The shared store on serverless hosts, or null for a single process.
  redis: Redis | null;
  /// Key prefix for everything this deployment keeps in Redis.
  prefix: string;
  /// Catch the issuer up with Transfer and PassUpdate logs since the last
  ///  call. Stands in for the watchers where no process lives long enough
  ///  to run them.
  sync(): Promise<{ from: string; to: string; transfers: number; updates: number } | null>;
}

const g = globalThis as unknown as { __erc8426Example?: { key: string; runtime: Promise<Runtime> } };

export function getRuntime(): Promise<Runtime> {
  const loaded = loadConfig();
  if (!loaded.ok) return Promise.reject(new Error(loaded.error));
  const key = `${loaded.config.chainId}:${loaded.config.contract}:${loaded.config.rpcUrl}`;
  if (g.__erc8426Example?.key !== key) {
    g.__erc8426Example = { key, runtime: createRuntime(loaded.config) };
    g.__erc8426Example.runtime.catch(() => {
      g.__erc8426Example = undefined;
    });
  }
  return g.__erc8426Example.runtime;
}

export async function readPet(publicClient: PublicClient, contract: Address, tokenId: bigint): Promise<PetState | null> {
  try {
    const [owner, pet, needs, diesAt, alive] = await Promise.all([
      publicClient.readContract({ address: contract, abi: petPassAbi, functionName: "ownerOf", args: [tokenId] }),
      publicClient.readContract({ address: contract, abi: petPassAbi, functionName: "pet", args: [tokenId] }),
      publicClient.readContract({ address: contract, abi: petPassAbi, functionName: "needs", args: [tokenId] }),
      publicClient.readContract({ address: contract, abi: petPassAbi, functionName: "diesAt", args: [tokenId] }),
      publicClient.readContract({ address: contract, abi: petPassAbi, functionName: "isAlive", args: [tokenId] }),
    ]);
    return {
      tokenId: tokenId.toString(),
      owner,
      alive,
      hunger: Number(needs[0]),
      thirst: Number(needs[1]),
      boredom: Number(needs[2]),
      cares: pet.cares,
      diesAt: Number(diesAt),
      lastFed: Number(pet.lastFed),
      lastWatered: Number(pet.lastWatered),
      lastPlayed: Number(pet.lastPlayed),
    };
  } catch (e) {
    if (e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError)) return null;
    throw e;
  }
}

/// The revert name inside a viem error, for example "PetIsDead".
function revertName(e: unknown): string | undefined {
  if (!(e instanceof BaseError)) return undefined;
  const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
}

/// The care functions plus every custom error PetPass can revert with, so a
/// simulation failure decodes to a name like BoundedActionWindowCapExceeded.
const careAbi = [...petPassAbi, ...(petPassFullAbi as unknown as Array<{ type: string }>).filter((x) => x.type === "error")] as unknown as typeof petPassAbi;

const CARE_LABEL: Record<CareAction, string> = { feed: "Feed", water: "Water", play: "Play" };

async function createRuntime(config: ServerConfig): Promise<Runtime> {
  const chain = defineChain({
    id: config.chainId,
    name: config.chainId === 31337 ? "Local anvil" : `Chain ${config.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl), pollingInterval: 1_000 }) as PublicClient;
  const operator = createWalletClient({ account: privateKeyToAccount(config.operatorKey), chain, transport: http(config.rpcUrl) });

  const redis = redisFromEnv();
  const prefix = `erc8426-demo:${config.chainId}:${config.contract.toLowerCase()}:`;

  // The nonce is chosen under the lock as the larger of the chain's pending
  // count and the next nonce this deployment recorded. A load-balanced RPC
  // can answer the pending count from a node that has not seen the previous
  // transaction yet, so the chain alone is not enough across instances.
  const nonceKey = `${prefix}operator-nonce`;
  const isNonceError = (e: unknown) => /nonce/i.test((e as Error)?.message ?? "");
  const sendWithNonce = async <T>(fn: (nonce: number) => Promise<T>): Promise<T> => {
    const address = operator.account.address;
    for (let attempt = 0; ; attempt++) {
      const chainNonce = await publicClient.getTransactionCount({ address, blockTag: "pending" });
      const stored = redis ? Number((await redis.get<string>(nonceKey)) ?? 0) : 0;
      const nonce = Math.max(chainNonce, stored);
      try {
        const result = await fn(nonce);
        if (redis) await redis.set(nonceKey, String(nonce + 1));
        return result;
      } catch (e) {
        if (!isNonceError(e) || attempt >= 2) throw e;
        // Too low: someone (another instance, or a lagging read) moved on.
        // Record that this nonce is spent and try the next one.
        if (redis) await redis.set(nonceKey, String(nonce + 1));
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  };
  let queue: Promise<unknown> = Promise.resolve();
  const withOperator = <T>(fn: (nonce: number) => Promise<T>): Promise<T> => {
    const send = () => sendWithNonce(fn);
    const locked = redis ? () => withLock(redis, `${prefix}operator-lock`, send) : send;
    const run = queue.then(locked, locked);
    queue = run.catch(() => undefined);
    return run;
  };

  // Each care is relayed by the operator, which the contract holds to the
  // BoundedAction limit (4 of each per pet per day, no value). That on-chain
  // bound is what makes these safe as capability links.
  const care = (action: CareAction): ActionDefinition => ({
    description: `${CARE_LABEL[action]} the pet`,
    capability: true,
    bound: `At most 4 ${action} actions per pet per day, enforced on chain by BoundedAction. Moves no tokens and no value, and cannot transfer, approve or change who owns the pet.`,
    async execute({ token, notifyUpdate }) {
      const tokenId = BigInt(token.tokenId);
      let hash: Hex;
      try {
        hash = await withOperator(async (nonce) => {
          const { request } = await publicClient.simulateContract({
            account: operator.account,
            address: config.contract,
            abi: careAbi,
            functionName: action,
            args: [tokenId],
          });
          return operator.writeContract({ ...request, nonce });
        });
      } catch (e) {
        const name = revertName(e);
        if (name === "PetIsDead") throw new ActionError(409, "pet_lapsed", "This pet has lapsed and can no longer be cared for.");
        if (name?.startsWith("BoundedAction")) {
          throw new ActionError(429, "bound_reached", `The on-chain bound for ${action} is used up for today (${name}).`);
        }
        throw new ActionError(502, "action_failed", "The care transaction could not be sent.");
      }
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      // The watcher also sees the PassUpdate this emits; bumping here makes
      // the updated pass visible without waiting for the next poll.
      await notifyUpdate();
      return { action, transactionHash: hash, blockNumber: receipt.blockNumber.toString() };
    },
  });

  const render: Parameters<typeof createIssuer>[0]["render"] = async ({ token, owner, serial, links, superseded, updatedAt }) => {
    const state = await readPet(publicClient, config.contract, BigInt(token.tokenId));
    const name = petName(token.tokenId);
    const content: PassContent = {
      serial,
      style: "generic",
      organizationName: "ERC-8426 Pet Pass",
      description: `${name}, pet #${token.tokenId}`,
      title: "Pet Pass",
      headline: name,
      colors: { background: petColor(token.tokenId), foreground: "#ffffff", label: "#e8e8ee" },
      header: [{ key: "token", label: "PET", value: `#${token.tokenId}` }],
      primary: [
        {
          key: "mood",
          label: superseded ? "STATUS" : "MOOD",
          value: superseded ? "Transferred" : state ? mood(state) : "Unknown",
          changeMessage: "Your pet is now %@",
        },
      ],
      secondary: state
        ? [
            { key: "hunger", label: "HUNGER", value: `${state.hunger}%` },
            { key: "thirst", label: "THIRST", value: `${state.thirst}%` },
            { key: "boredom", label: "BOREDOM", value: `${state.boredom}%` },
          ]
        : [],
      auxiliary: state
        ? [
            { key: "cares", label: "CARES", value: state.cares },
            { key: "lapses", label: state.alive ? "LAPSES" : "LAPSED", value: relativeTime(state.diesAt) },
          ]
        : [],
      back: [
        { key: "contract", label: "Issuing contract", value: config.contract },
        { key: "chain", label: "Chain", value: String(config.chainId) },
        { key: "owner", label: "Issued to", value: shortHex(owner) },
        { key: "updated", label: "Content updated", value: new Date(updatedAt * 1000).toISOString() },
        {
          key: "about",
          label: "About this pass",
          value:
            "A projection of the token, not the token. The links below care for this pet through the issuer, which checks the current owner on chain before every action. Anyone holding this pass can use them until the owner resets the links.",
        },
      ],
      links: CARE_ACTIONS.filter((a) => links[a]).map((a) => ({ key: a, label: CARE_LABEL[a], url: links[a]! })),
      barcode: { format: "qr", message: assetId(config.chainId, config.contract, token.tokenId), altText: `Pet #${token.tokenId}` },
    };
    if (state && !state.alive) content.expiresAt = new Date(state.diesAt * 1000);
    return content;
  };

  const providers: IssuerProvider[] = [previewProvider()];
  if (config.apple) {
    const { appleProvider } = await import("./appleProvider");
    providers.push(appleProvider(config, redis ? redisApplePassStore(redis, prefix) : undefined));
  }
  if (config.google) {
    const { googleProvider } = await import("./googleProvider");
    providers.push(googleProvider(config, redis ? redisGoogleObjectStore(redis, prefix) : undefined));
  }

  const issuer = createIssuer({
    domain: config.domain,
    baseUrl: config.baseUrl,
    chainId: config.chainId,
    contract: config.contract,
    mode: "gated",
    publicClient,
    ...(redis ? { stores: kvStores(upstashKv(redis), { prefix: `${prefix}issuer:` }) } : {}),
    providers,
    render,
    capability: { enabled: true },
    actions: Object.fromEntries(CARE_ACTIONS.map((a) => [a, care(a)])),
  });

  // Rotation on an observed transfer, and pushes on PassUpdate. The fresh
  // ownership read is the boundary either way; these keep links tidy.
  if (config.watchers) {
    watchTransfers({ client: publicClient, issuer, pollingInterval: 1_000 });
    watchPassUpdates({ client: publicClient, issuer, pollingInterval: 1_000 });
  }

  // Serverless catch-up: the same two hooks, driven from the logs between a
  // stored cursor and the head. Bounded per call so one request never scans
  // the whole chain; the next call continues where this one stopped.
  const SYNC_SPAN = 20_000n;
  let memoryCursor = config.deployBlock;
  // With Redis, one lease key is both the lock and the throttle: it is never
  // released, so at most one sync runs per SYNC_EVERY seconds across every
  // instance. That keeps a busy demo inside a free Upstash plan (one SET per
  // request, a handful of commands per actual sync).
  const SYNC_EVERY = 60;
  const sync = async () => {
    if (redis && (await redis.set(`${prefix}sync-lease`, "1", { nx: true, ex: SYNC_EVERY })) !== "OK") return null;
    {
      const cursorKey = `${prefix}sync-cursor`;
      const stored = redis ? await redis.get<string>(cursorKey) : null;
      const from = stored ? BigInt(stored) : memoryCursor;
      const head = await publicClient.getBlockNumber();
      if (from > head) return { from: from.toString(), to: head.toString(), transfers: 0, updates: 0 };
      const to = head - from > SYNC_SPAN ? from + SYNC_SPAN : head;
      const [transfers, updates] = await Promise.all([
        publicClient.getContractEvents({ address: config.contract, abi: erc721Abi, eventName: "Transfer", fromBlock: from, toBlock: to }),
        publicClient.getContractEvents({ address: config.contract, abi: walletPassAbi, fromBlock: from, toBlock: to }),
      ]);
      for (const log of transfers) {
        const { from: a, to: b, tokenId } = log.args as { from: Address; to: Address; tokenId: bigint };
        await issuer.onTransfer(tokenId, a, b);
      }
      for (const log of updates) {
        const args = log.args as { tokenId?: bigint; fromTokenId?: bigint; toTokenId?: bigint };
        if (log.eventName === "PassUpdate" && args.tokenId !== undefined) await issuer.onPassUpdate(args.tokenId);
        else if (log.eventName === "BatchPassUpdate" && args.fromTokenId !== undefined) await issuer.onPassUpdate(args.fromTokenId, args.toTokenId);
      }
      const next = to + 1n;
      if (redis) await redis.set(cursorKey, next.toString());
      else memoryCursor = next;
      return { from: from.toString(), to: to.toString(), transfers: transfers.length, updates: updates.length };
    }
  };

  return { config, chain, publicClient, operator, issuer, withOperator, redis, prefix, sync };
}

/// On serverless hosts (no watchers), catch up with the chain after the
/// response is sent, so transfers made outside this app still rotate links
/// and push passes without a cron.
export function syncAfter(rt: Runtime): void {
  if (rt.config.watchers) return;
  after(() => rt.sync().then(() => undefined, (e: Error) => console.warn(`[sync] ${e.message}`)));
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), {
    ...init,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...init.headers },
  });
}
