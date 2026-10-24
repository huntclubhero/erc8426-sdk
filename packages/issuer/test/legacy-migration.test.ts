import { describe, expect, it } from "vitest";
import { proofHeaders } from "@erc8426/core";
import { kvStores, memoryKv } from "@erc8426/issuer";

import { CONTRACT, TOKEN_ID, buildHarness, claim, newSigner, signChallenge } from "./helpers.js";

/// 0.2.x rows: `${prefix}pass:<id>` with raw link tokens as values, and
///  `${prefix}link:<token>` rows keyed by the raw token.
async function seedLegacy(kv: ReturnType<typeof memoryKv>, prefix: string, owner: `0x${string}` | null) {
  await kv.set(
    `${prefix}pass:${TOKEN_ID}`,
    JSON.stringify({ tokenId: TOKEN_ID, serial: "OLDSERIAL", generation: 0, lastIssuedTo: owner, links: { feed: "oldLinkTok" }, downloads: { apple: "oldDl" }, updatedAt: 1, rotatedAt: 1 }),
  );
  await kv.set(`${prefix}link:oldLinkTok`, JSON.stringify({ kind: "action", tokenId: TOKEN_ID, action: "feed", generation: 0 }));
  await kv.set(`${prefix}link:oldDl`, JSON.stringify({ kind: "download", tokenId: TOKEN_ID, name: "apple", generation: 0 }));
}

describe("0.2.x pass rows under the 0.3.x key scheme", () => {
  const prefix = "erc8426-demo:1:x:issuer:";

  it("a legacy row is read through, re-serialed on the owner's first claim, and the old serial is pushed as superseded", async () => {
    const kv = memoryKv();
    const owner = newSigner();
    const buyer = newSigner();
    await seedLegacy(kv, prefix, owner.address);
    const h = buildHarness({ rateLimit: false, stores: kvStores(kv, { chainId: 1, contract: CONTRACT, prefix }) });
    h.chain.setOwner(TOKEN_ID, owner.address);
    // The old raw-token link cannot resolve under the digest scheme.
    expect((await h.post("/wallet-pass/links/oldLinkTok")).status).toBe(404);
    // The owner's acquire works and gets a NEW serial with working links.
    const { message, signature } = await signChallenge(h, owner);
    const res = await h.get(`/wallet-pass/${TOKEN_ID}`, proofHeaders({ message, signature }));
    expect(res.status).toBe(200);
    const record = (await h.issuer.stores.passes.get(TOKEN_ID))!;
    expect(record.serial).not.toBe("OLDSERIAL");
    expect(record.generation).toBe(1);
    expect(record.lastIssuedTo).toBe(owner.address);
    expect(record.migratedFrom).toBeUndefined();
    expect(Object.keys(record.links).sort()).toEqual(["feed", "water"]);
    const links = await h.issuer.capabilityLinksFor(TOKEN_ID);
    expect((await h.post(new URL(links.feed!).pathname)).status).toBe(200);
    // The old serial was pushed as superseded, reason "reset", on both platforms.
    const superseded = h.notified.filter((n) => n.ctx.content.serial === "OLDSERIAL");
    expect(superseded.map((n) => n.format).sort()).toEqual(["apple", "google"]);
    for (const n of superseded) {
      expect(n.ctx.content.voided).toBe(true);
      expect(n.ctx.content.supersededReason).toBe("reset");
      expect(n.ctx.content.links).toEqual([]);
    }
    // The legacy rows are gone.
    expect(await kv.get(`${prefix}pass:${TOKEN_ID}`)).toBeNull();
    expect(await kv.get(`${prefix}link:oldLinkTok`)).toBeNull();
    expect(await kv.get(`${prefix}link:oldDl`)).toBeNull();
    // A later transfer supersedes the CURRENT serial, as it should.
    h.chain.setOwner(TOKEN_ID, buyer.address);
    expect(await h.issuer.onTransfer(TOKEN_ID, owner.address, buyer.address)).toBe(true);
    const afterTransfer = h.notified.filter((n) => n.ctx.content.serial === record.serial && n.ctx.content.voided);
    expect(afterTransfer.length).toBeGreaterThan(0);
    expect(afterTransfer[0]!.ctx.content.supersededReason).toBe("transfer");
    // Nothing is migrated twice.
    expect((await h.issuer.stores.passes.get(TOKEN_ID))!.generation).toBe(2);
  });

  it("onPassUpdate on a migrated record settles it first, so fresh content never reaches a pass with dead links", async () => {
    const kv = memoryKv();
    const owner = newSigner();
    await seedLegacy(kv, prefix, owner.address);
    const h = buildHarness({ rateLimit: false, stores: kvStores(kv, { chainId: 1, contract: CONTRACT, prefix }) });
    h.chain.setOwner(TOKEN_ID, owner.address);
    const summary = await h.issuer.onPassUpdate(TOKEN_ID);
    expect(summary.updated).toBe(1);
    const serials = h.notified.map((n) => [n.ctx.content.serial, Boolean(n.ctx.content.voided)] as const);
    expect(serials.filter(([s, voided]) => s === "OLDSERIAL" && voided).length).toBe(2);
    const current = (await h.issuer.stores.passes.get(TOKEN_ID))!.serial;
    expect(current).not.toBe("OLDSERIAL");
    expect(serials.filter(([s, voided]) => s === current && !voided).length).toBe(2);
  });

  it("a legacy row with no holder of record migrates quietly: new serial, no push", async () => {
    const kv = memoryKv();
    const owner = newSigner();
    await seedLegacy(kv, prefix, null);
    const h = buildHarness({ rateLimit: false, stores: kvStores(kv, { chainId: 1, contract: CONTRACT, prefix }) });
    h.chain.setOwner(TOKEN_ID, owner.address);
    const { res } = await claim(h, owner);
    expect(res.status).toBe(200);
    expect(h.notified.filter((n) => n.ctx.content.serial === "OLDSERIAL")).toHaveLength(0);
    expect((await h.issuer.stores.passes.get(TOKEN_ID))!.serial).not.toBe("OLDSERIAL");
  });

  it("legacy: false leaves 0.2.x rows alone", async () => {
    const kv = memoryKv();
    const owner = newSigner();
    await seedLegacy(kv, prefix, owner.address);
    const stores = kvStores(kv, { chainId: 1, contract: CONTRACT, prefix, legacy: false });
    expect(await stores.passes.get(TOKEN_ID)).toBeNull();
    expect(await kv.get(`${prefix}pass:${TOKEN_ID}`)).not.toBeNull();
  });
});
