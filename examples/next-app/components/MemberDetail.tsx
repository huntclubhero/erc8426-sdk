"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseAbi } from "viem";
import type { PassContent, PassManifest } from "@erc8426/core";
import { WalletPassError } from "@erc8426/core";
import { WalletPassClientError } from "@erc8426/client";
import { AddToWalletButton, useWalletPassClient } from "@erc8426/react";

import { shortHex } from "@/lib/pet";
import { PassPreview } from "./PassPreview";
import { useApp } from "./Providers";
import { NeedWallet, useWallet } from "./wallet";

/// The member pass page: the "go dark and come back" case of the ERC-1155
/// binding draft, made clickable. Claim a unit, add the pass to a wallet,
/// send the unit away and watch the installed pass go dark, then claim again
/// and watch the same pass come back.

const memberAbi = parseAbi([
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function claim(uint256 id, uint256 amount)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)",
]);

/// Where "send it away" sends: an address nobody holds the key to.
const AWAY = "0x000000000000000000000000000000000000dEaD" as const;

interface MemberState {
  contract: `0x${string}`;
  id: string;
  supply: string;
  claimLimit: string;
  open: boolean;
  passUri: string;
  holder: { account: string; balance: string; claimed: string; hasGas: boolean; pass: { serial: string; dark: boolean } | null } | null;
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

export function MemberDetail() {
  const { config, publicClient } = useApp();
  const passes = useWalletPassClient();
  const { address, signer, walletClient } = useWallet();

  const [state, setState] = useState<MemberState | null | undefined>(undefined);
  const [unlocked, setUnlocked] = useState<Unlocked | null>(null);
  const [activity, setActivity] = useState<Entry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const log = useCallback((title: string, ok: boolean, detail: string) => {
    setActivity((a) => [{ id: Date.now() + Math.random(), title, ok, detail }, ...a].slice(0, 20));
  }, []);

  // Anything that finishes for an account that is no longer the connected
  // one is dropped, so one account's pass never lands under another.
  const current = useRef(address);
  current.current = address;

  const load = useCallback(async (): Promise<MemberState | null> => {
    const who = address;
    const res = await fetch(`/api/member${who ? `?account=${who}` : ""}`).catch(() => null);
    if (current.current !== who) return null;
    if (res?.status === 404) {
      setState(null);
      return null;
    }
    if (!res?.ok) {
      setFailed(true);
      return null;
    }
    const next = (await res.json()) as MemberState;
    if (current.current !== who) return null;
    setFailed(false);
    setState(next);
    return next;
  }, [address]);

  useEffect(() => {
    void load();
    setUnlocked(null);
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

  if (!config.member) {
    return <p className="notice">This instance has no member pass configured (MEMBER_CONTRACT_ADDRESS is not set).</p>;
  }
  const member = config.member;
  const token = { contract: member.contract, tokenId: member.id, standard: "erc1155" as const };

  /// Ask the issuer to read this account's balance now and act on it, as a
  /// watcher would have on the transfer.
  const check = async (who: string) => {
    const res = await fetch("/api/member", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: who }) }).catch(() => null);
    return res?.ok ? ((await res.json()) as { dark: boolean; revived: boolean; pass: { serial: string; dark: boolean } | null }) : null;
  };

  const claim = () =>
    run("claim", async () => {
      if (!walletClient || !address) return;
      const hadDarkPass = state?.holder?.pass?.dark === true;
      try {
        const hash = await walletClient.writeContract({ address: member.contract, abi: memberAbi, functionName: "claim", args: [BigInt(member.id), 1n] });
        await publicClient.waitForTransactionReceipt({ hash });
        const seen = await check(address);
        if (hadDarkPass) {
          log(
            "Holding again",
            true,
            seen?.revived
              ? `Claimed 1 unit, transaction ${shortHex(hash)}. The issuer read your balance and brought your pass back: the same card, the same serial, live again. Look at your wallet.`
              : `Claimed 1 unit, transaction ${shortHex(hash)}. Your pass comes back when the issuer next reads your balance.`,
          );
        } else {
          log("Claimed", true, `1 unit of membership ${member.id}, transaction ${shortHex(hash)}.`);
        }
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
        log("Manifest resolved", true, `HTTP 200 after a signed acquire proof. Formats: ${Object.keys(r.manifest.formats).join(", ")}.`);
        const previewUrl = r.manifest.formats.preview;
        if (!previewUrl) throw new Error("the manifest has no preview format");
        const res = await fetch(previewUrl, { headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(`preview download answered HTTP ${res.status}`);
        const content = (await res.json()) as PassContent;
        if (current.current !== who) return;
        setUnlocked({ manifest: r.manifest, content });
        await load();
      } catch (e) {
        if (current.current !== who) return;
        setUnlocked(null);
        log("Manifest refused", false, describe(e));
      }
    });

  const sendAway = () =>
    run("send", async () => {
      if (!walletClient || !address) return;
      try {
        const held = await publicClient.readContract({ address: member.contract, abi: memberAbi, functionName: "balanceOf", args: [address, BigInt(member.id)] });
        if (held < 1n) return log("Send", false, "You hold no unit.");
        const hash = await walletClient.writeContract({
          address: member.contract,
          abi: memberAbi,
          functionName: "safeTransferFrom",
          args: [address, AWAY, BigInt(member.id), held, "0x"],
        });
        await publicClient.waitForTransactionReceipt({ hash });
        const seen = await check(address);
        setUnlocked(null);
        log(
          "Sent away",
          true,
          seen?.dark
            ? `${held} ${held === 1n ? "unit" : "units"} sent, transaction ${shortHex(hash)}. You hold none now. The issuer read your balance and took your pass dark: it stays in your wallet, says it is dark and why, and its download addresses were replaced. Look at your wallet.`
            : `${held} ${held === 1n ? "unit" : "units"} sent, transaction ${shortHex(hash)}. You hold none now. ${seen?.pass ? "Your pass goes dark when the issuer next reads your balance." : "You had not unlocked a pass, so there is none to go dark."}`,
        );
        await load();
      } catch (e) {
        log("Send failed", false, describe(e));
      }
    });

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
  if (state === null) return <p className="notice">This instance has no member pass configured.</p>;

  const holder = state.holder;
  const balance = BigInt(holder?.balance ?? "0");
  const remaining = BigInt(state.claimLimit) - BigInt(holder?.claimed ?? "0");
  const pass = holder?.pass ?? null;

  return (
    <>
      <div className="detail-head">
        <div>
          <p className="eyebrow">ERC-1155 binding, working draft</p>
          <h1>Member pass</h1>
          <p className="muted">
            A pass with no one tap links. Nothing on it can act without your signature, so a copy in someone else&apos;s hands can do nothing. That is why it does not have to be replaced when your unit leaves: it goes dark, and comes back on the same card when you
            hold a unit again.
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
            <dt>passURI({state.id})</dt>
            <dd>
              <code>{state.passUri}</code>
            </dd>
          </div>
        </dl>
      </div>

      <div className="detail-grid">
        <div className="stack">
          <section className="card" aria-labelledby="steps-h">
            <h2 id="steps-h" className="h-small">
              Try it in four steps
            </h2>
            {!address ? (
              <NeedWallet what="claim a unit" />
            ) : (
              <>
                <p>
                  You hold <strong>{balance.toString()}</strong> {balance === 1n ? "unit" : "units"}.{" "}
                  {pass ? (
                    <>
                      Your pass is <strong>{pass.dark ? "dark" : "live"}</strong>.
                    </>
                  ) : (
                    "You have no pass yet."
                  )}
                </p>
                <ol className="muted small">
                  <li>Claim a unit.</li>
                  <li>Unlock your pass and add it to your wallet.</li>
                  <li>Send the unit away. The card in your wallet goes dark.</li>
                  <li>Claim again. The same card comes back.</li>
                </ol>
                <div className="button-row">
                  {balance < 1n && state.open && remaining > 0n && holder?.hasGas ? (
                    <button type="button" className="btn btn-primary" onClick={() => void claim()} disabled={busy !== null} aria-busy={busy === "claim"}>
                      {pass?.dark ? "Claim a unit again" : "Claim a unit"}
                    </button>
                  ) : null}
                  {balance >= 1n ? (
                    <button type="button" className="btn" onClick={() => void sendAway()} disabled={busy !== null} aria-busy={busy === "send"}>
                      Send my unit away
                    </button>
                  ) : null}
                </div>
                {balance < 1n && state.open && remaining <= 0n ? (
                  <p className="muted small">This account has claimed all {state.claimLimit} units the contract allows it. Use a new demo wallet to go again.</p>
                ) : null}
                {!state.open ? <p className="muted small">Claiming is closed.</p> : null}
                {holder && !holder.hasGas ? (
                  <p className="muted small">This wallet has no testnet gas yet. Claiming and sending are your own transactions, so it needs a little. A demo wallet is sent some when it is created; give it a moment and reload.</p>
                ) : null}
              </>
            )}
            <p className="muted small">Free and open on purpose: this is a testnet demo and nothing here has value. Sending away sends to an address nobody holds the key to.</p>
          </section>

          {unlocked ? (
            <PassPreview content={unlocked.content} />
          ) : (
            <section className="card pass-placeholder" aria-labelledby="unlock-h">
              <h2 id="unlock-h" className="h-small">
                Your pass
              </h2>
              {!address ? (
                <NeedWallet what="unlock your pass" />
              ) : balance < 1n ? (
                <p className="muted">
                  {pass?.dark
                    ? "Your pass is dark. The issuer hands out nothing while you hold no unit: not the manifest, not a download. The card already in your wallet says it is dark."
                    : "Claim a unit first. The manifest is refused for an account that holds none."}
                </p>
              ) : (
                <>
                  <p className="muted">The manifest is gated: you sign a challenge that names this membership and your account, and the issuer reads your balance fresh.</p>
                  <button type="button" className="btn btn-primary" onClick={() => void unlock()} disabled={busy !== null} aria-busy={busy === "unlock"}>
                    Unlock my pass
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
                      contract={member.contract}
                      tokenId={member.id}
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
          <section className="card" aria-labelledby="why-h">
            <h2 id="why-h" className="h-small">
              Dark, or replaced?
            </h2>
            <p className="muted small">
              The edition pass on this site carries vote links that work with one tap and no signature. A copy of that card could vote, so when its account stops holding, the card is retired for good and a returning holder gets a new one.
            </p>
            <p className="muted small">
              This pass carries no such link. A copy of it can do nothing, so the issuer may keep the card and switch it off: it goes dark, says why, and comes back when the account holds again. The download addresses are still replaced every time, because they hand
              out the pass itself.
            </p>
          </section>

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
