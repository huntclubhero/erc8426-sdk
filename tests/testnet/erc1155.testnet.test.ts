import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, defineChain, http, type Abi, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { PKPASS_MEDIA_TYPE, WALLET_PASS_INTERFACE_ID, parseChallenge } from "@erc8426/core";
import { createWalletPassClient, type WalletPassClientError } from "@erc8426/client";
import { IssuerError, createIssuer, watchTransfers1155, type ActionContext, type Issuer } from "@erc8426/issuer";

import { appleProvider, artifact, eventually, googleProvider, startServer, type HttpServer } from "../e2e/harness.js";

/// The ERC-1155 binding (working draft) against a public testnet: the same
///  flow as tests/e2e/erc1155.test.ts, with real blocks, a real public RPC
///  and real transfer logs in place of anvil. The issuer runs on this
///  machine; the chain is the public one.
///
///  It deploys a fresh SwapOnRedeemTicket on every run and writes what it did
///  (the contract, every transaction hash) to the report file, so the run can
///  be checked on a block explorer afterwards.
///
///  Environment:
///  - TESTNET_ENV_FILE: a KEY=value file with RPC_URL, CHAIN_ID and the five
///    funded throwaway keys DEPLOYER_KEY, ALICE_KEY, BOB_KEY, CAROL_KEY,
///    STRANGER_KEY. Never commit it.
///  - TESTNET_REPORT: where the JSON report goes (optional).

const envFile = process.env.TESTNET_ENV_FILE;
const env: Record<string, string> = {};
if (envFile) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]!] = m[2]!.trim();
  }
}

const MEMBERSHIP = 77n;

interface Actor {
  name: string;
  account: PrivateKeyAccount;
  address: Address;
}

const report: { chainId?: number; rpcUrl?: string; contract?: Address; deployBlock?: string; accounts: Record<string, Address>; steps: { step: string; tx?: Hex; block?: string; note?: string }[] } = {
  accounts: {},
  steps: [],
};

let publicClient: PublicClient;
let rpcUrl: string;
let server: HttpServer;
let issuer: Issuer;
let ticket: { address: Address; abi: Abi };
let deployer: Actor, alice: Actor, bob: Actor, carol: Actor, stranger: Actor;
let client: ReturnType<typeof createWalletPassClient>;
const stamped: ActionContext[] = [];
const errors: unknown[] = [];

const actor = (name: string): Actor => {
  const key = env[`${name.toUpperCase()}_KEY`];
  if (!key) throw new Error(`${name.toUpperCase()}_KEY is missing from TESTNET_ENV_FILE`);
  const account = privateKeyToAccount(key as Hex);
  report.accounts[name] = account.address;
  return { name, account, address: account.address };
};

const walletOf = (who: Actor) => createWalletClient({ account: who.account, chain: publicClient.chain!, transport: http(rpcUrl) });

/// Simulate, send, wait for the receipt, and note it in the report.
async function send(step: string, from: Actor, functionName: string, args: unknown[]) {
  const { request } = await publicClient.simulateContract({ account: from.account, address: ticket.address, abi: ticket.abi, functionName, args });
  const hash = await walletOf(from).writeContract(request as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  report.steps.push({ step, tx: hash, block: receipt.blockNumber.toString() });
  return receipt;
}

const token = (id: bigint = MEMBERSHIP) => ({ contract: ticket.address, tokenId: id });
const balance = (who: Actor, id: bigint = MEMBERSHIP) =>
  publicClient.readContract({ ...ticket, functionName: "balanceOf", args: [who.address, id] }) as Promise<bigint>;
/// A public RPC can answer a read from a node that has not seen the block of
///  the receipt yet, so a balance is waited for and not read once.
const settled = (who: Actor, expected: bigint) => eventually(async () => (await balance(who)) === expected, 30_000);
const move = async (step: string, from: Actor, to: Actor, amount: bigint) => {
  const [a, b] = [await balance(from), await balance(to)];
  const receipt = await send(step, from, "safeTransferFrom", [from.address, to.address, MEMBERSHIP, amount, "0x"]);
  await settled(from, a - amount);
  await settled(to, b + amount);
  return receipt;
};
const stampLink = async (who: Actor) => (await issuer.capabilityLinksFor(MEMBERSHIP, who.address)).stamp!;
const post = (url: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const record = (who: Actor) => issuer.stores.passes.get(`${MEMBERSHIP}:${who.address.toLowerCase()}`);
const serialOf = async (who: Actor) => (await record(who))?.serial;
const issuedTo = async (who: Actor) => (await record(who))?.lastIssuedTo ?? null;
const watch = () => watchTransfers1155({ client: publicClient, issuer, pollingInterval: 1000, onError: (e) => errors.push(e) });

describe.skipIf(!envFile)("ERC-1155 binding on a public testnet", () => {
  beforeAll(async () => {
    rpcUrl = env.RPC_URL!;
    const chainId = Number(env.CHAIN_ID);
    const chain = defineChain({
      id: chainId,
      name: `eip155:${chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    publicClient = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 500 }) as PublicClient;
    expect(await publicClient.getChainId()).toBe(chainId);
    report.chainId = chainId;
    report.rpcUrl = rpcUrl;
    [deployer, alice, bob, carol, stranger] = ["deployer", "alice", "bob", "carol", "stranger"].map(actor) as [Actor, Actor, Actor, Actor, Actor];

    server = await startServer();
    const { abi, bytecode } = artifact("SwapOnRedeemTicket");
    const hash = await walletOf(deployer).deployContract({
      abi,
      bytecode,
      args: ["https://meta.example/{id}.json", `${server.baseUrl}/wallet-pass/`, deployer.address],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error("SwapOnRedeemTicket did not deploy");
    ticket = { address: receipt.contractAddress, abi };
    report.contract = ticket.address;
    report.deployBlock = receipt.blockNumber.toString();
    report.steps.push({ step: "deploy SwapOnRedeemTicket", tx: hash, block: receipt.blockNumber.toString() });
    await eventually(async () => ((await publicClient.getCode({ address: ticket.address })) ?? "0x") !== "0x", 30_000);

    await send("mint 3 units of id 77 to alice", deployer, "mint", [alice.address, MEMBERSHIP, 3n]);
    await send("mint 1 unit of id 77 to bob", deployer, "mint", [bob.address, MEMBERSHIP, 1n]);
    await settled(alice, 3n);
    await settled(bob, 1n);

    issuer = createIssuer({
      domain: server.domain,
      baseUrl: server.baseUrl,
      chainId,
      contract: ticket.address,
      standard: "erc1155",
      mode: "gated",
      capability: { enabled: true },
      linkSecret: "erc1155 testnet run link secret, thirty-two bytes plus",
      publicClient,
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
            value: Number(await publicClient.readContract({ ...ticket, functionName: "balanceOf", args: [owner, BigInt(t.tokenId)] })),
          },
        ],
        links: Object.entries(links).map(([key, url]) => ({ key, label: key, url })),
      }),
      onError: (e) => errors.push(e),
      onWarning: () => undefined,
    });
    server.setHandler((r) => issuer.handler(r));
    client = createWalletPassClient({ publicClient });
  });

  afterAll(async () => {
    await server?.close();
    if (process.env.TESTNET_REPORT) writeFileSync(process.env.TESTNET_REPORT, JSON.stringify(report, null, 2));
  });

  it("the deployed contract answers the ERC-8426 interface id and is ERC-1155", async () => {
    const supports = (id: Hex) => publicClient.readContract({ ...ticket, functionName: "supportsInterface", args: [id] }) as Promise<boolean>;
    expect(await supports(WALLET_PASS_INTERFACE_ID)).toBe(true);
    expect(await supports("0xd9b67a26")).toBe(true);
    expect(await supports("0x80ac58cd")).toBe(false);
    expect(await client.supportsWalletPass(ticket.address)).toBe(true);
    expect(await client.getPassURI(token())).toBe(`${server.baseUrl}/wallet-pass/77`);
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
    expect(await serialOf(alice)).not.toBe(await serialOf(bob));
    for (const m of [a, b]) {
      const file = await fetch(m.manifest.formats.apple!);
      expect(file.status).toBe(200);
      expect(file.headers.get("content-type")).toBe(PKPASS_MEDIA_TYPE);
    }
    report.steps.push({ step: "alice and bob each claimed a pass of id 77", note: "two serials, two sets of URLs" });
  });

  it("an account that holds none is refused", async () => {
    const refused = (await client.getManifest(token(), { signer: stranger.account }).catch((e: unknown) => e)) as WalletPassClientError;
    expect(refused.code).toBe("not_owner");
  });

  it("each capability link acts for the account it was issued to, and the signed path works", async () => {
    expect((await post(await stampLink(alice))).status).toBe(200);
    expect((await post(await stampLink(bob))).status).toBe(200);
    expect(stamped.map((s) => s.account)).toEqual([alice.address, bob.address]);
    expect(await client.signedAction({ token: token(), action: "vote", signer: bob.account })).toBeTruthy();
  });

  it("selling one of three leaves the seller's links alone, and the buyer claims its own pass", async () => {
    const stop = watch();
    try {
      const before = await stampLink(alice);
      const serial = await serialOf(alice);
      await move("alice sends 1 of 3 to carol", alice, carol, 1n);
      // Time for the watcher to see the log and decide to do nothing.
      await new Promise((r) => setTimeout(r, 6000));
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

  it("selling the last unit: the fresh read refuses the link at once, and the watcher retires it from the real log", async () => {
    const link = await stampLink(bob);
    const serial = await serialOf(bob);
    const aliceLink = await stampLink(alice);
    const stop = watch();
    try {
      // Let the subscription take its starting block before the transfer.
      await new Promise((r) => setTimeout(r, 3000));
      await move("bob sends his last unit to stranger", bob, stranger, 1n);
      const refused = await post(link);
      // 403 from the fresh read, or 404 if the watcher already retired it.
      expect([403, 404]).toContain(refused.status);
      await eventually(async () => (await issuedTo(bob)) === null, 60_000);
    } finally {
      stop();
    }
    expect((await post(link)).status).toBe(404);
    expect(await serialOf(bob)).not.toBe(serial);
    expect(await stampLink(alice)).toBe(aliceLink);
    expect((await post(aliceLink)).status).toBe(200);
    report.steps.push({ step: "bob's links retired by the watcher", note: "from the TransferSingle log, read at the log's block and at latest" });
  });

  it("buying back is a first claim: a new pass and new links, never the retired ones", async () => {
    const replacement = await serialOf(bob);
    await move("stranger sends the unit back to bob", stranger, bob, 1n);
    const again = await client.getManifest(token(), { signer: bob.account });
    expect(again.configuration).toBe("gated");
    expect(await issuedTo(bob)).toBe(bob.address);
    expect(await serialOf(bob)).toBe(replacement);
    expect((await post(await stampLink(bob))).status).toBe(200);
    expect((await fetch(again.manifest.formats.apple!)).status).toBe(200);
  });

  it("a balance that left and came back between two reads is still caught, from the block of the log", async () => {
    // No watcher runs while Bob sends his unit away and gets it back, so a
    // fresh read afterwards sees him holding again.
    const link = await stampLink(bob);
    const out = await move("bob sends his unit to stranger (nobody watching)", bob, stranger, 1n);
    await move("stranger sends it back to bob (nobody watching)", stranger, bob, 1n);
    expect((await issuer.checkHoldings(MEMBERSHIP, { accounts: [bob.address] })).retired).toEqual([]);
    expect((await post(link)).status).toBe(200);
    // The first transfer's log arrives late, with its block.
    expect(await issuer.onTransfer(MEMBERSHIP, bob.address, stranger.address, out.blockNumber)).toBe(true);
    expect((await post(link)).status).toBe(404);
    // And he claims again, as a first claim.
    await client.getManifest(token(), { signer: bob.account });
    expect((await post(await stampLink(bob))).status).toBe(200);
  });

  it("a log so old that the node no longer has its state changes nothing and says so", async () => {
    const head = await publicClient.getBlockNumber();
    const pruned = BigInt(report.deployBlock!) > 2_000_000n ? head - 2_000_000n : 1n;
    const link = await stampLink(alice);
    const before = errors.length;
    const outcome = await issuer.onTransfer(MEMBERSHIP, alice.address, carol.address, pruned).catch((e: unknown) => e);
    report.steps.push({
      step: "a transfer hint with a block the node has pruned",
      block: pruned.toString(),
      note: outcome instanceof IssuerError ? `refused as ${outcome.code}` : `answered ${String(outcome)}`,
    });
    expect(await stampLink(alice)).toBe(link);
    expect((await post(link)).status).toBe(200);
    // Whatever it reported, it reported it to the issuer's error hook only.
    errors.splice(before);
  });

  it("with no watcher at all, a read over the issued accounts finds who no longer holds", async () => {
    await send("carol redeems her unit (burn and swap in one transaction)", carol, "redeem", [MEMBERSHIP]);
    await settled(carol, 0n);
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
