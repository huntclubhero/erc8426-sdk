// SPDX-License-Identifier: MIT
import type { Address } from "viem";
import type { PassContent, PassDeliveryProvider } from "@erc8426/core";
import { createIssuer, rental4907, type Issuer } from "@erc8426/issuer";

import { artifact, type Chain8426 } from "../lib/chain.js";
import { fmtTime } from "../lib/demo.js";

/// @erc8426/contracts/artifacts/RentalPass.json
export const rentalPass = artifact("RentalPass");

export async function readRental(chain: Chain8426, contract: Address, tokenId: bigint) {
  const [owner, user, expires, holder] = await Promise.all([
    chain.read<Address>(contract, rentalPass.abi, "ownerOf", [tokenId]),
    chain.read<Address>(contract, rentalPass.abi, "userOf", [tokenId]),
    chain.read<bigint>(contract, rentalPass.abi, "userExpires", [tokenId]),
    chain.read<Address>(contract, rentalPass.abi, "passHolderOf", [tokenId]),
  ]);
  const rented = user !== "0x0000000000000000000000000000000000000000";
  return { owner, user: rented ? user : null, expires, holder };
}

export interface RentalIssuerOptions {
  baseUrl: string;
  domain: string;
  contract: Address;
  chain: Chain8426;
  providers: PassDeliveryProvider[];
  /// Where unlocks land (a smart lock in real life).
  lockLog: Array<{ tokenId: string; account: Address; via: string }>;
}

/// A rentable beach house key. Entitlement is `rental4907()` (exclusive by
///  default), the documented precedence the spec asks for: during an active
///  ERC-4907 rental the renter alone is entitled to every covered action,
///  acquire included, so the renter holds the pass and the owner's pass and
///  links stop working; after expiry the owner is entitled again. Both
///  `userOf` and `ownerOf` are read fresh on every request. The contract
///  exposes the same rule on chain as `passHolderOf`.
export function createRentalIssuer(o: RentalIssuerOptions): Issuer {
  return createIssuer({
    domain: o.domain,
    baseUrl: o.baseUrl,
    chainId: o.chain.publicClient.chain.id,
    contract: o.contract,
    mode: "gated",
    publicClient: o.chain.publicClient,
    providers: o.providers,
    entitlement: rental4907(),
    capability: { enabled: true },
    actions: {
      unlock: {
        description: "Unlock the front door",
        capability: true,
        bound:
          "Opens the smart lock and logs the entry; changes no on-chain state and moves no value. " +
          "Works only for the currently entitled account (the renter during a rental, else the owner).",
        execute: async ({ token, account, via }) => {
          o.lockLog.push({ tokenId: token.tokenId, account, via });
          return { unlocked: true, via };
        },
      },
    },
    async render({ token, serial, links, owner, superseded }): Promise<PassContent> {
      const id = BigInt(token.tokenId);
      const r = await readRental(o.chain, o.contract, id);
      const guest = r.user !== null && r.user.toLowerCase() === owner.toLowerCase();
      return {
        serial,
        style: "generic",
        organizationName: "Dune House",
        description: `Dune House key #${id}`,
        title: "DUNE HOUSE",
        colors: guest ? { background: "#0B4F6C", foreground: "#FFFFFF", label: "#F9C80E" } : { background: "#20272F", foreground: "#EDEDED" },
        primary: superseded
          ? [{ key: "role", label: "This key", value: "No longer active" }]
          : [{ key: "role", label: guest ? "Guest key" : "Owner key", value: guest ? "Enjoy your stay" : "Home" }],
        secondary: guest
          ? [{ key: "checkout", label: "Check out", value: fmtTime(r.expires), changeMessage: "Check out moved to %@" }]
          : [{ key: "status", label: "Status", value: r.user ? "Rented out" : "Available" }],
        back: [{ key: "policy", label: "Who holds this key", value: "During a rental only the guest's pass opens the door. It returns to the owner at check out." }],
        links: links.unlock ? [{ key: "unlock", label: "Unlock front door", url: links.unlock }] : [],
        // The rental ends passively at check out; the device shows it expired.
        ...(guest ? { expiresAt: new Date(Number(r.expires) * 1000) } : {}),
      };
    },
  });
}
