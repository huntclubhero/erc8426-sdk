import { describe, expect, it } from "vitest";
import { erc721Abi, walletPassAbi } from "@erc8426/core";
import { watchPassUpdates, watchTransfers, type WatchEventClient } from "@erc8426/issuer";

import { CONTRACT, TOKEN_ID, buildHarness, claim, issuePassTo, newSigner } from "./helpers.js";

/// A client that records the subscription and lets the test deliver logs.
function fakeClient() {
  const subs: Array<{ address: string; abi: unknown; eventName?: string; onLogs: (logs: unknown[]) => Promise<void> }> = [];
  let unwatched = 0;
  const client: WatchEventClient = {
    watchContractEvent(params: (typeof subs)[number]) {
      subs.push(params);
      return () => {
        unwatched++;
      };
    },
  };
  return { client, subs, unwatched: () => unwatched };
}

describe("onTransfer", () => {
  it("rotates on an observed transfer and marks the previous holder's pass superseded", async () => {
    const h = buildHarness();
    const seller = newSigner();
    const buyer = newSigner();
    const links = await issuePassTo(h, seller);
    const before = await h.issuer.stores.passes.get(TOKEN_ID);
    expect(await h.issuer.onTransfer(TOKEN_ID, seller.address, buyer.address)).toBe(true);
    const after = (await h.issuer.stores.passes.get(TOKEN_ID))!;
    expect(after.serial).not.toBe(before!.serial);
    expect(after.lastIssuedTo).toBeNull();
    expect(after.generation).toBe(before!.generation + 1);
    expect((await h.post(links.feed!)).status).toBe(404);
    const superseded = h.notified.filter((n) => n.ctx.content.voided);
    expect(superseded).toHaveLength(2);
    expect(superseded[0]!.ctx.content.serial).toBe(before!.serial);
    expect(superseded[0]!.ctx.owner).toBe(seller.address);
  });

  it("does nothing for a token it never issued", async () => {
    const h = buildHarness();
    expect(await h.issuer.onTransfer("77", newSigner().address, newSigner().address)).toBe(false);
  });

  it("does not rotate again when the buyer's first claim already did", async () => {
    const h = buildHarness();
    const seller = newSigner();
    const buyer = newSigner();
    await issuePassTo(h, seller);
    h.chain.setOwner(TOKEN_ID, buyer.address);
    await claim(h, buyer);
    const links = await h.issuer.capabilityLinksFor(TOKEN_ID);
    expect(await h.issuer.onTransfer(TOKEN_ID, seller.address, buyer.address)).toBe(false);
    expect(await h.issuer.capabilityLinksFor(TOKEN_ID)).toEqual(links);
  });

  it("keeps a failed push from failing the rotation", async () => {
    const h = buildHarness({
      providers: [
        {
          format: "google",
          acquisitionUrl: async () => "https://pay.google.com/gp/v/save/x",
          notifyUpdate: async () => {
            throw new Error("push failed");
          },
        },
      ],
    });
    const seller = newSigner();
    const links = await issuePassTo(h, seller);
    expect(await h.issuer.onTransfer(TOKEN_ID, seller.address, newSigner().address)).toBe(true);
    expect((await h.post(links.feed!)).status).toBe(404);
    expect(h.errors).toHaveLength(1);
  });
});

describe("onPassUpdate", () => {
  it("bumps updatedAt and pushes fresh content to the current holder's pass", async () => {
    const h = buildHarness();
    const owner = newSigner();
    await issuePassTo(h, owner);
    const before = (await h.issuer.stores.passes.get(TOKEN_ID))!.updatedAt;
    h.clock.advance(60_000);
    expect(await h.issuer.onPassUpdate(TOKEN_ID)).toEqual({ updated: 1 });
    const after = (await h.issuer.stores.passes.get(TOKEN_ID))!.updatedAt;
    expect(after).toBe(before + 60);
    expect(h.notified.map((n) => n.format).sort()).toEqual(["apple", "google"]);
    expect(h.notified[0]!.ctx.owner).toBe(owner.address);
    const manifest = await claim(h, owner);
    expect(manifest.body.updatedAt).toBe(after);
  });

  it("treats a BatchPassUpdate range as inclusive of both ends", async () => {
    const h = buildHarness();
    for (const id of ["9", "10", "11", "12"]) await issuePassTo(h, newSigner(), id);
    expect(await h.issuer.onPassUpdate(10n, 11n)).toEqual({ updated: 2 });
    expect(await h.issuer.onPassUpdate("9", "12")).toEqual({ updated: 4 });
  });

  it("serves a range wider than maxBatchRange from the store index", async () => {
    const h = buildHarness({ maxBatchRange: 10 });
    await issuePassTo(h, newSigner(), "5");
    expect(await h.issuer.onPassUpdate(0n, (1n << 255n))).toEqual({ updated: 1 });
  });

  it("refuses an inverted range", async () => {
    const h = buildHarness();
    await expect(h.issuer.onPassUpdate(5n, 4n)).rejects.toThrow(/inverted/);
  });
});

describe("watchers", () => {
  it("watchTransfers subscribes to the contract's Transfer logs and calls onTransfer in order", async () => {
    const h = buildHarness();
    const seller = newSigner();
    const buyer = newSigner();
    const links = await issuePassTo(h, seller);
    const { client, subs, unwatched } = fakeClient();
    const stop = watchTransfers({ client, issuer: h.issuer });
    expect(subs[0]!.address).toBe(CONTRACT);
    expect(subs[0]!.abi).toBe(erc721Abi);
    expect(subs[0]!.eventName).toBe("Transfer");
    await subs[0]!.onLogs([
      { removed: true, args: { from: seller.address, to: buyer.address, tokenId: 412n } },
      { args: { from: seller.address, to: buyer.address, tokenId: 412n } },
    ]);
    expect((await h.post(links.feed!)).status).toBe(404);
    stop();
    expect(unwatched()).toBe(1);
  });

  it("watchPassUpdates handles PassUpdate and BatchPassUpdate", async () => {
    const h = buildHarness();
    await issuePassTo(h, newSigner(), "1");
    await issuePassTo(h, newSigner(), "2");
    await issuePassTo(h, newSigner(), "3");
    const { client, subs } = fakeClient();
    watchPassUpdates({ client, issuer: h.issuer });
    expect(subs[0]!.abi).toBe(walletPassAbi);
    h.notified.length = 0;
    await subs[0]!.onLogs([
      { eventName: "PassUpdate", args: { tokenId: 1n } },
      { eventName: "BatchPassUpdate", args: { fromTokenId: 2n, toTokenId: 3n } },
    ]);
    // Two providers per token, three tokens.
    expect(h.notified).toHaveLength(6);
  });

  it("reports a failing hook through onError and keeps going", async () => {
    const h = buildHarness();
    await issuePassTo(h, newSigner(), "1");
    const { client, subs } = fakeClient();
    const errors: unknown[] = [];
    watchPassUpdates({ client, issuer: h.issuer, onError: (e) => errors.push(e) });
    await subs[0]!.onLogs([
      { eventName: "BatchPassUpdate", args: { fromTokenId: 5n, toTokenId: 4n } },
      { eventName: "PassUpdate", args: { tokenId: 1n } },
    ]);
    expect(errors).toHaveLength(1);
    expect(h.notified.length).toBeGreaterThan(0);
  });
});
