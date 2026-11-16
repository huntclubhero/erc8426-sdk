import { decodeEventLog, parseAbi, type Address, type Hex } from "viem";
import { proofHeaders, type PassContent } from "@erc8426/core";
import { createIssuer, kvRateLimiter, kvStores, rental4907, type Issuer, type IssuerProvider } from "@erc8426/issuer";
import { appleFormatProvider, createApnsClient, MemoryApplePassStore, type AppleFormatProvider } from "@erc8426/apple";
import { googleFormatProvider, googleWalletClient } from "@erc8426/google";

import type { RentalEnv } from "./config";
import { redisApplePassStore, redisGoogleObjectStore, upstashKv } from "./kv";
import { shortHex } from "./pet";
import { solidPng } from "./png";
import { previewProvider } from "./previewProvider";
import { getRuntime, type Runtime } from "./server";

/// The rental: a fourth issuer in the same app, for the one case of
/// ERC-8426 that loses entitlement with no transfer. A key (an ERC-721 token
/// with ERC-4907) is owned by the house (this app's operator) and rented to
/// a visitor for a few minutes. Entitlement is `rental4907()`: during the
/// rental the renter alone holds the pass and its link; when the rental
/// ends, by the clock, with no transaction and no event, the renter is no
/// longer entitled and the owner is.
///
/// It exists to watch what happens at that moment, on a real phone:
///  - the fresh read refuses the renter's link and download at once;
///  - the installed pass carries its check out time, so the device itself
///    shows it expired, with no push;
///  - the renter's links are retired when the issuer observes the loss,
///    which for this issuer is the owner's next claim.

export const rentalAbi = parseAbi([
  "function mint(address to) returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function userOf(uint256 tokenId) view returns (address)",
  "function userExpires(uint256 tokenId) view returns (uint256)",
  "function setUser(uint256 tokenId, address user, uint64 expires)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

/// How long a demo rental lasts unless asked otherwise, and the bounds.
export const RENTAL_SECONDS = 180;
export const RENTAL_MIN_SECONDS = 30;
export const RENTAL_MAX_SECONDS = 600;
const LIVE_COLOR = "#0b4f6c";
const OFF_COLOR = "#20272f";
const ZERO = "0x0000000000000000000000000000000000000000";

export interface RentalView {
  tokenId: string;
  owner: Address;
  /// The current ERC-4907 user, or null when none (or expired on chain).
  user: Address | null;
  expires: number;
  /// Whether the rental is active by this server's clock, as the issuer reads it.
  active: boolean;
  /// Who the issuer last issued this key's pass to: the renter of record, the owner, or nobody yet.
  issuedTo: "renter" | "owner" | "nobody" | "someone else";
  unlocks: number;
}

export interface RentalRuntime {
  rt: Runtime;
  rental: RentalEnv;
  issuer: Issuer;
  apple: AppleFormatProvider | null;
  view(tokenId: string, renter?: Address): Promise<RentalView>;
  /// Mint a new key to the house and rent it to `account`.
  rent(account: Address, seconds: number): Promise<{ tokenId: string; expires: number; transactionHash: Hex }>;
  /// Rent the same key to the same account again. Only for the account this
  ///  key was last rented to, and only when no rental is active.
  rentAgain(tokenId: string, account: Address, seconds: number): Promise<{ expires: number; transactionHash: Hex }>;
  /// The owner (the house) claims its pass for this key: the request an
  ///  owner's own wallet would make, with a signed acquire proof.
  ownerClaims(tokenId: string): Promise<{ status: number; error?: string }>;
  /// The account a key was rented to by this app, if any.
  renterOf(tokenId: string): Promise<Address | null>;
}

const g = globalThis as unknown as { __erc8426Rental?: { key: string; runtime: Promise<RentalRuntime | null> } };

/// Null when no rental is configured.
export async function getRentalRuntime(): Promise<RentalRuntime | null> {
  const rt = await getRuntime();
  if (!rt.config.rental) return null;
  const key = `${rt.config.chainId}:${rt.config.rental.contract}:${rt.config.rpcUrl}`;
  if (g.__erc8426Rental?.key !== key) {
    g.__erc8426Rental = { key, runtime: createRentalRuntime(rt, rt.config.rental) };
    g.__erc8426Rental.runtime.catch(() => {
      g.__erc8426Rental = undefined;
    });
  }
  return g.__erc8426Rental.runtime;
}

async function createRentalRuntime(rt: Runtime, rental: RentalEnv): Promise<RentalRuntime> {
  const { config, publicClient, redis } = rt;
  const prefix = `erc8426-demo:${config.chainId}:${rental.contract.toLowerCase()}:`;
  const contract = { address: rental.contract, abi: rentalAbi } as const;
  const memory = new Map<string, string>();
  const put = async (k: string, v: string) => {
    if (redis) await redis.set(`${prefix}${k}`, v);
    else memory.set(k, v);
  };
  const get = async (k: string) => (redis ? ((await redis.get<string | number>(`${prefix}${k}`)) ?? null) : (memory.get(k) ?? null));

  const read = async (tokenId: string) => {
    const id = BigInt(tokenId);
    const [owner, user, expires] = await Promise.all([
      publicClient.readContract({ ...contract, functionName: "ownerOf", args: [id] }),
      publicClient.readContract({ ...contract, functionName: "userOf", args: [id] }),
      publicClient.readContract({ ...contract, functionName: "userExpires", args: [id] }),
    ]);
    return { owner, user: user === ZERO ? null : user, expires: Number(expires) };
  };
  const unlocksOf = async (tokenId: string) => Number((await get(`unlocks:${tokenId}`)) ?? 0);
  const renterOf = async (tokenId: string) => {
    const v = await get(`renter:${tokenId}`);
    return v ? (String(v) as Address) : null;
  };

  const render: Parameters<typeof createIssuer>[0]["render"] = async ({ token, owner, serial, links, superseded, updatedAt }) => {
    const r = await read(token.tokenId);
    const guest = r.user !== null && r.user.toLowerCase() === owner.toLowerCase();
    const unlocks = await unlocksOf(token.tokenId).catch(() => 0);
    const out = new Date(r.expires * 1000);
    const content: PassContent = {
      serial,
      style: "generic",
      organizationName: "ERC-8426 Rental",
      description: `Dune House key ${token.tokenId}, held by ${shortHex(owner)}`,
      title: "Dune House",
      headline: superseded ? "Key returned" : guest ? "Guest key" : "Owner key",
      colors: guest && !superseded ? { background: LIVE_COLOR, foreground: "#ffffff", label: "#f9c80e" } : { background: OFF_COLOR, foreground: "#ededed", label: "#9aa4ad" },
      header: [{ key: "token", label: "KEY", value: `#${token.tokenId}` }],
      primary: [
        {
          key: "role",
          label: "THIS KEY",
          value: superseded ? "No longer active" : guest ? "Enjoy your stay" : "Home",
          changeMessage: "Your Dune House key: %@",
        },
      ],
      secondary: [
        ...(guest ? [{ key: "checkout", label: "CHECK OUT (UTC)", value: out.toISOString().slice(11, 19) }] : [{ key: "status", label: "STATUS", value: r.user ? "Rented out" : "Not rented" }]),
        { key: "unlocks", label: "DOOR OPENED", value: `${unlocks} ${unlocks === 1 ? "time" : "times"}`, changeMessage: "Door opened %@" },
      ],
      back: [
        { key: "policy", label: "Who holds this key", value: "During a rental only the guest's pass opens the door. At check out the key goes back to the owner by itself: the rental ends by the clock, with no transaction." },
        { key: "contract", label: "Issuing contract (ERC-721 with ERC-4907)", value: rental.contract },
        { key: "chain", label: "Chain", value: String(config.chainId) },
        { key: "owner", label: "Issued to", value: owner },
        { key: "updated", label: "Content updated", value: new Date(updatedAt * 1000).toISOString() },
        { key: "site", label: "Demo site", value: `${config.baseUrl}/rental` },
      ],
      links: superseded || !links.unlock ? [] : [{ key: "unlock", label: "Unlock front door", url: links.unlock }],
      // The rental ends with no event, so the pass carries its own check out
      // time and the device shows it expired when that time comes.
      ...(guest && !superseded ? { expiresAt: out } : {}),
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
      basePath: "/apple-rental",
      store,
      ...(apns ? { apns } : {}),
      images: {
        icon: { data: solidPng(29, 29, LIVE_COLOR), data2x: solidPng(58, 58, LIVE_COLOR), data3x: solidPng(87, 87, LIVE_COLOR) },
        logo: { data: solidPng(160, 50, LIVE_COLOR), data2x: solidPng(320, 100, LIVE_COLOR) },
      },
    });
    providers.push(apple);
  }
  if (config.google) {
    providers.push(
      googleFormatProvider({
        ...(redis ? { store: redisGoogleObjectStore(redis, prefix) } : {}),
        client: googleWalletClient({ serviceAccount: config.google.serviceAccount, issuerId: config.google.issuerId }),
        classSuffix: rental.googleClassSuffix,
        origins: [new URL(config.baseUrl).origin],
        unhostedImages: "omit",
        messageFor: () => ({ header: "Your Dune House key changed", body: "Open the pass to see it." }),
        onError: (err, where) => console.warn(`[google rental] ${where}: ${err.message}`),
      }),
    );
  }

  const issuer = createIssuer({
    domain: config.domain,
    baseUrl: config.baseUrl,
    basePath: "/rental-pass",
    chainId: config.chainId,
    contract: rental.contract,
    mode: "gated",
    publicClient,
    // The documented entitlement: an active ERC-4907 rental is exclusive of
    // the owner, for every action, acquire included.
    entitlement: rental4907(),
    ...(process.env.ISSUER_LINK_SECRET ? { linkSecret: process.env.ISSUER_LINK_SECRET } : {}),
    ...(redis ? { stores: kvStores(upstashKv(redis), { chainId: config.chainId, contract: rental.contract, prefix: `${prefix}issuer:` }) } : {}),
    rateLimit: {
      ...(redis ? { limiter: kvRateLimiter(upstashKv(redis), { prefix: `${prefix}rl:` }) } : {}),
      ...(process.env.VERCEL ? { trustProxy: "vercel" as const } : {}),
    },
    providers,
    render,
    capability: { enabled: true },
    actions: {
      unlock: {
        description: "Unlock the front door",
        capability: true,
        bound:
          "Opens the door and counts the entry. It changes no on-chain state and moves no value, and it cannot transfer, approve or re-rent the key. It works only for the account entitled right now: the guest during a rental, the owner otherwise.",
        async execute({ token, via, notifyUpdate }) {
          const n = (await unlocksOf(token.tokenId)) + 1;
          await put(`unlocks:${token.tokenId}`, String(n));
          await notifyUpdate();
          return { unlocked: true, via, unlocks: n, message: `Door unlocked. Welcome in. (Opened ${n} ${n === 1 ? "time" : "times"} with this key.)` };
        },
      },
    },
  });

  const view = async (tokenId: string, renter?: Address): Promise<RentalView> => {
    const [r, record, unlocks, known] = await Promise.all([read(tokenId), issuer.stores.passes.get(tokenId), unlocksOf(tokenId), renterOf(tokenId)]);
    const who = record?.lastIssuedTo ?? null;
    const guest = renter ?? known;
    const issuedTo = who === null ? "nobody" : who.toLowerCase() === r.owner.toLowerCase() ? "owner" : guest && who.toLowerCase() === guest.toLowerCase() ? "renter" : "someone else";
    return { tokenId, owner: r.owner, user: r.user, expires: r.expires, active: r.user !== null && r.expires * 1000 > Date.now(), issuedTo, unlocks };
  };

  const setUser = async (tokenId: string, account: Address, seconds: number) => {
    const expires = Math.floor(Date.now() / 1000) + seconds;
    const hash = await rt.withOperator(async (nonce) => {
      const { request } = await publicClient.simulateContract({ account: rt.operator.account, ...contract, functionName: "setUser", args: [BigInt(tokenId), account, BigInt(expires)] });
      return rt.operator.writeContract({ ...request, nonce });
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("setUser reverted");
    await put(`renter:${tokenId}`, account);
    return { expires, transactionHash: hash };
  };

  const rent = async (account: Address, seconds: number) => {
    const mintHash = await rt.withOperator((nonce) => rt.operator.writeContract({ ...contract, functionName: "mint", args: [rt.operator.account.address], nonce }));
    const receipt = await publicClient.waitForTransactionReceipt({ hash: mintHash });
    let tokenId: string | null = null;
    for (const log of receipt.logs) {
      try {
        const ev = decodeEventLog({ abi: rentalAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "Transfer") tokenId = ev.args.tokenId.toString();
      } catch {
        // Not a Transfer log.
      }
    }
    if (!tokenId) throw new Error("the mint produced no token id");
    const set = await setUser(tokenId, account, seconds);
    return { tokenId, ...set };
  };

  const rentAgain = async (tokenId: string, account: Address, seconds: number) => {
    const known = await renterOf(tokenId);
    if (!known || known.toLowerCase() !== account.toLowerCase()) throw new RentalRefused(403, "not_your_key", "This key was not rented to this account by this demo.");
    const r = await read(tokenId);
    if (r.owner.toLowerCase() !== rt.operator.account.address.toLowerCase()) throw new RentalRefused(409, "not_the_house", "The house no longer owns this key.");
    if (r.user !== null && r.expires * 1000 > Date.now()) throw new RentalRefused(409, "still_rented", "This rental has not ended yet.");
    return setUser(tokenId, account, seconds);
  };

  const ownerClaims = async (tokenId: string) => {
    const account = rt.operator.account;
    const challenge = await issuer.issueChallenge({ tokenId, account: account.address });
    const signature = await rt.operator.signMessage({ message: challenge.message });
    const res = await issuer.handler(new Request(`${config.baseUrl}/rental-pass/${tokenId}`, { headers: proofHeaders({ message: challenge.message, signature }) }));
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return { status: res.status, ...(body?.error ? { error: body.error } : {}) };
  };

  return { rt, rental, issuer, apple, view, rent, rentAgain, ownerClaims, renterOf };
}

export class RentalRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
