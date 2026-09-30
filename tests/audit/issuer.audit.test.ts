import { describe, expect, it } from "vitest";
import { ContractFunctionRevertedError, getAddress, type Address } from "viem";
import { erc721Abi } from "@erc8426/core";
import { delegateRegistry, publicClientChainReader, rental4907, toFetchRequest } from "@erc8426/issuer";

import {
  BASE,
  CONTRACT,
  TOKEN_ID,
  buildHarness,
  claim,
  issuePassTo,
  newSigner,
  signChallenge,
} from "../../packages/issuer/test/helpers.js";

const ROTATE = `/wallet-pass/${TOKEN_ID}/rotate`;

describe("AUDIT issuer: rotate route", () => {
  it("a rotate proof MUST NOT resolve the manifest (Gated acquisition)", async () => {
    const h = buildHarness();
    const owner = newSigner();
    await issuePassTo(h, owner);
    const p = await signChallenge(h, owner, TOKEN_ID, "rotate");
    const res = await h.post(ROTATE, p);
    const body = (await res.json()) as Record<string, unknown>;
    // The spec: "a proof for any other action MUST NOT resolve the manifest".
    expect(body.formats).toBeUndefined();
  });

  it("an owner excluded by an exclusive rental cannot take the pass back through the rotate route", async () => {
    // The rental covers acquire and the pass actions, not rotate: a documented
    // knob ("Uncovered actions fall back to the owner alone").
    const h = buildHarness({ entitlement: rental4907({ actions: ["acquire", "feed", "water", "levelUp"] }) });
    const owner = newSigner();
    const renter = newSigner();
    h.chain.setOwner(TOKEN_ID, owner.address);
    h.chain.setUser(TOKEN_ID, renter.address, BigInt(Math.floor(h.clock.now() / 1000) + 86_400));

    expect((await claim(h, renter)).res.status).toBe(200);
    // Acquire is exclusive to the renter: the owner is refused.
    expect((await claim(h, owner)).res.status).toBe(403);

    // But a rotate proof hands the owner the acquisition URLs anyway, and
    // makes the owner the holder of record, superseding the renter's pass.
    const p = await signChallenge(h, owner, TOKEN_ID, "rotate");
    const res = await h.post(ROTATE, p);
    const body = (await res.json()) as Record<string, unknown>;
    const record = await h.issuer.stores.passes.get(TOKEN_ID);
    expect({ formats: body.formats, lastIssuedTo: record?.lastIssuedTo }).toEqual({ formats: undefined, lastIssuedTo: renter.address });
  });
});

describe("AUDIT issuer: request body limits", () => {
  it("readBody stops reading an unauthenticated body past MAX_BODY_BYTES (64 KiB)", async () => {
    const h = buildHarness();
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const TOTAL = 16 * 1024 * 1024;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulled >= TOTAL) return c.close();
        pulled += chunk.length;
        c.enqueue(chunk);
      },
    });
    // No Content-Length (chunked), no proof: an anonymous request.
    const req = new Request(`${BASE}/wallet-pass/${TOKEN_ID}/actions/levelUp`, {
      method: "POST",
      body: stream,
      headers: { "Content-Type": "application/json" },
      duplex: "half",
    } as RequestInit);
    const res = await h.issuer.handler(req);
    expect(res.status).toBe(400);
    expect(pulled).toBeLessThanOrEqual(256 * 1024);
  });

  it("toFetchRequest (Node/Express adapter) buffers the whole body with no cap", async () => {
    let pulled = 0;
    const TOTAL = 16 * 1024 * 1024;
    const chunk = new Uint8Array(64 * 1024);
    const req = {
      method: "POST",
      url: `/wallet-pass/${TOKEN_ID}/actions/levelUp`,
      headers: { "content-type": "application/json" },
      async *[Symbol.asyncIterator]() {
        while (pulled < TOTAL) {
          pulled += chunk.length;
          yield chunk;
        }
      },
    };
    await toFetchRequest(req);
    expect(pulled).toBeLessThanOrEqual(256 * 1024);
  });
});

describe("AUDIT issuer: default in-memory nonce store", () => {
  it("unconsumed nonces are never evicted, so anonymous GET /challenge grows memory without bound", async () => {
    const maps = new Set<Map<unknown, unknown>>();
    const originalSet = Map.prototype.set;
    Map.prototype.set = function (this: Map<unknown, unknown>, k: unknown, v: unknown) {
      maps.add(this);
      return originalSet.call(this, k, v);
    };
    let h: ReturnType<typeof buildHarness>;
    try {
      h = buildHarness();
      const anyone = newSigner().address;
      for (let i = 0; i < 3000; i++) {
        const res = await h.get(`/wallet-pass/${TOKEN_ID}/challenge?address=${anyone}`);
        expect(res.status).toBe(200);
      }
      // A day later, far past nonceTtlSeconds (600), plus one more request that
      // would give any sweep a chance to run.
      h.clock.advance(86_400_000);
      await h.get(`/wallet-pass/${TOKEN_ID}/challenge?address=${anyone}`);
    } finally {
      Map.prototype.set = originalSet;
    }
    const largest = Math.max(...[...maps].map((m) => m.size));
    expect(largest).toBeLessThan(100);
  });
});

describe("AUDIT issuer: additive delegation", () => {
  it("a delegate's acquire does not void the owner's pass and links (delegation is additive by intent)", async () => {
    const h = buildHarness({ entitlement: delegateRegistry() });
    const owner = newSigner();
    const delegate = newSigner();
    const links = await issuePassTo(h, owner);
    h.chain.delegate(owner.address, delegate.address);
    expect((await claim(h, delegate)).res.status).toBe(200);
    // The owner is still entitled, yet the owner's links are dead and the
    // owner's installed pass was pushed as voided.
    const res = await h.post(links.feed!);
    const voidedForOwner = h.notified.some((n) => n.ctx.owner === owner.address && n.ctx.content.voided === true);
    expect({ status: res.status, voidedForOwner }).toEqual({ status: 200, voidedForOwner: false });
  });
});

describe("AUDIT issuer: a revert other than nonexistence is read as a burn", () => {
  it("onPassUpdate voids the pass when ownerOf reverts for a paused contract", async () => {
    const owner = newSigner();
    let paused = false;
    const client = {
      async readContract(p: { functionName: string }) {
        if (p.functionName !== "ownerOf") throw new Error("unexpected");
        if (paused) {
          throw new ContractFunctionRevertedError({ abi: erc721Abi, functionName: "ownerOf", message: "EnforcedPause()" });
        }
        return owner.address as Address;
      },
    };
    const chain = publicClientChainReader(client);
    const h = buildHarness({ chain });
    // issuePassTo sets the FakeChain owner, which this issuer does not read.
    const { res } = await claim(h, owner);
    expect(res.status).toBe(200);
    expect(getAddress((await h.issuer.stores.passes.get(TOKEN_ID))!.lastIssuedTo!)).toBe(owner.address);

    paused = true;
    // A read that could not be answered about ownership should be retryable,
    // not a destructive verdict.
    let summary: unknown;
    try {
      summary = await h.issuer.onPassUpdate(TOKEN_ID);
    } catch (e) {
      summary = (e as Error).name;
    }
    expect(summary).toBe("IssuerError");
    void CONTRACT;
  });
});
