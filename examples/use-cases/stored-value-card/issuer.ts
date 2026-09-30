// SPDX-License-Identifier: MIT
import { getAddress, isAddress, type Address } from "viem";
import type { PassContent, PassDeliveryProvider } from "@erc8426/core";
import { ActionError, createIssuer, type Issuer } from "@erc8426/issuer";

import { artifact, type Actor, type Chain8426 } from "../lib/chain.js";
import { fmtUsd, onChain } from "../lib/demo.js";

const card = artifact("StoredValueCard");

export interface CardState {
  balance: bigint;
  punches: number;
  rewards: number;
}

export async function readCard(chain: Chain8426, contract: Address, tokenId: bigint): Promise<CardState> {
  return chain.read<CardState>(contract, card.abi, "card", [tokenId]);
}

export interface CardIssuerOptions {
  baseUrl: string;
  domain: string;
  contract: Address;
  chain: Chain8426;
  /// The issuer's relayer, appointed operator on the card contract.
  operator: Actor;
  providers: PassDeliveryProvider[];
  /// On-chain caps, for the documented bound (read from the contract).
  perTxCap: bigint;
  dailyCap: bigint;
  chargesPerDay: number;
  punchesPerReward: number;
}

/// Params arrive unsigned (the capability link carries possession, not a
///  signature), so they are validated here and the bound must hold for every
///  possible value. It does: the contract caps amount and destination.
function chargeParams(params: unknown): { amount: bigint; merchant: Address } {
  const p = (params ?? {}) as { amount?: unknown; merchant?: unknown };
  if (typeof p.amount !== "string" || !/^[0-9]{1,18}$/.test(p.amount)) {
    throw new ActionError(400, "invalid_amount", "params.amount must be a decimal string of stablecoin units");
  }
  if (typeof p.merchant !== "string" || !isAddress(p.merchant)) {
    throw new ActionError(400, "invalid_merchant", "params.merchant must be an address");
  }
  return { amount: BigInt(p.amount), merchant: getAddress(p.merchant) };
}

/// PUNCHCARD pattern: a stablecoin spending card. The QR code on the pass is
///  the charge capability: a merchant terminal scans it and posts an amount.
///  That moves value without the holder signing, so the capability
///  configuration's value-bound condition is what makes it acceptable, and
///  the bound lives on chain (BoundedAction caps inside StoredValueCard), not
///  in this server.
export function createCardIssuer(o: CardIssuerOptions): Issuer {
  const bound =
    `Charges at most ${fmtUsd(o.perTxCap)} per charge, ${fmtUsd(o.dailyCap)} and ${o.chargesPerDay} charges per card per day ` +
    "(fixed on-chain windows, so at most twice that inside any 24 hours), paid only to merchants the issuer registered on chain. " +
    "Cannot withdraw to any other address, transfer, approve or burn the card.";

  const relay = <T>(fn: () => Promise<T>) =>
    onChain(fn, {
      BoundedActionValueTooHigh: [422, `above the ${fmtUsd(o.perTxCap)} per-charge cap`],
      BoundedActionWindowCapExceeded: [429, `the card's ${fmtUsd(o.dailyCap)} daily cap is spent`],
      BoundedActionRateLimited: [429, "too many charges on this card today"],
      BoundedActionOperatorRevoked: [409, "the card holder switched off tap-to-pay for this card"],
      CardUnknownMerchant: [422, "not a registered merchant"],
      CardInsufficientBalance: [402, "insufficient balance on the card"],
      CardNoReward: [409, "no reward earned yet"],
      CardZeroAmount: [400, "amount must be positive"],
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
      charge: {
        description: "Pay a registered merchant from this card",
        capability: true,
        bound,
        execute: async ({ token, params }) => {
          const { amount, merchant } = chargeParams(params);
          const r = await relay(() => o.chain.send(o.operator, o.contract, card.abi, "charge", [BigInt(token.tokenId), amount, merchant]));
          return { tx: r.transactionHash, charged: fmtUsd(amount) };
        },
      },
      redeem: {
        description: "Redeem one earned free coffee at a registered merchant",
        capability: true,
        bound: "Redeems only rewards the card has earned (one per 10 paid punches), at registered merchants. Moves no value.",
        execute: async ({ token, params }) => {
          const merchant = (params as { merchant?: unknown } | undefined)?.merchant;
          if (typeof merchant !== "string" || !isAddress(merchant)) throw new ActionError(400, "invalid_merchant");
          const r = await relay(() => o.chain.send(o.operator, o.contract, card.abi, "redeemReward", [BigInt(token.tokenId), merchant]));
          return { tx: r.transactionHash };
        },
      },
    },
    async render({ token, serial, links }): Promise<PassContent> {
      const id = BigInt(token.tokenId);
      const c = await readCard(o.chain, o.contract, id);
      const dots = "*".repeat(c.punches) + ".".repeat(o.punchesPerReward - c.punches);
      return {
        serial,
        style: "storeCard",
        organizationName: "Punchcard",
        description: `Stored value card #${id}`,
        title: "PUNCHCARD",
        colors: { background: "#111111", foreground: "#F3E9D2", label: "#C8A27A" },
        primary: [{ key: "balance", label: "Balance", value: fmtUsd(c.balance), changeMessage: "Balance is now %@" }],
        secondary: [
          { key: "punches", label: "Punches", value: dots },
          { key: "rewards", label: "Free coffees", value: c.rewards, changeMessage: "You have %@ free coffee(s)" },
        ],
        auxiliary: [{ key: "caps", label: "Tap limits", value: `${fmtUsd(o.perTxCap)} each, ${fmtUsd(o.dailyCap)} a day` }],
        back: [
          { key: "bound", label: "What the QR code can do", value: bound },
          { key: "withdraw", label: "Withdraw", value: "Only you can withdraw, from your own wallet. The pass cannot." },
        ],
        links: c.rewards > 0 && links.redeem ? [{ key: "redeem", label: "Redeem a free coffee", url: links.redeem }] : [],
        // The terminal scans this and posts { amount, merchant } to it.
        ...(links.charge ? { barcode: { format: "qr" as const, message: links.charge, altText: `Card #${id}` } } : {}),
      };
    },
  });
}
