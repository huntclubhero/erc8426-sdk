import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { encodeBase64Url } from "@erc8426/core";
import { DEFAULT_REPEAT_WINDOW_SECONDS, kvRepeatStore, memoryKv, memoryRepeatStore, resolveConfig, type RepeatStore } from "@erc8426/issuer";

import { CONTRACT, TOKEN_ID, buildHarness, createClock, issuePassTo, newSigner, signChallenge, type Harness } from "./helpers.js";

const ACTION_PATH = (action: string) => `/wallet-pass/${TOKEN_ID}/actions/${action}`;

/// POST the same bytes to the same path with the given headers.
function postRaw(h: Harness, path: string, text: string, headers: Record<string, string> = {}) {
  return h.issuer.handler(new Request(`https://issuer.example${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: text }));
}

async function same(a: Response, b: Response) {
  expect(b.status).toBe(a.status);
  expect(await b.clone().text()).toBe(await a.clone().text());
}

function storeSuite(name: string, make: (now: () => number) => RepeatStore) {
  describe(`${name}`, () => {
    it("holds an outcome for its window and forgets it after", async () => {
      const clock = createClock();
      const s = make(clock.now);
      await s.put("k", { status: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}' }, 30);
      expect(await s.get("k")).toEqual({ status: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}' });
      expect(await s.get("other")).toBeNull();
      clock.advance(29_000);
      expect(await s.get("k")).not.toBeNull();
      clock.advance(1_001);
      expect(await s.get("k")).toBeNull();
    });
  });
}
storeSuite("memoryRepeatStore", (now) => memoryRepeatStore({ now }));
storeSuite("kvRepeatStore", (now) => kvRepeatStore(memoryKv({ now })));

describe("memoryRepeatStore", () => {
  it("is bounded, least recently used first out", async () => {
    const s = memoryRepeatStore({ maxEntries: 2 });
    const o = (n: number) => ({ status: 200, headers: {}, body: String(n) });
    await s.put("a", o(1), 60);
    await s.put("b", o(2), 60);
    await s.get("a"); // a is now the most recent
    await s.put("c", o(3), 60);
    expect(await s.get("b")).toBeNull();
    expect((await s.get("a"))!.body).toBe("1");
    expect((await s.get("c"))!.body).toBe("3");
  });
});

describe("identical repeats on POST /links/:link", () => {
  const limited = (overrides: Parameters<typeof buildHarness>[0] = {}) => buildHarness({ rateLimit: false, ...overrides });

  it("is on by default with a 30 second window", () => {
    const c = resolveConfig({ domain: "issuer.example", baseUrl: "https://issuer.example", chainId: 1, contract: CONTRACT, mode: "gated" });
    expect(c.repeat && c.repeat.windowSeconds).toBe(DEFAULT_REPEAT_WINDOW_SECONDS);
    expect(DEFAULT_REPEAT_WINDOW_SECONDS).toBe(30);
    expect(resolveConfig({ domain: "issuer.example", baseUrl: "https://issuer.example", chainId: 1, contract: CONTRACT, mode: "gated", repeat: false }).repeat).toBe(false);
  });

  it("concurrent identical POSTs run the action once and get identical responses", async () => {
    const h = limited();
    const links = await issuePassTo(h, newSigner());
    const body = JSON.stringify({ action: "feed", params: { portion: 1 } });
    const [a, b, c] = await Promise.all([postRaw(h, links.feed!, body), postRaw(h, links.feed!, body), postRaw(h, links.feed!, body)]);
    expect(a.status).toBe(200);
    await same(a, b);
    await same(a, c);
    expect(h.executed).toHaveLength(1);
    expect([a, b, c].filter((r) => r.headers.get("x-wallet-pass-repeat") === "true")).toHaveLength(2);
  });

  it("a repeat after completion within the window returns the recorded outcome without running again", async () => {
    const h = limited();
    const links = await issuePassTo(h, newSigner());
    const body = JSON.stringify({ action: "feed" });
    const first = await postRaw(h, links.feed!, body);
    expect(first.status).toBe(200);
    h.clock.advance(10_000);
    const again = await postRaw(h, links.feed!, body);
    await same(first, again);
    expect(again.headers.get("x-wallet-pass-repeat")).toBe("true");
    expect(h.executed).toHaveLength(1);
    // A browser form repeat gets the same outcome rendered as a page.
    const page = await h.issuer.handler(
      new Request(`https://issuer.example${links.feed}`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/html" }, body }),
    );
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Done");
    expect(h.executed).toHaveLength(1);
  });

  it("a repeat after the window is a fresh request", async () => {
    const h = limited({ repeat: { windowSeconds: 5 } });
    const links = await issuePassTo(h, newSigner());
    const body = JSON.stringify({ action: "water" });
    expect((await postRaw(h, links.water!, body)).status).toBe(200);
    h.clock.advance(5_001);
    const fresh = await postRaw(h, links.water!, body);
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("x-wallet-pass-repeat")).toBeNull();
    expect(h.executed).toHaveLength(2);
  });

  it("a different body on the same link executes normally", async () => {
    const h = limited();
    const links = await issuePassTo(h, newSigner());
    expect((await postRaw(h, links.feed!, JSON.stringify({ params: { portion: 1 } }))).status).toBe(200);
    expect((await postRaw(h, links.feed!, JSON.stringify({ params: { portion: 2 } }))).status).toBe(200);
    expect((await postRaw(h, links.feed!, "")).status).toBe(200);
    expect(h.executed).toHaveLength(3);
    // And another link with the same body is its own request.
    expect((await postRaw(h, links.water!, JSON.stringify({ params: { portion: 1 } }))).status).toBe(200);
    expect(h.executed).toHaveLength(4);
  });

  it("repeats a refusal too: the identical repeat gets that request's outcome, whatever it was", async () => {
    const h = limited();
    const owner = newSigner();
    const links = await issuePassTo(h, owner);
    // binding_mismatch, repeated as binding_mismatch.
    const wrong = JSON.stringify({ action: "water" });
    const refused = await postRaw(h, links.feed!, wrong);
    expect(refused.status).toBe(400);
    const again = await postRaw(h, links.feed!, wrong);
    await same(refused, again);
    expect(again.headers.get("x-wallet-pass-repeat")).toBe("true");
    // not_owner (a sold token behind a live link), repeated as not_owner.
    h.chain.setOwner(TOKEN_ID, newSigner().address);
    const body = JSON.stringify({ action: "feed" });
    const sold = await postRaw(h, links.feed!, body);
    expect(sold.status).toBe(403);
    const soldAgain = await postRaw(h, links.feed!, body);
    await same(sold, soldAgain);
    expect(soldAgain.headers.get("x-wallet-pass-repeat")).toBe("true");
    // A 503 is answered before the store (the fresh read is taken first),
    // so it is never recorded: the retry runs fresh once the chain answers.
    h.chain.setOwner(TOKEN_ID, owner.address);
    h.chain.failing = true;
    const other = JSON.stringify({ action: "feed", params: { n: 2 } });
    expect((await postRaw(h, links.feed!, other)).status).toBe(503);
    h.chain.failing = false;
    const retried = await postRaw(h, links.feed!, other);
    expect(retried.status).toBe(200);
    expect(retried.headers.get("x-wallet-pass-repeat")).toBeNull();
    expect(h.executed).toHaveLength(1);
  });

  it("rotation wins: a link that no longer resolves is refused before the repeat store is consulted, and a changed binding is a new key", async () => {
    const h = limited();
    const seller = newSigner();
    const buyer = newSigner();
    const links = await issuePassTo(h, seller);
    const body = JSON.stringify({ action: "feed" });
    expect((await postRaw(h, links.feed!, body)).status).toBe(200);
    // Rotated on an observed transfer: the recorded 200 is not served.
    h.chain.setOwner(TOKEN_ID, buyer.address);
    await h.issuer.onTransfer(TOKEN_ID, seller.address, buyer.address);
    const dead = await postRaw(h, links.feed!, body);
    expect(dead.status).toBe(404);
    expect(dead.headers.get("x-wallet-pass-repeat")).toBeNull();
    // The buyer taps the new link before claiming (404, recorded), then
    // claims: the holder is part of the key, so the identical tap is a new
    // request and succeeds.
    const minted = new URL((await h.issuer.capabilityLinksFor(TOKEN_ID)).feed!).pathname;
    expect((await postRaw(h, minted, body)).status).toBe(404);
    const repeat404 = await postRaw(h, minted, body);
    expect(repeat404.status).toBe(404);
    expect(repeat404.headers.get("x-wallet-pass-repeat")).toBe("true");
    const p = await signChallenge(h, buyer);
    expect((await h.get(`/wallet-pass/${TOKEN_ID}`, { "Wallet-Pass-Proof": encodeBase64Url(p.message), "Wallet-Pass-Signature": p.signature })).status).toBe(200);
    const after = await postRaw(h, minted, body);
    expect(after.status).toBe(200);
    expect(after.headers.get("x-wallet-pass-repeat")).toBeNull();
    expect(h.executed).toHaveLength(2);
  });

  it("shares completed outcomes across issuers through a KV store", async () => {
    const clock = createClock();
    const kv = memoryKv({ now: clock.now });
    const a = limited({ now: clock.now, repeat: { store: kvRepeatStore(kv) } });
    const links = await issuePassTo(a, newSigner());
    // A second instance over the same pass and link stores.
    const b = limited({ now: clock.now, stores: a.issuer.stores, chain: a.chain, repeat: { store: kvRepeatStore(kv) } });
    const body = JSON.stringify({ action: "feed" });
    const first = await postRaw(a, links.feed!, body);
    expect(first.status).toBe(200);
    const onB = await postRaw(b, links.feed!, body);
    await same(first, onB);
    expect(onB.headers.get("x-wallet-pass-repeat")).toBe("true");
    expect(a.executed).toHaveLength(1);
    expect(b.executed).toHaveLength(0);
  });

  it("a repeat after a transfer meets the fresh read: 403 not_owner, never the recorded 200", async () => {
    const h = limited();
    const seller = newSigner();
    const links = await issuePassTo(h, seller);
    const body = "{}";
    const first = await postRaw(h, links.feed!, body);
    expect(first.status).toBe(200);
    // The token changes hands; no watcher has seen it, so the link still
    // resolves and the binding is unchanged. The identical repeat must not
    // be served from the store: the fresh read runs and refuses.
    h.chain.setOwner(TOKEN_ID, newSigner().address);
    const reads = h.chain.reads;
    const after = await postRaw(h, links.feed!, body);
    expect(after.status).toBe(403);
    expect(((await after.json()) as { error: string }).error).toBe("not_owner");
    expect(after.headers.get("x-wallet-pass-repeat")).toBeNull();
    expect(h.chain.reads).toBeGreaterThan(reads);
    expect(h.executed).toHaveLength(1);
    // And the 403 repeats as itself, without a second read, while the world stays the same.
    const again = await postRaw(h, links.feed!, body);
    expect(again.status).toBe(403);
    // Back to the seller inside the window: the world is as it was for the
    // first request, so its recorded 200 is served and nothing runs again.
    h.chain.setOwner(TOKEN_ID, seller.address);
    const back = await postRaw(h, links.feed!, body);
    expect(back.status).toBe(200);
    expect(back.headers.get("x-wallet-pass-repeat")).toBe("true");
    expect(h.executed).toHaveLength(1);
  });

  it("takes the fresh read once per request and answers 503 outside the store when it cannot be taken", async () => {
    const h = limited();
    const links = await issuePassTo(h, newSigner());
    const reads = h.chain.reads;
    expect((await postRaw(h, links.feed!, "{}")).status).toBe(200);
    expect(h.chain.reads).toBe(reads + 1);
    h.chain.failing = true;
    expect((await postRaw(h, links.feed!, '{"params":{"n":2}}')).status).toBe(503);
    h.chain.failing = false;
    const retried = await postRaw(h, links.feed!, '{"params":{"n":2}}');
    expect(retried.status).toBe(200);
    expect(retried.headers.get("x-wallet-pass-repeat")).toBeNull();
  });

  it("page-driven taps carry a fresh attempt each and all execute; an identical re-POST of one page coalesces", async () => {
    const h = limited();
    const links = await issuePassTo(h, newSigner());
    const formBody = async () => {
      const page = await h.get(links.feed!, { Accept: "text/html" });
      const html = await page.text();
      const action = /name="action" value="([^"]+)"/.exec(html)![1]!;
      const attempt = /name="attempt" value="([^"]+)"/.exec(html)![1]!;
      expect(attempt).toMatch(/^[A-Za-z0-9_-]{12}$/);
      return new URLSearchParams({ action, attempt }).toString();
    };
    const tap1 = await formBody();
    const tap2 = await formBody();
    const tap3 = await formBody();
    expect(new Set([tap1, tap2, tap3]).size).toBe(3);
    const form = { "Content-Type": "application/x-www-form-urlencoded" };
    for (const b of [tap1, tap2, tap3]) expect((await postRaw(h, links.feed!, b, form)).status).toBe(200);
    expect(h.executed).toHaveLength(3);
    // The browser resending tap 3's POST: same body, coalesced.
    const [a, b] = await Promise.all([postRaw(h, links.feed!, tap3, form), postRaw(h, links.feed!, tap3, form)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(h.executed).toHaveLength(3);
    // Direct POSTs that want to count send their own distinguishing body.
    expect((await postRaw(h, links.feed!, JSON.stringify({ attempt: "x1" }))).status).toBe(200);
    expect((await postRaw(h, links.feed!, JSON.stringify({ attempt: "x2" }))).status).toBe(200);
    expect(h.executed).toHaveLength(5);
  });

  it("repeat: false judges every presentation on its own", async () => {
    const h = limited({ repeat: false });
    const links = await issuePassTo(h, newSigner());
    const body = JSON.stringify({ action: "feed" });
    await Promise.all([postRaw(h, links.feed!, body), postRaw(h, links.feed!, body)]);
    expect(h.executed).toHaveLength(2);
  });
});

describe("identical repeats on POST /:tokenId/actions/:action", () => {
  async function proofFor(h: Harness, action = "levelUp") {
    const account = newSigner();
    h.chain.setOwner(TOKEN_ID, account.address);
    const p = await signChallenge(h, account, TOKEN_ID, action);
    return { account, ...p };
  }

  it("concurrent identical presentations spend the nonce once and get identical 200s", async () => {
    const h = buildHarness();
    const { message, signature } = await proofFor(h);
    const body = JSON.stringify({ message, signature, params: { to: 2 } });
    const [a, b] = await Promise.all([postRaw(h, ACTION_PATH("levelUp"), body), postRaw(h, ACTION_PATH("levelUp"), body)]);
    expect(a.status).toBe(200);
    await same(a, b);
    expect(h.executed).toHaveLength(1);
  });

  it("an identical repeat within the window gets the first outcome instead of nonce_invalid", async () => {
    const h = buildHarness();
    const { message, signature } = await proofFor(h);
    const body = JSON.stringify({ message, signature });
    const first = await postRaw(h, ACTION_PATH("levelUp"), body);
    expect(first.status).toBe(200);
    h.clock.advance(20_000);
    const again = await postRaw(h, ACTION_PATH("levelUp"), body);
    await same(first, again);
    expect(again.headers.get("x-wallet-pass-repeat")).toBe("true");
    expect(h.executed).toHaveLength(1);
    // The same proof presented through the headers instead of the body is a different presentation: the nonce is spent.
    const viaHeaders = await postRaw(h, ACTION_PATH("levelUp"), "{}", { "Wallet-Pass-Proof": encodeBase64Url(message), "Wallet-Pass-Signature": signature });
    expect(viaHeaders.status).toBe(401);
    expect(((await viaHeaders.json()) as { error: string }).error).toBe("nonce_invalid");
  });

  it("an identical repeat after the window is refused as nonce_invalid", async () => {
    const h = buildHarness({ repeat: { windowSeconds: 5 } });
    const { message, signature } = await proofFor(h);
    const body = JSON.stringify({ message, signature });
    expect((await postRaw(h, ACTION_PATH("levelUp"), body)).status).toBe(200);
    h.clock.advance(5_001);
    const late = await postRaw(h, ACTION_PATH("levelUp"), body);
    expect(late.status).toBe(401);
    expect(((await late.json()) as { error: string }).error).toBe("nonce_invalid");
    expect(h.executed).toHaveLength(1);
  });

  it("a different request carrying a spent nonce is still nonce_invalid", async () => {
    const h = buildHarness();
    const { message, signature } = await proofFor(h);
    expect((await postRaw(h, ACTION_PATH("levelUp"), JSON.stringify({ message, signature, params: { to: 2 } }))).status).toBe(200);
    // Same nonce, same proof, different params: a replay, not a repeat.
    const replay = await postRaw(h, ACTION_PATH("levelUp"), JSON.stringify({ message, signature, params: { to: 3 } }));
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { error: string }).error).toBe("nonce_invalid");
    // Same nonce, a tampered signature: refused too (nonce already spent, so the floor stops there).
    const tampered = `${signature.slice(0, -2)}${signature.endsWith("00") ? "11" : "00"}` as Hex;
    const forged = await postRaw(h, ACTION_PATH("levelUp"), JSON.stringify({ message, signature: tampered, params: { to: 2 } }));
    expect(forged.status).toBe(401);
    expect(h.executed).toHaveLength(1);
  });

  it("signed path: an identical repeat after a transfer is refused, not served from the store", async () => {
    const h = buildHarness();
    const { account, message, signature } = await proofFor(h);
    const body = JSON.stringify({ message, signature });
    expect((await postRaw(h, ACTION_PATH("levelUp"), body)).status).toBe(200);
    h.chain.setOwner(TOKEN_ID, newSigner().address);
    const after = await postRaw(h, ACTION_PATH("levelUp"), body);
    expect(after.status).toBe(401);
    expect(after.headers.get("x-wallet-pass-repeat")).toBeNull();
    // The nonce was spent by the first presentation; the read for the
    // former owner now says not entitled, so the key differs and the floor
    // judges the presentation afresh.
    expect(((await after.json()) as { error: string }).error).toBe("nonce_invalid");
    expect(h.executed).toHaveLength(1);
    expect(h.executed[0]!.account).toBe(account.address);
  });

  it("signed path: the fresh read is taken once per request", async () => {
    const h = buildHarness();
    const { message, signature } = await proofFor(h);
    const reads = h.chain.reads;
    expect((await postRaw(h, ACTION_PATH("levelUp"), JSON.stringify({ message, signature }))).status).toBe(200);
    expect(h.chain.reads).toBe(reads + 1);
  });

  it("a repeat of a refused presentation gets the same refusal, never nonce_invalid", async () => {
    const h = buildHarness();
    const { message } = await proofFor(h);
    const body = JSON.stringify({ message, signature: `0x${"ab".repeat(65)}` });
    const first = await postRaw(h, ACTION_PATH("levelUp"), body);
    expect(first.status).toBe(401);
    expect(((await first.clone().json()) as { error: string }).error).toBe("signature_invalid");
    const again = await postRaw(h, ACTION_PATH("levelUp"), body);
    await same(first, again);
    expect(again.headers.get("x-wallet-pass-repeat")).toBe("true");
    // A verified proof from a non-entitled account repeats as 403, as the reference asserts.
    const stranger = newSigner();
    const p = await signChallenge(h, stranger, TOKEN_ID, "levelUp");
    const refused = await postRaw(h, ACTION_PATH("levelUp"), JSON.stringify(p));
    expect(refused.status).toBe(403);
    const refusedAgain = await postRaw(h, ACTION_PATH("levelUp"), JSON.stringify(p));
    await same(refused, refusedAgain);
    expect(((await refusedAgain.json()) as { error: string }).error).toBe("not_owner");
    // Past the window the nonce is simply spent.
    h.clock.advance(31_000);
    const late = await postRaw(h, ACTION_PATH("levelUp"), body);
    expect(((await late.json()) as { error: string }).error).toBe("nonce_invalid");
  });
});
