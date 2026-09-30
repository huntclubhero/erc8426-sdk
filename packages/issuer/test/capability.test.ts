import { describe, expect, it } from "vitest";

import { TOKEN_ID, buildHarness, claim, issuePassTo, newSigner, proof, signChallenge } from "./helpers.js";

const ROTATE = `/wallet-pass/${TOKEN_ID}/rotate`;

describe("capability links (The capability configuration)", () => {
  it("performs the bound action for the holder the link was issued to, with no signature", async () => {
    const h = buildHarness();
    const owner = newSigner();
    const links = await issuePassTo(h, owner);
    expect(Object.keys(links).sort()).toEqual(["feed", "water"]);
    const res = await h.post(links.feed!);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, executed: true, action: "feed", tokenId: TOKEN_ID, account: owner.address });
    expect(h.executed[0]!.path).toBe("capability");
    // Naming the bound action is fine; the link still decides.
    expect((await h.post(links.feed!, { action: "feed" })).status).toBe(200);
  });

  it("the URL is an unguessable 256-bit capability not derivable from the token id", async () => {
    const h = buildHarness();
    const links = await issuePassTo(h, newSigner());
    const token = links.feed!.split("/").pop()!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(links.feed).not.toContain(TOKEN_ID);
    expect(links.feed).not.toBe(links.water);
  });

  it("places the links on the pass through render", async () => {
    const h = buildHarness();
    await issuePassTo(h, newSigner());
    await h.issuer.onPassUpdate(TOKEN_ID);
    const pushed = h.notified.find((n) => n.format === "google")!;
    const urls = (pushed.ctx.content.links ?? []).map((l) => new URL(l.url).pathname).sort();
    const links = await h.issuer.capabilityLinksFor(TOKEN_ID);
    expect(urls).toEqual(Object.values(links).map((u) => new URL(u).pathname).sort());
  });

  it("a link bound to one action is refused for another", async () => {
    const h = buildHarness();
    const links = await issuePassTo(h, newSigner());
    const res = await h.post(links.feed!, { action: "water" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("binding_mismatch");
    expect(h.executed).toHaveLength(0);
  });

  it("a link rotated on an observed transfer is refused", async () => {
    const h = buildHarness();
    const seller = newSigner();
    const buyer = newSigner();
    const links = await issuePassTo(h, seller);
    h.chain.setOwner(TOKEN_ID, buyer.address);
    expect(await h.issuer.onTransfer(TOKEN_ID, seller.address, buyer.address)).toBe(true);
    const dead = await h.post(links.feed!);
    expect(dead.status).toBe(404);
    expect(((await dead.json()) as { error: string }).error).toBe("link_invalid");
    // Links minted at the transfer are issued to no one until the buyer claims.
    const minted = new URL((await h.issuer.capabilityLinksFor(TOKEN_ID)).feed!).pathname;
    expect((await h.post(minted)).status).toBe(403);
    await claim(h, buyer);
    expect((await h.post(minted)).status).toBe(200);
    expect(h.executed[0]!.account).toBe(buyer.address);
  });

  it("a live link behind a sold token is refused by the fresh read before any rotation", async () => {
    const h = buildHarness();
    const links = await issuePassTo(h, newSigner());
    h.chain.setOwner(TOKEN_ID, newSigner().address);
    const res = await h.post(links.feed!);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("not_owner");
    expect(h.executed).toHaveLength(0);
  });

  it("answers a failed read as retryable, never as a verdict", async () => {
    const h = buildHarness();
    const links = await issuePassTo(h, newSigner());
    h.chain.failing = true;
    const res = await h.post(links.feed!);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(h.executed).toHaveLength(0);
  });

  it("a GET on a link is side-effect free: no execution and no chain read", async () => {
    const h = buildHarness();
    const links = await issuePassTo(h, newSigner());
    const reads = h.chain.reads;
    const res = await h.get(links.water!);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      tokenId: TOKEN_ID,
      action: "water",
      description: "Water the pet",
      bound: "Idempotent; moves no value",
      method: "POST",
      executed: false,
    });
    expect(h.executed).toHaveLength(0);
    expect(h.chain.reads).toBe(reads);
    expect((await h.get("/wallet-pass/links/not-a-capability")).status).toBe(404);
  });

  it("serves browsers an inert confirm page whose form POST performs the action", async () => {
    const h = buildHarness();
    const links = await issuePassTo(h, newSigner());
    const page = await h.get(links.feed!, { Accept: "text/html" });
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain('method="post"');
    expect(h.executed).toHaveLength(0);
    const submitted = await h.issuer.handler(
      new Request(`https://issuer.example${links.feed}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
        body: "action=feed",
      }),
    );
    expect(submitted.status).toBe(200);
    expect(await submitted.text()).toContain("Done");
    expect(h.executed).toHaveLength(1);
  });

  it("uses a custom confirm page when configured", async () => {
    const h = buildHarness({
      capability: { enabled: true, confirmPage: (ctx) => new Response(`confirm ${ctx.action}`, { headers: { "Content-Type": "text/plain" } }) },
    });
    const links = await issuePassTo(h, newSigner());
    expect(await (await h.get(links.feed!)).text()).toBe("confirm feed");
  });

  it("lets a forwarded link act under an unchanged owner: the residual the spec discloses", async () => {
    const h = buildHarness();
    const owner = newSigner();
    const links = await issuePassTo(h, owner);
    // A second party that never signed anything follows the same link. This
    // passes on purpose: "Any party holding the capability URL can trigger
    // the bound action while ownership is unchanged." The documented bound
    // limits what repetition can do, and rotation on the owner's request is
    // the remedy (next test).
    expect((await h.post(links.feed!)).status).toBe(200);
    const forwarded = await h.post(links.feed!);
    expect(forwarded.status).toBe(200);
    expect(h.executed).toHaveLength(2);
    expect(h.executed[1]!.account).toBe(owner.address);
  });

  it("has no action links in the public configuration", async () => {
    const h = buildHarness({ mode: "public" });
    const owner = newSigner();
    h.chain.setOwner(TOKEN_ID, owner.address);
    expect((await h.get(`/wallet-pass/${TOKEN_ID}`)).status).toBe(200);
    expect(await h.issuer.capabilityLinksFor(TOKEN_ID)).toEqual({});
    const fake = `/wallet-pass/links/${"A".repeat(43)}`;
    expect((await h.get(fake)).status).toBe(404);
    expect((await h.post(fake)).status).toBe(404);
  });

  it("only actions marked capability get links: a signed-only action has none", async () => {
    const h = buildHarness();
    const links = await issuePassTo(h, newSigner());
    expect(links.levelUp).toBeUndefined();
  });
});

describe("rotation on the owner's signed request", () => {
  it("answers no proof 401 pointing at the rotate challenge", async () => {
    const h = buildHarness();
    await issuePassTo(h, newSigner());
    const res = await h.post(ROTATE);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "proof_required", challenge: "https://issuer.example/wallet-pass/412/challenge?action=rotate" });
  });

  it("an acquire proof cannot rotate", async () => {
    const h = buildHarness();
    const owner = newSigner();
    await issuePassTo(h, owner);
    const acquire = await signChallenge(h, owner);
    const res = await h.post(ROTATE, undefined, proof(acquire));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("binding_mismatch");
  });

  it("a rotate proof from an account that is not entitled is refused 403, and the links live on", async () => {
    const h = buildHarness();
    const links = await issuePassTo(h, newSigner());
    const res = await h.post(ROTATE, undefined, proof(await signChallenge(h, newSigner(), TOKEN_ID, "rotate")));
    expect(res.status).toBe(403);
    expect((await h.post(links.feed!)).status).toBe(200);
  });

  it("the owner's rotate proof retires every link and download URL and keeps the serial", async () => {
    const h = buildHarness();
    const owner = newSigner();
    const links = await issuePassTo(h, owner);
    const before = await claim(h, owner);
    const res = await h.post(ROTATE, undefined, proof(await signChallenge(h, owner, TOKEN_ID, "rotate")));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rotated: boolean; formats: Record<string, string> };
    expect(body.rotated).toBe(true);
    expect(body.formats.apple).not.toBe(before.body.formats.apple);
    // Same holder, same card: the serial is kept so the push lands on it.
    expect(body.formats.google).toBe(before.body.formats.google);
    expect((await h.post(links.feed!)).status).toBe(404);
    expect((await h.get(before.body.formats.apple)).status).toBe(404);
    const fresh = new URL((await h.issuer.capabilityLinksFor(TOKEN_ID)).feed!).pathname;
    expect((await h.post(fresh)).status).toBe(200);
  });

  it("pushes the fresh links to the owner's installed pass", async () => {
    const h = buildHarness();
    const owner = newSigner();
    await issuePassTo(h, owner);
    await h.post(ROTATE, { ...(await signChallenge(h, owner, TOKEN_ID, "rotate")) });
    const pushed = h.notified.filter((n) => !n.ctx.content.voided);
    expect(pushed).toHaveLength(2);
    const fresh = Object.values(await h.issuer.capabilityLinksFor(TOKEN_ID)).sort();
    expect(pushed[0]!.ctx.content.links!.map((l) => l.url).sort()).toEqual(fresh);
  });

  it("programmatic rotate retires links too", async () => {
    const h = buildHarness();
    const links = await issuePassTo(h, newSigner());
    await h.issuer.rotate(TOKEN_ID);
    expect((await h.post(links.feed!)).status).toBe(404);
  });
});
