// SPDX-License-Identifier: MIT
import type { Address, Hex } from "viem";
import type { PassContent, PassDeliveryProvider } from "@erc8426/core";
import { createIssuer, type Issuer } from "@erc8426/issuer";

import { artifact, type Chain8426 } from "../lib/chain.js";
import { fmtTime } from "../lib/demo.js";
import type { ExtraRoute } from "../lib/server.js";

const club = artifact("MembershipPass");

export const TIERS: Record<number, string> = { 1: "Silver", 2: "Gold" };

export async function readMembership(chain: Chain8426, contract: Address, tokenId: bigint) {
  const [m, active] = await Promise.all([
    chain.read<{ tier: number; expiresAt: bigint }>(contract, club.abi, "membership", [tokenId]),
    chain.read<boolean>(contract, club.abi, "isActive", [tokenId]),
  ]);
  return { tier: m.tier, tierName: TIERS[m.tier] ?? `Tier ${m.tier}`, expiresAt: m.expiresAt, active };
}

export interface MembershipIssuerOptions {
  baseUrl: string;
  domain: string;
  contract: Address;
  chain: Chain8426;
  providers: PassDeliveryProvider[];
}

/// Memberships. Nothing here is a capability link: entering a venue has to
///  prove the member is present with their own key (a forwarded pass must
///  not open the door), so `enter` is signed only. Renewal is a payment the
///  payer signs in their own wallet; tier changes are issuer transactions.
export function createMembershipIssuer(o: MembershipIssuerOptions): Issuer {
  return createIssuer({
    domain: o.domain,
    baseUrl: o.baseUrl,
    chainId: o.chain.publicClient.chain.id,
    contract: o.contract,
    mode: "gated",
    publicClient: o.chain.publicClient,
    providers: o.providers,
    actions: {
      enter: {
        description: "Prove you are the member, at a venue",
        // Signed path only (no `capability`): the proof is single-use, scoped
        // to this token and action, and signed by the entitled account.
        execute: async ({ token, account }) => {
          const m = await readMembership(o.chain, o.contract, BigInt(token.tokenId));
          return { admit: m.active, tier: m.tierName, expiresAt: Number(m.expiresAt), member: account };
        },
      },
    },
    async render({ token, serial }): Promise<PassContent> {
      const id = BigInt(token.tokenId);
      const m = await readMembership(o.chain, o.contract, id);
      const gold = m.tier === 2;
      return {
        serial,
        style: "storeCard",
        organizationName: "Harbor Club",
        description: `Membership #${id}`,
        title: "HARBOR CLUB",
        colors: gold ? { background: "#3A2A00", foreground: "#FFF4D6", label: "#E8B931" } : { background: "#1F2933", foreground: "#F5F7FA", label: "#9AA5B1" },
        primary: [{ key: "tier", label: "Membership", value: m.tierName, changeMessage: "You are now %@" }],
        secondary: [
          { key: "status", label: "Status", value: m.active ? "Active" : "Expired" },
          // Expiry is passive, so the date is on the pass for the device to
          // count down; isActive answers verifiers at request time.
          { key: "expires", label: m.active ? "Renews by" : "Expired", value: fmtTime(m.expiresAt), changeMessage: "Valid until %@" },
        ],
        back: [{ key: "entry", label: "At the door", value: "Scan the venue's QR and confirm in your wallet. A copy of this pass cannot get in." }],
        links: [{ key: "renew", label: "Renew or upgrade", url: `${o.baseUrl}/club/renew/${id}` }],
        // The barcode identifies the membership (public data). It is not a
        // credential: entry takes the member's signature.
        barcode: { format: "qr", message: `eip155:${token.chainId}/erc721:${token.contract}/${id}`, altText: `Member ${id}` },
        expiresAt: new Date(Number(m.expiresAt) * 1000),
      };
    },
  });
}

/// The venue's access check: POST /venue/access { tokenId, message, signature }.
///  It runs the issuer's two-check floor for the `enter` action (a single-use
///  challenge signed by the member, plus a fresh entitlement read), then reads
///  whether the membership is active right now.
export function venueAccessRoute(getIssuer: () => Issuer, o: Pick<MembershipIssuerOptions, "chain" | "contract">): ExtraRoute {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== "/venue/access" || request.method !== "POST") return null;
    const body = (await request.json().catch(() => null)) as { tokenId?: string; message?: string; signature?: Hex } | null;
    if (!body?.tokenId || !body.message || !body.signature) return Response.json({ admit: false, reason: "bad_request" }, { status: 400 });
    const auth = await getIssuer().authorize({ tokenId: body.tokenId, message: body.message, signature: body.signature, action: "enter" });
    if (!auth.ok) return Response.json({ admit: false, reason: auth.error }, { status: auth.error === "not_owner" ? 403 : 401 });
    const m = await readMembership(o.chain, o.contract, BigInt(body.tokenId));
    return Response.json({ admit: m.active, reason: m.active ? "active" : "expired", tier: m.tierName, member: auth.account });
  };
}
