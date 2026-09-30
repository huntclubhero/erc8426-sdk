// SPDX-License-Identifier: MIT
import type { Address } from "viem";

import { expectRevert } from "../lib/chain.js";
import { installPass, linkOf, runIfMain, stage, tapLink } from "../lib/demo.js";
import { expect, finish, mustRefuse, note, ok, push, say, showPass, step, title } from "../lib/narrate.js";
import { previewProvider } from "../lib/preview.js";
import { startIssuerServer } from "../lib/server.js";
import { createRentalIssuer, readRental, rentalPass } from "./issuer.js";

const DAY = 86_400;

export async function main(): Promise<void> {
  title("rental", "An ERC-4907 rental: the renter holds the pass exclusively, the owner gets it back at check out.");
  const s = await stage();
  try {
    const host = await s.chain.actor("host");
    const guest = await s.chain.actor("guest");
    const abi = rentalPass.abi;

    step("Deploy RentalPass (ERC721WalletPassRentable) and mint the house key to the host");
    const contract = await s.chain.deploy(host, rentalPass, ["", host.address]);
    const lockLog: Array<{ tokenId: string; account: Address; via: string }> = [];
    const server = await startIssuerServer(({ baseUrl, domain }) =>
      createRentalIssuer({ baseUrl, domain, contract, chain: s.chain, providers: [previewProvider(push)], lockLog }),
    );
    s.index(contract, server.issuer);
    await s.chain.send(host, contract, abi, "setPassBaseURI", [`${server.baseUrl}/wallet-pass/`]);
    await s.chain.send(host, contract, abi, "mint", [host.address]);
    expect(await s.chain.read<boolean>(contract, abi, "supportsInterface", ["0xad092b5c"]), "supports ERC-4907 (0xad092b5c)");
    const token = { contract, tokenId: 1n };
    const hostPass = await installPass(s.client, token, host.account);
    showPass(hostPass.content);
    await tapLink(linkOf(hostPass.content, "unlock"));
    ok(`host unlocked the door (via ${lockLog.at(-1)!.via})`);

    step("The host rents the house to a guest for three nights (setUser, PassUpdate)");
    const checkout = (await s.chain.now()) + BigInt(3 * DAY);
    await s.chain.send(host, contract, abi, "setUser", [1n, guest.address, checkout]);
    const r = await readRental(s.chain, contract, 1n);
    say(`on chain: owner ${r.owner.slice(0, 10)}..., userOf ${r.user?.slice(0, 10)}..., passHolderOf ${r.holder.slice(0, 10)}... (the guest)`);

    step("During the rental the guest alone is entitled (rental4907, exclusive)");
    await mustRefuse("the host's still-live unlock link, before any rotation", () => tapLink(linkOf(hostPass.content, "unlock")));
    note("refused by the fresh entitlement read (userOf), not by rotation: the host still owns the token");
    await mustRefuse("the host asking for the manifest", () => s.client.getManifest(token, { signer: host.account }));
    const guestPass = await installPass(s.client, token, guest.account);
    ok("guest's first claim rotated the links and issued the guest a pass");
    showPass(guestPass.content);
    await tapLink(linkOf(guestPass.content, "unlock"));
    ok(`guest unlocked the door (via ${lockLog.at(-1)!.via})`);

    step("The guest holds a key, not the house");
    ok(`guest transferFrom reverts: ${await expectRevert(() => s.chain.send(guest, contract, abi, "transferFrom", [host.address, guest.address, 1n]))}`);
    ok(`guest extending their own stay reverts: ${await expectRevert(() => s.chain.send(guest, contract, abi, "setUser", [1n, guest.address, checkout + BigInt(30 * DAY)]))}`);

    step("Check out passes: the rental expires with no transaction and no event");
    await s.chain.warp(3 * DAY + 60);
    const after = await readRental(s.chain, contract, 1n);
    expect(after.user === null && after.holder === host.address, "userOf is zero again and passHolderOf is the host");
    await mustRefuse("the guest's unlock link after check out", () => tapLink(linkOf(guestPass.content, "unlock")));
    await mustRefuse("the guest asking for the manifest after check out", () => s.client.getManifest(token, { signer: guest.account }));
    const back = await installPass(s.client, token, host.account);
    ok("the host claims the pass back (rotation again: the guest's links are retired)");
    await tapLink(linkOf(back.content, "unlock"));
    ok(`host unlocked the door (via ${lockLog.at(-1)!.via})`);
    say(`lock log: ${lockLog.map((e) => `${e.via}:${e.account.slice(0, 6)}`).join(", ")}`);
    await server.stop();
  } finally {
    await s.close();
  }
  finish();
}

runIfMain(import.meta.url, main);
