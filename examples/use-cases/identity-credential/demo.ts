// SPDX-License-Identifier: MIT
import { keccak256, toHex } from "viem";

import { artifact, expectRevert, type Actor } from "../lib/chain.js";
import { installPass, runIfMain, stage } from "../lib/demo.js";
import { expect, finish, mustRefuse, note, ok, push, say, showPass, step, title } from "../lib/narrate.js";
import { downloadPreview, previewProvider } from "../lib/preview.js";
import { startIssuerServer } from "../lib/server.js";
import { createCredentialIssuer } from "./issuer.js";

const idcAbi = artifact("IdentityCredential").abi;

export async function main(): Promise<void> {
  title("identity-credential", "A soulbound ID card on a pass: verified by signed challenge, voided by revocation, rotated on request.");
  const s = await stage();
  try {
    const authority = await s.chain.actor("authority");
    const holder = await s.chain.actor("holder");
    const impostor = await s.chain.actor("impostor");
    const verifier = await s.chain.actor("verifier");

    step("Deploy IdentityCredential (ERC-5192 soulbound) and issue an over-18 credential");
    const contract = await s.chain.deploy(authority, "IdentityCredential", ["", authority.address]);
    const server = await startIssuerServer(({ baseUrl, domain }) =>
      createCredentialIssuer({ baseUrl, domain, contract, chain: s.chain, providers: [previewProvider(push)], claimLabel: "Over 18" }),
    );
    // The holder's on-chain rotation request reaches the issuer like any
    // other event an indexer forwards.
    s.index(contract, server.issuer, async (_c, eventName, args) => {
      if (eventName !== "PassRotationRequested") return;
      await server.issuer.rotate(args.tokenId as bigint);
      note(`indexer: PassRotationRequested #${String(args.tokenId)}, issuer rotated every link and download URL`);
    });
    await s.chain.send(authority, contract, idcAbi, "setPassBaseURI", [`${server.baseUrl}/wallet-pass/`]);
    const expiresAt = (await s.chain.now()) + 365n * 86_400n;
    // Only a salted hash of the claim goes on chain, never personal data.
    await s.chain.send(authority, contract, idcAbi, "issue", [holder.address, keccak256(toHex("over-18:v1:random-salt")), expiresAt]);
    const token = { contract, tokenId: 1n };
    const supports5192 = await s.chain.read<boolean>(contract, idcAbi, "supportsInterface", ["0xb45a3c0e"]);
    expect(supports5192 && (await s.chain.read<boolean>(contract, idcAbi, "locked", [1n])), "ERC-5192: locked(1) is true");
    const card = await installPass(s.client, token, holder.account);
    showPass(card.content);

    // A verifier at a bar: it fetches a `verify` challenge for the account
    // the holder claims, the holder signs it in their wallet, and the
    // verifier posts the proof to the issuer's standard action route.
    const check = async (claimed: Actor, signer: Actor = claimed) => {
      const { message } = await s.client.requestChallenge(token, "verify", claimed.address);
      const signature = await signer.account.signMessage({ message });
      const res = await fetch(`${server.baseUrl}/wallet-pass/1/actions/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, signature }),
      });
      return { status: res.status, body: (await res.json()) as { result?: { status: string; valid: boolean }; error?: string } };
    };

    step("A verifier checks the holder by signed challenge");
    const good = await check(holder);
    expect(good.status === 200 && good.body.result?.valid === true, `holder verified: ${good.body.result?.status}`);
    const copy = await check(impostor);
    expect(copy.status === 403, `an impostor showing a copy of the card, signing with their own key: ${copy.status} ${copy.body.error}`);
    const forged = await check(holder, impostor);
    expect(forged.status === 401, `a challenge for the holder signed by someone else: ${forged.status} ${forged.body.error}`);
    note(`verifier ${verifier.address.slice(0, 10)}... never needs to trust the pass file, only the issuer's two checks`);

    step("Soulbound: the credential cannot move, so transfer rotation never fires");
    const why = await expectRevert(() => s.chain.send(holder, contract, idcAbi, "transferFrom", [holder.address, impostor.address, 1n]));
    ok(`transferFrom reverts: ${why}`);

    step("The holder lost a phone: they request rotation on chain");
    await s.chain.send(holder, contract, idcAbi, "requestPassRotation", [1n]);
    await mustRefuse("the lost phone's pass download URL", () => downloadPreview(card.downloadUrl));
    const reissued = await installPass(s.client, token, holder.account);
    ok("the holder's new phone installs a fresh pass");
    expect(reissued.downloadUrl !== card.downloadUrl, "the download URL changed");

    step("The authority revokes the credential: the pass is voided and verification fails");
    await s.chain.send(authority, contract, idcAbi, "revoke", [1n]);
    const after = await check(holder);
    expect(after.body.result?.valid === false, `holder's proof still verifies, but the credential reports: ${after.body.result?.status}`);
    const revoked = await installPass(s.client, token, holder.account);
    expect(revoked.content.voided === true, "the re-rendered pass is voided");
    showPass(revoked.content);
    say("the record survives on chain for audit; the holder may renounce (burn) it with their own signature");
    await server.stop();
  } finally {
    await s.close();
  }
  finish();
}

runIfMain(import.meta.url, main);
