// SPDX-License-Identifier: MIT
import type { Address } from "viem";

import { artifact, expectRevert } from "../lib/chain.js";
import { fmtUsd, installPass, runIfMain, stage, tapLink } from "../lib/demo.js";
import { expect, finish, mustRefuse, note, ok, push, say, showPass, step, title } from "../lib/narrate.js";
import { previewProvider } from "../lib/preview.js";
import { startIssuerServer } from "../lib/server.js";
import { createCardIssuer, readCard } from "./issuer.js";

const card = artifact("StoredValueCard");
const usd = artifact("MockERC20");
const $ = (dollars: number) => BigInt(Math.round(dollars * 1e6));

export async function main(): Promise<void> {
  title("stored-value-card", "PUNCHCARD pattern: a stablecoin card on a pass, charged by merchants within on-chain caps.");
  const s = await stage();
  try {
    const issuerKey = await s.chain.actor("issuer");
    const relayer = await s.chain.actor("relayer");
    const holder = await s.chain.actor("holder");
    const cafe = await s.chain.actor("cafe");
    const stranger = await s.chain.actor("stranger");

    step("Deploy a 6 decimal stablecoin and the card: $25 per charge, $100 and 20 charges a day, 10 punches per reward");
    const coin = await s.chain.deploy(issuerKey, "MockERC20", ["Mock USD", "mUSD", 6]);
    const perTxCap = $(25);
    const dailyCap = $(100);
    const contract = await s.chain.deploy(issuerKey, "StoredValueCard", ["", issuerKey.address, coin, 10, perTxCap, dailyCap, 20]);
    await s.chain.send(issuerKey, contract, card.abi, "setActionOperator", [relayer.address, true]);
    await s.chain.send(issuerKey, contract, card.abi, "setMerchant", [cafe.address, true]);
    say(`card contract ${contract}; cafe ${cafe.address} registered as a merchant`);

    const server = await startIssuerServer(({ baseUrl, domain }) =>
      createCardIssuer({
        baseUrl,
        domain,
        contract,
        chain: s.chain,
        operator: relayer,
        providers: [previewProvider(push)],
        perTxCap,
        dailyCap,
        chargesPerDay: 20,
        punchesPerReward: 10,
      }),
    );
    s.index(contract, server.issuer);
    await s.chain.send(issuerKey, contract, card.abi, "setPassBaseURI", [`${server.baseUrl}/wallet-pass/`]);

    step("Issue card #1 and top it up with $120 (anyone can top up)");
    await s.chain.send(issuerKey, contract, card.abi, "mint", [holder.address]);
    await s.chain.send(holder, coin, usd.abi, "mint", [holder.address, $(120)]);
    await s.chain.send(holder, coin, usd.abi, "approve", [contract, $(120)]);
    await s.chain.send(holder, contract, card.abi, "topUp", [1n, $(120)]);
    const token = { contract, tokenId: 1n };
    const pass = await installPass(s.client, token, holder.account);
    showPass(pass.content);
    const qr = pass.content.barcode!.message;

    const terminal = (amount: bigint, merchant: Address = cafe.address) => tapLink(qr, { amount: amount.toString(), merchant });

    step("Morning coffee: the cafe terminal scans the QR code and charges $4.50");
    const r = await terminal($(4.5));
    ok(`charged ${String((r.result as { charged: string }).charged)}`);
    const balanceOf = (a: Address) => s.chain.read<bigint>(coin, usd.abi, "balanceOf", [a]);
    say(`cafe received ${fmtUsd(await balanceOf(cafe.address))}; card ${JSON.stringify(await readCard(s.chain, contract, 1n), (_, v) => (typeof v === "bigint" ? fmtUsd(v) : v))}`);

    step("Nine more coffees earn a free one");
    for (let i = 0; i < 9; i++) await terminal($(4.5));
    const afterTen = await readCard(s.chain, contract, 1n);
    expect(afterTen.rewards === 1 && afterTen.punches === 0, `10 punches: rewards ${afterTen.rewards}, punches reset to ${afterTen.punches}`);
    const withReward = await installPass(s.client, token, holder.account);
    showPass(withReward.content);
    await tapLink(withReward.content.links!.find((l) => l.key === "redeem")!.url, { merchant: cafe.address });
    const redeemed = await readCard(s.chain, contract, 1n);
    expect(redeemed.rewards === 0 && redeemed.balance === afterTen.balance, "free coffee redeemed, no money moved");

    step("The caps are the chain's, not the server's");
    await mustRefuse("a $30 charge (per-charge cap $25)", () => terminal($(30)));
    await mustRefuse("paying a non-merchant address", () => terminal($(1), stranger.address));
    note(`spent today so far: ${fmtUsd($(45))}; cap ${fmtUsd(dailyCap)}`);
    await terminal($(25));
    await terminal($(25));
    await mustRefuse("a $25 charge that would pass the $100 daily cap", () => terminal($(25)));
    await s.chain.warp(86_400);
    await terminal($(5));
    ok("a new day, a new window: $5 charge accepted");

    step("A leaked QR code (a screenshot) is the disclosed residual");
    note("anyone holding the QR can charge it, but only at registered merchants and only within the caps above");
    note("remedy: the holder switches tap-to-pay off on chain, and rotates the pass so the QR changes");
    await s.chain.send(holder, contract, card.abi, "setOperatorRevoked", [1n, relayer.address, true]);
    await mustRefuse("charge after the holder revoked the relayer", () => terminal($(1)));
    await s.client.rotatePassLinks(token, { signer: holder.account });
    await s.chain.send(holder, contract, card.abi, "setOperatorRevoked", [1n, relayer.address, false]);
    await mustRefuse("the leaked QR after rotation", () => terminal($(1)));
    const fresh = await installPass(s.client, token, holder.account);
    await tapLink(fresh.content.barcode!.message, { amount: $(2).toString(), merchant: cafe.address });
    ok("the new QR on the holder's refreshed pass works");

    step("Withdraw is owner only, never through the pass");
    const why = await expectRevert(() => s.chain.send(relayer, contract, card.abi, "withdraw", [1n, $(1), relayer.address]));
    ok(`the relayer cannot withdraw: ${why}`);
    const before = await readCard(s.chain, contract, 1n);
    await s.chain.send(holder, contract, card.abi, "withdraw", [1n, before.balance, holder.address]);
    const end = await readCard(s.chain, contract, 1n);
    expect(end.balance === 0n && (await balanceOf(holder.address)) === before.balance, `holder withdrew ${fmtUsd(before.balance)} from their own wallet`);
    showPass((await installPass(s.client, token, holder.account)).content);
    await server.stop();
  } finally {
    await s.close();
  }
  finish();
}

runIfMain(import.meta.url, main);
