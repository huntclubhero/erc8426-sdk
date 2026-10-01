import { describe, expect, it } from "vitest";
import { ContractFunctionRevertedError, createPublicClient, custom, encodeErrorResult, getAddress, type Address, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { erc721Abi } from "@erc8426/core";
import {
  MAX_BODY_BYTES,
  delegateRegistry,
  memoryStores,
  publicClientChainReader,
  rental4907,
  toFetchRequest,
} from "@erc8426/issuer";

import { BASE, TOKEN_ID, buildHarness, claim, issuePassTo, newSigner, signChallenge } from "./helpers.js";

const ROTATE = `/wallet-pass/${TOKEN_ID}/rotate`;

/// Regressions for the TypeScript audit's issuer findings. Each asserts the
///  secure behavior the finding asked for.

describe("rotate route (audit 1 and 3)", () => {
  it("a rotate proof MUST NOT resolve the manifest", async () => {
    const h = buildHarness();
    const owner = newSigner();
    await issuePassTo(h, owner);
    const res = await h.post(ROTATE, await signChallenge(h, owner, TOKEN_ID, "rotate"));
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toEqual({ ok: true, rotated: true });
  });

  it("an owner excluded by an exclusive rental cannot take the pass back through rotate", async () => {
    const h = buildHarness({ entitlement: rental4907({ actions: ["acquire", "feed", "water", "levelUp"] }) });
    const owner = newSigner();
    const renter = newSigner();
    h.chain.setOwner(TOKEN_ID, owner.address);
    h.chain.setUser(TOKEN_ID, renter.address, BigInt(Math.floor(h.clock.now() / 1000) + 86_400));
    expect((await claim(h, renter)).res.status).toBe(200);
    expect((await claim(h, owner)).res.status).toBe(403);
    const res = await h.post(ROTATE, await signChallenge(h, owner, TOKEN_ID, "rotate"));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.formats).toBeUndefined();
    expect((await h.issuer.stores.passes.get(TOKEN_ID))!.lastIssuedTo).toBe(renter.address);
  });

  it("owner-requested rotation voids the old serial so leaked copies never get the fresh links", async () => {
    const h = buildHarness();
    const owner = newSigner();
    await issuePassTo(h, owner);
    const leakedSerial = (await h.issuer.stores.passes.get(TOKEN_ID))!.serial;
    h.notified.length = 0;
    expect((await h.post(ROTATE, await signChallenge(h, owner, TOKEN_ID, "rotate"))).status).toBe(200);
    const fresh = (await h.issuer.capabilityLinksFor(TOKEN_ID)).feed!;
    const toLeaked = h.notified.filter((n) => n.ctx.content.serial === leakedSerial);
    expect(toLeaked.length).toBeGreaterThan(0);
    for (const n of toLeaked) expect(n.ctx.content).toMatchObject({ voided: true, links: [], supersededReason: "reset" });
    expect(JSON.stringify(h.notified)).not.toContain(fresh);
  });
});

describe("request body limits (audit 5)", () => {
  it("the handler stops reading an unauthenticated chunked body past MAX_BODY_BYTES", async () => {
    const h = buildHarness();
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulled >= 16 * 1024 * 1024) return c.close();
        pulled += chunk.length;
        c.enqueue(chunk);
      },
    });
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

  it("the Node adapter buffers at most MAX_BODY_BYTES + 1, which the handler refuses", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const req = {
      method: "POST",
      url: `/wallet-pass/${TOKEN_ID}/actions/levelUp`,
      headers: { "content-type": "application/json" },
      async *[Symbol.asyncIterator]() {
        while (pulled < 16 * 1024 * 1024) {
          pulled += chunk.length;
          yield chunk;
        }
      },
    };
    const request = await toFetchRequest(req);
    expect(pulled).toBeLessThanOrEqual(256 * 1024);
    expect((await request.arrayBuffer()).byteLength).toBe(MAX_BODY_BYTES + 1);
    const h = buildHarness();
    expect((await h.issuer.handler(await toFetchRequest({ ...req, [Symbol.asyncIterator]: req[Symbol.asyncIterator] }))).status).toBe(400);
  });

  it("refuses an oversized proof header and an absurdly long token id before parsing them", async () => {
    const h = buildHarness();
    const big = await h.get(`/wallet-pass/${TOKEN_ID}`, { "X-Wallet-Pass-Proof": "A".repeat(20_000), "X-Wallet-Pass-Signature": "0x00" });
    expect(big.status).toBe(400);
    expect((await h.get(`/wallet-pass/${"9".repeat(5000)}`)).status).toBe(400);
  });
});

describe("in-memory nonce store (audit 6)", () => {
  it("sweeps unconsumed nonces once their retention passes", async () => {
    const h = buildHarness();
    const anyone = newSigner().address;
    for (let i = 0; i < 500; i++) await h.get(`/wallet-pass/${TOKEN_ID}/challenge?address=${anyone}`);
    h.clock.advance(86_400_000);
    // The next issue sweeps; the expired 500 are gone, a new one is live.
    const res = await h.get(`/wallet-pass/${TOKEN_ID}/challenge?address=${anyone}`);
    const { nonce } = (await res.json()) as { nonce: string };
    expect(await h.issuer.stores.nonces.consume(nonce)).not.toBeNull();
  });

  it("is capped: past maxNonces the oldest pending nonce is dropped", async () => {
    const t = 0;
    const s = memoryStores({ now: () => t, maxNonces: 3 });
    const rec = { account: getAddress(newSigner().address), tokenId: "1", action: "acquire", expiresAt: 0 };
    for (const n of ["a", "b", "c", "d"]) await s.nonces.issue(n, rec, 600);
    expect(await s.nonces.consume("a")).toBeNull();
    expect(await s.nonces.consume("d")).not.toBeNull();
  });
});

describe("additive delegation (audit 7)", () => {
  it("a delegate's acquire shares the owner's pass instead of voiding it", async () => {
    const h = buildHarness({ entitlement: delegateRegistry() });
    const owner = newSigner();
    const delegate = newSigner();
    const links = await issuePassTo(h, owner);
    h.chain.delegate(owner.address, delegate.address);
    const d = await claim(h, delegate);
    expect(d.res.status).toBe(200);
    expect((await h.post(links.feed!)).status).toBe(200);
    expect(h.notified.some((n) => n.ctx.owner === owner.address && n.ctx.content.voided === true)).toBe(false);
    expect((await h.issuer.stores.passes.get(TOKEN_ID))!.lastIssuedTo).toBe(owner.address);
  });

  it("once the holder of record is no longer entitled, the next claim rotates as before", async () => {
    const h = buildHarness({ entitlement: delegateRegistry() });
    const seller = newSigner();
    const buyer = newSigner();
    const links = await issuePassTo(h, seller);
    h.chain.setOwner(TOKEN_ID, buyer.address);
    expect((await claim(h, buyer)).res.status).toBe(200);
    expect((await h.post(links.feed!)).status).toBe(404);
  });
});

describe("only a nonexistent-token revert is a burn (audit 8)", () => {
  function readerOver(answer: () => Address | { revert: Hex }) {
    const client = createPublicClient({
      chain: mainnet,
      transport: custom(
        {
          async request({ method }: { method: string }) {
            if (method !== "eth_call") throw new Error(`unexpected ${method}`);
            const a = answer();
            if (typeof a === "object") throw Object.assign(new Error("execution reverted"), { code: 3, data: a.revert });
            return `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
          },
        },
        { retryCount: 0 },
      ),
    });
    return publicClientChainReader(client);
  }
  const token = { chainId: 1, contract: getAddress("0x5F9B5a1cdED9d6B3f5E8a2C47B0e13d6A8F4c2e1"), tokenId: "412" };
  const errorAbi = (name: string, inputs: { name: string; type: string }[] = []) => [{ type: "error", name, inputs }] as const;

  it("ERC721NonexistentToken reads as no owner", async () => {
    const revert = encodeErrorResult({ abi: errorAbi("ERC721NonexistentToken", [{ name: "tokenId", type: "uint256" }]), errorName: "ERC721NonexistentToken", args: [412n] });
    expect(await readerOver(() => ({ revert })).ownerOf(token)).toBeNull();
  });

  it("the OpenZeppelin 4 revert string reads as no owner", async () => {
    const revert = encodeErrorResult({
      abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }],
      errorName: "Error",
      args: ["ERC721: invalid token ID"],
    });
    expect(await readerOver(() => ({ revert })).ownerOf(token)).toBeNull();
  });

  it("any other revert (a paused contract) is a failed read, not a burn", async () => {
    const revert = encodeErrorResult({ abi: errorAbi("EnforcedPause"), errorName: "EnforcedPause" });
    await expect(readerOver(() => ({ revert })).ownerOf(token)).rejects.toThrow();
  });

  it("onPassUpdate for a paused contract throws read_failed and voids nothing", async () => {
    const owner = newSigner();
    let paused = false;
    const client = {
      async readContract(p: { functionName: string }) {
        if (p.functionName !== "ownerOf") throw new Error("unexpected");
        if (paused) throw new ContractFunctionRevertedError({ abi: erc721Abi, functionName: "ownerOf", message: "EnforcedPause()" });
        return owner.address as Address;
      },
    };
    const h = buildHarness({ chain: publicClientChainReader(client) });
    expect((await claim(h, owner)).res.status).toBe(200);
    paused = true;
    h.notified.length = 0;
    const err = await h.issuer.onPassUpdate(TOKEN_ID).catch((e: unknown) => e);
    expect((err as Error).name).toBe("IssuerError");
    expect(h.notified).toHaveLength(0);
    expect((await h.issuer.stores.passes.get(TOKEN_ID))!.lastIssuedTo).toBe(owner.address);
  });
});
