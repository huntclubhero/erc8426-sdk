// SPDX-License-Identifier: MIT
import { parseEther } from "viem";
import type { Issuer } from "@erc8426/issuer";

import { artifact, type Actor } from "../lib/chain.js";
import { fmtTime, installPass, runIfMain, stage } from "../lib/demo.js";
import { expect, finish, mustRefuse, note, ok, push, refused, say, showPass, step, title } from "../lib/narrate.js";
import { previewProvider } from "../lib/preview.js";
import { startIssuerServer } from "../lib/server.js";
import { createMembershipIssuer, readMembership, venueAccessRoute } from "./issuer.js";

const clubAbi = artifact("MembershipPass").abi;
const DAY = 86_400;

export async function main(): Promise<void> {
  title("membership", "Tiered, expiring memberships on a pass, with an access check a venue can call.");
  const s = await stage();
  try {
    const club = await s.chain.actor("club");
    const member = await s.chain.actor("member");
    const friend = await s.chain.actor("friend");
    const copycat = await s.chain.actor("copycat");

    step("Deploy MembershipPass; Silver costs 0.01 ETH per 30 days");
    const contract = await s.chain.deploy(club, "MembershipPass", ["", club.address]);
    await s.chain.send(club, contract, clubAbi, "setTierPrice", [1, parseEther("0.01")]);

    let issuer: Issuer | undefined;
    const server = await startIssuerServer(
      ({ baseUrl, domain }) => createMembershipIssuer({ baseUrl, domain, contract, chain: s.chain, providers: [previewProvider(push)] }),
      [venueAccessRoute(() => issuer!, { chain: s.chain, contract })],
    );
    issuer = server.issuer;
    s.index(contract, server.issuer);
    await s.chain.send(club, contract, clubAbi, "setPassBaseURI", [`${server.baseUrl}/wallet-pass/`]);

    step("The club grants a 30 day Silver membership");
    await s.chain.send(club, contract, clubAbi, "grant", [member.address, 1, BigInt(30 * DAY)]);
    const token = { contract, tokenId: 1n };
    const pass = await installPass(s.client, token, member.account);
    showPass(pass.content);

    // The venue kiosk: fetch a single-use `enter` challenge for the claimed
    // member, have the member confirm it in their wallet, post the proof.
    const kiosk = async (claimed: Actor, signer: Actor = claimed) => {
      const { message } = await s.client.requestChallenge(token, "enter", claimed.address);
      const signature = await signer.account.signMessage({ message });
      const res = await fetch(`${server.baseUrl}/venue/access`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tokenId: "1", message, signature }),
      });
      return { status: res.status, body: (await res.json()) as { admit: boolean; reason: string; tier?: string }, message, signature };
    };

    step("At the door: the member confirms the venue's challenge in their wallet");
    const entry = await kiosk(member);
    expect(entry.body.admit, `admitted: ${entry.body.reason}, ${entry.body.tier}`);
    const replay = await fetch(`${server.baseUrl}/venue/access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tokenId: "1", message: entry.message, signature: entry.signature }),
    });
    const replayed = (await replay.json()) as { admit: boolean; reason: string };
    expect(!replayed.admit, `a replayed proof is refused (${replay.status} ${replayed.reason})`);
    const imposter = await kiosk(copycat);
    expect(!imposter.body.admit, `someone with a copy of the pass but their own key is refused (${imposter.status} ${imposter.body.reason})`);
    const forged = await kiosk(member, copycat);
    expect(!forged.body.admit, `a challenge for the member signed by another key is refused (${forged.status} ${forged.body.reason})`);

    step("The same check through the SDK's signed action route");
    const r = await s.client.signedAction({ token, action: "enter", signer: member.account });
    say(`POST /wallet-pass/1/actions/enter -> ${JSON.stringify((r.body as { result: unknown }).result)}`);

    step("31 days later the membership has lapsed (passive, no event)");
    await s.chain.warp(31 * DAY);
    const lapsed = await kiosk(member);
    expect(!lapsed.body.admit, `the proof verifies but the venue turns them away: ${lapsed.body.reason}`);

    step("A friend gifts three months (anyone can pay a renewal)");
    await mustRefuse("renewal with the wrong payment", () =>
      s.chain.send(friend, contract, clubAbi, "renew", [1n, 3n], parseEther("0.01")),
    );
    await s.chain.send(friend, contract, clubAbi, "renew", [1n, 3n], parseEther("0.03"));
    const renewed = await readMembership(s.chain, contract, 1n);
    ok(`active until ${fmtTime(renewed.expiresAt)}`);
    expect((await kiosk(member)).body.admit, "admitted again");

    step("The club upgrades the member to Gold (issuer transaction, PassUpdate)");
    await s.chain.send(club, contract, clubAbi, "setTier", [1n, 2]);
    showPass((await installPass(s.client, token, member.account)).content);
    try {
      await s.chain.send(member, contract, clubAbi, "setTier", [1n, 2]);
    } catch {
      refused("a member cannot change their own tier: only the club can");
    }
    note("renewing at Gold by payment is refused until the club prices Gold: tier 2 has no price");
    await mustRefuse("paying to renew an unpriced tier", () => s.chain.send(member, contract, clubAbi, "renew", [1n, 1n], parseEther("0.01")));
    await server.stop();
  } finally {
    await s.close();
  }
  finish();
}

runIfMain(import.meta.url, main);
