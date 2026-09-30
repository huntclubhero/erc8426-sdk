// SPDX-License-Identifier: MIT
import { formatEther, parseEther } from "viem";

import { artifact } from "../lib/chain.js";
import { installPass, runIfMain, stage, tapLink } from "../lib/demo.js";
import { expect, finish, mustRefuse, note, ok, push, say, showPass, step, title } from "../lib/narrate.js";
import { previewProvider } from "../lib/preview.js";
import { startIssuerServer } from "../lib/server.js";
import { createTicketIssuer, readTicket } from "./issuer.js";

const tixAbi = artifact("EventTicketPass").abi;
const HOUR = 3600;

export async function main(): Promise<void> {
  title("event-ticket", "Tickets on a pass: scan to check in once, keepsake after the show, one BatchPassUpdate for the lot.");
  const s = await stage();
  try {
    const promoter = await s.chain.actor("promoter");
    const door = await s.chain.actor("door");
    const ana = await s.chain.actor("ana");
    const ben = await s.chain.actor("ben");
    const cam = await s.chain.actor("cam");
    const buyer = await s.chain.actor("buyer");
    const screenshot = "someone holding a screenshot";

    step("Deploy EventTicketPass with a 5% royalty and grant DOOR_ROLE to the door scanner");
    const contract = await s.chain.deploy(promoter, "EventTicketPass", ["", promoter.address, promoter.address, 500]);
    await s.chain.send(promoter, contract, tixAbi, "grantRole", [await s.chain.read(contract, tixAbi, "DOOR_ROLE"), door.address]);
    const [royaltyTo, royalty] = await s.chain.read<readonly [string, bigint]>(contract, tixAbi, "royaltyInfo", [1n, parseEther("1")]);
    say(`royaltyInfo on a 1 ETH resale: ${formatEther(royalty)} ETH to ${royaltyTo.slice(0, 10)}...`);

    const preview = previewProvider(push);
    const server = await startIssuerServer(({ baseUrl, domain }) =>
      createTicketIssuer({ baseUrl, domain, contract, chain: s.chain, door, providers: [preview], showName: "Night Shift Live", venue: "Pier 17" }),
    );
    s.index(contract, server.issuer);
    await s.chain.send(promoter, contract, tixAbi, "setPassBaseURI", [`${server.baseUrl}/wallet-pass/`]);

    step("Create a show in two days (4 hours long) and sell three tickets");
    const now = await s.chain.now();
    const startsAt = now + BigInt(48 * HOUR);
    const endsAt = startsAt + BigInt(4 * HOUR);
    await s.chain.send(promoter, contract, tixAbi, "createShow", [startsAt, endsAt, 50n]);
    for (const fan of [ana, ben, cam]) await s.chain.send(promoter, contract, tixAbi, "mintTicket", [1n, fan.address]);
    const t = (id: bigint) => ({ contract, tokenId: id });
    const anaPass = await installPass(s.client, t(1n), ana.account);
    const benPass = await installPass(s.client, t(2n), ben.account);
    const camPass = await installPass(s.client, t(3n), cam.account);
    showPass(anaPass.content);

    step("Cam resells ticket #3; the old barcode dies with the sale");
    await s.chain.send(cam, contract, tixAbi, "transferFrom", [cam.address, buyer.address, 3n]);
    await mustRefuse("Cam's old barcode at the door", () => tapLink(camPass.content.barcode!.message));
    const buyerPass = await installPass(s.client, t(3n), buyer.account);
    ok("buyer's first claim issued a fresh barcode");

    step("Ben posted a photo of his ticket online, so he rotates his pass before the show");
    await s.client.rotatePassLinks(t(2n), { signer: ben.account });
    const benFresh = await installPass(s.client, t(2n), ben.account);
    note(`the posted barcode is now dead; ${screenshot} will be turned away`);

    step("Show night: the door scans barcodes");
    await s.chain.warp(48 * HOUR + 600);
    const scan = (barcode: string) => tapLink(barcode);
    await scan(anaPass.content.barcode!.message);
    ok("Ana admitted");
    await mustRefuse("Ana's barcode scanned a second time", () => scan(anaPass.content.barcode!.message));
    await mustRefuse(`${screenshot} of Ben's old barcode`, () => scan(benPass.content.barcode!.message));
    await scan(benFresh.content.barcode!.message);
    ok("Ben admitted with his rotated barcode");
    await scan(buyerPass.content.barcode!.message);
    ok("the resale buyer admitted");
    const ana1 = await readTicket(s.chain, contract, 1n);
    expect(ana1.phase === "Checked in", `ticket #1 phase on chain: ${ana1.phase}`);
    showPass((await installPass(s.client, t(1n), ana.account)).content);

    step("The show ends: one BatchPassUpdate turns every ticket into a keepsake");
    await s.chain.warp(4 * HOUR);
    const pushesBefore = preview.pushes.length;
    await s.chain.send(buyer, contract, tixAbi, "endShow", [1n]); // permissionless
    expect(preview.pushes.length - pushesBefore === 3, `one event refreshed all ${preview.pushes.length - pushesBefore} issued passes`);
    const keepsake = await installPass(s.client, t(1n), ana.account);
    expect(!keepsake.content.barcode, "the keepsake has no barcode");
    showPass(keepsake.content);
    await mustRefuse("a check-in after the show", () => scan(buyerPass.content.barcode!.message));
    await server.stop();
  } finally {
    await s.close();
  }
  finish();
}

runIfMain(import.meta.url, main);
