"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PassContent, PassManifest } from "@erc8426/core";
import { WalletPassError } from "@erc8426/core";
import { WalletPassClientError } from "@erc8426/client";
import { AddToWalletButton, useWalletPassClient } from "@erc8426/react";

import { shortHex } from "@/lib/pet";
import { PassPreview } from "./PassPreview";
import { useApp } from "./Providers";
import { NeedWallet, useWallet } from "./wallet";

/// The rental page: the one case of ERC-8426 where an account loses its pass
/// with no transfer. Rent a key for a few minutes, add it to a wallet, open
/// the door from the card, then watch what happens when the rental ends by
/// the clock, and again when the same key is rented to you a second time.

interface KeyView {
  tokenId: string;
  owner: string;
  user: string | null;
  expires: number;
  active: boolean;
  issuedTo: "renter" | "owner" | "nobody" | "someone else";
  unlocks: number;
}

interface RentalState {
  contract: `0x${string}`;
  seconds: number;
  now: number;
  key: KeyView | null;
  passUri?: string;
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

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export function RentalDetail() {
  const { config } = useApp();
  const passes = useWalletPassClient();
  const { address, signer } = useWallet();

  const [state, setState] = useState<RentalState | null | undefined>(undefined);
  const [tokenId, setTokenId] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState<Unlocked | null>(null);
  const [myLink, setMyLink] = useState<string | null>(null);
  const [activity, setActivity] = useState<Entry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [failed, setFailed] = useState(false);

  const log = useCallback((title: string, ok: boolean, detail: string) => {
    setActivity((a) => [{ id: Date.now() + Math.random(), title, ok, detail }, ...a].slice(0, 20));
  }, []);

  const current = useRef(address);
  current.current = address;
  const storeKey = address ? `erc8426-rental-key:${address.toLowerCase()}` : null;

  // The key this browser rented with this account, if any.
  useEffect(() => {
    setUnlocked(null);
    setMyLink(null);
    setActivity([]);
    setTokenId(storeKey ? window.localStorage.getItem(storeKey) : null);
  }, [storeKey]);

  const load = useCallback(async (): Promise<RentalState | null> => {
    const who = address;
    const res = await fetch(`/api/rental${tokenId ? `?tokenId=${tokenId}` : ""}`).catch(() => null);
    if (current.current !== who) return null;
    if (res?.status === 404) {
      setState(null);
      return null;
    }
    if (!res?.ok) {
      setFailed(true);
      return null;
    }
    const next = (await res.json()) as RentalState;
    if (current.current !== who) return null;
    setFailed(false);
    setState(next);
    return next;
  }, [address, tokenId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A clock for the countdown, and one reload when the rental ends.
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  const expires = state?.key?.expires ?? 0;
  const ended = expires > 0 && now >= expires;
  useEffect(() => {
    if (ended) void load();
  }, [ended, load]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  if (!config.rental) {
    return <p className="notice">This instance has no rental configured (RENTAL_CONTRACT_ADDRESS is not set).</p>;
  }
  const rental = config.rental;

  const house = async (body: Record<string, unknown>) => {
    const res = await fetch("/api/rental", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const out = (res ? await res.json().catch(() => null) : null) as Record<string, unknown> | null;
    return { ok: Boolean(res?.ok), status: res?.status ?? 0, body: out };
  };

  const rent = (again: boolean) =>
    run("rent", async () => {
      if (!address) return;
      const who = address;
      const r = await house(again ? { do: "rent-again", tokenId, account: who } : { do: "rent", account: who });
      if (current.current !== who) return;
      if (!r.ok) return log(again ? "Not rented again" : "Not rented", false, `HTTP ${r.status} ${String(r.body?.error ?? "")}${r.body?.message ? `: ${String(r.body.message)}` : ""}`);
      const id = String(r.body?.tokenId);
      if (storeKey) window.localStorage.setItem(storeKey, id);
      setTokenId(id);
      if (!again) {
        setUnlocked(null);
        setMyLink(null);
      }
      log(
        again ? "Rented again" : "Rented",
        true,
        again
          ? `The house rented key ${id} to you again for ${String(r.body?.seconds)} seconds. The owner had not taken it back in between. If you used your old link after check out, the issuer retired it then, and it stays retired: unlock the pass again to get this rental's link and card.`
          : `The house minted key ${id} and rented it to you for ${String(r.body?.seconds)} seconds (ERC-4907 setUser). You hold no token: the house owns the key, you are its user until check out.`,
      );
    });

  const unlock = () =>
    run("unlock", async () => {
      if (!tokenId) return;
      const who = address;
      try {
        const r = await passes.getManifest({ contract: rental.contract, tokenId }, { signer: signer ?? undefined });
        if (current.current !== who) return;
        const previewUrl = r.manifest.formats.preview;
        if (!previewUrl) throw new Error("the manifest has no preview format");
        const res = await fetch(previewUrl, { headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(`preview download answered HTTP ${res.status}`);
        const content = (await res.json()) as PassContent;
        if (current.current !== who) return;
        setUnlocked({ manifest: r.manifest, content });
        const link = content.links?.find((l) => l.key === "unlock")?.url ?? null;
        if (link) setMyLink(link);
        log("Manifest resolved", true, `HTTP 200 after a signed acquire proof. You are the key's user right now, so the pass is yours. Formats: ${Object.keys(r.manifest.formats).join(", ")}.`);
        await load();
      } catch (e) {
        if (current.current !== who) return;
        setUnlocked(null);
        log("Manifest refused", false, `${describe(e)}. The issuer read the chain fresh and you are not the account entitled to this key right now.`);
      }
    });

  const tryLink = () =>
    run("link", async () => {
      if (!myLink) return;
      const res = await fetch(myLink, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ attempt: crypto.randomUUID() }) }).catch(() => null);
      const body = (res ? await res.json().catch(() => null) : null) as { error?: string; message?: string; result?: { unlocks?: number } } | null;
      if (res?.ok) {
        log("Door unlocked from the pass link", true, `HTTP 200, no signature. The issuer read the chain fresh and you are the key's user. Opened ${String(body?.result?.unlocks ?? "?")} times with this key.`);
      } else if (res?.status === 403) {
        log("Link refused", false, `HTTP 403 ${body?.error ?? ""}. The fresh read says you are not entitled now: the rental has ended. Nothing told the issuer, it found out by reading the chain for this tap, and that read is the moment it retires this link. Tap again and it is gone (404).`);
      } else if (res?.status === 404) {
        log("Link retired", false, `HTTP 404 ${body?.error ?? ""}. The issuer has retired this link for good: it observed that you lost the key when it read the chain for a request after check out. A new rental gets a new link and a new card.`);
      } else {
        log("Link not followed", false, `HTTP ${res?.status ?? 0} ${body?.error ?? ""}${body?.message ? `: ${body.message}` : ""}`);
      }
      await load();
    });

  const ownerClaims = () =>
    run("owner", async () => {
      if (!tokenId) return;
      const r = await house({ do: "owner-claims", tokenId });
      const status = Number(r.body?.status ?? r.status);
      if (r.ok && status === 200) {
        log("The owner took the key back", true, "The owner's wallet asked for its pass with a signed proof and got it (HTTP 200). If no request had reached the issuer since check out, this is where it observes that the renter lost the key: the renter's links and download addresses are retired, and the renter's installed card is told it is no longer active.");
      } else {
        log("The owner was refused", false, `HTTP ${status} ${String(r.body?.error ?? "")}. During an active rental the owner is not entitled: only the guest's pass opens the door.`);
      }
      await load();
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
  if (state === null) return <p className="notice">This instance has no rental configured.</p>;

  const key = state.key;
  const left = Math.max(0, expires - now);
  const mine = Boolean(key && address && key.user && key.user.toLowerCase() === address.toLowerCase() && !ended);
  const issued = key?.issuedTo === "renter" ? "you (the renter)" : key?.issuedTo === "owner" ? "the owner" : key?.issuedTo === "nobody" ? "nobody yet" : "someone else";

  return (
    <>
      <div className="detail-head">
        <div>
          <p className="eyebrow">ERC-8426, entitlement that ends with no transfer</p>
          <h1>Rental key</h1>
          <p className="muted">
            A house key rented for a few minutes. The house owns the token, you are its user until check out (ERC-4907), and during the rental only your pass opens the door. Then the rental ends by the clock: no transaction, no event, nobody tells the issuer. This
            page is here to watch what happens next.
          </p>
        </div>
        <dl className="issuer-box" aria-label="Issuer">
          <div>
            <dt>Issuing contract (ERC-721 with ERC-4907)</dt>
            <dd>
              <code title={state.contract}>{shortHex(state.contract)}</code> on chain {config.chainId}
            </dd>
          </div>
          {state.passUri ? (
            <div>
              <dt>passURI({key?.tokenId})</dt>
              <dd>
                <code>{state.passUri}</code>
              </dd>
            </div>
          ) : null}
        </dl>
      </div>

      <div className="detail-grid">
        <div className="stack">
          <section className="card" aria-labelledby="key-h">
            <h2 id="key-h" className="h-small">
              The key
            </h2>
            {!address ? (
              <NeedWallet what="rent a key" />
            ) : !key ? (
              <>
                <p>You have not rented a key with this wallet.</p>
                <div className="button-row">
                  <button type="button" className="btn btn-primary" onClick={() => void rent(false)} disabled={busy !== null} aria-busy={busy === "rent"}>
                    Rent the key for {Math.round(state.seconds / 60)} minutes
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>
                  Key <strong>#{key.tokenId}</strong>.{" "}
                  {mine ? (
                    <>
                      Yours for another <strong aria-live="off">{clock(left)}</strong>.
                    </>
                  ) : (
                    <>
                      <strong>The rental has ended.</strong> The key is the owner&apos;s again.
                    </>
                  )}
                </p>
                <p className="muted small">
                  On chain: owner <code>{shortHex(key.owner)}</code>, user {key.user ? <code>{shortHex(key.user)}</code> : "nobody"}. The issuer last issued this key&apos;s pass to <strong>{issued}</strong>. Door opened {key.unlocks}{" "}
                  {key.unlocks === 1 ? "time" : "times"}.
                </p>
                <div className="button-row">
                  {!mine ? (
                    <>
                      <button type="button" className="btn" onClick={() => void ownerClaims()} disabled={busy !== null} aria-busy={busy === "owner"}>
                        The owner takes the key back
                      </button>
                      <button type="button" className="btn" onClick={() => void rent(true)} disabled={busy !== null} aria-busy={busy === "rent"}>
                        Rent the same key again
                      </button>
                      <button type="button" className="btn btn-quiet" onClick={() => void rent(false)} disabled={busy !== null}>
                        Rent a new key
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn btn-quiet" onClick={() => void ownerClaims()} disabled={busy !== null} aria-busy={busy === "owner"}>
                      The owner tries to take the key back now
                    </button>
                  )}
                </div>
              </>
            )}
            <p className="muted small">Free and open on purpose: this is a testnet demo and nothing here has value. The house pays for the rental; you sign and never send a transaction.</p>
          </section>

          {unlocked ? (
            <PassPreview content={unlocked.content} onLink={() => void tryLink()} />
          ) : key ? (
            <section className="card pass-placeholder" aria-labelledby="unlock-h">
              <h2 id="unlock-h" className="h-small">
                Your pass
              </h2>
              <p className="muted">The manifest is gated: you sign a challenge and the issuer reads the chain fresh. During the rental the pass is yours; after it, the same request is refused.</p>
              <button type="button" className="btn btn-primary" onClick={() => void unlock()} disabled={busy !== null || !signer} aria-busy={busy === "unlock"}>
                {mine ? "Unlock my pass" : "Ask for the pass anyway"}
              </button>
            </section>
          ) : null}

          {unlocked && key ? (
            <section className="card" aria-labelledby="wallets-h">
              <h2 id="wallets-h" className="h-small">
                Add to a wallet
              </h2>
              {config.platforms.length > 0 ? (
                <div className="wallet-buttons">
                  {config.platforms.map((p) => (
                    <AddToWalletButton key={p} contract={rental.contract} tokenId={key.tokenId} signer={signer} platform={p} className="btn btn-primary" onError={(e) => log(`Add to ${p}`, false, describe(e))} />
                  ))}
                </div>
              ) : (
                <p className="muted">Local mode: no Apple or Google credentials, so the manifest offers only the preview drawn above.</p>
              )}
              <p className="muted small">The card carries its own check out time, so the phone itself shows it expired when the time comes, with nothing sent to it.</p>
            </section>
          ) : null}
        </div>

        <div className="stack">
          <section className="card" aria-labelledby="door-h">
            <h2 id="door-h" className="h-small">
              The door
            </h2>
            {myLink ? (
              <>
                <p className="muted small">
                  This is the link printed on your pass. It opens the door with one tap and no signature, which is why it has to stop working when you stop being entitled. Use it during the rental, once after check out, and once more: the three
                  answers are different.
                </p>
                <div className="button-row">
                  <button type="button" className="btn btn-primary" onClick={() => void tryLink()} disabled={busy !== null} aria-busy={busy === "link"}>
                    Use my pass link
                  </button>
                </div>
              </>
            ) : (
              <p className="muted small">Unlock the pass to get its door link.</p>
            )}
            <ol className="muted small">
              <li>During the rental: the door opens (200).</li>
              <li>The first use after check out: refused by the fresh read (403). That read retires the link.</li>
              <li>Every use after that, a new rental included: retired (404).</li>
            </ol>
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
