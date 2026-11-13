import { BaseError, ContractFunctionRevertedError, parseAbi, type Address, type Hex } from "viem";
import { after } from "next/server";
import { assetId, walletPassAbi, type PassContent } from "@erc8426/core";
import {
  ActionError,
  createIssuer,
  kvRateLimiter,
  kvStores,
  watchPassUpdates,
  watchTransfers1155,
  type ActionDefinition,
  type Issuer,
  type IssuerProvider,
} from "@erc8426/issuer";
import { appleFormatProvider, createApnsClient, MemoryApplePassStore, type AppleFormatProvider } from "@erc8426/apple";
import { googleFormatProvider, googleWalletClient } from "@erc8426/google";

import type { EditionEnv } from "./config";
import { redisApplePassStore, redisGoogleObjectStore, upstashKv } from "./kv";
import { shortHex } from "./pet";
import { solidPng } from "./png";
import { previewProvider } from "./previewProvider";
import { getRuntime, type Runtime } from "./server";

/// The ERC-1155 edition: a second issuer in the same app, for the working
/// draft of the ERC-1155 binding. It shares the chain client, the store, the
/// operator and the wallet credentials with the pet issuer and nothing else:
/// its own contract, its own path (/edition-pass), its own records.
///
/// What differs from the pet: there is no "the owner". A pass belongs to a
/// pair, an id and an account, and an account is entitled while a fresh
/// `balanceOf(account, id)` is at least 1. Sending away one unit of three
/// changes nothing; sending the last one retires that account's links.
///
/// The action is a vote: one unit, one vote. It is the case that shows why a
/// balance is not a unit. The fresh read admits the request (the account
/// holds now), but it is the contract that decides what the vote weighs: the
/// balance at the proposal's snapshot. A unit that moves to another account
/// after the snapshot cannot vote again, however many accounts it visits.

export const editionAbi = parseAbi([
  "struct Proposal { uint256 id; uint48 snapshot; uint48 closes; uint256 yes; uint256 no; string title; }",
  "struct Ballot { uint8 choice; bool signed; uint208 weight; }",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function totalSupply(uint256 id) view returns (uint256)",
  "function claimed(uint256 id, address account) view returns (uint256)",
  "function claimLimit() view returns (uint256)",
  "function open(uint256 id) view returns (bool)",
  "function passURI(uint256 id) view returns (string)",
  "function claim(uint256 id, uint256 amount)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)",
  "function proposalCount() view returns (uint256)",
  "function proposal(uint256 proposalId) view returns (Proposal)",
  "function ballotOf(uint256 proposalId, address account) view returns (Ballot)",
  "function votable(uint256 proposalId) view returns (bool)",
  "function votingPower(uint256 proposalId, address account) view returns (uint256)",
  "function propose(uint256 id, string title, uint48 duration) returns (uint256)",
  "function castVoteFor(address account, uint256 proposalId, bool support, bool signed)",
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
  "error VoteEditionNotVotable(uint256 proposalId)",
  "error VoteEditionNoVotingPower(uint256 proposalId, address account)",
  "error VoteEditionAlreadyVoted(uint256 proposalId, address account)",
  "error VoteEditionNotOperator(address caller)",
]);

export const VOTE_ACTIONS = ["vote-yes", "vote-no"] as const;
export type VoteAction = (typeof VOTE_ACTIONS)[number];
const VOTE_LABEL: Record<VoteAction, string> = { "vote-yes": "Vote yes", "vote-no": "Vote no" };

/// How long a demo proposal stays open, and how soon another may be opened.
export const PROPOSAL_SECONDS = 15 * 60;
export const PROPOSAL_MIN_GAP_SECONDS = 3 * 60;
const EDITION_COLOR = "#3b2f63";

export interface ProposalView {
  proposalId: string;
  title: string;
  snapshot: number;
  closes: number;
  yes: string;
  no: string;
  votable: boolean;
}

export interface BallotView {
  /// Voting power on the proposal: the balance at its snapshot.
  power: string;
  choice: "none" | "yes" | "no";
  /// False for a vote cast through a pass link.
  signed: boolean;
}

function revertName(e: unknown): string | undefined {
  if (!(e instanceof BaseError)) return undefined;
  const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
}

export interface EditionRuntime {
  rt: Runtime;
  edition: EditionEnv;
  issuer: Issuer;
  apple: AppleFormatProvider | null;
  /// The newest proposal, or null when none was ever opened.
  currentProposal(): Promise<ProposalView | null>;
  /// An account's power and ballot on a proposal.
  ballot(proposalId: string, account: Address): Promise<BallotView>;
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

  const contract = { address: edition.contract, abi: editionAbi } as const;
  const currentProposal = async (): Promise<ProposalView | null> => {
    const count = await publicClient.readContract({ ...contract, functionName: "proposalCount" });
    if (count === 0n) return null;
    const [p, votable] = await Promise.all([
      publicClient.readContract({ ...contract, functionName: "proposal", args: [count] }),
      publicClient.readContract({ ...contract, functionName: "votable", args: [count] }),
    ]);
    return { proposalId: count.toString(), title: p.title, snapshot: Number(p.snapshot), closes: Number(p.closes), yes: p.yes.toString(), no: p.no.toString(), votable };
  };
  const ballot = async (proposalId: string, account: Address): Promise<BallotView> => {
    const [power, b] = await Promise.all([
      publicClient.readContract({ ...contract, functionName: "votingPower", args: [BigInt(proposalId), account] }),
      publicClient.readContract({ ...contract, functionName: "ballotOf", args: [BigInt(proposalId), account] }),
    ]);
    return { power: power.toString(), choice: b.choice === 1 ? "yes" : b.choice === 2 ? "no" : "none", signed: b.signed };
  };
  const balanceOf = (account: Address) =>
    publicClient.readContract({ address: edition.contract, abi: editionAbi, functionName: "balanceOf", args: [account, edition.id] });

  const render: Parameters<typeof createIssuer>[0]["render"] = async ({ token, owner, serial, links, superseded, supersededReason, updatedAt }) => {
    const [held, proposal] = await Promise.all([balanceOf(owner).catch(() => null), currentProposal().catch(() => null)]);
    const mine = proposal ? await ballot(proposal.proposalId, owner).catch(() => null) : null;
    const power = mine ? BigInt(mine.power) : 0n;
    const voteText = !proposal
      ? "No proposal yet"
      : !mine
        ? "Unknown"
        : mine.choice !== "none"
          ? `${mine.choice === "yes" ? "Yes" : "No"} (${mine.signed ? "signed, final" : "by pass link"})`
          : power === 0n
            ? "No vote on this one"
            : proposal.votable
              ? "Not cast yet"
              : "Not cast";
    // The links are offered only while they can do something: the proposal
    // is open, the account has power on it, and it has not voted. A link
    // cannot change a vote, so after a vote they leave the pass.
    const canLinkVote = Boolean(proposal?.votable && mine && mine.choice === "none" && power > 0n);
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
        { key: "proposal", label: proposal ? `PROPOSAL ${proposal.proposalId}` : "PROPOSAL", value: proposal ? proposal.title : "None open", changeMessage: "New proposal: %@" },
        { key: "vote", label: "YOUR VOTE", value: voteText, changeMessage: "Your vote: %@" },
      ],
      auxiliary: proposal ? [{ key: "power", label: "VOTES AT SNAPSHOT", value: mine ? mine.power : "?" }] : [],
      back: [
        ...(proposal
          ? [
              { key: "tally", label: `Proposal ${proposal.proposalId} when this pass last updated`, value: `Yes ${proposal.yes}, No ${proposal.no}. Closes ${new Date(proposal.closes * 1000).toISOString()}` },
            ]
          : []),
        { key: "contract", label: "Issuing contract (ERC-1155)", value: edition.contract },
        { key: "chain", label: "Chain", value: String(config.chainId) },
        { key: "owner", label: "Issued to", value: owner },
        { key: "updated", label: "Content updated", value: new Date(updatedAt * 1000).toISOString() },
        {
          key: "about",
          label: "About this pass",
          value:
            "This pass belongs to one account's holding of this edition. Every holder has their own. One unit is one vote, counted from what the account held when the proposal opened, so a unit cannot vote twice by moving. The links below cast this account's vote without a signature: anyone holding this pass can use them, once per proposal. The holder can replace a link vote with a signed vote on the demo site while the proposal is open, and can reset these links at any time.",
        },
      ],
      links: superseded || !canLinkVote ? [] : VOTE_ACTIONS.filter((a) => links[a]).map((a) => ({ key: a, label: VOTE_LABEL[a], url: links[a]! })),
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

  // A vote, relayed by the operator. Reachable from the link on the pass
  // (capability path) and with a signature (signed path); the contract is
  // told which, and treats them differently. What makes it safe as a link is
  // enforced on chain, not here.
  const vote = (action: VoteAction): ActionDefinition => ({
    description: `${VOTE_LABEL[action]} on the open proposal`,
    capability: true,
    bound:
      "At most one vote per account per proposal, enforced on chain. Its weight is the account's balance at the proposal's snapshot, so a unit that moves to another account cannot vote again. A link vote cannot change a vote already cast, and the holder can replace it once with a signed vote while the proposal is open. A vote moves no tokens and no value, and cannot transfer, approve or change any balance or entitlement.",
    async execute({ account, path, notifyUpdate }) {
      const proposal = await currentProposal();
      if (!proposal) throw new ActionError(409, "no_proposal", "No proposal has been opened yet.");
      const support = action === "vote-yes";
      let hash: Hex;
      try {
        hash = await rt.withOperator(async (nonce) => {
          const { request } = await publicClient.simulateContract({
            account: rt.operator.account,
            ...contract,
            functionName: "castVoteFor",
            args: [account, BigInt(proposal.proposalId), support, path === "signed"],
          });
          return rt.operator.writeContract({ ...request, nonce });
        });
      } catch (e) {
        const name = revertName(e);
        if (name === "VoteEditionNotVotable") throw new ActionError(409, "voting_closed", `Proposal ${proposal.proposalId} is not open for votes.`);
        if (name === "VoteEditionNoVotingPower") {
          throw new ActionError(409, "no_voting_power", `This account held no unit when proposal ${proposal.proposalId} opened, so it has no vote on it. Units that arrive after the snapshot do not carry a vote.`);
        }
        if (name === "VoteEditionAlreadyVoted") {
          throw new ActionError(
            409,
            "already_voted",
            path === "signed" ? "This account's signed vote is final." : "This account has already voted. A pass link cannot change a vote; the holder can, once, with a signature.",
          );
        }
        console.warn(`[edition vote] ${(e as Error).message.split("\n")[0]}`);
        throw new ActionError(502, "action_failed", "The vote transaction could not be sent.");
      }
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new ActionError(502, "action_failed", "The vote transaction reverted.");
      await notifyUpdate();
      return { action, proposalId: proposal.proposalId, support, signed: path === "signed", transactionHash: hash };
    },
  });

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
    actions: Object.fromEntries(VOTE_ACTIONS.map((a) => [a, vote(a)])),
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

  return { rt, edition, issuer, apple, currentProposal, ballot, sync };
}

/// On serverless hosts (no watchers), catch up after the response is sent.
export function editionSyncAfter(ed: EditionRuntime): void {
  if (ed.rt.config.watchers) return;
  after(() => ed.sync().then(() => undefined, (e: Error) => console.warn(`[edition sync] ${e.message}`)));
}
