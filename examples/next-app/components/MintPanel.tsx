"use client";

import Link from "next/link";
import { useState } from "react";

import { petName } from "@/lib/pet";
import { useApp } from "./Providers";
import { NeedWallet, useWallet } from "./wallet";

export function MintPanel() {
  const { config } = useApp();
  const { address } = useWallet();
  const [state, setState] = useState<{ status: "idle" | "busy" | "done" | "error"; tokenId?: string; error?: string }>({ status: "idle" });

  if (!config.mintEnabled) return <p className="notice">Minting through this app is turned off (MINT_API=off).</p>;
  if (!address) return <NeedWallet what="hatch a pet" />;

  const mint = async () => {
    setState({ status: "busy" });
    try {
      const res = await fetch("/api/mint", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: address }),
      });
      // A host error page is not JSON; report the status, not a parse error.
      const body = (await res.json().catch(() => ({}))) as { tokenId?: string; message?: string; error?: string };
      if (!res.ok || !body.tokenId) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      setState({ status: "done", tokenId: body.tokenId });
    } catch (e) {
      setState({ status: "error", error: (e as Error).message });
    }
  };

  return (
    <section className="card">
      <p>
        The collection owner (this app&apos;s operator key) mints the pet to <code>{address}</code>.
      </p>
      <button type="button" className="btn btn-primary" onClick={() => void mint()} disabled={state.status === "busy"} aria-busy={state.status === "busy"}>
        {state.status === "busy" ? "Hatching..." : "Hatch a pet"}
      </button>
      <div aria-live="polite">
        {state.status === "done" && state.tokenId ? (
          <p className="success">
            {petName(state.tokenId)} hatched as pet #{state.tokenId}. <Link href={`/passes/${state.tokenId}`}>Open its pass</Link>
          </p>
        ) : null}
        {state.status === "error" ? (
          <p role="alert" className="error-text">
            {state.error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
