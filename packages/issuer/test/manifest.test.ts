import { describe, expect, it } from "vitest";
import { PKPASS_MEDIA_TYPE, encodeBase64Url, parseManifest } from "@erc8426/core";

import { BASE, TOKEN_ID, buildHarness, claim, newSigner, proof, signChallenge } from "./helpers.js";

const MANIFEST = `/wallet-pass/${TOKEN_ID}`;
const CHALLENGE_URI = `${BASE}/wallet-pass/${TOKEN_ID}/challenge`;

describe("public configuration", () => {
  it("serves a valid manifest to anyone, rendered for the current owner", async () => {
    const h = buildHarness({ mode: "public" });
    h.chain.setOwner(TOKEN_ID, newSigner().address);
    const res = await h.get(MANIFEST);
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = parseManifest(body);
    expect(parsed.ok).toBe(true);
    expect(Object.keys((body as { formats: object }).formats).sort()).toEqual(["apple", "google"]);
    expect(Number.isInteger((body as { updatedAt: number }).updatedAt)).toBe(true);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("answers a nonexistent token 404", async () => {
    const h = buildHarness({ mode: "public" });
    const res = await h.get(MANIFEST);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("not_found");
  });

  it("answers a failed owner read 503 with Retry-After", async () => {
    const h = buildHarness({ mode: "public" });
    h.chain.failing = true;
    const res = await h.get(MANIFEST);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
  });

  it("rotates acquisition URLs when it observes a new owner", async () => {
    const h = buildHarness({ mode: "public" });
    h.chain.setOwner(TOKEN_ID, newSigner().address);
    const first = (await (await h.get(MANIFEST)).json()) as { formats: Record<string, string> };
    const again = (await (await h.get(MANIFEST)).json()) as { formats: Record<string, string> };
    expect(again.formats.apple).toBe(first.formats.apple);
    h.chain.setOwner(TOKEN_ID, newSigner().address);
    const after = (await (await h.get(MANIFEST)).json()) as { formats: Record<string, string> };
    expect(after.formats.apple).not.toBe(first.formats.apple);
    expect((await h.get(first.formats.apple!)).status).toBe(404);
  });
});

describe("gated acquisition", () => {
  it("answers a request with no proof 401 proof_required with the challenge URI and no acquisition URLs", async () => {
    const h = buildHarness();
    h.chain.setOwner(TOKEN_ID, newSigner().address);
    const res = await h.get(MANIFEST);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "proof_required", challenge: CHALLENGE_URI });
    // No chain read is needed to refuse a request with no proof.
    expect(h.chain.reads).toBe(0);
  });

  it("the challenge the 401 points at resolves the manifest, served with Cache-Control no-store", async () => {
    const h = buildHarness();
    const owner = newSigner();
    h.chain.setOwner(TOKEN_ID, owner.address);
    const refused = (await (await h.get(MANIFEST)).json()) as { challenge: string };
    const challenge = await h.get(`${refused.challenge}?address=${owner.address}`);
    const { message } = (await challenge.json()) as { message: string };
    expect(message).toContain("urn:wallet-pass:action:acquire");
    const signature = await owner.signMessage({ message });
    const res = await h.get(MANIFEST, proof({ message, signature }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(parseManifest(await res.json()).ok).toBe(true);
  });

  it("refuses a malformed proof with 400", async () => {
    const h = buildHarness();
    const partial = await h.get(MANIFEST, { "X-Wallet-Pass-Proof": encodeBase64Url("x") });
    expect(partial.status).toBe(400);
    expect(((await partial.json()) as { error: string }).error).toBe("malformed_proof");
    const notHex = await h.get(MANIFEST, { "X-Wallet-Pass-Proof": encodeBase64Url("x"), "X-Wallet-Pass-Signature": "nothex" });
    expect(notHex.status).toBe(400);
    const badEncoding = await h.get(MANIFEST, { "X-Wallet-Pass-Proof": "***", "X-Wallet-Pass-Signature": "0x00" });
    expect(badEncoding.status).toBe(400);
  });

  it("a proof for any other action MUST NOT resolve the manifest", async () => {
    const h = buildHarness();
    const owner = newSigner();
    h.chain.setOwner(TOKEN_ID, owner.address);
    const p = await signChallenge(h, owner, TOKEN_ID, "feed");
    const res = await h.get(MANIFEST, proof(p));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("binding_mismatch");
    expect(body.formats).toBeUndefined();
  });

  it("carries the challenge URI on every 401 from the gated path", async () => {
    const h = buildHarness();
    const owner = newSigner();
    h.chain.setOwner(TOKEN_ID, owner.address);

    const first = await claim(h, owner);
    const replay = await h.get(MANIFEST, proof(first.proof));
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: "nonce_invalid", challenge: CHALLENGE_URI });

    const fresh = await signChallenge(h, owner);
    const badlySigned = await h.get(MANIFEST, proof({ message: fresh.message, signature: "0xdeadbeef" }));
    expect(await badlySigned.json()).toEqual({ error: "signature_invalid", challenge: CHALLENGE_URI });

    const stale = await signChallenge(h, owner);
    h.clock.advance(301_000);
    const expired = await h.get(MANIFEST, proof(stale));
    expect(await expired.json()).toEqual({ error: "challenge_expired", challenge: CHALLENGE_URI });
  });

  it("refuses a verified proof from a non-entitled account with 403, and nothing else uses 403", async () => {
    const h = buildHarness();
    h.chain.setOwner(TOKEN_ID, newSigner().address);
    const stranger = newSigner();
    const res = await h.get(MANIFEST, proof(await signChallenge(h, stranger)));
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "not_owner" });
  });

  it("answers a failed read 503 read_failed with Retry-After, not 403, and no URLs", async () => {
    const h = buildHarness();
    const owner = newSigner();
    h.chain.setOwner(TOKEN_ID, owner.address);
    const p = await signChallenge(h, owner);
    h.chain.failing = true;
    const res = await h.get(MANIFEST, proof(p));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("read_failed");
    expect(body.formats).toBeUndefined();
  });

  it("rotates acquisition URLs on a new owner's first claim, not on a repeat claim", async () => {
    const h = buildHarness();
    const seller = newSigner();
    const buyer = newSigner();
    h.chain.setOwner(TOKEN_ID, seller.address);

    const s1 = await claim(h, seller);
    const s2 = await claim(h, seller);
    expect(s2.body.formats).toEqual(s1.body.formats);
    expect((await h.get(s1.body.formats.apple)).status).toBe(200);

    h.chain.setOwner(TOKEN_ID, buyer.address);
    const b1 = await claim(h, buyer);
    expect(b1.res.status).toBe(200);
    expect(b1.body.formats.apple).not.toBe(s1.body.formats.apple);
    expect(b1.body.formats.google).not.toBe(s1.body.formats.google);

    const dead = await h.get(s1.body.formats.apple);
    expect(dead.status).toBe(404);
    expect(((await dead.json()) as { error: string }).error).toBe("link_invalid");
    expect((await h.get(b1.body.formats.apple)).status).toBe(200);

    // Rotation retires URLs; it is not a content change.
    expect(b1.body.updatedAt).toBe(s1.body.updatedAt);
  });

  it("gives the new holder a new random serial and pushes the previous holder's pass as superseded", async () => {
    const h = buildHarness();
    const seller = newSigner();
    const buyer = newSigner();
    h.chain.setOwner(TOKEN_ID, seller.address);
    const s = await claim(h, seller);
    h.chain.setOwner(TOKEN_ID, buyer.address);
    const b = await claim(h, buyer);
    // The google URL embeds the serial in this fake provider.
    expect(b.body.formats.google).not.toBe(s.body.formats.google);
    const superseded = h.notified.filter((n) => n.ctx.content.voided);
    expect(superseded.map((n) => n.format).sort()).toEqual(["apple", "google"]);
    expect(superseded[0]!.ctx.owner).toBe(seller.address);
    expect(s.body.formats.google).toContain(superseded[0]!.ctx.content.serial);
    expect(superseded[0]!.ctx.content.links).toEqual([]);
    // A new account's claim is a change of hands.
    expect(superseded[0]!.ctx.content.supersededReason).toBe("transfer");
  });

  it("serves the apple pass file at a capability URL with the pkpass media type", async () => {
    const h = buildHarness();
    const owner = newSigner();
    h.chain.setOwner(TOKEN_ID, owner.address);
    const { body } = await claim(h, owner);
    const apple = body.formats.apple as string;
    expect(apple).toMatch(/^https:\/\/issuer\.example\/wallet-pass\/passes\/[A-Za-z0-9_-]{43}$/);
    expect(apple).not.toContain(TOKEN_ID);
    const res = await h.get(apple);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(PKPASS_MEDIA_TYPE);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain(owner.address);
  });

  it("answers HEAD on the pass file with the pkpass media type and no body", async () => {
    const h = buildHarness();
    const owner = newSigner();
    h.chain.setOwner(TOKEN_ID, owner.address);
    const { body } = await claim(h, owner);
    const res = await h.issuer.handler(new Request(body.formats.apple, { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(PKPASS_MEDIA_TYPE);
    expect(await res.text()).toBe("");
    expect((await h.issuer.handler(new Request(`${BASE}/wallet-pass/passes/${"A".repeat(43)}`, { method: "HEAD" }))).status).toBe(404);
  });

  it("refuses a pass download when the holder it was issued to is no longer entitled", async () => {
    const h = buildHarness();
    const owner = newSigner();
    h.chain.setOwner(TOKEN_ID, owner.address);
    const { body } = await claim(h, owner);
    h.chain.setOwner(TOKEN_ID, newSigner().address);
    expect((await h.get(body.formats.apple)).status).toBe(403);
    h.chain.failing = true;
    expect((await h.get(body.formats.apple)).status).toBe(503);
  });

  it("answers an invalid token id 400 invalid_token", async () => {
    const h = buildHarness();
    for (const bad of ["abc", "-1", "1.5", (1n << 256n).toString()]) {
      const res = await h.get(`/wallet-pass/${bad}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_token");
    }
  });

  it("answers an unknown route 404 and a wrong method 405", async () => {
    const h = buildHarness();
    expect((await h.get("/wallet-pass/412/nope")).status).toBe(404);
    const wrong = await h.post(MANIFEST, {});
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toContain("GET");
  });

  it("returns null from route for a path outside basePath", async () => {
    const h = buildHarness();
    expect(await h.issuer.route(new Request(`${BASE}/elsewhere/412`))).toBeNull();
    expect((await h.issuer.handler(new Request(`${BASE}/elsewhere/412`))).status).toBe(404);
  });

  it("exposes the passURI and challenge URI shapes", () => {
    const h = buildHarness();
    expect(h.issuer.passUri(412n)).toBe(`${BASE}/wallet-pass/412`);
    expect(h.issuer.challengeUri("412")).toBe(CHALLENGE_URI);
    expect(h.issuer.challengeUri("412", "rotate")).toBe(`${CHALLENGE_URI}?action=rotate`);
  });
});
