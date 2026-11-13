import { parseAbi, type Address } from "viem";
import { after } from "next/server";
import { assetId, walletPassAbi, type PassContent } from "@erc8426/core";
import {
  ActionError,
  createIssuer,
  kvRateLimiter,
  kvStores,
  watchPassUpdates,
  watchTransfers1155,
  type Issuer,
  type IssuerProvider,
} from "@erc8426/issuer";
import { appleFormatProvider, createApnsClient, MemoryApplePassStore, type AppleFormatProvider } from "@erc8426/apple";
import { googleFormatProvider, googleWalletClient } from "@erc8426/google";

import type { EditionEnv } from "./config";
import { redisApplePassStore, redisGoogleObjectStore, underLimit, upstashKv } from "./kv";
import { shortHex } from "./pet";
import { solidPng } from "./png";
import { previewProvider } from "./previewProvider";
import { getRuntime, type Runtime } from "./server";

/// The ERC-1155 edition: a second issuer in the same app, for the working
/// draft of the ERC-1155 binding. It shares the chain client, the store and
/// the wallet credentials with the pet issuer and nothing else: its own
/// contract, its own path (/edition-pass), its own records.
///
/// What differs from the pet: there is no "the owner". A pass belongs to a
/// pair, an id and an account, and an account is entitled while a fresh
/// `balanceOf(account, id)` is at least 1. Sending away one unit of three
/// changes nothing; sending the last one retires that account's links.

export const editionAbi = parseAbi([
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function totalSupply(uint256 id) view returns (uint256)",
  "function claimed(uint256 id, address account) view returns (uint256)",
  "function claimLimit() view returns (uint256)",
  "function open(uint256 id) view returns (bool)",
  "function passURI(uint256 id) view returns (string)",
  "function claim(uint256 id, uint256 amount)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)",
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
]);

export const STAMPS_PER_DAY = 5;
const EDITION_COLOR = "#3b2f63";

export interface EditionRuntime {
  rt: Runtime;
  edition: EditionEnv;
  issuer: Issuer;
  apple: AppleFormatProvider | null;
  /// Stamps an account has collected (issuer state, not chain state).
  stamps(account: Address): Promise<number>;
  /// Catch up with the chain: read every issued account's balance, and apply
  ///  transfer and PassUpdate logs since the last call.
  sync(): Promise<{ checked: number; retired: number; transfers: number; updates: number } | null>;
}

const g = globalThis as unknown as { __erc8426Edition?: { key: string; runtime: Promise<EditionRuntime | null> } };

/// Null when no edition is configured.
export async function getEditionRuntime(): Promise<EditionRuntime | null> {
  const rt = await getRuntime();
  if (!rt.config.edition) return null;
  const key = `${rt.config.chainId}:${rt.config.edition.contract}:${rt.config.rpcUrl}`;
  if (g.__erc8426Edition?.key !== key) {
    g.__erc8426Edition = { key, runtime: createEditionRuntime(rt, rt.config.edition) };
    g.__erc8426Edition.runtime.catch(() => {
      g.__erc8426Edition = undefined;
    });
  }
  return g.__erc8426Edition.runtime;
}

async function createEditionRuntime(rt: Runtime, edition: EditionEnv): Promise<EditionRuntime> {
  const { config, publicClient, redis } = rt;
  const prefix = `erc8426-demo:${config.chainId}:${edition.contract.toLowerCase()}:`;
  const id = edition.id.toString();

  // Stamps are the issuer's own record of the account, shown on its pass.
  // They are a count and nothing else: no token and no value moves.
  const memoryStamps = new Map<string, number>();
  const memoryToday = new Map<string, number>();
  const stampKey = (account: Address) => `${prefix}stamps:${account.toLowerCase()}`;
  const stamps = async (account: Address) =>
    redis ? Number((await redis.get<string>(stampKey(account))) ?? 0) : (memoryStamps.get(account.toLowerCase()) ?? 0);
  const underDailyBound = async (account: Address) => {
    const day = Math.floor(Date.now() / 86_400_000);
    if (redis) return underLimit(redis, `${prefix}stamp-day:${day}:${account.toLowerCase()}`, STAMPS_PER_DAY, 86_400);
    const k = `${day}:${account.toLowerCase()}`;
    const n = (memoryToday.get(k) ?? 0) + 1;
    memoryToday.set(k, n);
    return n <= STAMPS_PER_DAY;
  };
  const balanceOf = (account: Address) =>
    publicClient.readContract({ address: edition.contract, abi: editionAbi, functionName: "balanceOf", args: [account, edition.id] });

  const render: Parameters<typeof createIssuer>[0]["render"] = async ({ token, owner, serial, links, superseded, supersededReason, updatedAt }) => {
    const [held, count] = await Promise.all([balanceOf(owner).catch(() => null), stamps(owner)]);
    const content: PassContent = {
      serial,
      style: "generic",
      organizationName: "ERC-8426 Edition",
      description: `Edition ${token.tokenId}, held by ${shortHex(owner)}`,
      title: "Edition Pass",
      headline: `Edition ${token.tokenId}`,
      colors: { background: EDITION_COLOR, foreground: "#ffffff", label: "#dcd6f0" },
      header: [{ key: "token", label: "EDITION", value: `#${token.tokenId}` }],
      primary: [
        {
          key: "held",
          label: superseded ? "STATUS" : "HELD",
          value: superseded ? (supersededReason === "reset" ? "Links reset" : "No longer held") : held === null ? "Unknown" : `${held} ${held === 1n ? "unit" : "units"}`,
          changeMessage: "You now hold %@",
        },
      ],
      secondary: [
        { key: "stamps", label: "STAMPS", value: String(count), changeMessage: "Stamps: %@" },
        { key: "holder", label: "HOLDER", value: shortHex(owner) },
      ],
      back: [
        { key: "contract", label: "Issuing contract (ERC-1155)", value: edition.contract },
        { key: "chain", label: "Chain", value: String(config.chainId) },
        { key: "owner", label: "Issued to", value: owner },
        { key: "updated", label: "Content updated", value: new Date(updatedAt * 1000).toISOString() },
        {
          key: "about",
          label: "About this pass",
          value:
            "This pass belongs to one account's holding of this edition, not to the edition. Every holder has their own. It works while that account holds at least one unit; the issuer reads the balance on chain before every action. Anyone holding this pass can use the link below until the holder resets it.",
        },
      ],
      links: links.stamp ? [{ key: "stamp", label: "Stamp", url: links.stamp }] : [],
      barcode: { format: "qr", message: assetId(token), altText: `Edition #${token.tokenId}` },
    };
    return content;
  };

  const providers: IssuerProvider[] = [previewProvider()];
  let apple: AppleFormatProvider | null = null;
  if (config.apple) {
    const a = config.apple;
    const store = redis ? redisApplePassStore(redis, prefix) : new MemoryApplePassStore();
    const apns = a.apns
      ? createApnsClient({ certificate: { cert: a.signerCert, key: a.signerKey, passphrase: a.signerKeyPassphrase }, passTypeIdentifier: a.passTypeIdentifier, store })
      : undefined;
    apple = appleFormatProvider({
      passTypeIdentifier: a.passTypeIdentifier,
      teamIdentifier: a.teamIdentifier,
      certificates: { signerCert: a.signerCert, signerKey: a.signerKey, signerKeyPassphrase: a.signerKeyPassphrase, wwdr: a.wwdr },
      origin: config.baseUrl,
      // Its own PassKit web service, mounted by app/apple-edition/[...path].
      basePath: "/apple-edition",
      store,
      ...(apns ? { apns } : {}),
      images: {
        icon: { data: solidPng(29, 29, EDITION_COLOR), data2x: solidPng(58, 58, EDITION_COLOR), data3x: solidPng(87, 87, EDITION_COLOR) },
        logo: { data: solidPng(160, 50, EDITION_COLOR), data2x: solidPng(320, 100, EDITION_COLOR) },
      },
    });
    providers.push(apple);
  }
  if (config.google) {
    providers.push(
      googleFormatProvider({
        ...(redis ? { store: redisGoogleObjectStore(redis, prefix) } : {}),
        client: googleWalletClient({ serviceAccount: config.google.serviceAccount, issuerId: config.google.issuerId }),
        classSuffix: edition.googleClassSuffix,
        origins: [new URL(config.baseUrl).origin],
        unhostedImages: "omit",
        messageFor: () => ({ header: "Your edition pass changed", body: "Open the pass to see it." }),
        onError: (err, where) => console.warn(`[google edition] ${where}: ${err.message}`),
      }),
    );
  }

  const issuer = createIssuer({
    domain: config.domain,
    baseUrl: config.baseUrl,
    basePath: "/edition-pass",
    chainId: config.chainId,
    contract: edition.contract,
    standard: "erc1155",
    mode: "gated",
    publicClient,
    ...(process.env.ISSUER_LINK_SECRET ? { linkSecret: process.env.ISSUER_LINK_SECRET } : {}),
    ...(redis ? { stores: kvStores(upstashKv(redis), { chainId: config.chainId, contract: edition.contract, prefix: `${prefix}issuer:` }) } : {}),
    rateLimit: {
      ...(redis ? { limiter: kvRateLimiter(upstashKv(redis), { prefix: `${prefix}rl:` }) } : {}),
      ...(process.env.VERCEL ? { trustProxy: "vercel" as const } : {}),
    },
    providers,
    render,
    capability: { enabled: true },
    actions: {
      // Reachable both ways: from the link on the pass (capability path) and
      // with a signature (signed path). Safe as a link because it is bounded
      // and moves nothing.
      stamp: {
        description: "Stamp the pass",
        capability: true,
        bound: `At most ${STAMPS_PER_DAY} stamps per account per day, counted by the issuer. A stamp is a number on the pass: it moves no tokens and no value, and cannot transfer, approve or change any balance.`,
        async execute({ account, notifyUpdate }) {
          if (!(await underDailyBound(account))) {
            throw new ActionError(429, "bound_reached", `This account has used its ${STAMPS_PER_DAY} stamps for today.`);
          }
          let total: number;
          if (redis) total = await redis.incr(stampKey(account));
          else {
            total = (memoryStamps.get(account.toLowerCase()) ?? 0) + 1;
            memoryStamps.set(account.toLowerCase(), total);
          }
          await notifyUpdate();
          return { action: "stamp", account, stamps: total };
        },
      },
    },
  });

  // For this binding a transfer is a hint. The issuer answers it with a fresh
  // read of the two accounts it names.
  if (config.watchers) {
    watchTransfers1155({ client: publicClient, issuer, pollingInterval: 1_000 });
    watchPassUpdates({ client: publicClient, issuer, pollingInterval: 1_000 });
  }

  // Serverless catch-up. The read over the issued accounts is the truth and
  // needs no log at all; the logs add the block of each transfer, which lets
  // the issuer see a balance that left and came back between two reads. A
  // node only keeps old state for a while, so a log read too late fails that
  // second read and changes nothing: best effort, and reported as such.
  const SYNC_SPAN = 20_000n;
  const SYNC_EVERY = 60;
  let memoryCursor = edition.deployBlock;
  const sync = async () => {
    if (redis && (await redis.set(`${prefix}sync-lease`, "1", { nx: true, ex: SYNC_EVERY })) !== "OK") return null;
    const cursorKey = `${prefix}sync-cursor`;
    const stored = redis ? await redis.get<string>(cursorKey) : null;
    const head = await publicClient.getBlockNumber();
    let from = stored ? BigInt(stored) : memoryCursor;
    // Logs older than the span cannot be read at their block anyway; the
    // balance read below covers whatever they would have reported.
    if (head - from > SYNC_SPAN) from = head - SYNC_SPAN;
    let transfers = 0;
    let updates = 0;
    if (from <= head) {
      const [moved, changed] = await Promise.all([
        publicClient.getContractEvents({ address: edition.contract, abi: editionAbi, fromBlock: from, toBlock: head }),
        publicClient.getContractEvents({ address: edition.contract, abi: walletPassAbi, fromBlock: from, toBlock: head }),
      ]);
      for (const log of moved) {
        const args = log.args as { from?: Address; to?: Address; id?: bigint; ids?: readonly bigint[] };
        if (!args.from || !args.to) continue;
        const ids = log.eventName === "TransferSingle" ? [args.id!] : [...new Set(args.ids ?? [])];
        for (const moved1 of ids) {
          if (moved1 !== edition.id) continue;
          transfers++;
          await issuer.onTransfer(moved1, args.from, args.to, log.blockNumber ?? undefined).catch((e: Error) => console.warn(`[edition sync] transfer hint: ${e.message}`));
        }
      }
      for (const log of changed) {
        const args = log.args as { tokenId?: bigint; fromTokenId?: bigint; toTokenId?: bigint };
        updates++;
        if (log.eventName === "PassUpdate" && args.tokenId !== undefined) await issuer.onPassUpdate(args.tokenId);
        else if (log.eventName === "BatchPassUpdate" && args.fromTokenId !== undefined) await issuer.onPassUpdate(args.fromTokenId, args.toTokenId);
      }
      const next = (head + 1n).toString();
      if (redis) await redis.set(cursorKey, next);
      else memoryCursor = head + 1n;
    }
    const summary = await issuer.checkHoldings(id);
    return { checked: summary.checked, retired: summary.retired.length, transfers, updates };
  };

  return { rt, edition, issuer, apple, stamps, sync };
}

/// On serverless hosts (no watchers), catch up after the response is sent.
export function editionSyncAfter(ed: EditionRuntime): void {
  if (ed.rt.config.watchers) return;
  after(() => ed.sync().then(() => undefined, (e: Error) => console.warn(`[edition sync] ${e.message}`)));
}
