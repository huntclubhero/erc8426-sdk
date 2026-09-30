import { describe, expect, it } from "vitest";
import { zeroAddress } from "viem";
import { IssuerError, watchTransfers, type RenderContext, type WatchEventClient } from "@erc8426/issuer";

import { TOKEN_ID, buildHarness, claim, issuePassTo, newSigner } from "./helpers.js";

/// A harness whose render records every call and throws for a token the
///  fake chain says is gone, as a real render reading the chain would.
function withRenderSpy() {
  const renders: RenderContext[] = [];
  const h = buildHarness({
    render: async (ctx) => {
      renders.push(ctx);
      if ((await h.chain.ownerOf(ctx.token)) === null) throw new Error(`render read a dead token ${ctx.token.tokenId}`);
      return { serial: ctx.serial, organizationName: "Example", description: "d", title: "Pet" };
    },
  });
  return { h, renders };
}

describe("onPassUpdate takes a fresh ownerOf read before rendering", () => {
  it("voids a burned token's passes instead of rendering it, and retires its links", async () => {
    const { h, renders } = withRenderSpy();
    const owner = newSigner();
    const links = await issuePassTo(h, owner);
    const serial = (await h.issuer.stores.passes.get(TOKEN_ID))!.serial;
    h.notified.length = 0;
    renders.length = 0;

    h.chain.setOwner(TOKEN_ID, null); // burned: the burn emitted PassUpdate
    const summary = await h.issuer.onPassUpdate(TOKEN_ID);

    expect(summary).toMatchObject({ updated: 1, burned: [TOKEN_ID], rotated: [] });
    expect(renders).toHaveLength(0);
    expect(h.errors).toHaveLength(0);
    expect(h.notified.map((n) => n.format).sort()).toEqual(["apple", "google"]);
    for (const n of h.notified) {
      expect(n.ctx.content).toMatchObject({ serial, voided: true, links: [], title: "No longer exists" });
      expect(n.ctx.owner).toBe(owner.address);
    }
    expect((await h.post(links.feed!)).status).toBe(404);
    expect(await h.issuer.capabilityLinksFor(TOKEN_ID)).toEqual({});
  });

  it("uses renderBurned when given", async () => {
    const h = buildHarness({ renderBurned: ({ serial }) => ({ serial, organizationName: "Pets", description: "gone", title: "RIP" }) });
    await issuePassTo(h, newSigner());
    h.notified.length = 0;
    h.chain.setOwner(TOKEN_ID, null);
    await h.issuer.onPassUpdate(TOKEN_ID);
    expect(h.notified[0]!.ctx.content).toMatchObject({ title: "RIP", voided: true });
  });

  it("a later PassUpdate for the burned token pushes nothing", async () => {
    const { h } = withRenderSpy();
    await issuePassTo(h, newSigner());
    h.chain.setOwner(TOKEN_ID, null);
    await h.issuer.onPassUpdate(TOKEN_ID);
    h.notified.length = 0;
    expect(await h.issuer.onPassUpdate(TOKEN_ID)).toMatchObject({ burned: [] });
    expect(h.notified).toHaveLength(0);
  });

  it("rotates on an unobserved transfer instead of pushing the new owner's state to the old holder", async () => {
    const { h, renders } = withRenderSpy();
    const seller = newSigner();
    const links = await issuePassTo(h, seller);
    h.notified.length = 0;
    renders.length = 0;
    h.chain.setOwner(TOKEN_ID, newSigner().address);
    const summary = await h.issuer.onPassUpdate(TOKEN_ID);
    expect(summary.rotated).toEqual([TOKEN_ID]);
    expect((await h.post(links.feed!)).status).toBe(404);
    // The only render was the seller's superseded card.
    expect(renders.every((r) => r.superseded && r.owner === seller.address)).toBe(true);
    expect(h.notified.every((n) => n.ctx.content.voided)).toBe(true);
  });

  it("a read failure stays an error: nothing is rendered for that token, the rest of the range is processed", async () => {
    const { h, renders } = withRenderSpy();
    await issuePassTo(h, newSigner(), "1");
    await issuePassTo(h, newSigner(), "2");
    renders.length = 0;
    const realOwnerOf = h.chain.ownerOf.bind(h.chain);
    h.chain.ownerOf = async (t) => {
      if (t.tokenId === "1") throw new Error("rpc unavailable");
      return realOwnerOf(t);
    };
    const err = await h.issuer.onPassUpdate(1n, 2n).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IssuerError);
    expect((err as IssuerError).code).toBe("read_failed");
    expect(renders.map((r) => r.token.tokenId)).toEqual(["2"]);
  });
});

describe("a Transfer to the zero address is a burn", () => {
  it("onTransfer voids the holder's passes without rendering and kills every link and download", async () => {
    const { h, renders } = withRenderSpy();
    const owner = newSigner();
    const links = await issuePassTo(h, owner);
    const { body } = await claim(h, owner);
    h.notified.length = 0;
    renders.length = 0;
    h.chain.setOwner(TOKEN_ID, null);
    expect(await h.issuer.onTransfer(TOKEN_ID, owner.address, zeroAddress)).toBe(true);
    expect(renders).toHaveLength(0);
    expect(h.notified.every((n) => n.ctx.content.voided)).toBe(true);
    expect(h.notified).toHaveLength(2);
    expect((await h.post(links.feed!)).status).toBe(404);
    expect((await h.get(body.formats.apple)).status).toBe(404);
  });

  it("watchTransfers routes a burn log through the same path", async () => {
    const { h, renders } = withRenderSpy();
    const owner = newSigner();
    const links = await issuePassTo(h, owner);
    renders.length = 0;
    let onLogs: ((logs: unknown[]) => Promise<void>) | undefined;
    const client: WatchEventClient = {
      watchContractEvent(p: { onLogs: (logs: unknown[]) => Promise<void> }) {
        onLogs = p.onLogs;
        return () => {};
      },
    };
    watchTransfers({ client, issuer: h.issuer });
    h.chain.setOwner(TOKEN_ID, null);
    await onLogs!([{ args: { from: owner.address, to: zeroAddress, tokenId: 412n } }]);
    expect(renders).toHaveLength(0);
    expect((await h.post(links.feed!)).status).toBe(404);
  });
});
