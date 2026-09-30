import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { kvStores, memoryKv, memoryStores, type IssuerStores, type KeyValueStore, type NonceRecord } from "@erc8426/issuer";

import { buildHarness, createClock, issuePassTo, newSigner, TOKEN_ID } from "./helpers.js";

const record = (): NonceRecord => ({ account: getAddress(newSigner().address), tokenId: "1", action: "acquire", expiresAt: 0 });

/// A fake remote KV whose every call yields to the event loop, so racing
///  callers genuinely interleave. `getDel` is atomic, as Redis GETDEL is.
function asyncKv(): KeyValueStore & { calls: string[] } {
  const inner = memoryKv();
  const calls: string[] = [];
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    calls,
    async get(k) {
      calls.push(`get ${k}`);
      await tick();
      return inner.get(k);
    },
    async set(k, v, o) {
      calls.push(`set ${k} ${JSON.stringify(o ?? {})}`);
      await tick();
      return inner.set(k, v, o);
    },
    async getDel(k) {
      calls.push(`getDel ${k}`);
      const v = await inner.getDel(k);
      await tick();
      return v;
    },
    async del(k) {
      calls.push(`del ${k}`);
      await tick();
      return inner.del(k);
    },
  };
}

function nonceSuite(name: string, make: (now: () => number) => IssuerStores) {
  describe(`${name} nonce store`, () => {
    it("consumes a nonce at most once", async () => {
      const s = make(Date.now);
      const r = record();
      await s.nonces.issue("n1", r, 60);
      expect(await s.nonces.consume("n1")).toEqual(r);
      expect(await s.nonces.consume("n1")).toBeNull();
    });

    it("of concurrent presentations of one nonce, exactly one succeeds", async () => {
      const s = make(Date.now);
      await s.nonces.issue("n2", record(), 60);
      const results = await Promise.all(Array.from({ length: 10 }, () => s.nonces.consume("n2")));
      expect(results.filter((r) => r !== null)).toHaveLength(1);
    });

    it("forgets a nonce after its retention", async () => {
      const clock = createClock();
      const s = make(clock.now);
      await s.nonces.issue("n3", record(), 60);
      clock.advance(61_000);
      expect(await s.nonces.consume("n3")).toBeNull();
    });

    it("never knew a nonce it did not issue", async () => {
      expect(await make(Date.now).nonces.consume("never")).toBeNull();
    });
  });
}

nonceSuite("memory", (now) => memoryStores({ now }));
nonceSuite("kv", (now) => kvStores(memoryKv({ now })));

describe("kvStores", () => {
  it("consumes nonces with one atomic getDel, never a get then del", async () => {
    const kv = asyncKv();
    const s = kvStores(kv);
    await s.nonces.issue("n", record(), 600);
    await s.nonces.consume("n");
    expect(kv.calls).toEqual([`set erc8426:nonce:n {"ttlSeconds":600,"onlyIfAbsent":true}`, "getDel erc8426:nonce:n"]);
  });

  it("stays single-use across interleaving callers on a remote store", async () => {
    const s = kvStores(asyncKv());
    await s.nonces.issue("n", record(), 60);
    const results = await Promise.all(Array.from({ length: 8 }, () => s.nonces.consume("n")));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("refuses to overwrite a live nonce", async () => {
    const s = kvStores(memoryKv());
    await s.nonces.issue("dup", record(), 60);
    await expect(s.nonces.issue("dup", record(), 60)).rejects.toThrow(/collision/);
  });

  it("round trips pass records and link bindings under the prefix", async () => {
    const kv = memoryKv();
    const s = kvStores(kv, { prefix: "col1:" });
    await s.passes.put({ tokenId: "7", serial: "s", generation: 2, lastIssuedTo: null, links: { feed: "t" }, downloads: {}, updatedAt: 1, rotatedAt: 1 });
    expect((await s.passes.get("7"))!.links).toEqual({ feed: "t" });
    await s.links.put("t", { kind: "action", tokenId: "7", name: "feed", generation: 2 });
    expect(await kv.get("col1:link:t")).not.toBeNull();
    await s.links.delete(["t"]);
    expect(await s.links.get("t")).toBeNull();
  });

  it("drives a full issuer: claim, capability link, rotation", async () => {
    const h = buildHarness({ stores: kvStores(asyncKv()) });
    const owner = newSigner();
    const links = await issuePassTo(h, owner);
    expect((await h.post(links.feed!)).status).toBe(200);
    await h.issuer.onTransfer(TOKEN_ID, owner.address, newSigner().address);
    expect((await h.post(links.feed!)).status).toBe(404);
  });
});

describe("memoryKv", () => {
  it("honours onlyIfAbsent and TTL", async () => {
    const clock = createClock();
    const kv = memoryKv({ now: clock.now });
    expect(await kv.set("k", "a", { ttlSeconds: 1, onlyIfAbsent: true })).toBe(true);
    expect(await kv.set("k", "b", { onlyIfAbsent: true })).toBe(false);
    clock.advance(1_000);
    expect(await kv.get("k")).toBeNull();
    expect(await kv.set("k", "c", { onlyIfAbsent: true })).toBe(true);
    expect(await kv.getDel("k")).toBe("c");
    expect(await kv.getDel("k")).toBeNull();
  });
});

describe("pass records", () => {
  it("resolve a link only while the record lists it as current", async () => {
    const h = buildHarness();
    const links = await issuePassTo(h, newSigner());
    const token = links.feed!.split("/").pop()!;
    // Simulate a lost race: the binding survives but the record moved on.
    const rec = (await h.issuer.stores.passes.get(TOKEN_ID))!;
    await h.issuer.stores.passes.put({ ...rec, links: { ...rec.links, feed: "somethingelse" } });
    expect(await h.issuer.stores.links.get(token)).not.toBeNull();
    expect((await h.post(links.feed!)).status).toBe(404);
  });
});
