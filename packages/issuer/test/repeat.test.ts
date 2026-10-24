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

  it("replays only a success; a refusal is judged afresh against current state", async () => {
    const h = limited();
    const seller = newSigner();
    const buyer = newSigner();
    const links = await issuePassTo(h, seller);
    // A failed read is retryable: the repeat runs again and succeeds once the chain answers.
    h.chain.failing = true;
    const body = JSON.stringify({ action: "feed" });
    expect((await postRaw(h, links.feed!, body)).status).toBe(503);
    h.chain.failing = false;
    const retried = await postRaw(h, links.feed!, body);
    expect(retried.status).toBe(200);
    expect(retried.headers.get("x-wallet-pass-repeat")).toBeNull();
    // A refusal that state can change: the buyer taps the new link before
    // claiming (404), then claims; the identical tap now succeeds.
    h.chain.setOwner(TOKEN_ID, buyer.address);
    await h.issuer.onTransfer(TOKEN_ID, seller.address, buyer.address);
    const minted = new URL((await h.issuer.capabilityLinksFor(TOKEN_ID)).feed!).pathname;
    expect((await postRaw(h, minted, body)).status).toBe(404);
    const p = await signChallenge(h, buyer);
    expect((await h.get(`/wallet-pass/${TOKEN_ID}`, { "Wallet-Pass-Proof": encodeBase64Url(p.message), "Wallet-Pass-Signature": p.signature })).status).toBe(200);
    const after = await postRaw(h, minted, body);
    expect(after.status).toBe(200);
    expect(after.headers.get("x-wallet-pass-repeat")).toBeNull();
    // The seller's old link, replayed inside the window, still answers with
    // the recorded success and runs nothing: the action already happened.
    const stale = await postRaw(h, links.feed!, body);
    expect(stale.status).toBe(200);
    expect(stale.headers.get("x-wallet-pass-repeat")).toBe("true");
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

  it("a repeat of a refused presentation is judged afresh and finds the nonce spent", async () => {
    const h = buildHarness();
    const { message } = await proofFor(h);
    const body = JSON.stringify({ message, signature: `0x${"ab".repeat(65)}` });
    const first = await postRaw(h, ACTION_PATH("levelUp"), body);
    expect(first.status).toBe(401);
    expect(((await first.json()) as { error: string }).error).toBe("signature_invalid");
    const again = await postRaw(h, ACTION_PATH("levelUp"), body);
    expect(again.status).toBe(401);
    expect(((await again.json()) as { error: string }).error).toBe("nonce_invalid");
    expect(again.headers.get("x-wallet-pass-repeat")).toBeNull();
  });
});
