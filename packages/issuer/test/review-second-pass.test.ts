import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { TokenRef } from "@erc8426/core";
import { publicClientChainReader, rental4907, type CreateIssuerOptions, type PassRecord } from "@erc8426/issuer";

import { FakeChain, TOKEN_ID, buildHarness, claim, newSigner, type Harness } from "./helpers.js";

/// Findings of an independent review of the change that made the issuer's
///  own read the moment a loss is observed. Each test is written as the
///  behaviour that should hold, and each failed before its fix.

/// An ERC-721 chain with its history: who owned and who rented from which
/// block. `lagHead`, when set, is a node that is behind: it names that block
/// as the head, answers `latest` from it, tells the truth about the blocks it
/// has, and cannot answer for a later one.
class History721 extends FakeChain {
  private ownerSteps: { from: bigint; owner: Address | null }[] = [];
  private userSteps: { from: bigint; user: Address | null }[] = [];
  head = 100n;
  lagHead: bigint | null = null;
  ownerFrom(block: bigint, owner: Address | null): void {
    this.ownerSteps.push({ from: block, owner });
  }
  userFrom(block: bigint, user: Address | null): void {
    this.userSteps.push({ from: block, user });
  }
  private tip(): bigint {
    return this.lagHead ?? this.head;
  }
  private block(blockNumber: bigint | undefined): bigint {
    this.reads++;
    const b = blockNumber ?? this.tip();
    if (b > this.tip()) throw new Error("header not found");
    return b;
  }
  blockNumber = async (): Promise<bigint> => this.tip();
  override async ownerOf(_token: TokenRef, blockNumber?: bigint): Promise<Address | null> {
    const b = this.block(blockNumber);
    let owner: Address | null = null;
    for (const s of this.ownerSteps) if (s.from <= b) owner = s.owner;
    return owner;
  }
  override async userOf(_token: TokenRef, blockNumber?: bigint): Promise<{ user: Address | null; expires: bigint }> {
    const b = this.block(blockNumber);
    let user: Address | null = null;
    for (const s of this.userSteps) if (s.from <= b) user = s.user;
    return { user, expires: 0n };
  }
}

type H = Harness & { chain: History721 };

function hist(overrides: Partial<CreateIssuerOptions> = {}): H {
  const chain = new History721();
  return { ...buildHarness({ chain, ...overrides }), chain };
}

const rec = (h: Harness): Promise<PassRecord | null> => h.issuer.stores.passes.get(TOKEN_ID);
const voidedSince = (h: Harness, from: number) => h.notified.slice(from).filter((n) => n.ctx.content.voided);

describe("second pass: a lagging node and the ERC-721 claim paths", () => {
  it("a claim by another account, admitted at a head behind the block the pass is dated with, does not take the pass", async () => {
    const h = hist();
    const seller = newSigner();
    const buyer = newSigner();
    h.chain.ownerFrom(1n, seller.address);
    h.chain.ownerFrom(100n, buyer.address);
    expect((await claim(h, buyer)).res.status).toBe(200);
    const mine = (await rec(h))!;
    expect(mine.issuedAtBlock).toBe("100");
    const pushes = h.notified.length;
    // The seller claims, answered by a node one block behind the sale.
    h.chain.lagHead = 99n;
    const stale = await claim(h, seller);
    h.chain.lagHead = null;
    expect(stale.res.status).toBe(503);
    expect(voidedSince(h, pushes)).toEqual([]);
    expect((await rec(h))!.serial).toBe(mine.serial);
    expect((await rec(h))!.lastIssuedTo).toBe(buyer.address);
    // A real sale, read at a later block, still moves the pass.
    h.chain.ownerFrom(101n, seller.address);
    h.chain.head = 101n;
    expect((await claim(h, seller)).res.status).toBe(200);
    expect((await rec(h))!.lastIssuedTo).toBe(seller.address);
  });

  it("the holder's own later claim moves the block a loss is tested against", async () => {
    const h = hist({ entitlement: rental4907() });
    const house = newSigner();
    const guest = newSigner();
    h.chain.ownerFrom(1n, house.address);
    h.chain.userFrom(100n, guest.address);
    expect((await claim(h, guest)).res.status).toBe(200);
    // The rental ends at 150 and nothing reads. The same account rents at
    // 152 and claims at 153: the same record, the same card.
    h.chain.userFrom(150n, null);
    h.chain.userFrom(152n, guest.address);
    h.chain.head = 153n;
    const again = await claim(h, guest);
    expect(again.res.status).toBe(200);
    const serial = (await rec(h))!.serial;
    // A node at 151, inside the gap, answers a download.
    h.chain.lagHead = 151n;
    expect((await h.get(new URL(again.body.formats.apple).pathname)).status).toBe(403);
    h.chain.lagHead = null;
    expect((await rec(h))!.serial).toBe(serial);
    expect((await rec(h))!.lastIssuedTo).toBe(guest.address);
  });

  it("a pass issued before passes were dated is not retired by one refused request, and its holder's next claim dates it", async () => {
    const h = hist();
    const owner = newSigner();
    h.chain.ownerFrom(100n, owner.address);
    const first = await claim(h, owner);
    const download = new URL(first.body.formats.apple).pathname;
    // As an earlier version stored it: no block.
    const legacy = (await rec(h))!;
    delete legacy.issuedAtBlock;
    await h.issuer.stores.passes.put(legacy);
    h.chain.lagHead = 99n;
    expect((await h.get(download)).status).toBe(403);
    h.chain.lagHead = null;
    expect((await rec(h))!.lastIssuedTo).toBe(owner.address);
    expect((await h.get(download)).status).toBe(200);
    // The holder claims again: from here the pass has a block to test against.
    expect((await claim(h, owner)).res.status).toBe(200);
    h.chain.lagHead = 99n;
    await h.issuer.onPassUpdate(TOKEN_ID).catch(() => undefined);
    h.chain.lagHead = null;
    expect((await rec(h))!.lastIssuedTo).toBe(owner.address);
    // A real sale read at a later block is acted on.
    h.chain.ownerFrom(101n, newSigner().address);
    h.chain.head = 101n;
    expect((await h.get(download)).status).toBe(403);
    expect((await rec(h))!.lastIssuedTo).toBeNull();
  });

  it("public mode: a pass is dated, and a lagging node does not void it on a download", async () => {
    const h = hist({ mode: "public" });
    const seller = newSigner();
    const buyer = newSigner();
    h.chain.ownerFrom(1n, seller.address);
    h.chain.ownerFrom(100n, buyer.address);
    const body = (await (await h.get(`/wallet-pass/${TOKEN_ID}`)).json()) as { formats: { apple: string } };
    expect((await rec(h))!.issuedAtBlock).toBe("100");
    const pushes = h.notified.length;
    h.chain.lagHead = 99n;
    expect((await h.get(new URL(body.formats.apple).pathname)).status).toBe(403);
    h.chain.lagHead = null;
    expect(voidedSince(h, pushes)).toEqual([]);
    expect((await rec(h))!.lastIssuedTo).toBe(buyer.address);
  });

  it("the read of the previous holder at the admitted block is tried again like the admitting read", async () => {
    const h = hist();
    const seller = newSigner();
    const buyer = newSigner();
    h.chain.ownerFrom(1n, seller.address);
    expect((await claim(h, seller)).res.status).toBe(200);
    h.chain.ownerFrom(101n, buyer.address);
    h.chain.head = 101n;
    // The second read taken at block 101 reaches a node that lacks it, once.
    const real = h.chain.ownerOf.bind(h.chain);
    let atBlock = 0;
    h.chain.ownerOf = async (token: TokenRef, blockNumber?: bigint) => {
      if (blockNumber !== undefined && ++atBlock === 2) throw new Error("header not found");
      return real(token, blockNumber);
    };
    expect((await claim(h, buyer)).res.status).toBe(200);
    expect((await rec(h))!.lastIssuedTo).toBe(buyer.address);
  });
});

describe("second pass: what the fixes themselves got wrong", () => {
  it("public mode: a manifest request for an unchanged owner writes nothing, block after block", async () => {
    const h = hist({ mode: "public" });
    const owner = newSigner();
    h.chain.ownerFrom(1n, owner.address);
    expect((await h.get(`/wallet-pass/${TOKEN_ID}`)).status).toBe(200);
    const passes = h.issuer.stores.passes;
    const put = passes.put.bind(passes);
    let puts = 0;
    passes.put = async (record) => {
      puts++;
      return put(record);
    };
    for (let i = 1n; i <= 5n; i++) {
      h.chain.head = 100n + i;
      expect((await h.get(`/wallet-pass/${TOKEN_ID}`)).status).toBe(200);
    }
    expect(puts).toBe(0);
  });

  it("public mode: a pass with no block is dated by the next manifest request, once", async () => {
    const h = hist({ mode: "public" });
    const owner = newSigner();
    h.chain.ownerFrom(1n, owner.address);
    expect((await h.get(`/wallet-pass/${TOKEN_ID}`)).status).toBe(200);
    const legacy = (await rec(h))!;
    delete legacy.issuedAtBlock;
    await h.issuer.stores.passes.put(legacy);
    h.chain.head = 105n;
    expect((await h.get(`/wallet-pass/${TOKEN_ID}`)).status).toBe(200);
    const after = (await rec(h))!;
    expect(after.issuedAtBlock ?? after.heldAtBlock).toBe("105");
    h.chain.head = 110n;
    expect((await h.get(`/wallet-pass/${TOKEN_ID}`)).status).toBe(200);
    expect((await rec(h))!.heldAtBlock).toBe("105");
  });

  it("a claim read behind the block the pass is dated with says so, with both blocks, to the claimer and to onError", async () => {
    const h = hist();
    const seller = newSigner();
    const buyer = newSigner();
    // A chain that was reset under a kept store: the pass is dated 5000 and
    // the head is 40.
    h.chain.head = 5000n;
    h.chain.ownerFrom(1n, seller.address);
    expect((await claim(h, seller)).res.status).toBe(200);
    h.chain.ownerFrom(2n, buyer.address);
    h.chain.head = 40n;
    const refused = await claim(h, buyer);
    expect(refused.res.status).toBe(503);
    expect(String(refused.body.message)).toMatch(/block 40,/);
    expect(String(refused.body.message)).toMatch(/block 5000 /);
    expect(h.errors.map((e) => String((e as Error).message)).join(" ")).toMatch(/5000/);
  });
});

describe("second pass: an issuer that reads at safe or finalized", () => {
  it("keeps admitting claims at its own tag: the newest block does not decide", async () => {
    const seller = newSigner();
    const buyer = newSigner();
    let headOwner: Address = seller.address;
    const client = {
      async readContract(p: { blockNumber?: bigint; blockTag?: string }) {
        if (p.blockNumber !== undefined) return headOwner;
        if (p.blockTag === "finalized") return seller.address;
        throw new Error("unexpected tag");
      },
      async getBlockNumber() {
        return 100n;
      },
    };
    const h = buildHarness({ chain: publicClientChainReader(client, { blockTag: "finalized" }) });
    expect((await claim(h, seller)).res.status).toBe(200);
    // A sale in the newest block only: not final.
    headOwner = buyer.address;
    expect((await claim(h, buyer)).res.status).toBe(403);
    expect((await claim(h, seller)).res.status).toBe(200);
    expect((await rec(h))!.lastIssuedTo).toBe(seller.address);
  });

  it("a reader at latest still names its head", () => {
    const client = { readContract: async () => 0n, getBlockNumber: async () => 1n };
    expect(typeof publicClientChainReader(client).blockNumber).toBe("function");
    expect(publicClientChainReader(client, { blockTag: "safe" }).blockNumber).toBeUndefined();
  });
});

describe("second pass: ending a link does not write an old record back", () => {
  interface Poll {
    open: string | null;
    gate: Promise<void> | null;
    delay: number;
    failing: boolean;
  }
  function polled(): Harness & { poll: Poll } {
    const poll: Poll = { open: null, gate: null, delay: 0, failing: false };
    const h = buildHarness({
      actions: {
        "vote-yes": {
          description: "Vote yes",
          capability: true,
          bound: "One vote per proposal",
          subject: async () => {
            const open = poll.open;
            if (poll.failing) throw new Error("rpc unavailable");
            if (poll.gate) await poll.gate;
            if (poll.delay) await new Promise((r) => setTimeout(r, poll.delay));
            return open;
          },
          execute: () => ({ ok: true }),
        },
      },
    });
    return { ...h, poll };
  }
  const pathOf = (u: string | undefined) => new URL(u!).pathname;

  async function racing(h: Harness & { poll: Poll }) {
    const owner = newSigner();
    h.chain.setOwner(TOKEN_ID, owner.address);
    expect((await claim(h, owner)).res.status).toBe(200);
    h.poll.open = "5";
    await h.issuer.capabilityLinksFor(TOKEN_ID);
    const before = (await rec(h))!;
    // The subject changes, and a render is waiting on its answer.
    h.poll.open = "6";
    let release!: () => void;
    h.poll.gate = new Promise<void>((r) => (release = r));
    const render = h.issuer.capabilityLinksFor(TOKEN_ID);
    await new Promise((r) => setTimeout(r, 10));
    h.poll.gate = null;
    return { owner, before, render, release };
  }

  it("a rotation that lands while a render waits on the subject stands", async () => {
    const h = polled();
    const { before, render, release } = await racing(h);
    await h.issuer.rotate(TOKEN_ID);
    const rotated = (await rec(h))!;
    expect(rotated.serial).not.toBe(before.serial);
    release();
    await render;
    const after = (await rec(h))!;
    expect(after.serial).toBe(rotated.serial);
    expect(after.generation).toBe(rotated.generation);
  });

  it("a transfer that lands while a render waits on the subject stands", async () => {
    const h = polled();
    const { owner, render, release } = await racing(h);
    await h.issuer.onTransfer(TOKEN_ID, owner.address, newSigner().address);
    expect((await rec(h))!.lastIssuedTo).toBeNull();
    release();
    await render;
    expect((await rec(h))!.lastIssuedTo).toBeNull();
  });

  it("two renders at once give the same live link for one subject", async () => {
    const h = polled();
    const owner = newSigner();
    h.chain.setOwner(TOKEN_ID, owner.address);
    expect((await claim(h, owner)).res.status).toBe(200);
    h.poll.open = "5";
    h.poll.delay = 5;
    const [a, b] = await Promise.all([h.issuer.capabilityLinksFor(TOKEN_ID), h.issuer.capabilityLinksFor(TOKEN_ID)]);
    expect(a["vote-yes"]).toBe(b["vote-yes"]);
    h.poll.delay = 0;
    expect((await h.post(pathOf(a["vote-yes"]), { attempt: 1 })).status).toBe(200);
    expect((await h.post(pathOf(b["vote-yes"]), { attempt: 2 })).status).toBe(200);
  });

  it("a slow answer about the subject does not overwrite a newer one", async () => {
    const h = polled();
    const owner = newSigner();
    h.chain.setOwner(TOKEN_ID, owner.address);
    expect((await claim(h, owner)).res.status).toBe(200);
    h.poll.open = "5";
    await h.issuer.capabilityLinksFor(TOKEN_ID);
    // A render asks while "5" is open, and its answer is slow.
    let release!: () => void;
    h.poll.gate = new Promise<void>((r) => (release = r));
    const slow = h.issuer.capabilityLinksFor(TOKEN_ID);
    await new Promise((r) => setTimeout(r, 10));
    h.poll.gate = null;
    // "5" closes and "6" opens. A second render is asked for.
    h.poll.open = "6";
    // It waits its turn behind the first, so the answers are applied in the
    // order they were asked for.
    const fresh = h.issuer.capabilityLinksFor(TOKEN_ID);
    await new Promise((r) => setTimeout(r, 10));
    release();
    await slow;
    const links = await fresh;
    expect((await rec(h))!.linkSubjects).toEqual({ "vote-yes": "6" });
    expect((await h.post(pathOf(links["vote-yes"]), {})).status).toBe(200);
  });

  it("an answer about the subject that never comes is given up, and does not hold the pass", async () => {
    let hang = false;
    const h = buildHarness({
      capability: { enabled: true, subjectTimeoutMs: 40 },
      actions: {
        "vote-yes": {
          description: "Vote yes",
          capability: true,
          bound: "One vote per proposal",
          subject: () => (hang ? new Promise<string>(() => undefined) : "5"),
          execute: () => ({ ok: true }),
        },
      },
    });
    const owner = newSigner();
    h.chain.setOwner(TOKEN_ID, owner.address);
    expect((await claim(h, owner)).res.status).toBe(200);
    const link = pathOf((await h.issuer.capabilityLinksFor(TOKEN_ID))["vote-yes"]);
    hang = true;
    // Untold, like a throw: the render leaves the link out, a use answers 503.
    expect((await h.issuer.capabilityLinksFor(TOKEN_ID))["vote-yes"]).toBeUndefined();
    expect((await h.post(link, {})).status).toBe(503);
    hang = false;
    // Nothing is held: the next request is served, and the link is the same.
    expect(pathOf((await h.issuer.capabilityLinksFor(TOKEN_ID))["vote-yes"])).toBe(link);
    expect((await h.post(link, {})).status).toBe(200);
    expect((await claim(h, owner)).res.status).toBe(200);
  });

  it("a link whose subject closed stays ended when the subject cannot be told at that moment", async () => {
    const h = polled();
    const owner = newSigner();
    h.chain.setOwner(TOKEN_ID, owner.address);
    expect((await claim(h, owner)).res.status).toBe(200);
    h.poll.open = "5";
    const link = pathOf((await h.issuer.capabilityLinksFor(TOKEN_ID))["vote-yes"]);
    h.poll.open = "6";
    // The subject is asked once per tap: a failure answers 503 and ends nothing.
    h.poll.failing = true;
    expect((await h.post(link, {})).status).toBe(503);
    h.poll.failing = false;
    expect((await h.post(link, {})).status).toBe(404);
    // The first subject opening again does not wake the link.
    h.poll.open = "5";
    expect((await h.post(link, {})).status).toBe(404);
  });
});
