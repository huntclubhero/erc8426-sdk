import { parseAbi, type Address } from "viem";
import { assetId, type PassContent } from "@erc8426/core";
import { createIssuer, kvRateLimiter, kvStores, passKeyFor, watchTransfers1155, type HoldingsSummary, type Issuer, type IssuerProvider } from "@erc8426/issuer";
import { appleFormatProvider, createApnsClient, MemoryApplePassStore, type AppleFormatProvider } from "@erc8426/apple";
import { googleFormatProvider, googleWalletClient } from "@erc8426/google";

import type { EditionEnv } from "./config";
import { redisApplePassStore, redisGoogleObjectStore, upstashKv } from "./kv";
import { shortHex } from "./pet";
import { solidPng } from "./png";
import { previewProvider } from "./previewProvider";
import { getRuntime, type Runtime } from "./server";

/// The member pass: the "go dark and come back" case of the ERC-1155 binding
/// draft, as a third issuer in the same app (its own contract, its own path
/// /member-pass, its own records).
///
/// It differs from the edition in one thing that decides everything else:
/// its pass carries no capability link. Nothing on the card can act without
/// the holder's signature, so a copy of the card in someone else's hands can
/// do nothing. That is why, when the account's balance falls below one unit,
/// the installed pass does not have to be retired. It goes dark (it says so,
/// and why), keeps its serial, and comes back live on the same card when the
/// account holds a unit again. The acquisition URLs are still replaced each
/// time: they are possession proofs for the download.

export const memberAbi = parseAbi([
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function totalSupply(uint256 id) view returns (uint256)",
  "function claimed(uint256 id, address account) view returns (uint256)",
  "function claimLimit() view returns (uint256)",
  "function open(uint256 id) view returns (bool)",
  "function claim(uint256 id, uint256 amount)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)",
]);

const LIVE_COLOR = "#0f5c4d";
const DARK_COLOR = "#2b2b2b";

export interface MemberRuntime {
  rt: Runtime;
  member: EditionEnv;
  issuer: Issuer;
  apple: AppleFormatProvider | null;
  /// Whether `account` has an installed pass, and whether it is dark.
  passOf(account: Address): Promise<{ serial: string; dark: boolean } | null>;
  /// Read one account's balance fresh and act on it now: dark when it is
  ///  below one unit, live again when it holds.
  check(account: Address): Promise<HoldingsSummary>;
  /// The same read over every account with a pass, at most once a minute.
  sync(): Promise<HoldingsSummary | null>;
}

const g = globalThis as unknown as { __erc8426Member?: { key: string; runtime: Promise<MemberRuntime | null> } };

/// Null when no member pass is configured.
export async function getMemberRuntime(): Promise<MemberRuntime | null> {
  const rt = await getRuntime();
  if (!rt.config.member) return null;
  const key = `${rt.config.chainId}:${rt.config.member.contract}:${rt.config.rpcUrl}`;
  if (g.__erc8426Member?.key !== key) {
    g.__erc8426Member = { key, runtime: createMemberRuntime(rt, rt.config.member) };
    g.__erc8426Member.runtime.catch(() => {
      g.__erc8426Member = undefined;
    });
  }
  return g.__erc8426Member.runtime;
}

async function createMemberRuntime(rt: Runtime, member: EditionEnv): Promise<MemberRuntime> {
  const { config, publicClient, redis } = rt;
  const prefix = `erc8426-demo:${config.chainId}:${member.contract.toLowerCase()}:`;
  const id = member.id.toString();
  const balanceOf = (account: Address) => publicClient.readContract({ address: member.contract, abi: memberAbi, functionName: "balanceOf", args: [account, member.id] });

  const render: Parameters<typeof createIssuer>[0]["render"] = async ({ token, owner, serial, superseded, supersededReason, dark, updatedAt }) => {
    const held = dark ? 0n : await balanceOf(owner).catch(() => null);
    const off = Boolean(dark || superseded);
    const content: PassContent = {
      serial,
      style: "generic",
      organizationName: "ERC-8426 Member",
      description: `Member pass ${token.tokenId}, held by ${shortHex(owner)}`,
      title: "Member Pass",
      headline: dark ? "Dark" : `Member ${shortHex(owner)}`,
      colors: off ? { background: DARK_COLOR, foreground: "#b5b5b5", label: "#8a8a8a" } : { background: LIVE_COLOR, foreground: "#ffffff", label: "#cfe9e2" },
      header: [{ key: "token", label: "MEMBERSHIP", value: `#${token.tokenId}` }],
      primary: [
        {
          key: "status",
          label: "STATUS",
          value: superseded ? (supersededReason === "reset" ? "Links reset" : "No longer held") : dark ? "Dark" : "Active",
          changeMessage: "Your member pass is now: %@",
        },
      ],
      secondary: [
        { key: "held", label: "HELD", value: held === null ? "Unknown" : `${held} ${held === 1n ? "unit" : "units"}` },
        { key: "why", label: dark ? "WHY" : "GOOD WHILE", value: dark ? "This account holds no unit" : "This account holds a unit" },
      ],
      back: [
        ...(dark
          ? [
              {
                key: "dark",
                label: "This pass is dark",
                value:
                  "The account this pass was issued to no longer holds a unit of this membership, so the pass shows nothing and proves nothing right now. It was not replaced: when the account holds a unit again, this same pass comes back by itself.",
              },
            ]
          : []),
        { key: "contract", label: "Issuing contract (ERC-1155)", value: member.contract },
        { key: "chain", label: "Chain", value: String(config.chainId) },
        { key: "owner", label: "Issued to", value: owner },
        { key: "updated", label: "Content updated", value: new Date(updatedAt * 1000).toISOString() },
        {
          key: "about",
          label: "About this pass",
          value:
            "This pass belongs to one account's holding of this membership. It carries no link that can act for the holder: anything it leads to asks for the holder's signature. That is why it can go dark and come back on the same card, where a pass with one tap links has to be replaced.",
        },
        { key: "site", label: "Demo site", value: `${config.baseUrl}/member` },
      ],
      links: [],
      // A dark pass presents nothing to scan.
      ...(off ? {} : { barcode: { format: "qr" as const, message: assetId(token), altText: `Member #${token.tokenId}` } }),
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
      // Its own PassKit web service, mounted by app/apple-member/[...path].
      basePath: "/apple-member",
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
        classSuffix: member.googleClassSuffix,
        origins: [new URL(config.baseUrl).origin],
        unhostedImages: "omit",
        messageFor: () => ({ header: "Your member pass changed", body: "Open the pass to see it." }),
        onError: (err, where) => console.warn(`[google member] ${where}: ${err.message}`),
      }),
    );
  }

  // No actions at all, so no capability links: `lostEntitlement` defaults to
  // "dark". It is written out because it is the point of this issuer.
  const issuer = createIssuer({
    domain: config.domain,
    baseUrl: config.baseUrl,
    basePath: "/member-pass",
    chainId: config.chainId,
    contract: member.contract,
    standard: "erc1155",
    mode: "gated",
    lostEntitlement: "dark",
    publicClient,
    ...(process.env.ISSUER_LINK_SECRET ? { linkSecret: process.env.ISSUER_LINK_SECRET } : {}),
    ...(redis ? { stores: kvStores(upstashKv(redis), { chainId: config.chainId, contract: member.contract, prefix: `${prefix}issuer:` }) } : {}),
    rateLimit: {
      ...(redis ? { limiter: kvRateLimiter(upstashKv(redis), { prefix: `${prefix}rl:` }) } : {}),
      ...(process.env.VERCEL ? { trustProxy: "vercel" as const } : {}),
    },
    providers,
    render,
  });

  if (config.watchers) watchTransfers1155({ client: publicClient, issuer, pollingInterval: 1_000 });

  const passOf = async (account: Address) => {
    const record = await issuer.stores.passes.get(passKeyFor(id, account));
    if (!record || record.lastIssuedTo === null) return null;
    return { serial: record.serial, dark: record.dark === true };
  };
  const check = (account: Address) => issuer.checkHoldings(id, { accounts: [account] });
  let memorySyncedAt = 0;
  const sync = async () => {
    if (redis) {
      if ((await redis.set(`${prefix}sync-lease`, "1", { nx: true, ex: 60 })) !== "OK") return null;
    } else {
      if (Date.now() - memorySyncedAt < 60_000) return null;
      memorySyncedAt = Date.now();
    }
    return issuer.checkHoldings(id);
  };

  return { rt, member, issuer, apple, passOf, check, sync };
}
