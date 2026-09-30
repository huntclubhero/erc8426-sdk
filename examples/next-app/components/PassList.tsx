"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { mood, petColor, petName, type PetState } from "@/lib/pet";
import { NeedWallet, useWallet } from "./wallet";

export function PassList() {
  const { address } = useWallet();
  const [pets, setPets] = useState<PetState[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    setPets(null);
    setError(null);
    fetch(`/api/passes?owner=${address}`)
      .then((r) => r.json())
      .then((b) => !cancelled && (b.pets ? setPets(b.pets) : setError(b.message ?? b.error)))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [address]);

  if (!address) return <NeedWallet what="see your passes" />;
  if (error) return <p role="alert" className="error-text">{error}</p>;
  if (!pets) return <p aria-live="polite">Reading the chain...</p>;
  if (pets.length === 0) {
    return (
      <p className="notice">
        No pets yet. <Link href="/mint">Hatch one</Link>.
      </p>
    );
  }
  return (
    <ul className="pet-grid">
      {pets.map((p) => (
        <li key={p.tokenId}>
          <Link href={`/passes/${p.tokenId}`} className="pet-tile" style={{ background: petColor(p.tokenId) }}>
            <span className="pet-tile-id">#{p.tokenId}</span>
            <span className="pet-tile-name">{petName(p.tokenId)}</span>
            <span className="pet-tile-mood">{mood(p)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
