import { BaseError, ContractFunctionRevertedError, parseAbi, type Address, type Hex } from "viem";
import { after } from "next/server";
import { assetId, walletPassAbi, type PassContent } from "@erc8426/core";
import {
  ActionError,
  createIssuer,
  newAttempt,
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
  "error VoteEditionUnknownProposal(uint256 proposalId)",
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

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/// The proposal a vote request names: `?p=` on a pass link (the capability
/// path), `params.proposalId` beside a proof (the signed path). Null when it
/// names none or names nonsense.
function namedProposal(path: "signed" | "capability", request: Request, params: unknown): string | null {
  const raw = path === "capability" ? new URL(request.url).searchParams.get("p") : (params as { proposalId?: unknown } | null)?.proposalId;
  const text = typeof raw === "number" || typeof raw === "bigint" ? raw.toString() : typeof raw === "string" ? raw : "";
  return /^[1-9][0-9]{0,30}$/.test(text) ? text : null;
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
  const proposalById = async (proposalId: bigint): Promise<ProposalView> => {
    const [p, votable] = await Promise.all([
      publicClient.readContract({ ...contract, functionName: "proposal", args: [proposalId] }),
      publicClient.readContract({ ...contract, functionName: "votable", args: [proposalId] }),
    ]);
    return { proposalId: proposalId.toString(), title: p.title, snapshot: Number(p.snapshot), closes: Number(p.closes), yes: p.yes.toString(), no: p.no.toString(), votable };
  };
  const currentProposal = async (): Promise<ProposalView | null> => {
    const count = await publicClient.readContract({ ...contract, functionName: "proposalCount" });
    return count === 0n ? null : proposalById(count);
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
      // Each link names the proposal it was printed for. A link names an
      // action, and "vote yes" on its own would land on whichever proposal
      // is newest when it is tapped, which may not be the one this pass
      // shows.
      links:
        superseded || !canLinkVote
          ? []
          : VOTE_ACTIONS.filter((a) => links[a]).map((a) => ({ key: a, label: `${VOTE_LABEL[a]} on proposal ${proposal!.proposalId}`, url: `${links[a]!}?p=${proposal!.proposalId}` })),
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
    async execute({ account, path, request, params, notifyUpdate }) {
      // The request says which proposal. It is never "the newest one": a
      // new proposal can open between a pass being read and a link tapped.
      const proposalId = namedProposal(path, request, params);
      if (!proposalId) throw new ActionError(400, "proposal_required", "The request does not say which proposal the vote is for. Open the pass again and use its current link.");
      const proposal = { proposalId };
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
        if (name === "VoteEditionUnknownProposal") throw new ActionError(404, "unknown_proposal", `There is no proposal ${proposal.proposalId}.`);
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
    capability: {
      enabled: true,
      // What a phone shows when a vote link on the pass is tapped. It says
      // which proposal the vote is for, and nothing happens until Confirm.
      async confirmPage(ctx) {
        const proposalId = namedProposal("capability", ctx.request, null);
        const found = proposalId ? await proposalById(BigInt(proposalId)).catch(() => null) : null;
        const support = ctx.action === "vote-yes" ? "Yes" : "No";
        const shell = (title: string, body: string) =>
          new Response(
            `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1.25rem}button{font:inherit;padding:.75rem 1.5rem;border-radius:.5rem;border:0;background:#3b2f63;color:#fff}small{color:#666}</style></head><body>${body}</body></html>`,
            { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
          );
        if (!found) return shell("This link is out of date", "<h1>This link is out of date</h1><p>It does not name a proposal. Open your pass again and use the link it shows now.</p>");
        if (!found.votable) return shell("Voting is closed", `<h1>Voting is closed</h1><p>Proposal ${escapeHtml(found.proposalId)}, ${escapeHtml(found.title)}, is no longer open for votes.</p>`);
        return shell(
          `Vote ${support}`,
          `<h1>Vote ${support}?</h1><p>Proposal ${escapeHtml(found.proposalId)}: <strong>${escapeHtml(found.title)}</strong></p><form method="post" action="${escapeHtml(`${ctx.postUrl}?p=${found.proposalId}`)}"><input type="hidden" name="action" value="${escapeHtml(ctx.action)}"><input type="hidden" name="attempt" value="${escapeHtml(newAttempt())}"><button type="submit">Confirm: vote ${support}</button></form><p><small>${escapeHtml(ctx.bound)}</small></p>`,
        );
      },
    },
    actions: Object.fromEntries(VOTE_ACTIONS.map((a) => [a, vote(a)])),
  });

  // For this binding a transfer is a hint. The issuer answers it with a fresh
  // read of the two accounts it names.
  if (config.watchers) {
    watchTransfers1155({ client: publicClient, issuer, pollingInterval: 1_000 });
    watchPassUpdates({ client: publicClient, issuer, pollingInterval: 1_000 });
  }

  // Serverless catch-up, in the order of what matters.
  //
  // 1. The read over the issued accounts. It is the truth, needs no log, and
  //    runs first so that nothing in the log step can keep it from running.
  // 2. The logs since the cursor, one bounded span per call, walking forward
  //    and never skipping (a PassUpdate must not be lost to a quiet hour).
  //    A transfer log adds one thing the read cannot see: the block, which
  //    shows a balance that left and came back between two reads. Only logs
  //    that moved units between accounts with a pass are looked at. A node
  //    keeps old state for a while only, so a log read too late fails that
  //    second read and changes nothing: best effort, and reported as such.
  const SYNC_SPAN = 20_000n;
  const SYNC_EVERY = 60;
  let memoryCursor = edition.deployBlock;
  const sync = async () => {
    if (redis && (await redis.set(`${prefix}sync-lease`, "1", { nx: true, ex: SYNC_EVERY })) !== "OK") return null;
    const summary = await issuer.checkHoldings(id).catch((e: Error) => {
      console.warn(`[edition sync] holdings: ${e.message}`);
      return { checked: 0, retired: [] as Address[] };
    });

    const cursorKey = `${prefix}sync-cursor`;
    const stored = redis ? await redis.get<string>(cursorKey) : null;
    const head = await publicClient.getBlockNumber();
    const from = stored ? BigInt(stored) : memoryCursor;
    let transfers = 0;
    let updates = 0;
    if (from <= head) {
      const to = head - from > SYNC_SPAN ? from + SYNC_SPAN : head;
      const [moved, changed] = await Promise.all([
        publicClient.getContractEvents({ address: edition.contract, abi: editionAbi, fromBlock: from, toBlock: to }),
        publicClient.getContractEvents({ address: edition.contract, abi: walletPassAbi, fromBlock: from, toBlock: to }),
      ]);
      // One read of the issued accounts, then the logs are filtered in
      // memory: a flood of transfers between strangers costs nothing more.
      const issued = new Set((await issuer.stores.passes.accounts!(id)).map((a) => a.toLowerCase()));
      const seen = new Set<string>();
      for (const log of moved) {
        const args = log.args as { from?: Address; to?: Address; id?: bigint; value?: bigint; ids?: readonly bigint[]; values?: readonly bigint[] };
        if (!args.from || !args.to || log.blockNumber === null) continue;
        const units = log.eventName === "TransferSingle" ? (args.id === edition.id ? (args.value ?? 0n) : 0n) : (args.ids ?? []).reduce((n, x, i) => (x === edition.id ? n + (args.values?.[i] ?? 0n) : n), 0n);
        // Zero units move nothing, and anyone can send them naming anyone.
        if (units === 0n) continue;
        if (!issued.has(args.from.toLowerCase()) && !issued.has(args.to.toLowerCase())) continue;
        const key = `${log.blockNumber}:${args.from.toLowerCase()}:${args.to.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        transfers++;
        await issuer.onTransfer(edition.id, args.from, args.to, log.blockNumber).catch((e: Error) => console.warn(`[edition sync] transfer hint: ${e.message}`));
      }
      // One fan-out however many PassUpdate logs the span holds.
      const announced = changed.some((log) => {
        const args = log.args as { tokenId?: bigint; fromTokenId?: bigint; toTokenId?: bigint };
        if (log.eventName === "PassUpdate") return args.tokenId === edition.id;
        return log.eventName === "BatchPassUpdate" && args.fromTokenId !== undefined && args.toTokenId !== undefined && args.fromTokenId <= edition.id && edition.id <= args.toTokenId;
      });
      if (announced) {
        updates = 1;
        await issuer.onPassUpdate(edition.id).catch((e: Error) => console.warn(`[edition sync] pass update: ${e.message}`));
      }
      const next = to + 1n;
      if (redis) await redis.set(cursorKey, next.toString());
      else memoryCursor = next;
    }
    return { checked: summary.checked, retired: summary.retired.length, transfers, updates };
  };

  return { rt, edition, issuer, apple, currentProposal, ballot, sync };
}

/// On serverless hosts (no watchers), catch up after the response is sent.
export function editionSyncAfter(ed: EditionRuntime): void {
  if (ed.rt.config.watchers) return;
  after(() => ed.sync().then(() => undefined, (e: Error) => console.warn(`[edition sync] ${e.message}`)));
}
