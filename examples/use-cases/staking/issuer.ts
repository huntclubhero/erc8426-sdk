// SPDX-License-Identifier: MIT
import { formatUnits, type Address } from "viem";
import type { PassContent, PassDeliveryProvider } from "@erc8426/core";
import { createIssuer, type ActionDefinition, type Issuer } from "@erc8426/issuer";

import { artifact, type Actor, type Chain8426 } from "../lib/chain.js";
import { fmtTime, onChain } from "../lib/demo.js";

const staking = artifact("StakingPass");

export interface Position {
  stakedTokenId: bigint;
  stakedAt: bigint;
  lastClaimAt: bigint;
}

export async function readPosition(chain: Chain8426, contract: Address, receiptId: bigint) {
  const [position, pending, rate] = await Promise.all([
    chain.read<Position>(contract, staking.abi, "position", [receiptId]),
    chain.read<bigint>(contract, staking.abi, "pendingRewards", [receiptId]),
    chain.read<bigint>(contract, staking.abi, "rewardPerSecond"),
  ]);
  return { position, pending, perDay: rate * 86_400n };
}

export const rwd = (v: bigint) => `${Number(formatUnits(v, 18)).toFixed(3)} RWD`;

export interface StakingIssuerOptions {
  baseUrl: string;
  domain: string;
  contract: Address;
  chain: Chain8426;
  /// The appointed claim operator. Its only authority is CLAIM, rate
  ///  limited on chain, and a claim can only pay the owner.
  relayer: Actor;
  providers: PassDeliveryProvider[];
}

/// The claim action. Capability-safe by construction: StakingPass.claim pays
///  ONLY the receipt's current owner, never more than has accrued, and the
///  relayer's calls are rate limited on chain (24 per receipt per day), so
///  repeating it only pays the owner sooner.
export const claimAction = (o: StakingIssuerOptions): ActionDefinition => ({
  description: "Claim accrued rewards to the receipt owner's wallet",
  capability: true,
  bound:
    "Pays accrued rewards to the receipt's current owner and nobody else; the total paid can never exceed what accrued. " +
    "Cannot unstake, transfer, approve or burn the receipt.",
  execute: async ({ token }) => {
    const r = await onChain(() => o.chain.send(o.relayer, o.contract, staking.abi, "claim", [BigInt(token.tokenId)]), {
      StakingNothingToClaim: [409, "nothing has accrued since the last claim"],
      StakingInsufficientRewardPool: [503, "the reward pool is being refilled"],
    });
    return { tx: r.transactionHash };
  },
});

/// Staking receipts on a pass, mirroring the Rare Friends Pass split: Claim
///  is a one-tap capability link (the appointed relayer sends a claim that
///  can only pay the owner), while Unstake burns the receipt and returns the
///  NFT, which a capability link MUST NOT do, so its link only opens a page
///  where the owner confirms the transaction in their own wallet.
export function createStakingIssuer(o: StakingIssuerOptions): Issuer {
  return createIssuer({
    domain: o.domain,
    baseUrl: o.baseUrl,
    chainId: o.chain.publicClient.chain.id,
    contract: o.contract,
    mode: "gated",
    publicClient: o.chain.publicClient,
    providers: o.providers,
    capability: { enabled: true },
    actions: { claim: claimAction(o) },
    async render({ token, serial, links }): Promise<PassContent> {
      const id = BigInt(token.tokenId);
      const p = await readPosition(o.chain, o.contract, id).catch(() => null);
      if (!p) {
        // Unstaking burns the receipt. The issuer still renders once more to
        // void the holder's installed pass, so render a closed card.
        return {
          serial,
          organizationName: "Staking Pass",
          description: `Staking receipt #${id}`,
          title: `Receipt #${id}`,
          primary: [{ key: "pending", label: "Status", value: "Unstaked" }],
        };
      }
      return {
        serial,
        style: "generic",
        organizationName: "Staking Pass",
        description: `Staking receipt #${id}`,
        title: `Receipt #${id}`,
        colors: { background: "#0E2A1F", foreground: "#E8F5EC", label: "#7ED9A6" },
        // Accrual is passive: this value is as of render time. The pass
        // shows the rate too, and the issuer can refresh on a schedule.
        primary: [{ key: "pending", label: "Claimable", value: rwd(p.pending), changeMessage: "Claimable: %@" }],
        secondary: [
          { key: "staked", label: "Staked NFT", value: `#${p.position.stakedTokenId}` },
          { key: "rate", label: "Earning", value: `${rwd(p.perDay)} / day` },
        ],
        auxiliary: [{ key: "since", label: "Staked since", value: fmtTime(p.position.stakedAt) }],
        back: [
          { key: "claim", label: "Claim", value: "One tap. Pays only the receipt's owner." },
          { key: "unstake", label: "Unstake", value: "Opens a page to confirm in your own wallet. The pass cannot unstake." },
        ],
        links: [
          ...(links.claim ? [{ key: "claim", label: "Claim rewards", url: links.claim }] : []),
          // A plain page, not a capability: the owner signs the unstake tx.
          { key: "unstake", label: "Unstake (confirm in wallet)", url: `${o.baseUrl}/app/unstake/${id}` },
        ],
      };
    },
  });
}
