// SPDX-License-Identifier: MIT
import type { Address } from "viem";
import type { PassContent, PassDeliveryProvider } from "@erc8426/core";
import { ActionError, createIssuer, type Issuer } from "@erc8426/issuer";

import { artifact, type Actor, type Chain8426 } from "../lib/chain.js";
import { fmtTime, onChain } from "../lib/demo.js";
import { readPet } from "../pet-game/issuer.js";

const pet = artifact("PetPass");
const KINDS = ["feed", "water", "play"] as const;
type Kind = (typeof KINDS)[number];

/// The partner app's universal link domain. On a phone with the app
///  installed, tapping a link on this origin opens the app; without it, the
///  same URL opens the partner's website.
export const APP_ORIGIN = "https://app.petpals.example";

export function appLink(tokenId: bigint, intent: string): string {
  return `${APP_ORIGIN}/pet/${tokenId}?do=${encodeURIComponent(intent)}`;
}

export interface PartnerIssuerOptions {
  baseUrl: string;
  domain: string;
  contract: Address;
  chain: Chain8426;
  operator: Actor;
  providers: PassDeliveryProvider[];
}

/// A pass whose links are universal links into a partner app rather than
///  capability URLs. The links carry no authority at all: the app holds the
///  member's signer (an embedded wallet) and runs every action on the SIGNED
///  path through @erc8426/client, so forwarding is closed, and the app can
///  offer things a static pass cannot (batched care, choices as params, live
///  state, history). The capability configuration is off.
export function createPartnerIssuer(o: PartnerIssuerOptions): Issuer {
  return createIssuer({
    domain: o.domain,
    baseUrl: o.baseUrl,
    chainId: o.chain.publicClient.chain.id,
    contract: o.contract,
    mode: "gated",
    publicClient: o.chain.publicClient,
    providers: o.providers,
    actions: {
      care: {
        description: "Run one or more care actions in one signed request",
        // params are not covered by the signature (the challenge binds token
        // and action only), so they only choose among care kinds, and every
        // choice stays inside the contract's on-chain bound.
        execute: async ({ token, params }) => {
          const kinds = (params as { kinds?: unknown } | undefined)?.kinds;
          if (!Array.isArray(kinds) || kinds.length === 0 || kinds.length > 3 || !kinds.every((k) => KINDS.includes(k as Kind))) {
            throw new ActionError(400, "invalid_params", 'params.kinds must list 1 to 3 of "feed", "water", "play"');
          }
          const done: string[] = [];
          for (const kind of new Set(kinds as Kind[])) {
            await onChain(() => o.chain.send(o.operator, o.contract, pet.abi, kind, [BigInt(token.tokenId)]), {
              BoundedActionRateLimited: [429, `${kind} allowance for this window is used`],
              PetIsDead: [409, "the pet died"],
            });
            done.push(kind);
          }
          return { done };
        },
      },
    },
    async render({ token, serial }): Promise<PassContent> {
      const id = BigInt(token.tokenId);
      const p = await readPet(o.chain, o.contract, id);
      return {
        serial,
        style: "generic",
        organizationName: "PetPals",
        description: `Pet #${id}`,
        title: `Pet #${id}`,
        colors: { background: "#2D1B69", foreground: "#FFFFFF", label: "#FFC857" },
        primary: [{ key: "state", label: "Pet", value: p.alive ? "Doing well" : "Gone" }],
        secondary: [
          { key: "hunger", label: "Hunger", value: `${p.hunger}%` },
          { key: "cares", label: "Cares", value: p.state.cares },
        ],
        auxiliary: [{ key: "dies", label: "Needs care by", value: fmtTime(p.diesAt) }],
        back: [{ key: "app", label: "PetPals app", value: "Links open the PetPals app, which asks you to confirm each action." }],
        links: [
          { key: "open", label: "Open in PetPals", url: appLink(id, "open") },
          { key: "care", label: "Care for your pet", url: appLink(id, "care") },
        ],
      };
    },
  });
}
