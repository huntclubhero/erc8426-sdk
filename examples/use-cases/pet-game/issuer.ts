// SPDX-License-Identifier: MIT
import type { Address } from "viem";
import type { PassContent, PassDeliveryProvider } from "@erc8426/core";
import { createIssuer, type ActionDefinition, type Issuer } from "@erc8426/issuer";

import { artifact, type Actor, type Chain8426 } from "../lib/chain.js";
import { fmtTime, onChain } from "../lib/demo.js";

const pet = artifact("PetPass");

export interface PetState {
  lastFed: bigint;
  lastWatered: bigint;
  lastPlayed: bigint;
  cares: number;
}

export async function readPet(chain: Chain8426, contract: Address, tokenId: bigint) {
  const [state, needs, alive, diesAt] = await Promise.all([
    chain.read<PetState>(contract, pet.abi, "pet", [tokenId]),
    chain.read<readonly [bigint, bigint, bigint]>(contract, pet.abi, "needs", [tokenId]),
    chain.read<boolean>(contract, pet.abi, "isAlive", [tokenId]),
    chain.read<bigint>(contract, pet.abi, "diesAt", [tokenId]),
  ]);
  return { state, hunger: needs[0], thirst: needs[1], boredom: needs[2], alive, diesAt };
}

export interface PetIssuerOptions {
  baseUrl: string;
  domain: string;
  contract: Address;
  chain: Chain8426;
  /// The relayer appointed with `setActionOperator` on the contract.
  operator: Actor;
  providers: PassDeliveryProvider[];
}

/// WALLETCHI pattern. Gated configuration with the capability configuration
///  on: Feed, Water and Play are links on the back of the pass that run with
///  no per-tap signature, because every condition holds:
///  - they cannot transfer, burn or approve the pet or change who owns it;
///  - their repetition is bounded ON CHAIN by BoundedAction (4 of each per
///    pet per day, no value moved), whatever the server does;
///  - the links rotate on transfer and on the owner's request;
///  - the issuer takes a fresh ownerOf read on every tap.
export function createPetIssuer(o: PetIssuerOptions): Issuer {
  const care = (fn: "feed" | "water" | "play", verb: string): ActionDefinition => ({
    description: `${verb} your pet`,
    capability: true,
    bound:
      `${verb}s the pet at most 4 times per pet per day (a fixed on-chain window, so at most 8 in any 24 hours), ` +
      "enforced by the PetPass contract's BoundedAction. Moves no tokens and no value; cannot transfer, approve or burn the pet.",
    execute: async ({ token }) => {
      const receipt = await onChain(() => o.chain.send(o.operator, o.contract, pet.abi, fn, [BigInt(token.tokenId)]), {
        BoundedActionRateLimited: [429, `the pet already had its ${fn} allowance for this window`],
        PetIsDead: [409, "the pet died: a need went unmet past the lapse"],
        BoundedActionOperatorRevoked: [409, "the owner revoked the care relayer for this pet"],
      });
      return { tx: receipt.transactionHash };
    },
  });

  return createIssuer({
    domain: o.domain,
    baseUrl: o.baseUrl,
    chainId: o.chain.publicClient.chain.id,
    contract: o.contract,
    mode: "gated",
    publicClient: o.chain.publicClient,
    providers: o.providers,
    capability: { enabled: true },
    actions: {
      feed: care("feed", "Feed"),
      water: care("water", "Water"),
      play: care("play", "Play with"),
    },
    async render({ token, serial, links, superseded }): Promise<PassContent> {
      const id = BigInt(token.tokenId);
      const p = await readPet(o.chain, o.contract, id);
      const mood = !p.alive ? "Gone" : p.hunger + p.thirst + p.boredom < 90n ? "Happy" : "Needs you";
      return {
        serial,
        style: "generic",
        organizationName: "Pet Pass",
        description: `Pet #${id}`,
        title: `Pet #${id}`,
        colors: p.alive ? { background: "#16233A", foreground: "#F6F1E7", label: "#F2B84B" } : { background: "#2B2B2B", foreground: "#9A9A9A" },
        primary: [{ key: "mood", label: "Mood", value: superseded ? "Rehomed" : mood, changeMessage: "Your pet is %@" }],
        secondary: [
          { key: "hunger", label: "Hunger", value: `${p.hunger}%` },
          { key: "thirst", label: "Thirst", value: `${p.thirst}%` },
          { key: "boredom", label: "Boredom", value: `${p.boredom}%` },
        ],
        auxiliary: [
          { key: "cares", label: "Cares", value: p.state.cares },
          // Death is passive (no event), so the pass carries the deadline and
          // the device counts it down between pushes.
          { key: "dies", label: p.alive ? "Needs care by" : "Died", value: fmtTime(p.diesAt) },
        ],
        back: [{ key: "bound", label: "Pass links", value: "Each care runs at most 4 times per pet per day. Links cannot move or sell your pet." }],
        links: p.alive
          ? [
              { key: "feed", label: "Feed", url: links.feed! },
              { key: "water", label: "Water", url: links.water! },
              { key: "play", label: "Play", url: links.play! },
            ].filter((l) => l.url)
          : [],
        barcode: { format: "qr", message: `${o.baseUrl}/wallet-pass/${id}`, altText: `Pet #${id}` },
      };
    },
  });
}
