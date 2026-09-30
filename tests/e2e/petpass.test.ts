import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEventLogs, type Abi, type Address, type Hex } from "viem";
import { GOOGLE_SAVE_URL_PREFIX, PKPASS_MEDIA_TYPE, walletPassAbi } from "@erc8426/core";
import { createWalletPassClient, type WalletPassClientError } from "@erc8426/client";
import { formatReport, runConformance } from "@erc8426/conformance";
import { ActionError, createIssuer, isRevert, watchTransfers, type ActionContext, type Issuer } from "@erc8426/issuer";

import {
  ROOT,
  appleProvider,
  deploy,
  eventually,
  googleProvider,
  newActor,
  send,
  startAnvil,
  startServer,
  unzip,
  type Actor,
  type Chain,
  type HttpServer,
} from "./harness.js";

const execFileAsync = promisify(execFile);
const DAY = 86_400;

let chain: Chain;
let server: HttpServer;
let issuer: Issuer;
let petPass: { address: Address; abi: Abi };
let deployer: Actor, operator: Actor, owner: Actor, stranger: Actor, buyer: Actor, third: Actor;
let feedBound: { maxPerWindow: number; windowSeconds: number; maxValuePerCall: bigint; maxValuePerWindow: bigint };
let client: ReturnType<typeof createWalletPassClient>;
const errors: unknown[] = [];

type Pet = { lastFed: bigint; lastWatered: bigint; lastPlayed: bigint; cares: number };
const pet = (tokenId: bigint) => chain.publicClient.readContract({ ...petPass, functionName: "pet", args: [tokenId] }) as Promise<Pet>;
const ownerOf = (tokenId: bigint) => chain.publicClient.readContract({ ...petPass, functionName: "ownerOf", args: [tokenId] }) as Promise<Address>;
const token = (tokenId: bigint) => ({ contract: petPass.address, tokenId });
const path = (url: string) => new URL(url).pathname;
const post = (url: string, body?: unknown) =>
  fetch(url.startsWith("http") ? url : `${server.baseUrl}${url}`, {
    method: "POST",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

/// An action that sends the real contract transaction from the operator key.
///  A revert (BoundedAction refusing, a dead pet) becomes a 429 with the
///  revert's error name; anything else is a server failure.
function care(fn: "feed" | "water" | "play") {
  return async (ctx: ActionContext) => {
    let receipt;
    try {
      receipt = await send(chain, operator, petPass.address, petPass.abi, fn, [BigInt(ctx.token.tokenId)]);
    } catch (e) {
      if (!isRevert(e)) throw e;
      throw new ActionError(429, "bounded_action_refused", (e as Error).message.split("\n")[0]);
    }
    await ctx.notifyUpdate();
    const updates = parseEventLogs({ abi: walletPassAbi, logs: receipt.logs, eventName: "PassUpdate" });
    return { tx: receipt.transactionHash, passUpdates: updates.map((u) => u.args.tokenId.toString()) };
  };
}

beforeAll(async () => {
  chain = await startAnvil();
  [deployer, operator, owner, stranger, buyer, third] = await Promise.all([newActor(chain), newActor(chain), newActor(chain), newActor(chain), newActor(chain), newActor(chain)]);
  server = await startServer();
  petPass = await deploy(chain, deployer, "PetPass", [`${server.baseUrl}/wallet-pass/`, deployer.address, BigInt(3 * DAY)]);
  await send(chain, deployer, petPass.address, petPass.abi, "setActionOperator", [operator.address, true]);
  for (let i = 0; i < 3; i++) await send(chain, deployer, petPass.address, petPass.abi, "mint", [owner.address]);

  const feedId = (await chain.publicClient.readContract({ ...petPass, functionName: "FEED" })) as Hex;
  feedBound = (await chain.publicClient.readContract({ ...petPass, functionName: "actionBound", args: [feedId] })) as typeof feedBound;
  // The documented bound, built from the bound the chain enforces.
  const bound = (what: string) =>
    `At most ${feedBound.maxPerWindow} ${what} per pet per ${feedBound.windowSeconds / 3600} hour window (fixed windows, so up to ${
      feedBound.maxPerWindow * 2
    } inside any ${feedBound.windowSeconds / 3600} hour span); enforced on chain by BoundedAction; moves no value (value caps ${feedBound.maxValuePerCall} and ${feedBound.maxValuePerWindow}); cannot transfer, burn or approve.`;

  const apple = appleProvider(server.baseUrl);
  const google = googleProvider(server.baseUrl);
  issuer = createIssuer({
    domain: server.domain,
    baseUrl: server.baseUrl,
    chainId: chain.publicClient.chain!.id,
    contract: petPass.address,
    mode: "gated",
    publicClient: chain.publicClient,
    providers: [apple, google.provider],
    capability: { enabled: true },
    actions: {
      feed: { description: "Feed your pet", capability: true, bound: bound("feeds"), execute: care("feed") },
      water: { description: "Water your pet", capability: true, bound: bound("waterings"), execute: care("water") },
      play: { description: "Play with your pet", execute: care("play") },
    },
    render: async ({ token: t, serial, links }) => {
      const [hunger, thirst, boredom] = (await chain.publicClient.readContract({
        ...petPass,
        functionName: "needs",
        args: [BigInt(t.tokenId)],
      })) as [bigint, bigint, bigint];
      return {
        serial,
        organizationName: "Pet Pass",
        description: `Pet #${t.tokenId}`,
        title: `Pet #${t.tokenId}`,
        primary: [{ key: "hunger", label: "Hunger", value: Number(hunger) }],
        secondary: [
          { key: "thirst", label: "Thirst", value: Number(thirst) },
          { key: "boredom", label: "Boredom", value: Number(boredom) },
        ],
        links: Object.entries(links).map(([key, url]) => ({ key, label: key, url })),
      };
    },
    onError: (e) => errors.push(e),
  });
  server.setHandler((r) => issuer.handler(r));
  client = createWalletPassClient({ publicClient: chain.publicClient });
}, 120_000);

afterAll(async () => {
  await server?.close();
  await chain?.stop();
});

describe("conformance", () => {
  it("the gated PetPass issuer passes every MUST check with the owner key", async () => {
    const report = await runConformance({ publicClient: chain.publicClient, contract: petPass.address, tokenId: 1n, ownerPrivateKey: owner.key });
    if (!report.ok) console.error(formatReport(report));
    expect(report.configuration).toBe("gated");
    expect(report.summary.fail).toBe(0);
    expect(report.ok).toBe(true);
    // The owner checks ran rather than being skipped.
    expect(report.checks.filter((c) => c.status === "pass").length).toBeGreaterThan(10);
  }, 120_000);

  it("the built CLI exits 0 against the same deployment", async () => {
    const cli = join(ROOT, "packages", "conformance", "dist", "cli.js");
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        process.execPath,
        [cli, "--rpc", chain.rpcUrl, "--contract", petPass.address, "--token", "1", "--json"],
        { env: { ...process.env, ERC8426_OWNER_KEY: owner.key }, timeout: 90_000, windowsHide: true },
      ));
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      throw new Error(`CLI exited ${err.code}\n${err.stdout}\n${err.stderr}`);
    }
    const report = JSON.parse(stdout) as { ok: boolean; summary: { fail: number } };
    expect(report.ok).toBe(true);
    expect(report.summary.fail).toBe(0);
  }, 120_000);
});

describe("client flows", () => {
  it("detects the wallet pass interface through ERC-165", async () => {
    expect(await client.supportsWalletPass(petPass.address)).toBe(true);
    expect(await client.supportsWalletPass(stranger.address)).toBe(false);
  });

  it("a gated manifest needs a proof: none throws proof_required", async () => {
    await expect(client.getManifest(token(1n))).rejects.toMatchObject({ code: "proof_required", status: 401 });
  });

  it("resolves the gated manifest for the owner and refuses a stranger with 403", async () => {
    const res = await client.getManifest(token(1n), { signer: owner.account });
    expect(res.configuration).toBe("gated");
    expect(res.passUri).toBe(`${server.baseUrl}/wallet-pass/1`);
    expect(Object.keys(res.manifest.formats).sort()).toEqual(["apple", "google"]);
    const refused = (await client.getManifest(token(1n), { signer: stranger.account }).catch((e: unknown) => e)) as WalletPassClientError;
    expect(refused.status).toBe(403);
    expect(refused.code).toBe("not_owner");
  });

  it("addToWallet: the apple URL serves a signed pkpass zip via GET and HEAD", async () => {
    const add = await client.addToWallet(token(1n), { signer: owner.account, platform: "apple" });
    expect(add.platform).toBe("apple");
    const head = await fetch(add.url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe(PKPASS_MEDIA_TYPE);
    const res = await fetch(add.url);
    expect(res.headers.get("content-type")).toBe(PKPASS_MEDIA_TYPE);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const files = unzip(bytes);
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["pass.json", "manifest.json", "signature", "icon.png"]));
    const passJson = JSON.parse(files["pass.json"]!.toString("utf8")) as { serialNumber: string };
    expect(passJson.serialNumber).toBe((await issuer.stores.passes.get("1"))!.serial);
  });

  it("addToWallet: an Android user agent gets the Save to Google Wallet link", async () => {
    const add = await client.addToWallet(token(1n), {
      signer: owner.account,
      userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36",
    });
    expect(add.platform).toBe("google");
    expect(add.url.startsWith(GOOGLE_SAVE_URL_PREFIX)).toBe(true);
  });
});

describe("capability links on chain", () => {
  it("GET on a link is side-effect free: no transaction, no state change", async () => {
    const links = await issuer.capabilityLinksFor(1n);
    const before = await pet(1n);
    const block = await chain.publicClient.getBlockNumber();
    const res = await fetch(links.feed!);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ action: "feed", method: "POST", executed: false });
    expect(await chain.publicClient.getBlockNumber()).toBe(block);
    expect(await pet(1n)).toEqual(before);
  });

  it("POST feeds on chain with PassUpdate, repeated until BoundedAction refuses: bounded repetition", async () => {
    const link = (await issuer.capabilityLinksFor(1n)).feed!;
    const fromBlock = await chain.publicClient.getBlockNumber();
    const start = (await pet(1n)).cares;
    for (let i = 1; i <= feedBound.maxPerWindow; i++) {
      const res = await post(link);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { executed: boolean; account: string; result: { passUpdates: string[] } };
      expect(body.executed).toBe(true);
      expect(body.account).toBe(owner.address);
      expect(body.result.passUpdates).toContain("1");
      expect((await pet(1n)).cares).toBe(start + i);
    }
    // The link still resolves, but the chain refuses a fifth feed in the window.
    const refused = await post(link);
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: string }).error).toBe("bounded_action_refused");
    expect((await pet(1n)).cares).toBe(start + feedBound.maxPerWindow);
    const [calls] = (await chain.publicClient.readContract({
      ...petPass,
      functionName: "remainingInWindow",
      args: [1n, (await chain.publicClient.readContract({ ...petPass, functionName: "FEED" })) as Hex],
    })) as [number, bigint];
    expect(calls).toBe(0);
    // Wallets and distributors see the freshness signal on chain.
    const updates = await client.getPassUpdates({ contract: petPass.address, fromBlock });
    expect(updates.filter((u) => JSON.stringify(u, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).includes('"1"')).length).toBeGreaterThanOrEqual(
      feedBound.maxPerWindow,
    );
  }, 60_000);

  it("water is bound separately: its own link still works after feed is exhausted", async () => {
    const res = await post((await issuer.capabilityLinksFor(1n)).water!);
    expect(res.status).toBe(200);
  });
});

describe("transfer", () => {
  it("an observed transfer rotates; the old link and old owner are refused; the new owner claims", async () => {
    const id = 2n;
    await client.getManifest(token(id), { signer: owner.account });
    const ownerLinks = await issuer.capabilityLinksFor(id);
    expect((await post(ownerLinks.feed!)).status).toBe(200);

    const stop = watchTransfers({ client: chain.publicClient, issuer, pollingInterval: 100, onError: (e) => errors.push(e) });
    try {
      await send(chain, owner, petPass.address, petPass.abi, "transferFrom", [owner.address, buyer.address, id]);
      expect(await ownerOf(id)).toBe(buyer.address);
      await eventually(async () => (await issuer.stores.passes.get("2"))!.lastIssuedTo === null);
    } finally {
      stop();
    }

    const dead = await post(ownerLinks.feed!);
    expect(dead.status).toBe(404);
    expect(((await dead.json()) as { error: string }).error).toBe("link_invalid");

    const old = (await client.getManifest(token(id), { signer: owner.account }).catch((e: unknown) => e)) as WalletPassClientError;
    expect(old.status).toBe(403);

    const claimed = await client.getManifest(token(id), { signer: buyer.account });
    expect(claimed.configuration).toBe("gated");
    const buyerLinks = await issuer.capabilityLinksFor(id);
    expect(buyerLinks.feed).not.toBe(ownerLinks.feed);
    const fed = await post(buyerLinks.feed!);
    expect(fed.status).toBe(200);
    expect(((await fed.json()) as { account: string }).account).toBe(buyer.address);
  }, 60_000);

  it("with no watcher, the new owner's first claim rotates before the manifest is returned", async () => {
    const id = 2n;
    const buyerManifest = await client.getManifest(token(id), { signer: buyer.account });
    const buyerLinks = await issuer.capabilityLinksFor(id);
    await send(chain, buyer, petPass.address, petPass.abi, "transferFrom", [buyer.address, third.address, id]);

    // Before anyone claims, the fresh read already refuses the buyer's live link.
    const stale = await post(buyerLinks.feed!);
    expect(stale.status).toBe(403);

    const thirdManifest = await client.getManifest(token(id), { signer: third.account });
    expect(thirdManifest.manifest.formats.apple).not.toBe(buyerManifest.manifest.formats.apple);
    expect((await post(buyerLinks.feed!)).status).toBe(404);
    expect((await fetch(buyerManifest.manifest.formats.apple!, { method: "HEAD" })).status).toBe(404);
    const thirdLinks = await issuer.capabilityLinksFor(id);
    expect((await post(thirdLinks.water!)).status).toBe(200);
  }, 60_000);
});

describe("signed path", () => {
  it("client.signedAction runs a non-capability action on chain; a stranger is refused 403", async () => {
    const id = 3n;
    const before = (await pet(id)).cares;
    const res = await client.signedAction({ token: token(id), action: "play", signer: owner.account });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ executed: true, action: "play", account: owner.address });
    expect((await pet(id)).cares).toBe(before + 1);
    // play has no capability link at all.
    expect((await issuer.capabilityLinksFor(id)).play).toBeUndefined();
    const refused = (await client.signedAction({ token: token(id), action: "play", signer: stranger.account }).catch((e: unknown) => e)) as WalletPassClientError;
    expect(refused.status).toBe(403);
    expect((await pet(id)).cares).toBe(before + 1);
  }, 60_000);

  it("rotatePassLinks retires every link for the owner; a stranger cannot rotate", async () => {
    const id = 3n;
    await client.getManifest(token(id), { signer: owner.account });
    const before = await issuer.capabilityLinksFor(id);
    const refused = (await client.rotatePassLinks(token(id), { signer: stranger.account }).catch((e: unknown) => e)) as WalletPassClientError;
    expect(refused.status).toBe(403);
    expect((await fetch(before.feed!)).status).toBe(200);

    const res = await client.rotatePassLinks(token(id), { signer: owner.account });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rotated: true });
    expect((await post(before.feed!)).status).toBe(404);
    const after = await issuer.capabilityLinksFor(id);
    expect(path(after.feed!)).not.toBe(path(before.feed!));
    expect((await post(after.feed!)).status).toBe(200);
  }, 60_000);

  it("reported no unexpected issuer errors", () => {
    expect(errors).toEqual([]);
  });
});
