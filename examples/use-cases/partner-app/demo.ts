// SPDX-License-Identifier: MIT
import type { Address } from "viem";
import type { WalletPassClient, WalletPassSigner } from "@erc8426/client";

import { artifact, type Chain8426 } from "../lib/chain.js";
import { installPass, linkOf, runIfMain, stage } from "../lib/demo.js";
import { describeError, expect, finish, mustRefuse, note, ok, push, refused, say, showPass, step, title } from "../lib/narrate.js";
import { previewProvider } from "../lib/preview.js";
import { startIssuerServer } from "../lib/server.js";
import { readPet } from "../pet-game/issuer.js";
import { APP_ORIGIN, createPartnerIssuer } from "./issuer.js";

const petAbi = artifact("PetPass").abi;

/// The partner app, simulated as a script. It is what a universal link on
///  the pass opens. It holds the user's signer (an embedded wallet), reads
///  the chain itself, and runs actions on the signed path.
function partnerApp(opts: { client: WalletPassClient; chain: Chain8426; contract: Address; signer: WalletPassSigner }) {
  return {
    async open(link: string) {
      const url = new URL(link);
      if (url.origin !== APP_ORIGIN) throw new Error(`not a PetPals link: ${link}`);
      const tokenId = BigInt(url.pathname.split("/")[2]!);
      const intent = url.searchParams.get("do") ?? "open";
      const token = { contract: opts.contract, tokenId };
      const p = await readPet(opts.chain, opts.contract, tokenId);
      say(`app opened pet #${tokenId} (intent "${intent}"): hunger ${p.hunger}%, thirst ${p.thirst}%, boredom ${p.boredom}%`);
      return {
        token,
        /// One confirm in the app, one signature, several on-chain effects.
        careAll: () => opts.client.signedAction({ token, action: "care", signer: opts.signer, params: { kinds: ["feed", "water", "play"] } }),
        care: (kinds: string[]) => opts.client.signedAction({ token, action: "care", signer: opts.signer, params: { kinds } }),
      };
    },
  };
}

export async function main(): Promise<void> {
  title("partner-app", "Pass links are universal links into a partner app; the app runs signed actions with the SDK client.");
  const s = await stage();
  try {
    const studio = await s.chain.actor("studio");
    const relayer = await s.chain.actor("relayer");
    const player = await s.chain.actor("player");
    const friend = await s.chain.actor("friend");

    step("Deploy PetPass and an issuer whose pass links point at the PetPals app");
    const contract = await s.chain.deploy(studio, "PetPass", ["", studio.address, BigInt(3 * 86_400)]);
    await s.chain.send(studio, contract, petAbi, "setActionOperator", [relayer.address, true]);
    const server = await startIssuerServer(({ baseUrl, domain }) =>
      createPartnerIssuer({ baseUrl, domain, contract, chain: s.chain, operator: relayer, providers: [previewProvider(push)] }),
    );
    s.index(contract, server.issuer);
    await s.chain.send(studio, contract, petAbi, "setPassBaseURI", [`${server.baseUrl}/wallet-pass/`]);
    await s.chain.send(studio, contract, petAbi, "mint", [player.address]);
    const fromBlock = (await s.chain.publicClient.getBlockNumber()) + 1n;
    const pass = await installPass(s.client, { contract, tokenId: 1n }, player.account);
    showPass(pass.content);
    expect(Object.keys(await server.issuer.capabilityLinksFor(1n)).length === 0, "no capability links exist: the capability configuration is off");

    step("A link on the pass carries no authority by itself");
    const careLink = linkOf(pass.content, "care");
    say(`the Care link is ${careLink}`);
    const bare = await fetch(`${server.baseUrl}/wallet-pass/1/actions/care`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(bare.status === 401, `posting the action without a proof: ${bare.status} ${String(((await bare.json()) as { error: string }).error)}`);

    step("The player taps Care; the PetPals app opens and asks them to confirm");
    await s.chain.warp(8 * 3600);
    const app = partnerApp({ client: s.client, chain: s.chain, contract, signer: player.account });
    const session = await app.open(careLink);
    const r = await session.careAll();
    ok(`one signature, three effects: ${JSON.stringify((r.body as { result: unknown }).result)}`);
    const after = await readPet(s.chain, contract, 1n);
    say(`on chain: cares ${after.state.cares}, hunger ${after.hunger}%`);

    step("Params are the app's choice, but cannot escape the bound");
    await mustRefuse("params asking for a care kind that does not exist", () => session.care(["pet-the-cat"]));
    for (let i = 0; i < 3; i++) await session.care(["feed"]);
    await mustRefuse("a 5th feed in the window, even with a valid signature", () => session.care(["feed"]));
    note("the signed path closes forwarding; the on-chain bound still caps what any request can do");

    step("Forwarding is closed: the friend's copy of the link opens the app on their phone");
    const friendsApp = partnerApp({ client: s.client, chain: s.chain, contract, signer: friend.account });
    const friendSession = await friendsApp.open(careLink);
    await mustRefuse("the friend confirming care with their own wallet", () => friendSession.care(["water"]));

    step("Things only an app can do: history from PassUpdate events, and owner transactions");
    const updates = await s.client.getPassUpdates({ contract, fromBlock });
    say(`${updates.length} PassUpdate events for pet #1 since the pass was issued (the app's activity feed)`);
    await s.chain.send(player, contract, petAbi, "play", [1n]);
    ok("the app also sent an owner transaction from the embedded wallet (the owner's own path, outside the relayer's bound)");
    try {
      await s.chain.send(player, contract, petAbi, "transferFrom", [player.address, friend.address, 1n]);
      ok("and could list or gift the pet: the app is a full wallet, the pass is only a shortcut into it");
    } catch (e) {
      refused(describeError(e));
    }
    await mustRefuse("the player's old app session after the gift", () => session.care(["water"]));
    await server.stop();
  } finally {
    await s.close();
  }
  finish();
}

runIfMain(import.meta.url, main);
