import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Abi, Address } from "viem";
import { PKPASS_MEDIA_TYPE, WALLET_PASS_INTERFACE_ID, parseChallenge } from "@erc8426/core";
import { createWalletPassClient, type WalletPassClientError } from "@erc8426/client";
import { createIssuer, watchTransfers1155, type ActionContext, type Issuer } from "@erc8426/issuer";

import {
  appleProvider,
  deploy,
  eventually,
  googleProvider,
  newActor,
  send,
  startAnvil,
  startServer,
  type Actor,
  type Chain,
  type HttpServer,
} from "./harness.js";

/// The ERC-1155 binding (working draft) end to end: a real ERC-1155 contract
///  on anvil, the issuer over real HTTP with the Apple and Google providers,
///  and the client an app would use. A membership id held by several
///  accounts, which is the case the binding is scoped to.

const MEMBERSHIP = 77n;

let chain: Chain;
let server: HttpServer;
let issuer: Issuer;
let ticket: { address: Address; abi: Abi };
let deployer: Actor, alice: Actor, bob: Actor, carol: Actor, stranger: Actor;
let client: ReturnType<typeof createWalletPassClient>;
const stamped: ActionContext[] = [];
const errors: unknown[] = [];

const token = (id: bigint = MEMBERSHIP) => ({ contract: ticket.address, tokenId: id });
const balance = (who: Actor, id: bigint = MEMBERSHIP) =>
  chain.publicClient.readContract({ ...ticket, functionName: "balanceOf", args: [who.address, id] }) as Promise<bigint>;
const move = (from: Actor, to: Actor, amount: bigint, id: bigint = MEMBERSHIP) =>
  send(chain, from, ticket.address, ticket.abi, "safeTransferFrom", [from.address, to.address, id, amount, "0x"]);
const stampLink = async (who: Actor) => (await issuer.capabilityLinksFor(MEMBERSHIP, who.address)).stamp!;
const post = (url: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const serialOf = async (who: Actor) => (await issuer.stores.passes.get(`${MEMBERSHIP}:${who.address.toLowerCase()}`))?.serial;
const issuedTo = async (who: Actor) => (await issuer.stores.passes.get(`${MEMBERSHIP}:${who.address.toLowerCase()}`))?.lastIssuedTo ?? null;

beforeAll(async () => {
  chain = await startAnvil();
  [deployer, alice, bob, carol, stranger] = await Promise.all([newActor(chain), newActor(chain), newActor(chain), newActor(chain), newActor(chain)]);
  server = await startServer();
  ticket = await deploy(chain, deployer, "SwapOnRedeemTicket", ["https://meta.example/{id}.json", `${server.baseUrl}/wallet-pass/`, deployer.address]);
  await send(chain, deployer, ticket.address, ticket.abi, "mint", [alice.address, MEMBERSHIP, 3n]);
  await send(chain, deployer, ticket.address, ticket.abi, "mint", [bob.address, MEMBERSHIP, 1n]);
  issuer = createIssuer({
    domain: server.domain,
    baseUrl: server.baseUrl,
    chainId: chain.publicClient.chain!.id,
    contract: ticket.address,
    standard: "erc1155",
    mode: "gated",
    capability: { enabled: true },
    linkSecret: "erc1155 end to end link secret, thirty-two bytes plus",
    publicClient: chain.publicClient,
    providers: [appleProvider(server.baseUrl), googleProvider(server.baseUrl).provider],
    actions: {
      stamp: {
        description: "Stamp the card",
        capability: true,
        bound: "Idempotent; moves no value and no balance",
        execute: (ctx) => {
          stamped.push(ctx);
          return { stamped: true };
        },
      },
      vote: { description: "Vote", execute: () => ({ voted: true }) },
    },
    render: async ({ token: t, owner, serial, links }) => ({
      serial,
      organizationName: "Members",
      description: `Membership ${t.tokenId}`,
      title: "Member",
      primary: [
        {
          key: "held",
          label: "Held",
          value: Number(await chain.publicClient.readContract({ ...ticket, functionName: "balanceOf", args: [owner, BigInt(t.tokenId)] })),
        },
      ],
      links: Object.entries(links).map(([key, url]) => ({ key, label: key, url })),
    }),
    onError: (e) => errors.push(e),
    onWarning: () => undefined,
  });
  server.setHandler((r) => issuer.handler(r));
  client = createWalletPassClient({ publicClient: chain.publicClient });
}, 120_000);

afterAll(async () => {
  await server?.close();
  await chain?.stop();
});

describe("ERC-1155 binding end to end", () => {
  it("the contract answers the same interface id as the ERC-721 extension, and is ERC-1155", async () => {
    const supports = (id: `0x${string}`) =>
      chain.publicClient.readContract({ ...ticket, functionName: "supportsInterface", args: [id] }) as Promise<boolean>;
    expect(WALLET_PASS_INTERFACE_ID).toBe("0xef5f1e71");
    expect(await supports(WALLET_PASS_INTERFACE_ID)).toBe(true);
    expect(await supports("0xd9b67a26")).toBe(true);
    expect(await supports("0x80ac58cd")).toBe(false);
    expect(await client.supportsWalletPass(ticket.address)).toBe(true);
    expect(await client.getPassURI(token())).toBe(`${server.baseUrl}/wallet-pass/77`);
    // No supply, no pass endpoint.
    await expect(client.getPassURI(token(5n))).rejects.toThrow();
  });

  it("the client signs a challenge in the erc1155 namespace without being told the standard", async () => {
    const { message } = await client.requestChallenge(token(), "acquire", alice.address);
    expect(parseChallenge(message)?.token?.standard).toBe("erc1155");
    expect(message.toLowerCase()).toContain(`/erc1155:${ticket.address.toLowerCase()}/77`);
  });

  it("two holders of one id each resolve their own pass, with real pass files", async () => {
    const a = await client.getManifest(token(), { signer: alice.account });
    const b = await client.getManifest(token(), { signer: bob.account });
    expect(a.configuration).toBe("gated");
    expect(a.manifest.formats.apple).not.toBe(b.manifest.formats.apple);
    expect(a.manifest.formats.google).not.toBe(b.manifest.formats.google);
    expect(await serialOf(alice)).not.toBe(await serialOf(bob));
    for (const m of [a, b]) {
      const file = await fetch(m.manifest.formats.apple!);
      expect(file.status).toBe(200);
      expect(file.headers.get("content-type")).toBe(PKPASS_MEDIA_TYPE);
    }
    // Bob's claim did not disturb Alice's pass.
    expect((await client.getManifest(token(), { signer: alice.account })).manifest.formats.apple).toBe(a.manifest.formats.apple);
  });

  it("an account that holds none is refused", async () => {
    const refused = (await client.getManifest(token(), { signer: stranger.account }).catch((e: unknown) => e)) as WalletPassClientError;
    expect(refused.code).toBe("not_owner");
  });

  it("each capability link acts for the account it was issued to", async () => {
    expect((await post(await stampLink(alice))).status).toBe(200);
    expect((await post(await stampLink(bob))).status).toBe(200);
    expect(stamped.map((s) => s.account)).toEqual([alice.address, bob.address]);
    const signed = await client.signedAction({ token: token(), action: "vote", signer: bob.account });
    expect(signed).toBeTruthy();
  });

  it("selling one of three leaves the seller's links alone, and the buyer claims its own pass", async () => {
    const stop = watchTransfers1155({ client: chain.publicClient, issuer, pollingInterval: 100, onError: (e) => errors.push(e) });
    try {
      const before = await stampLink(alice);
      const serial = await serialOf(alice);
      await move(alice, carol, 1n);
      expect(await balance(alice)).toBe(2n);
      // Give the watcher time to see the log and decide to do nothing.
      await new Promise((r) => setTimeout(r, 1500));
      expect(await stampLink(alice)).toBe(before);
      expect(await serialOf(alice)).toBe(serial);
      expect((await post(before)).status).toBe(200);
      const c = await client.getManifest(token(), { signer: carol.account });
      expect(c.configuration).toBe("gated");
      expect(await issuedTo(carol)).toBe(carol.address);
    } finally {
      stop();
    }
  });

  it("selling the last unit: the fresh read refuses the link at once, and the watcher then retires it", async () => {
    const link = await stampLink(bob);
    const serial = await serialOf(bob);
    const aliceLink = await stampLink(alice);
    await move(bob, stranger, 1n);
    expect(await balance(bob)).toBe(0n);
    // Nothing has observed the transfer yet.
    const refused = await post(link);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe("not_owner");

    const stop = watchTransfers1155({ client: chain.publicClient, issuer, pollingInterval: 100, onError: (e) => errors.push(e) });
    try {
      // The watcher subscribes from now on; a later transfer names Bob again.
      await move(stranger, bob, 1n);
      await move(bob, stranger, 1n);
      await eventually(async () => (await issuedTo(bob)) === null);
    } finally {
      stop();
    }
    expect((await post(link)).status).toBe(404);
    expect(await serialOf(bob)).not.toBe(serial);
    // Alice was not part of it.
    expect(await stampLink(alice)).toBe(aliceLink);
    expect((await post(aliceLink)).status).toBe(200);
  });

  it("buying back is a first claim: a new pass and new links, never the retired ones", async () => {
    // The retirement already replaced the serial; the claim takes that one.
    const replacement = await serialOf(bob);
    await move(stranger, bob, 1n);
    const again = await client.getManifest(token(), { signer: bob.account });
    expect(again.configuration).toBe("gated");
    expect(await issuedTo(bob)).toBe(bob.address);
    expect(await serialOf(bob)).toBe(replacement);
    expect((await post(await stampLink(bob))).status).toBe(200);
    expect((await fetch(again.manifest.formats.apple!)).status).toBe(200);
  });

  it("with no watcher at all, a read over the issued accounts finds who no longer holds", async () => {
    // Carol uses her one unit on chain: the live balance leaves in the same
    // transaction, so the holding is over.
    await send(chain, carol, ticket.address, ticket.abi, "redeem", [MEMBERSHIP]);
    expect(await balance(carol)).toBe(0n);
    const link = await stampLink(carol);
    const summary = await issuer.checkHoldings(MEMBERSHIP);
    expect(summary.retired).toEqual([carol.address]);
    expect(summary.checked).toBe(3);
    expect((await post(link)).status).toBe(404);
    expect(await issuedTo(alice)).toBe(alice.address);
    expect(await issuedTo(bob)).toBe(bob.address);
  });

  it("a holder rotates its own links through the client, and nobody else's", async () => {
    const mine = await stampLink(alice);
    const theirs = await stampLink(bob);
    const refused = (await client.rotatePassLinks(token(), { signer: carol.account }).catch((e: unknown) => e)) as WalletPassClientError;
    expect(refused.code).toBe("not_owner");
    await client.rotatePassLinks(token(), { signer: alice.account });
    expect((await post(mine)).status).toBe(404);
    expect(await stampLink(alice)).not.toBe(mine);
    expect(await stampLink(bob)).toBe(theirs);
    expect((await post(theirs)).status).toBe(200);
  });

  it("nothing failed quietly along the way", () => {
    expect(errors).toEqual([]);
  });
});
