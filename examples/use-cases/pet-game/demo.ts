// SPDX-License-Identifier: MIT
import { artifact, expectRevert } from "../lib/chain.js";
import { describeLink, installPass, LinkRefused, linkOf, runIfMain, stage, tapLink } from "../lib/demo.js";
import { describeError, expect, finish, mustRefuse, note, ok, push, say, showPass, step, title } from "../lib/narrate.js";
import { previewProvider } from "../lib/preview.js";
import { startIssuerServer } from "../lib/server.js";
import { createPetIssuer, readPet } from "./issuer.js";

const pet = artifact("PetPass");
const DAY = 86_400;

export async function main(): Promise<void> {
  title("pet-game", "WALLETCHI pattern: a pet that lives on a wallet pass, cared for from links on the pass.");
  const s = await stage();
  try {
    const issuerKey = await s.chain.actor("issuer");
    const relayer = await s.chain.actor("relayer");
    const holder = await s.chain.actor("holder");
    const friend = await s.chain.actor("friend");
    const buyer = await s.chain.actor("buyer");

    step("Deploy PetPass (3 day lapse) and appoint the care relayer on chain");
    const contract = await s.chain.deploy(issuerKey, "PetPass", ["", issuerKey.address, BigInt(3 * DAY)]);
    await s.chain.send(issuerKey, contract, pet.abi, "setActionOperator", [relayer.address, true]);
    const bound = await s.chain.read<{ maxPerWindow: number; windowSeconds: number }>(contract, pet.abi, "actionBound", [
      await s.chain.read(contract, pet.abi, "FEED"),
    ]);
    say(`PetPass at ${contract}; FEED bound on chain: ${bound.maxPerWindow} per ${bound.windowSeconds / 3600}h window`);

    const preview = previewProvider(push);
    const server = await startIssuerServer(({ baseUrl, domain }) =>
      createPetIssuer({ baseUrl, domain, contract, chain: s.chain, operator: relayer, providers: [preview] }),
    );
    s.index(contract, server.issuer);
    await s.chain.send(issuerKey, contract, pet.abi, "setPassBaseURI", [`${server.baseUrl}/wallet-pass/`]);
    say(`issuer listening at ${server.baseUrl}; passURI(id) points at it`);

    step("Hatch pet #1 for the holder");
    await s.chain.send(issuerKey, contract, pet.abi, "mint", [holder.address]);
    const token = { contract, tokenId: 1n };
    expect(await s.client.supportsWalletPass(contract), "client detects ERC-8426 (supportsInterface 0xef5f1e71)");

    step("Add to Wallet: the manifest is gated");
    await mustRefuse("manifest without a proof", () => s.client.getManifest(token));
    await mustRefuse("manifest proven by a stranger's key", () => s.client.getManifest(token, { signer: friend.account }));
    const installed = await installPass(s.client, token, holder.account);
    ok(`holder signed the acquire challenge; manifest formats: ${Object.keys(installed.manifest).join(", ")}`);
    showPass(installed.content);

    step("Tap Feed on the back of the pass (capability link, no signature)");
    const feed = linkOf(installed.content, "feed");
    const described = await describeLink(feed);
    say(`GET on the link only describes it (executed: ${String(described.body.executed)}): "${String(described.body.bound).slice(0, 80)}..."`);
    await s.chain.warp(6 * 3600);
    const tapped = await tapLink(feed);
    ok(`fed, account ${String(tapped.account).slice(0, 10)}..., via ${String(tapped.via)}`);
    const after = await readPet(s.chain, contract, 1n);
    say(`on chain: cares ${after.state.cares}, hunger ${after.hunger}%, thirst ${after.thirst}%`);

    step("The bound is enforced by the chain: a 5th feed in the window is refused");
    for (let i = 0; i < 3; i++) await tapLink(feed);
    await mustRefuse("5th feed today", () => tapLink(feed));
    note("even a compromised issuer server could not feed more: the relayer's authority is capped in PetPass");

    step("The disclosed residual: a forwarded link works for anyone holding it");
    const water = linkOf(installed.content, "water");
    await tapLink(water); // the friend taps the link the holder sent them
    ok("friend watered the pet through a forwarded link (bounded, cannot move the pet)");

    step("Remedy 1: the owner rotates the pass links (signed rotate proof)");
    await s.client.rotatePassLinks(token, { signer: holder.account });
    ok("links rotated");
    await mustRefuse("old water link after rotation", () => tapLink(water));
    const rotated = await installPass(s.client, token, holder.account);
    await tapLink(linkOf(rotated.content, "water"));
    ok("the holder's fresh water link works");

    step("Remedy 2: the owner switches every relayer off for this pet on chain");
    await s.chain.send(holder, contract, pet.abi, "setAllOperatorsRevoked", [1n, true]);
    await mustRefuse("play link while the relayer is revoked", () => tapLink(linkOf(rotated.content, "play")));
    await s.chain.send(holder, contract, pet.abi, "setAllOperatorsRevoked", [1n, false]);
    ok("owner switched the relayers back on (only the owner can)");

    step("The relayer cannot move the pet, whatever the server wants");
    const why = await expectRevert(() => s.chain.send(relayer, contract, pet.abi, "transferFrom", [holder.address, relayer.address, 1n]));
    ok(`transferFrom by the relayer reverts: ${why}`);

    step("Sale: the holder transfers the pet to a buyer");
    const oldPlay = linkOf(rotated.content, "play");
    await s.chain.send(holder, contract, pet.abi, "transferFrom", [holder.address, buyer.address, 1n]);
    await mustRefuse("seller's old play link", () => tapLink(oldPlay));
    await mustRefuse("seller's old pass download", () => fetch(rotated.downloadUrl).then((r) => (r.ok ? r : Promise.reject(new Error(`${r.status}`)))));
    await mustRefuse("seller asking for the manifest", () => s.client.getManifest(token, { signer: holder.account }));
    const buyers = await installPass(s.client, token, buyer.account);
    ok("buyer's first claim returns a fresh manifest");
    showPass(buyers.content);

    step("Neglect: three days without play and the pet dies (passive, no event)");
    await tapLink(linkOf(buyers.content, "water")); // the buyer waters, but never plays
    await s.chain.warp(3 * DAY + 60);
    const dead = await readPet(s.chain, contract, 1n);
    expect(!dead.alive, `isAlive is false (hunger ${dead.hunger}%, boredom ${dead.boredom}%)`);
    try {
      await tapLink(linkOf(buyers.content, "play"));
    } catch (e) {
      if (e instanceof LinkRefused) ok(`play refused by the contract, relayed as ${e.message}`);
      else say(describeError(e));
    }
    const grave = await installPass(s.client, token, buyer.account);
    expect((grave.content.links ?? []).length === 0, "the re-rendered pass shows no care links");
    showPass(grave.content);
    await server.stop();
  } finally {
    await s.close();
  }
  finish();
}

runIfMain(import.meta.url, main);
