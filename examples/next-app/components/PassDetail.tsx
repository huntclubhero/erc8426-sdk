"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { getAddress, isAddress, isAddressEqual } from "viem";
import type { PassContent, PassManifest } from "@erc8426/core";
import { WalletPassError } from "@erc8426/core";
import { WalletPassClientError, originMatches, type IssuerDisplay, type PassUpdateNotice } from "@erc8426/client";
import { AddToWalletButton, usePassUpdates, useWalletPassClient } from "@erc8426/react";

import { mood, petName, relativeTime, shortHex, type PetState } from "@/lib/pet";
import { CARE_ACTIONS, petPassAbi, type CareAction } from "@/lib/petAbi";
import { PassPreview } from "./PassPreview";
import { useApp } from "./Providers";
import { NeedWallet, useWallet } from "./wallet";

interface Unlocked {
  manifest: PassManifest;
  configuration: string;
  content: PassContent;
}

interface Entry {
  id: number;
  at: Date;
  title: string;
  ok: boolean;
  detail: string;
}

const CARE_LABEL: Record<CareAction, string> = { feed: "Feed", water: "Water", play: "Play" };

/// One line for any failure, keeping the status and the issuer's code
/// visible, because the difference between a 403 and a 401 is the lesson.
function describe(e: unknown): string {
  if (e instanceof WalletPassClientError) {
    const extra = e.serverCode && e.serverCode !== e.code ? ` / ${e.serverCode}` : "";
    return `${e.status ? `HTTP ${e.status} ` : ""}${e.code}${extra}${e.source === "client" ? " (refused by the client)" : ""}: ${e.message}`;
  }
  if (e instanceof WalletPassError) return `${e.code}: ${e.message}`;
  return (e as Error).message?.split("\n")[0] ?? String(e);
}

export function PassDetail({ tokenId }: { tokenId: string }) {
  const { config, publicClient } = useApp();
  const passes = useWalletPassClient();
  const { address, signer, walletClient } = useWallet();
  const token = { contract: config.contract, tokenId };

  const [pet, setPet] = useState<PetState | null | undefined>(undefined);
  const [issuer, setIssuer] = useState<IssuerDisplay | null>(null);
  const [unlocked, setUnlocked] = useState<Unlocked | null>(null);
  const [previousLinks, setPreviousLinks] = useState<Record<string, string> | null>(null);
  const [activity, setActivity] = useState<Entry[]>([]);
  const [updates, setUpdates] = useState<PassUpdateNotice[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [transferTo, setTransferTo] = useState("");
  const [transferred, setTransferred] = useState(false);

  const log = useCallback((title: string, ok: boolean, detail: string) => {
    setActivity((a) => [{ id: Date.now() + Math.random(), at: new Date(), title, ok, detail }, ...a].slice(0, 20));
  }, []);

  const loadPet = useCallback(async () => {
    const res = await fetch(`/api/pets/${tokenId}`);
    if (res.status === 404) return setPet(null);
    const body = await res.json();
    setPet(body.pet ?? null);
  }, [tokenId]);

  useEffect(() => {
    void loadPet();
    passes.issuerDisplay(token).then(setIssuer, () => setIssuer(null));
  }, [tokenId, passes, loadPet]);

  // Live PassUpdate feed. Every care, mint and transfer emits one.
  usePassUpdates(config.contract, {
    tokenId,
    onUpdate: (u) => {
      setUpdates((list) => [u, ...list].slice(0, 8));
      void loadPet();
    },
  });

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  // Resolve the gated manifest (signing the acquire challenge), then fetch
  // the preview file it lists. Held in memory only, never stored: the spec
  // forbids durably caching acquisition URLs.
  const unlock = () =>
    run("unlock", async () => {
      try {
        const r = await passes.getManifest(token, { signer: signer ?? undefined });
        const formats = Object.keys(r.manifest.formats);
        log("Manifest resolved", true, `${r.configuration} configuration, HTTP 200 after a signed acquire proof. Formats: ${formats.join(", ")}.`);
        const previewUrl = r.manifest.formats.preview;
        if (!previewUrl) throw new Error("the manifest has no preview format");
        const res = await fetch(previewUrl, { headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(`preview download answered HTTP ${res.status}`);
        setUnlocked({ manifest: r.manifest, configuration: r.configuration, content: (await res.json()) as PassContent });
      } catch (e) {
        setUnlocked(null);
        log("Manifest refused", false, describe(e));
      }
    });

  const signedCare = (action: CareAction) =>
    run(`signed-${action}`, async () => {
      if (!signer) return;
      try {
        const r = await passes.signedAction({ token, action, signer });
        const tx = (r.body as { result?: { transactionHash?: string } }).result?.transactionHash;
        log(`${CARE_LABEL[action]} (signed path)`, true, `HTTP ${r.status}. The issuer verified your signature, read the owner fresh, and relayed ${tx ? shortHex(tx) : "the care"}.`);
      } catch (e) {
        log(`${CARE_LABEL[action]} (signed path)`, false, describe(e));
      }
    });

  const followLink = (key: string, url: string, label = "Pass link") =>
    run(`link-${key}`, async () => {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: "{}" });
      const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
      if (res.ok) log(`${label}: ${key} (capability path)`, true, `HTTP ${res.status}. No signature: the link stood in for it, and the issuer still read the owner fresh.`);
      else log(`${label}: ${key} (capability path)`, false, `HTTP ${res.status} ${body?.error ?? ""}${body?.message ? `: ${body.message}` : ""}`);
    });

  const rotate = () =>
    run("rotate", async () => {
      if (!signer) return;
      const before = linksOf(unlocked);
      try {
        await passes.rotatePassLinks(token, { signer });
        setPreviousLinks(before);
        setUnlocked(null);
        log("Links rotated", true, "Every acquisition URL and pass link for this pet was replaced. The old links now answer 404. Unlock again to see the new ones.");
      } catch (e) {
        log("Rotation refused", false, describe(e));
      }
    });

  const transfer = (ev: FormEvent) => {
    ev.preventDefault();
    void run("transfer", async () => {
      if (!walletClient || !address) return;
      if (!isAddress(transferTo)) {
        log("Transfer", false, "That is not an address.");
        return;
      }
      const before = linksOf(unlocked);
      try {
        const hash = await walletClient.writeContract({
          address: config.contract,
          abi: petPassAbi,
          functionName: "transferFrom",
          args: [address, getAddress(transferTo), BigInt(tokenId)],
        });
        await publicClient.waitForTransactionReceipt({ hash });
        setPreviousLinks(before);
        setUnlocked(null);
        setTransferred(true);
        log("Transferred", true, `Pet #${tokenId} now belongs to ${shortHex(transferTo)}. Try the pass again below as the previous owner.`);
        void loadPet();
      } catch (e) {
        log("Transfer failed", false, describe(e));
      }
    });
  };

  if (pet === undefined) return <p aria-live="polite">Reading the chain...</p>;
  if (pet === null) {
    return (
      <p className="notice">
        Pet #{tokenId} does not exist on this contract. <Link href="/mint">Hatch one</Link>.
      </p>
    );
  }

  const isOwner = Boolean(address && isAddressEqual(pet.owner as `0x${string}`, address));
  const links = unlocked?.content.links ?? [];
  const originOk = issuer ? originMatches(issuer.passUri, [config.baseUrl]) : false;

  return (
    <>
      <div className="detail-head">
        <div>
          <p className="eyebrow">Pet #{tokenId}</p>
          <h1>{petName(tokenId)}</h1>
          <p className="muted">
            {mood(pet)}. {pet.alive ? `Lapses ${relativeTime(pet.diesAt)}` : `Lapsed ${relativeTime(pet.diesAt)}`}. Owned by <code title={pet.owner}>{shortHex(pet.owner)}</code>
            {isOwner ? " (you)" : ""}.
          </p>
        </div>
        {issuer ? (
          <dl className="issuer-box" aria-label="Issuer">
            <div>
              <dt>Issuing contract</dt>
              <dd>
                <code title={issuer.contract}>{issuer.contractShort}</code> on chain {issuer.chainId}
              </dd>
            </div>
            <div>
              <dt>Pass endpoint</dt>
              <dd>
                {issuer.origin ?? "no web origin"} {originOk ? <span className="tag tag-ok">matches this site</span> : <span className="tag tag-warn">other origin</span>}
              </dd>
            </div>
          </dl>
        ) : null}
      </div>

      <div className="detail-grid">
        <div className="stack">
          <section className="card" aria-labelledby="needs-h">
            <h2 id="needs-h" className="h-small">
              On chain now
            </h2>
            <Need label="Hunger" value={pet.hunger} />
            <Need label="Thirst" value={pet.thirst} />
            <Need label="Boredom" value={pet.boredom} />
            <p className="muted small">
              {pet.cares} cares so far. Public data: anyone can read this. The pass and its links are not public.
            </p>
          </section>

          {unlocked ? (
            <PassPreview content={unlocked.content} onLink={(key, url) => void followLink(key, url)} />
          ) : (
            <section className="card pass-placeholder" aria-labelledby="unlock-h">
              <h2 id="unlock-h" className="h-small">
                Your pass
              </h2>
              {!address ? (
                <NeedWallet what="unlock this pass" />
              ) : (
                <>
                  <p>
                    The manifest is gated. Unlocking asks your wallet to sign a challenge for <code>urn:wallet-pass:action:acquire</code> on this token; the SDK checks the challenge names this site, your account, this token and that action before your wallet sees it.
                  </p>
                  <button type="button" className="btn btn-primary" onClick={() => void unlock()} disabled={busy !== null} aria-busy={busy === "unlock"}>
                    {busy === "unlock" ? "Waiting for signature..." : isOwner ? "Unlock my pass" : "Try to unlock (not your pet)"}
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
                      contract={config.contract}
                      tokenId={tokenId}
                      signer={signer}
                      platform={p}
                      className="btn btn-primary"
                      onError={(e) => log(`Add to ${p}`, false, describe(e))}
                    />
                  ))}
                </div>
              ) : (
                <p className="muted">
                  Local mode: no Apple or Google credentials, so the manifest offers only the <code>preview</code> format drawn above. Add credentials (see the README) and real Add to Apple Wallet and Save to Google Wallet buttons appear here.
                </p>
              )}
              <p className="muted small">
                Manifest formats: {Object.keys(unlocked.manifest.formats).join(", ")}
                {unlocked.manifest.updatedAt ? `; content updated ${relativeTime(unlocked.manifest.updatedAt)}` : ""}.
              </p>
            </section>
          ) : null}
        </div>

        <div className="stack">
          <section className="card" aria-labelledby="signed-h">
            <h2 id="signed-h" className="h-small">
              Care, signed path
            </h2>
            <p className="muted small">Each click signs a fresh challenge for that one action. Check (1) is your signature; check (2) is the issuer&apos;s fresh ownerOf read.</p>
            {signer ? (
              <div className="button-row">
                {CARE_ACTIONS.map((a) => (
                  <button key={a} type="button" className="btn" onClick={() => void signedCare(a)} disabled={busy !== null} aria-busy={busy === `signed-${a}`}>
                    {CARE_LABEL[a]}
                  </button>
                ))}
              </div>
            ) : (
              <p className="muted small">Connect a wallet to sign.</p>
            )}
          </section>

          <section className="card" aria-labelledby="cap-h">
            <h2 id="cap-h" className="h-small">
              Care, capability path
            </h2>
            <p className="muted small">
              These are the links printed on the back of the pass. No signature: the unguessable link stands in for it, which is why each action is bounded on chain (4 per day) and the links rotate.
            </p>
            {links.length > 0 ? (
              <div className="button-row">
                {links.map((l) => (
                  <button key={l.key} type="button" className="btn" onClick={() => void followLink(l.key, l.url)} disabled={busy !== null}>
                    {l.label}
                  </button>
                ))}
              </div>
            ) : (
              <p className="muted small">Unlock the pass to get its links.</p>
            )}
            {previousLinks && Object.keys(previousLinks).length > 0 ? (
              <div className="old-links">
                <p className="small">Links from before the last rotation or transfer:</p>
                <div className="button-row">
                  {Object.entries(previousLinks).map(([key, url]) => (
                    <button key={key} type="button" className="btn btn-quiet" onClick={() => void followLink(key, url, "Old link")} disabled={busy !== null}>
                      Old {key} link
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {isOwner && signer ? (
              <button type="button" className="btn btn-quiet" onClick={() => void rotate()} disabled={busy !== null} aria-busy={busy === "rotate"}>
                Reset my pass links
              </button>
            ) : null}
          </section>

          {isOwner && walletClient ? (
            <section className="card" aria-labelledby="transfer-h">
              <h2 id="transfer-h" className="h-small">
                Transfer
              </h2>
              <p className="muted small">After a transfer the issuer rotates every link, and a proof from you is refused with exactly HTTP 403: verified, but no longer entitled.</p>
              <form onSubmit={transfer} className="inline-form">
                <label htmlFor="transfer-to">Recipient address</label>
                <input id="transfer-to" value={transferTo} onChange={(e) => setTransferTo(e.target.value.trim())} placeholder="0x..." spellCheck={false} autoComplete="off" />
                <button type="submit" className="btn" disabled={busy !== null || !transferTo} aria-busy={busy === "transfer"}>
                  Transfer pet
                </button>
              </form>
            </section>
          ) : null}

          {transferred && !isOwner && signer ? (
            <section className="card card-accent" aria-labelledby="after-h">
              <h2 id="after-h" className="h-small">
                You sold it. Now try the pass.
              </h2>
              <p className="small">You still hold a signing key and the old links. Neither works: the issuer reads the owner fresh on every request.</p>
              <button type="button" className="btn" onClick={() => void unlock()} disabled={busy !== null}>
                Request the manifest again (expect 403)
              </button>
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

          <section className="card" aria-labelledby="feed-h">
            <h2 id="feed-h" className="h-small">
              PassUpdate feed
            </h2>
            <p className="muted small">Live from the chain via usePassUpdates. Wallet distributors use this signal to push fresh passes.</p>
            {updates.length === 0 ? <p className="muted small">Waiting for events...</p> : null}
            <ul className="feed">
              {updates.map((u) => (
                <li key={`${u.transactionHash}-${u.logIndex}`}>
                  <code>{u.kind === "single" ? "PassUpdate" : "BatchPassUpdate"}</code> block {u.blockNumber?.toString() ?? "?"}
                  {u.transactionHash ? <span className="muted"> tx {shortHex(u.transactionHash)}</span> : null}
                </li>
              ))}
            </ul>
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

function Need({ label, value }: { label: string; value: number }) {
  return (
    <div className="need">
      <span className="need-label">{label}</span>
      <meter min={0} max={100} low={34} high={67} optimum={0} value={value} aria-label={`${label} ${value} percent`} />
      <span className="need-value">{value}%</span>
    </div>
  );
}
