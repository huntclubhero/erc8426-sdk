// SPDX-License-Identifier: MIT
import { parseEther } from "viem";
import { createIssuer, IssuerConfigError } from "@erc8426/issuer";

import { artifact, expectRevert } from "../lib/chain.js";
import { installPass, linkOf, runIfMain, stage, tapLink } from "../lib/demo.js";
import { expect, fail, finish, mustRefuse, note, ok, push, say, showPass, step, title } from "../lib/narrate.js";
import { previewProvider } from "../lib/preview.js";
import { startIssuerServer } from "../lib/server.js";
import { claimAction, createStakingIssuer, readPosition, rwd } from "./issuer.js";

const stakingAbi = artifact("StakingPass").abi;
const nftAbi = artifact("MockERC721").abi;
const tokenAbi = artifact("MockERC20").abi;
const DAY = 86_400;

export async function main(): Promise<void> {
  title("staking", "Stake an NFT, carry the position on a pass, claim from the pass; unstaking stays with the owner.");
  const s = await stage();
  try {
    const issuerKey = await s.chain.actor("issuer");
    const relayer = await s.chain.actor("relayer");
    const holder = await s.chain.actor("holder");
    const stranger = await s.chain.actor("stranger");
    const buyer = await s.chain.actor("buyer");

    step("Deploy a collection, a reward token, and StakingPass paying 1 RWD per day per receipt");
    const nft = await s.chain.deploy(issuerKey, "MockERC721", ["Friends", "FRND"]);
    const reward = await s.chain.deploy(issuerKey, "MockERC20", ["Reward", "RWD", 18]);
    const contract = await s.chain.deploy(issuerKey, "StakingPass", ["", issuerKey.address, nft, reward, parseEther("1") / BigInt(DAY)]);
    await s.chain.send(issuerKey, reward, tokenAbi, "mint", [contract, parseEther("1000")]);
    await s.chain.send(issuerKey, contract, stakingAbi, "setActionOperator", [relayer.address, true]);

    const server = await startIssuerServer(({ baseUrl, domain }) =>
      createStakingIssuer({ baseUrl, domain, contract, chain: s.chain, relayer, providers: [previewProvider(push)] }),
    );
    s.index(contract, server.issuer);
    await s.chain.send(issuerKey, contract, stakingAbi, "setPassBaseURI", [`${server.baseUrl}/wallet-pass/`]);

    step("The issuer refuses to put a burn behind a capability link");
    try {
      createIssuer({
        domain: server.domain,
        baseUrl: server.baseUrl,
        chainId: 31337,
        contract,
        mode: "gated",
        publicClient: s.chain.publicClient,
        providers: [previewProvider()],
        render: () => ({ serial: "", organizationName: "", description: "", title: "" }),
        capability: { enabled: true },
        actions: {
          claim: claimAction({ baseUrl: server.baseUrl, domain: server.domain, contract, chain: s.chain, relayer, providers: [] }),
          unstake: { description: "Unstake", capability: true, transfersOrBurns: true, bound: "n/a", execute: () => null },
        },
      });
      fail("an unstake capability action was accepted");
    } catch (e) {
      if (e instanceof IssuerConfigError) ok(`IssuerConfigError: ${e.message.slice(0, 110)}...`);
      else throw e;
    }

    step("The holder stakes NFT #1 and receives receipt #1");
    await s.chain.send(holder, nft, nftAbi, "mint", [holder.address]);
    await s.chain.send(holder, nft, nftAbi, "approve", [contract, 1n]);
    await s.chain.send(holder, contract, stakingAbi, "stake", [1n]);
    const token = { contract, tokenId: 1n };
    const pass = await installPass(s.client, token, holder.account);
    showPass(pass.content);

    step("Three days pass: rewards accrue with no transaction and no event");
    await s.chain.warp(3 * DAY);
    const p = await readPosition(s.chain, contract, 1n);
    say(`pendingRewards(1) = ${rwd(p.pending)}; the pass re-renders it on the next refresh`);
    showPass((await installPass(s.client, token, holder.account)).content);

    step("Tap Claim on the pass");
    const claim = linkOf(pass.content, "claim");
    await tapLink(claim);
    const bal = (a: `0x${string}`) => s.chain.read<bigint>(reward, tokenAbi, "balanceOf", [a]);
    const holderAfterClaim = await bal(holder.address);
    ok(`holder received ${rwd(holderAfterClaim)}; relayer received ${rwd(await bal(relayer.address))}`);

    step("A forwarded Claim link can only pay the owner, sooner");
    await s.chain.warp(DAY);
    await tapLink(claim); // tapped by the stranger the link was forwarded to
    expect((await bal(stranger.address)) === 0n, "the stranger received nothing");
    ok(`the holder was paid again: ${rwd((await bal(holder.address)) - holderAfterClaim)}`);
    const direct = await expectRevert(() => s.chain.send(stranger, contract, stakingAbi, "claim", [1n]));
    ok(`a stranger calling claim on chain directly is refused (${direct}): only the owner, an approved account or the rate-limited relayer may claim`);

    step("Unstake is never pass-reachable: the relayer cannot do it");
    say(`the pass's Unstake link is a plain page: ${linkOf(pass.content, "unstake")}`);
    const why = await expectRevert(() => s.chain.send(relayer, contract, stakingAbi, "unstake", [1n]));
    ok(`unstake from the relayer reverts: ${why}`);

    step("The holder sells the position; accrued rewards travel with the receipt");
    await s.chain.warp(DAY);
    await s.chain.send(holder, contract, stakingAbi, "transferFrom", [holder.address, buyer.address, 1n]);
    await mustRefuse("the seller's old Claim link", () => tapLink(claim));
    const buyers = await installPass(s.client, token, buyer.account);
    await tapLink(linkOf(buyers.content, "claim"));
    ok(`buyer claimed ${rwd(await bal(buyer.address))}`);

    step("The buyer unstakes with their own signature");
    await s.chain.warp(DAY);
    await s.chain.send(buyer, contract, stakingAbi, "unstake", [1n]);
    const owner = await s.chain.read<string>(nft, nftAbi, "ownerOf", [1n]);
    expect(owner === buyer.address, "NFT #1 returned to the buyer");
    note("the receipt is burned, so its pass is dead everywhere");
    await mustRefuse("the buyer's Claim link after unstake", () => tapLink(linkOf(buyers.content, "claim")));
    await mustRefuse("the manifest for a burned receipt (passURI reverts for a nonexistent token)", () => s.client.getManifest(token, { signer: buyer.account }));
    await server.stop();
  } finally {
    await s.close();
  }
  finish();
}

runIfMain(import.meta.url, main);
