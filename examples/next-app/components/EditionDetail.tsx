"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { getAddress, isAddress, parseAbi } from "viem";
import type { PassContent, PassManifest } from "@erc8426/core";
import { WalletPassError } from "@erc8426/core";
import { WalletPassClientError } from "@erc8426/client";
import { AddToWalletButton, useWalletPassClient } from "@erc8426/react";

import { shortHex } from "@/lib/pet";
import { PassPreview } from "./PassPreview";
import { useApp } from "./Providers";
import { NeedWallet, useWallet } from "./wallet";

/// The ERC-1155 edition page: the working draft of the ERC-1155 binding for
/// ERC-8426, made clickable. Claim a few units, unlock the pass that belongs
/// to your holding, vote with it, send units away and watch what the issuer
/// and the contract do.

const editionAbi = parseAbi([
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function claim(uint256 id, uint256 amount)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)",
]);

interface ProposalView {
  proposalId: string;
  title: string;
  snapshot: number;
  closes: number;
  yes: string;
  no: string;
  votable: boolean;
}

interface BallotView {
  power: string;
  choice: "none" | "yes" | "no";
  signed: boolean;
}

interface EditionState {
  contract: `0x${string}`;
  id: string;
  supply: string;
  claimLimit: string;
  open: boolean;
  passUri: string;
  proposal: ProposalView | null;
  proposalMinGapSeconds: number;
  now: number;
  holder: { account: string; balance: string; claimed: string; hasGas: boolean; ballot: BallotView | null } | null;
}

type VoteAction = "vote-yes" | "vote-no";
const VOTE_LABEL: Record<VoteAction, string> = { "vote-yes": "Yes", "vote-no": "No" };

interface Unlocked {
  manifest: PassManifest;
  content: PassContent;
}

interface Entry {
  id: number;
  title: string;
  ok: boolean;
  detail: string;
}

function describe(e: unknown): string {
  if (e instanceof WalletPassClientError) {
    const extra = e.serverCode && e.serverCode !== e.code ? ` / ${e.serverCode}` : "";
    return `${e.status ? `HTTP ${e.status} ` : ""}${e.code}${extra}${e.source === "client" ? " (refused by the client)" : ""}: ${e.message}`;
  }
  if (e instanceof WalletPassError) return `${e.code}: ${e.message}`;
  return (e as Error).message?.split("\n")[0] ?? String(e);
}

export function EditionDetail() {
  const { config, publicClient } = useApp();
  const passes = useWalletPassClient();
  const { address, signer, walletClient } = useWallet();

  const [state, setState] = useState<EditionState | null | undefined>(undefined);
  const [unlocked, setUnlocked] = useState<Unlocked | null>(null);
  const [previousLinks, setPreviousLinks] = useState<Record<string, string> | null>(null);
  const [activity, setActivity] = useState<Entry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [sendTo, setSendTo] = useState("");
  const [sendAmount, setSendAmount] = useState("1");

  const log = useCallback((title: string, ok: boolean, detail: string) => {
    setActivity((a) => [{ id: Date.now() + Math.random(), title, ok, detail }, ...a].slice(0, 20));
  }, []);

  // The connected account right now. Anything that finishes for an account
  // that is no longer the connected one is dropped, so one account's pass,
  // links or balance never land on screen under another.
  const current = useRef(address);
  current.current = address;
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (): Promise<EditionState | null> => {
    const who = address;
    const res = await fetch(`/api/edition${who ? `?account=${who}` : ""}`).catch(() => null);
    if (current.current !== who) return null;
    if (res?.status === 404) {
      setState(null);
      return null;
    }
    if (!res?.ok) {
      setFailed(true);
      return null;
    }
    const next = (await res.json()) as EditionState;
    if (current.current !== who) return null;
    setFailed(false);
    setState(next);
    return next;
  }, [address]);

  useEffect(() => {
    void load();
    // Another account means another pass: drop everything the last one did.
    setUnlocked(null);
    setPreviousLinks(null);
    setActivity([]);
  }, [load]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  if (!config.edition) {
    return <p className="notice">This instance has no edition configured (EDITION_CONTRACT_ADDRESS is not set).</p>;
  }
  const edition = config.edition;
  const token = { contract: edition.contract, tokenId: edition.id, standard: "erc1155" as const };

  /// Ask the issuer to catch up with the chain, as a watcher would have.
  const catchUp = () => fetch("/api/edition", { method: "POST" }).catch(() => undefined);

  const claim = (amount: bigint) =>
    run("claim", async () => {
      if (!walletClient) return;
      try {
        const hash = await walletClient.writeContract({ address: edition.contract, abi: editionAbi, functionName: "claim", args: [BigInt(edition.id), amount] });
        await publicClient.waitForTransactionReceipt({ hash });
        log("Claimed", true, `${amount} ${amount === 1n ? "unit" : "units"} of edition ${edition.id}, transaction ${shortHex(hash)}.`);
        await load();
      } catch (e) {
        log("Claim failed", false, describe(e));
      }
    });

  const unlock = () =>
    run("unlock", async () => {
      const who = address;
      try {
        const r = await passes.getManifest(token, { signer: signer ?? undefined });
        if (current.current !== who) return;
        log("Manifest resolved", true, `HTTP 200 after a signed acquire proof. The challenge named this token as erc1155 and named your account. Formats: ${Object.keys(r.manifest.formats).join(", ")}.`);
        const previewUrl = r.manifest.formats.preview;
        if (!previewUrl) throw new Error("the manifest has no preview format");
        const res = await fetch(previewUrl, { headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(`preview download answered HTTP ${res.status}`);
        const content = (await res.json()) as PassContent;
        if (current.current !== who) return;
        setUnlocked({ manifest: r.manifest, content });
      } catch (e) {
        if (current.current !== who) return;
        setUnlocked(null);
        log("Manifest refused", false, describe(e));
      }
    });

  const refreshPreview = async () => {
    const who = address;
    if (!unlocked?.manifest.formats.preview) return;
    const res = await fetch(unlocked.manifest.formats.preview, { headers: { accept: "application/json" } }).catch(() => null);
    if (!res?.ok) return;
    const content = (await res.json()) as PassContent;
    if (current.current === who) setUnlocked({ manifest: unlocked.manifest, content });
  };

  const signedVote = (action: VoteAction) =>
    run(`signed-${action}`, async () => {
      if (!signer) return;
      try {
        const r = await passes.signedAction({ token, action, signer });
        const tx = (r.body as { result?: { transactionHash?: string } }).result?.transactionHash;
        log(`Vote ${VOTE_LABEL[action]} (signed path)`, true, `HTTP ${r.status}. The issuer verified your signature and read your balance fresh; the contract counted your units at the snapshot${tx ? `, transaction ${shortHex(tx)}` : ""}. A signed vote is final.`);
      } catch (e) {
        log(`Vote ${VOTE_LABEL[action]} (signed path)`, false, describe(e));
      }
      await Promise.all([load(), refreshPreview()]);
    });

  const followLink = (key: string, url: string, label = "Pass link") =>
    run(`link-${key}`, async () => {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: "{}" });
      const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
      if (res.ok && res.headers.get("x-wallet-pass-repeat") === "true") {
        log(`${label}: ${key} (capability path)`, true, `HTTP ${res.status}, a repeat. The issuer answered with the outcome of the same tap a moment ago and did not run it again.`);
      } else if (res.ok) {
        log(`${label}: ${key} (capability path)`, true, `HTTP ${res.status}. No signature: the link stood in for it. The contract recorded it as a link vote, which you can replace once with a signed vote while the proposal is open.`);
      } else {
        const why = res.status === 403 ? " The link is still known, but the account it was issued to no longer holds a unit." : res.status === 404 ? " The link has been retired." : "";
        log(`${label}: ${key} (capability path)`, false, `HTTP ${res.status} ${body?.error ?? ""}${body?.message ? `: ${body.message}` : ""}.${why}`);
      }
      await Promise.all([load(), refreshPreview()]);
    });

  const openProposal = () =>
    run("propose", async () => {
      const res = await fetch("/api/edition/proposal", { method: "POST" });
      const body = (await res.json().catch(() => null)) as { error?: string; message?: string; proposal?: ProposalView } | null;
      if (res.ok && body?.proposal) {
        log("Proposal opened", true, `Proposal ${body.proposal.proposalId}: "${body.proposal.title}". Its snapshot is now: whoever holds units at this moment votes with them. Every holder's pass is told.`);
      } else {
        log("Proposal not opened", false, `HTTP ${res.status} ${body?.error ?? ""}${body?.message ? `: ${body.message}` : ""}`);
      }
      // The snapshot second has to end before votes are accepted.
      await new Promise((r) => setTimeout(r, 2000));
      await Promise.all([load(), refreshPreview()]);
    });

  const rotate = () =>
    run("rotate", async () => {
      if (!signer) return;
      const before = linksOf(unlocked);
      try {
        await passes.rotatePassLinks(token, { signer });
        setPreviousLinks(before);
        setUnlocked(null);
        log("Links reset", true, "Your links and acquisition URLs for this edition were replaced. No other holder's were touched. Unlock again to see the new ones.");
      } catch (e) {
        log("Reset refused", false, describe(e));
      }
    });

  const send = (ev: FormEvent) => {
    ev.preventDefault();
    void run("send", async () => {
      if (!walletClient || !address) return;
      if (!isAddress(sendTo)) return log("Send", false, "That is not an address.");
      const amount = /^\d+$/.test(sendAmount) ? BigInt(sendAmount) : 0n;
      if (amount < 1n) return log("Send", false, "Send at least one unit.");
      const before = linksOf(unlocked);
      try {
        const hash = await walletClient.writeContract({
          address: edition.contract,
          abi: editionAbi,
          functionName: "safeTransferFrom",
          args: [address, getAddress(sendTo), BigInt(edition.id), amount, "0x"],
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        // What is left is read from the chain at the block of the transfer,
        // never worked out from what this page last showed.
        const left = await publicClient.readContract({
          address: edition.contract,
          abi: editionAbi,
          functionName: "balanceOf",
          args: [address, BigInt(edition.id)],
          blockNumber: receipt.blockNumber,
        });
        if (left < 1n) {
          setPreviousLinks(before);
          setUnlocked(null);
          log("Sent", true, `${amount} to ${shortHex(sendTo)}. You hold none now, so you lost the pass. Try an old link below: the issuer reads your balance, refuses (403) and retires the link on the spot (404 from then on), even if a unit comes back.`);
        } else {
          log("Sent", true, `${amount} to ${shortHex(sendTo)}. You still hold ${left}. Your pass keeps its serial and its links, and is told its new count.`);
        }
        await catchUp();
        await Promise.all([load(), left < 1n ? Promise.resolve() : refreshPreview()]);
      } catch (e) {
        log("Send failed", false, describe(e));
      }
    });
  };

  if (state === undefined) {
    return failed ? (
      <p className="notice" role="alert">
        The chain could not be read.{" "}
        <button type="button" className="btn btn-quiet" onClick={() => void load()}>
          Try again
        </button>
      </p>
    ) : (
      <p aria-live="polite">Reading the chain...</p>
    );
  }
  if (state === null) return <p className="notice">This instance has no edition configured.</p>;

  const holder = state.holder;
  const balance = BigInt(holder?.balance ?? "0");
  const remaining = BigInt(state.claimLimit) - BigInt(holder?.claimed ?? "0");
  const links = unlocked?.content.links ?? [];
  const proposal = state.proposal;
  const ballot = holder?.ballot ?? null;

  return (
    <>
      <div className="detail-head">
        <div>
          <p className="eyebrow">ERC-1155 binding, working draft</p>
          <h1>Edition {state.id}</h1>
          <p className="muted">
            One id, many holders. Every holder gets their own pass, and it works while that account holds at least one unit. Each unit is one vote. Not part of ERC-8426 yet: this page exists so the draft can be tried before it is proposed.
          </p>
        </div>
        <dl className="issuer-box" aria-label="Issuer">
          <div>
            <dt>Issuing contract (ERC-1155)</dt>
            <dd>
              <code title={state.contract}>{shortHex(state.contract)}</code> on chain {config.chainId}
            </dd>
          </div>
          <div>
            <dt>Pass endpoint</dt>
            <dd>
              <code>{state.passUri.replace(/^https?:\/\//, "")}</code>
            </dd>
          </div>
        </dl>
      </div>

      <div className="detail-grid">
        <div className="stack">
          <section className="card" aria-labelledby="chain-h">
            <h2 id="chain-h" className="h-small">
              On chain now
            </h2>
            <p>
              {state.supply} units of edition {state.id} exist.{" "}
              {address ? (
                <>
                  You hold <strong>{balance.toString()}</strong>.
                </>
              ) : (
                "Connect a wallet to see yours."
              )}
            </p>
            {address && walletClient ? (
              <>
                {!state.open ? <p className="muted small">Claiming is closed.</p> : null}
                {state.open && remaining > 0n ? (
                  <div className="button-row">
                    <button type="button" className="btn btn-primary" onClick={() => void claim(1n)} disabled={busy !== null} aria-busy={busy === "claim"}>
                      Claim 1 unit
                    </button>
                    {remaining > 1n ? (
                      <button type="button" className="btn" onClick={() => void claim(remaining)} disabled={busy !== null}>
                        Claim {remaining.toString()} units
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {state.open && remaining <= 0n ? <p className="muted small">You have claimed all {state.claimLimit} this contract allows one account. Units sent to you still count.</p> : null}
                {holder && !holder.hasGas ? (
                  <p className="muted small">This wallet has no testnet gas yet. Claiming and sending are your own transactions, so it needs a little. A demo wallet is sent some when it is created; give it a few seconds.</p>
                ) : null}
              </>
            ) : null}
            <p className="muted small">Free and open on purpose: this is a testnet demo and nothing here has value. Each account can claim up to {state.claimLimit} units.</p>
          </section>

          {unlocked ? (
            <PassPreview content={unlocked.content} onLink={(key, url) => void followLink(key, url)} />
          ) : (
            <section className="card pass-placeholder" aria-labelledby="unlock-h">
              <h2 id="unlock-h" className="h-small">
                Your pass
              </h2>
              {!address ? (
                <NeedWallet what="unlock your pass" />
              ) : (
                <>
                  <p>
                    The pass belongs to your account&apos;s holding of this edition. Unlocking signs a challenge that names this token under <code>erc1155</code> and names your account; the issuer then reads <code>balanceOf(you, {state.id})</code> fresh.
                  </p>
                  <button type="button" className="btn btn-primary" onClick={() => void unlock()} disabled={busy !== null} aria-busy={busy === "unlock"}>
                    {busy === "unlock" ? "Waiting for signature..." : balance > 0n ? "Unlock my pass" : "Try to unlock (you hold none)"}
                  </button>
                </>
              )}
            </section>
          )}

          {unlocked ? (
            <section className="card" aria-labelledby="wallets-h">
              <h2 id="wallets-h" className="h-small">
                Add to a wallet
              </h2>
              {config.platforms.length > 0 ? (
                <div className="wallet-buttons">
                  {config.platforms.map((p) => (
                    <AddToWalletButton
                      key={p}
                      contract={edition.contract}
                      tokenId={edition.id}
                      signer={signer}
                      platform={p}
                      className="btn btn-primary"
                      onError={(e) => log(`Add to ${p}`, false, describe(e))}
                    />
                  ))}
                </div>
              ) : (
                <p className="muted">Local mode: no Apple or Google credentials, so the manifest offers only the preview drawn above.</p>
              )}
            </section>
          ) : null}
        </div>

        <div className="stack">
          <section className="card" aria-labelledby="vote-h">
            <h2 id="vote-h" className="h-small">
              Vote: one unit, one vote
            </h2>
            {proposal ? (
              <>
                <p>
                  <strong>
                    Proposal {proposal.proposalId}: {proposal.title}
                  </strong>
                </p>
                <p className="muted small">
                  Yes {proposal.yes}, No {proposal.no}. {proposal.votable ? `Open for about ${minutesLeft(proposal.closes, state.now)}.` : proposal.closes < state.now ? "Closed." : "Opening..."}
                </p>
                {address && ballot ? (
                  <p className="small">
                    Your votes on this proposal: <strong>{ballot.power}</strong> (what you held when it opened).{" "}
                    {ballot.choice !== "none" ? (
                      <>
                        You voted <strong>{ballot.choice === "yes" ? "Yes" : "No"}</strong>, {ballot.signed ? "signed. That is final." : "by pass link. You can replace it once with a signed vote."}
                      </>
                    ) : null}
                  </p>
                ) : null}
                {address && ballot && ballot.power === "0" && balance > 0n ? (
                  <p className="notice small">
                    You hold units now, but you held none when this proposal opened, so they carry no vote on it. That is deliberate: otherwise one unit could vote, move to a second wallet and vote again. Open a new proposal and your units count.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="muted small">No proposal has been opened yet.</p>
            )}
            {signer && proposal?.votable && ballot && ballot.power !== "0" && !(ballot.choice !== "none" && ballot.signed) ? (
              <div className="button-row">
                {(["vote-yes", "vote-no"] as const).map((a) => (
                  <button key={a} type="button" className="btn" onClick={() => void signedVote(a)} disabled={busy !== null} aria-busy={busy === `signed-${a}`}>
                    Vote {VOTE_LABEL[a]} with a signature
                  </button>
                ))}
              </div>
            ) : null}
            {links.length > 0 ? (
              <>
                <p className="muted small">Or the way a phone does it, with the links printed on your pass. No signature, so anyone holding the pass could tap them: that is why a link can vote only once and cannot change a vote.</p>
                <div className="button-row">
                  {links.map((l) => (
                    <button key={l.key} type="button" className="btn" onClick={() => void followLink(l.key, l.url)} disabled={busy !== null}>
                      {l.label} with the pass link
                    </button>
                  ))}
                </div>
              </>
            ) : unlocked ? (
              <p className="muted small">Your pass carries vote links only while they can do something: a proposal is open, you have votes on it, and you have not voted.</p>
            ) : (
              <p className="muted small">Unlock the pass to get its vote links.</p>
            )}
            <div className="button-row">
              <button type="button" className="btn btn-quiet" onClick={() => void openProposal()} disabled={busy !== null} aria-busy={busy === "propose"}>
                Open a new proposal (demo)
              </button>
            </div>
            {previousLinks && Object.keys(previousLinks).length > 0 ? (
              <div className="old-links">
                <p className="small">Links from before the last reset, or from before you sent your last unit:</p>
                <div className="button-row">
                  {Object.entries(previousLinks).map(([key, url]) => (
                    <button key={key} type="button" className="btn btn-quiet" onClick={() => void followLink(key, url, "Old link")} disabled={busy !== null}>
                      Old {key} link
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {signer && balance > 0n ? (
              <button type="button" className="btn btn-quiet" onClick={() => void rotate()} disabled={busy !== null} aria-busy={busy === "rotate"}>
                Reset my pass links
              </button>
            ) : null}
          </section>

          {walletClient && balance > 0n ? (
            <section className="card" aria-labelledby="send-h">
              <h2 id="send-h" className="h-small">
                Send units
              </h2>
              <p className="muted small">
                Send some and keep at least one: your pass keeps its links and shows the new count. Send them all: you lose the pass, and your links stop working. Units you send after a proposal opened still vote from your account on that proposal, not from the receiver's. The receiver gets their own pass with their own links, never yours.
              </p>
              <form onSubmit={send} className="inline-form">
                <label htmlFor="send-to">Recipient address</label>
                <input id="send-to" value={sendTo} onChange={(e) => setSendTo(e.target.value.trim())} placeholder="0x..." spellCheck={false} autoComplete="off" />
                <label htmlFor="send-amount">Units</label>
                <input id="send-amount" value={sendAmount} onChange={(e) => setSendAmount(e.target.value.trim())} inputMode="numeric" style={{ maxWidth: "5rem" }} />
                <button type="submit" className="btn" disabled={busy !== null || !sendTo} aria-busy={busy === "send"}>
                  Send
                </button>
              </form>
            </section>
          ) : null}

          <section className="card" aria-labelledby="activity-h">
            <h2 id="activity-h" className="h-small">
              Activity
            </h2>
            {activity.length === 0 ? <p className="muted small">Nothing yet.</p> : null}
            <ol className="activity" aria-live="polite">
              {activity.map((a) => (
                <li key={a.id} className={a.ok ? "ok" : "refused"}>
                  <span className="activity-title">
                    <span className="sr-only">{a.ok ? "Succeeded: " : "Refused: "}</span>
                    {a.title}
                  </span>
                  <span className="activity-detail">{a.detail}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    </>
  );
}

function minutesLeft(closes: number, now: number): string {
  const s = Math.max(0, closes - now);
  return s >= 120 ? `${Math.round(s / 60)} more minutes` : s >= 60 ? "1 more minute" : `${s} more seconds`;
}

function linksOf(u: Unlocked | null): Record<string, string> | null {
  if (!u?.content.links?.length) return null;
  return Object.fromEntries(u.content.links.map((l) => [l.key, l.url]));
}
