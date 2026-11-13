"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
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
/// to your holding, send units away and watch what the issuer does.

const editionAbi = parseAbi([
  "function claim(uint256 id, uint256 amount)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)",
]);

interface EditionState {
  contract: `0x${string}`;
  id: string;
  supply: string;
  claimLimit: string;
  open: boolean;
  stampsPerDay: number;
  passUri: string;
  holder: { account: string; balance: string; claimed: string; hasGas: boolean; stamps: number } | null;
}

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

  const load = useCallback(async () => {
    const res = await fetch(`/api/edition${address ? `?account=${address}` : ""}`);
    if (res.status === 404) return setState(null);
    if (!res.ok) return;
    setState((await res.json()) as EditionState);
  }, [address]);

  useEffect(() => {
    void load();
    // Another account means another pass: drop what the last one unlocked.
    setUnlocked(null);
    setPreviousLinks(null);
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
      try {
        const r = await passes.getManifest(token, { signer: signer ?? undefined });
        log("Manifest resolved", true, `HTTP 200 after a signed acquire proof. The challenge named this token as erc1155 and named your account. Formats: ${Object.keys(r.manifest.formats).join(", ")}.`);
        const previewUrl = r.manifest.formats.preview;
        if (!previewUrl) throw new Error("the manifest has no preview format");
        const res = await fetch(previewUrl, { headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(`preview download answered HTTP ${res.status}`);
        setUnlocked({ manifest: r.manifest, content: (await res.json()) as PassContent });
      } catch (e) {
        setUnlocked(null);
        log("Manifest refused", false, describe(e));
      }
    });

  const refreshPreview = async () => {
    if (!unlocked?.manifest.formats.preview) return;
    const res = await fetch(unlocked.manifest.formats.preview, { headers: { accept: "application/json" } });
    if (res.ok) setUnlocked({ manifest: unlocked.manifest, content: (await res.json()) as PassContent });
  };

  const signedStamp = () =>
    run("signed-stamp", async () => {
      if (!signer) return;
      try {
        const r = await passes.signedAction({ token, action: "stamp", signer });
        const total = (r.body as { result?: { stamps?: number } }).result?.stamps;
        log("Stamp (signed path)", true, `HTTP ${r.status}. The issuer verified your signature and read your balance fresh.${total ? ` Stamps: ${total}.` : ""}`);
        await Promise.all([load(), refreshPreview()]);
      } catch (e) {
        log("Stamp (signed path)", false, describe(e));
      }
    });

  const followLink = (key: string, url: string, label = "Pass link") =>
    run(`link-${key}`, async () => {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: "{}" });
      const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
      if (res.ok) {
        log(`${label}: ${key} (capability path)`, true, `HTTP ${res.status}. No signature: the link stood in for it, and the issuer still read the balance of the account it was issued to.`);
        await Promise.all([load(), refreshPreview()]);
      } else {
        const why = res.status === 403 ? " The link is still known, but the account it was issued to no longer holds a unit." : res.status === 404 ? " The link has been retired." : "";
        log(`${label}: ${key} (capability path)`, false, `HTTP ${res.status} ${body?.error ?? ""}${body?.message ? `: ${body.message}` : ""}.${why}`);
      }
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
        await publicClient.waitForTransactionReceipt({ hash });
        const left = BigInt(state?.holder?.balance ?? "0") - amount;
        if (left < 1n) {
          setPreviousLinks(before);
          setUnlocked(null);
          log("Sent", true, `${amount} to ${shortHex(sendTo)}. You hold none now, so you lost the pass. Try the old link below: the fresh balance read refuses it (403), and once the issuer catches up it is retired (404).`);
        } else {
          log("Sent", true, `${amount} to ${shortHex(sendTo)}. You still hold ${left}, so nothing about your pass changed. Try your link: it still works.`);
        }
        await catchUp();
        await load();
      } catch (e) {
        log("Send failed", false, describe(e));
      }
    });
  };

  if (state === undefined) return <p aria-live="polite">Reading the chain...</p>;
  if (state === null) return <p className="notice">This instance has no edition configured.</p>;

  const holder = state.holder;
  const balance = BigInt(holder?.balance ?? "0");
  const remaining = BigInt(state.claimLimit) - BigInt(holder?.claimed ?? "0");
  const links = unlocked?.content.links ?? [];

  return (
    <>
      <div className="detail-head">
        <div>
          <p className="eyebrow">ERC-1155 binding, working draft</p>
          <h1>Edition {state.id}</h1>
          <p className="muted">
            One id, many holders. Every holder gets their own pass, and it works while that account holds at least one unit. Not part of ERC-8426 yet: this page exists so the draft can be tried before it is proposed.
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
          <section className="card" aria-labelledby="stamp-h">
            <h2 id="stamp-h" className="h-small">
              Stamp the pass
            </h2>
            <p className="muted small">
              A stamp is a number on your pass, kept by the issuer: at most {state.stampsPerDay} a day, and it moves nothing. It can be reached two ways.
            </p>
            <div className="button-row">
              {signer ? (
                <button type="button" className="btn" onClick={() => void signedStamp()} disabled={busy !== null} aria-busy={busy === "signed-stamp"}>
                  Stamp with a signature
                </button>
              ) : null}
              {links.map((l) => (
                <button key={l.key} type="button" className="btn" onClick={() => void followLink(l.key, l.url)} disabled={busy !== null}>
                  Stamp with the pass link
                </button>
              ))}
            </div>
            {links.length === 0 ? <p className="muted small">Unlock the pass to get its link.</p> : null}
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
                Send some and keep at least one: your pass and its links stay exactly as they are. Send them all: you lose the pass, and your links stop working. The receiver gets their own pass with their own links, never yours.
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

function linksOf(u: Unlocked | null): Record<string, string> | null {
  if (!u?.content.links?.length) return null;
  return Object.fromEntries(u.content.links.map((l) => [l.key, l.url]));
}
