// SPDX-License-Identifier: MIT
import type { Address } from "viem";
import type { PassContent, PassDeliveryProvider } from "@erc8426/core";
import { createIssuer, type Issuer } from "@erc8426/issuer";

import { artifact, type Actor, type Chain8426 } from "../lib/chain.js";
import { fmtTime, onChain } from "../lib/demo.js";

const tix = artifact("EventTicketPass");

export const PHASES = ["Upcoming", "Checked in", "Keepsake"] as const;

export interface Show {
  startsAt: bigint;
  endsAt: bigint;
  firstTokenId: bigint;
  capacity: bigint;
  minted: bigint;
  ended: boolean;
}

export async function readTicket(chain: Chain8426, contract: Address, tokenId: bigint) {
  const showId = await chain.read<bigint>(contract, tix.abi, "showOf", [tokenId]);
  const [show, phase, checkedInAt] = await Promise.all([
    chain.read<Show>(contract, tix.abi, "show", [showId]),
    chain.read<number>(contract, tix.abi, "phase", [tokenId]),
    chain.read<bigint>(contract, tix.abi, "checkedInAt", [tokenId]),
  ]);
  return { showId, show, phase: PHASES[phase]!, checkedInAt };
}

export interface TicketIssuerOptions {
  baseUrl: string;
  domain: string;
  contract: Address;
  chain: Chain8426;
  /// The door account: holds DOOR_ROLE on the contract.
  door: Actor;
  providers: PassDeliveryProvider[];
  showName: string;
  venue: string;
}

/// Tickets. The barcode on the pass is the check-in capability: door staff
///  scan it and their scanner posts it. Check-in cannot transfer, burn or
///  approve the ticket, and its repetition is bounded by construction: the
///  contract checks a ticket in once, and only before the show ends.
export function createTicketIssuer(o: TicketIssuerOptions): Issuer {
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
      checkin: {
        description: "Admit this ticket at the door",
        capability: true,
        bound:
          "Checks the ticket in at most once, and only before the show ends (enforced by EventTicketPass). " +
          "Moves no value; cannot transfer, approve or burn the ticket.",
        execute: async ({ token }) => {
          const r = await onChain(() => o.chain.send(o.door, o.contract, tix.abi, "checkIn", [BigInt(token.tokenId)]), {
            TicketAlreadyCheckedIn: [409, "this ticket was already admitted"],
            TicketShowOver: [410, "the show is over; the ticket is a keepsake now"],
          });
          return { admitted: true, tx: r.transactionHash };
        },
      },
    },
    async render({ token, serial, links }): Promise<PassContent> {
      const id = BigInt(token.tokenId);
      const t = await readTicket(o.chain, o.contract, id);
      const keepsake = t.phase === "Keepsake";
      const seat = `GA ${id - t.show.firstTokenId + 1n}`;
      return {
        serial,
        style: "eventTicket",
        organizationName: o.venue,
        description: `${o.showName}, ticket #${id}`,
        title: o.showName,
        colors: keepsake
          ? { background: "#3B2F5C", foreground: "#F4E9FF", label: "#C9A7FF" }
          : { background: "#0B0B0F", foreground: "#FFFFFF", label: "#FF4F79" },
        header: [{ key: "status", label: "Status", value: t.phase, changeMessage: "Ticket: %@" }],
        primary: [{ key: "show", label: keepsake ? "You were there" : "Show", value: o.showName }],
        secondary: [
          { key: "doors", label: "Doors", value: fmtTime(t.show.startsAt) },
          { key: "seat", label: "Admission", value: seat },
        ],
        auxiliary: t.checkedInAt > 0n ? [{ key: "admitted", label: "Admitted", value: fmtTime(t.checkedInAt) }] : [],
        back: [{ key: "resale", label: "Resale", value: "Resales pay a 5% royalty (ERC-2981). A resale voids this barcode." }],
        event: { name: o.showName, venue: o.venue, startsAt: new Date(Number(t.show.startsAt) * 1000), endsAt: new Date(Number(t.show.endsAt) * 1000) },
        relevantDate: new Date(Number(t.show.startsAt) * 1000),
        // A keepsake has nothing to scan. Before that, the barcode is the
        // check-in link the door scanner posts.
        ...(!keepsake && links.checkin ? { barcode: { format: "qr" as const, message: links.checkin, altText: seat } } : {}),
      };
    },
  });
}
