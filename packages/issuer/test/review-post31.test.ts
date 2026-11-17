import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { TokenRef } from "@erc8426/core";
import { watchTransfers, type ActionContext, type CreateIssuerOptions, type PassRecord, type WatchEventClient } from "@erc8426/issuer";

import { FakeChain, TOKEN_ID, buildHarness, claim, newSigner, type Harness } from "./helpers.js";

/// From a review of 0.5.2 (Magicians t/29358 post 31). Each test is written
///  as the behaviour that should hold, and each of the first kind failed on
///  0.5.2 (the link tests in the shape they had before `subjectClosed`).

const ID = "77";

/// A provider that answers from two nodes (as in review-post29.test.ts).
class TwoNodes extends FakeChain {
  private history = new Map<string, { from: bigint; balance: bigint }[]>();
  fresh = 100n;
  lagging = 98n;
  latestFrom: "fresh" | "lagging" = "fresh";
  headFrom: "fresh" | "lagging" = "fresh";
  private key = (id: string, account: string) => `${id}:${account.toLowerCase()}`;
  setBalanceFrom(block: bigint, id: string, account: Address, balance: bigint): void {
    const k = this.key(id, account);
    this.history.set(k, [...(this.history.get(k) ?? []), { from: block, balance }]);
  }
  private at(block: bigint, id: string, account: Address): bigint {
    let balance = 0n;
    for (const step of this.history.get(this.key(id, account)) ?? []) if (step.from <= block) balance = step.balance;
    return balance;
  }
  blockNumber = async (): Promise<bigint> => this[this.headFrom];
  async balanceOf(token: TokenRef, account: Address, blockNumber?: bigint): Promise<bigint> {
    this.reads++;
    if (blockNumber === undefined) return this.at(this[this.latestFrom], token.tokenId, account);
    if (blockNumber > this[this.headFrom]) throw new Error("header not found");
    return this.at(blockNumber, token.tokenId, account);
  }
  override async ownerOf(): Promise<Address | null> {
    throw new Error("ownerOf must never be read under the ERC-1155 binding");
  }
}

type H = Harness & { chain: TwoNodes };

function harness1155(overrides: Partial<CreateIssuerOptions> = {}): H {
  const chain = new TwoNodes();
  const h = buildHarness({
    standard: "erc1155",
    chain,
    render: (ctx) => ({ serial: ctx.serial, organizationName: "Example", description: ctx.dark ? "dark" : "live", title: "Member", links: [] }),
    ...overrides,
  });
  return { ...h, chain };
}

const signedOnly = (): H =>
  harness1155({ actions: { levelUp: { description: "Level up", execute: () => ({ ok: true }) } }, capability: { enabled: false } });

const recordOf = (h: H, account: Address): Promise<PassRecord | null> => h.issuer.stores.passes.get(`${ID}:${account.toLowerCase()}`);

/// Alice holds from block 100 on and claims with every node at 100. The
/// stored record is then rewritten as an earlier version left it, and a
/// download reaches a node at 99, where she held nothing yet.
async function storedThenLaggingDownload(h: H, rewrite: (record: PassRecord) => void) {
  const alice = newSigner();
  h.chain.setBalanceFrom(100n, ID, alice.address, 1n);
  h.chain.lagging = 100n;
  const first = await claim(h, alice, ID);
  expect(first.res.status).toBe(200);
  const stored = (await recordOf(h, alice.address))!;
  rewrite(stored);
  await h.issuer.stores.passes.put(stored);
  const serial = stored.serial;
  const download = new URL(first.body.formats.apple).pathname;
  h.chain.lagging = 99n;
  h.chain.latestFrom = "lagging";
  h.chain.headFrom = "lagging";
  expect((await h.get(download)).status).toBe(403);
  // Every node has caught up. Alice held throughout.
  h.chain.fresh = 105n;
  h.chain.lagging = 105n;
  h.chain.latestFrom = "fresh";
  h.chain.headFrom = "fresh";
  const record = (await recordOf(h, alice.address))!;
  expect(record.dark, "the pass went dark").toBeUndefined();
  expect(record.lastIssuedTo, "the pass was retired").toBe(alice.address);
  expect(record.serial).toBe(serial);
  expect((await h.get(download)).status).toBe(200);
}

describe("post 31, stored passes (ERC-1155)", () => {
  it("an undated pass (as 0.5.1 issued when the dating read reached a lagging node) is not lost on one read at a refused request", async () => {
    for (const make of [signedOnly, harness1155]) {
      await storedThenLaggingDownload(make(), (record) => {
        delete record.issuedAtBlock;
        delete record.heldAtBlock;
        delete record.datedByRead;
      });
    }
  });

  it("a block stored by 0.5.0 (a head no read was taken at, here behind the block the unit arrived in) is not tested as if a read was taken at it", async () => {
    for (const make of [signedOnly, harness1155]) {
      await storedThenLaggingDownload(make(), (record) => {
        // 0.5.0: admitted by a read at `latest` (a node at 100), then dated
        // with a head fetched afterwards from a node at 98.
        record.issuedAtBlock = "98";
        delete record.heldAtBlock;
        delete record.datedByRead;
      });
    }
  });
});

/// Proposals as a chain holds them, read through a node that can be behind.
/// `opened` is the number of proposals that exist and `closed` the ones whose
/// close has passed. `behind`, when set, is what a lagging node knows: fewer
/// proposals, and its own idea of which have closed. Asked about a proposal
/// it has not reached, a node reverts (as the example contract's
/// `proposal(id)` does), or, with `unknownIs: "false"`, says "not closed".
interface Poll {
  opened: number;
  closed: Set<number>;
  behind: { opened: number; closed: Set<number> } | null;
  unknownIs: "throw" | "false";
  votes: (string | undefined)[];
  closedAsked: string[];
}

function pollHarness(): Harness & { poll: Poll } {
  const poll: Poll = { opened: 0, closed: new Set(), behind: null, unknownIs: "throw", votes: [], closedAsked: [] };
  const node = () => poll.behind ?? poll;
  const h = buildHarness({
    actions: {
      "vote-yes": {
        description: "Vote yes",
        capability: true,
        bound: "One vote per proposal, enforced elsewhere",
        // The newest proposal the node knows, while it is open there.
        subject: () => {
          const n = node();
          return n.opened > 0 && !n.closed.has(n.opened) ? n.opened.toString() : null;
        },
        subjectClosed: ({ subject }) => {
          poll.closedAsked.push(subject);
          const n = node();
          if (Number(subject) > n.opened) {
            if (poll.unknownIs === "throw") throw new Error(`unknown proposal ${subject}`);
            return false;
          }
          return n.closed.has(Number(subject));
        },
        execute: (ctx: ActionContext) => {
          poll.votes.push(ctx.subject);
          return { ok: true };
        },
      },
    },
  });
  return { ...h, poll };
}

const linksOf = async (h: Harness): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const [action, u] of Object.entries(await h.issuer.capabilityLinksFor(TOKEN_ID))) out[action] = new URL(u).pathname;
  return out;
};

/// Proposals 1 to 5 have closed and proposal 6 is open. The holder's pass
/// carries a link for 6.
async function withLinkFor6(h: Harness & { poll: Poll }): Promise<string> {
  const owner = newSigner();
  h.chain.setOwner(TOKEN_ID, owner.address);
  expect((await claim(h, owner)).res.status).toBe(200);
  h.poll.opened = 6;
  h.poll.closed = new Set([1, 2, 3, 4, 5]);
  const link = (await linksOf(h))["vote-yes"]!;
  expect(link).toBeDefined();
  expect((await h.issuer.stores.passes.get(TOKEN_ID))!.linkSubjects).toEqual({ "vote-yes": "6" });
  return link;
}

describe("post 31, a link that ends: one answer from a node behind the opening of its proposal", () => {
  // A node behind the opening of proposal 6 names 5 as the newest: open
  // where 5 has not closed on that node, nothing open where it has.
  const lagging = {
    "proposal 5 is the open one": { opened: 5, closed: new Set([1, 2, 3, 4]) },
    "nothing is open": { opened: 5, closed: new Set([1, 2, 3, 4, 5]) },
  };
  for (const [told, behind] of Object.entries(lagging)) {
    for (const unknownIs of ["throw", "false"] as const) {
      it(`the holder's live link for proposal 6 survives a render that is told ${told} (a proposal the node has not reached: ${unknownIs})`, async () => {
        const h = pollHarness();
        h.poll.unknownIs = unknownIs;
        const during6 = await withLinkFor6(h);
        // One render reaches the node that is behind. Proposal 6 never closed.
        h.poll.behind = behind;
        const rendered = await linksOf(h);
        // No link for proposal 5 is handed out in its place.
        expect(rendered["vote-yes"] === undefined || rendered["vote-yes"] === during6).toBe(true);
        expect((await h.issuer.stores.passes.get(TOKEN_ID))!.linkSubjects).toEqual({ "vote-yes": "6" });
        // Caught up.
        h.poll.behind = null;
        expect((await linksOf(h))["vote-yes"]).toBe(during6);
        expect((await h.post(during6, {})).status, "the link on the installed pass").toBe(200);
        expect(h.poll.votes).toEqual(["6"]);
      });
    }
  }

  it("a tap that reaches the lagging node is not told the link has ended, and the link works on the next tap", async () => {
    const h = pollHarness();
    const during6 = await withLinkFor6(h);
    h.poll.behind = { opened: 5, closed: new Set([1, 2, 3, 4, 5]) };
    // The node cannot say whether proposal 6 has closed: 503, not 404.
    expect((await h.post(during6, { attempt: 1 })).status).toBe(503);
    h.poll.behind = null;
    expect((await h.post(during6, { attempt: 2 })).status).toBe(200);
    expect(h.poll.votes).toEqual(["6"]);
  });

  it("the link ends when its own proposal has closed, and only then is one minted for the next", async () => {
    const h = pollHarness();
    const during6 = await withLinkFor6(h);
    // Proposal 7 opens while 6 is still open: the link for 6 stays, and 6 is
    // what was asked about.
    h.poll.opened = 7;
    expect((await linksOf(h))["vote-yes"]).toBe(during6);
    expect(h.poll.closedAsked.at(-1)).toBe("6");
    expect((await h.post(during6, { attempt: 1 })).status).toBe(200);
    expect(h.poll.votes).toEqual(["6"]);
    // Proposal 6 closes: its link ends and the pass gets one for 7.
    h.poll.closed.add(6);
    const during7 = (await linksOf(h))["vote-yes"]!;
    expect(during7).not.toBe(during6);
    expect((await h.post(during6, { attempt: 2 })).status).toBe(404);
    expect((await h.post(during7, {})).status).toBe(200);
    expect(h.poll.votes).toEqual(["6", "7"]);
  });

  it("the open subject is not asked about: a link bound to it stays without a second question", async () => {
    const h = pollHarness();
    const during6 = await withLinkFor6(h);
    h.poll.closedAsked.length = 0;
    expect((await linksOf(h))["vote-yes"]).toBe(during6);
    expect((await h.post(during6, {})).status).toBe(200);
    expect(h.poll.closedAsked).toEqual([]);
  });
});

/// An ERC-721 chain whose reader can name its newest block.
class Chain721 extends FakeChain {
  head = 100n;
  blockNumber = async (): Promise<bigint> => this.head;
}

function harness721(): Harness & { chain: Chain721 } {
  const chain = new Chain721();
  const h = buildHarness({ chain });
  chain.clock = h.clock.now;
  return { ...h, chain };
}

describe("post 31, ERC-721: a transfer log delivered late", () => {
  for (const observedBy of ["the buyer's claim", "a refused request of the seller's"] as const) {
    it(`does not retire the pass of a seller who bought back and claimed (the sale was observed by ${observedBy})`, async () => {
      const h = harness721();
      const a = newSigner();
      const b = newSigner();
      // Block 100: A owns and claims.
      h.chain.setOwner(TOKEN_ID, a.address);
      const first = await claim(h, a);
      expect(first.res.status).toBe(200);
      // Block 101: A sells to B. No log reaches the issuer.
      h.chain.setOwner(TOKEN_ID, b.address);
      h.chain.head = 102n;
      if (observedBy === "the buyer's claim") {
        expect((await claim(h, b)).res.status).toBe(200);
      } else {
        expect((await h.get(new URL(first.body.formats.apple).pathname)).status).not.toBe(200);
        expect((await h.issuer.stores.passes.get(TOKEN_ID))!.lastIssuedTo).toBeNull();
      }
      // Block 103: A buys back. Block 104: A claims, a new pass.
      h.chain.setOwner(TOKEN_ID, a.address);
      h.chain.head = 104n;
      const again = await claim(h, a);
      expect(again.res.status).toBe(200);
      const issued = (await h.issuer.stores.passes.get(TOKEN_ID))!;
      expect(issued.lastIssuedTo).toBe(a.address);
      expect(issued.issuedAtBlock).toBe("104");
      // The log of the sale at block 101 is delivered now.
      const acted = await h.issuer.onTransfer(TOKEN_ID, a.address, b.address, 101n);
      const after = (await h.issuer.stores.passes.get(TOKEN_ID))!;
      expect(after.lastIssuedTo, "the new pass was retired by the old log").toBe(a.address);
      expect(after.serial).toBe(issued.serial);
      expect(acted).toBe(false);
      expect((await h.get(new URL(again.body.formats.apple).pathname)).status).toBe(200);
    });
  }
});

/// What follows from the fixes, beyond the cases the review named.

/// Strip a record down to what an earlier version left: no block at all, or
/// a block with no mark that a read was taken at it.
const asEarlier = (record: PassRecord, block?: string): void => {
  delete record.heldAtBlock;
  delete record.datedByRead;
  if (block === undefined) delete record.issuedAtBlock;
  else record.issuedAtBlock = block;
};

describe("a stored pass with no block a read was taken at (ERC-1155)", () => {
  async function issuedEarlier(h: H, block?: string) {
    const alice = newSigner();
    h.chain.setBalanceFrom(100n, ID, alice.address, 1n);
    h.chain.lagging = 100n;
    const first = await claim(h, alice, ID);
    expect(first.res.status).toBe(200);
    expect((await recordOf(h, alice.address))!.datedByRead).toBe(true);
    const stored = (await recordOf(h, alice.address))!;
    asEarlier(stored, block);
    await h.issuer.stores.passes.put(stored);
    return { alice, first, serial: stored.serial };
  }

  it("is not taken by a holdings check or a PassUpdate that reaches a lagging node", async () => {
    for (const block of [undefined, "98"]) {
      for (const make of [signedOnly, harness1155]) {
        const h = make();
        const { alice, serial } = await issuedEarlier(h, block);
        h.chain.lagging = 99n;
        h.chain.latestFrom = "lagging";
        h.chain.headFrom = "lagging";
        const swept = await h.issuer.checkHoldings(ID);
        expect(swept.retired).toEqual([]);
        expect(swept.dark).toEqual([]);
        await h.issuer.onPassUpdate(ID);
        await h.issuer.onTransfer(ID, newSigner().address, alice.address);
        const record = (await recordOf(h, alice.address))!;
        expect(record.dark).toBeUndefined();
        expect(record.lastIssuedTo).toBe(alice.address);
        expect(record.serial).toBe(serial);
      }
    }
  });

  it("is dated the next time a holdings check finds the account holding, and a loss of it is acted on from then", async () => {
    for (const make of [signedOnly, harness1155]) {
      const h = make();
      const { alice } = await issuedEarlier(h, "98");
      h.chain.fresh = 103n;
      h.chain.lagging = 103n;
      await h.issuer.checkHoldings(ID);
      let record = (await recordOf(h, alice.address))!;
      expect(record.datedByRead).toBe(true);
      expect(record.heldAtBlock).toBe("103");
      // The earlier version's block is gone: it is never tested against.
      expect(record.issuedAtBlock).toBeUndefined();
      // A node behind the dating read takes nothing.
      h.chain.lagging = 99n;
      h.chain.latestFrom = "lagging";
      h.chain.headFrom = "lagging";
      expect((await h.issuer.checkHoldings(ID)).checked).toBe(1);
      expect((await recordOf(h, alice.address))!.lastIssuedTo).toBe(alice.address);
      expect((await recordOf(h, alice.address))!.dark).toBeUndefined();
      // The unit leaves at 105, and a node that has the block says so.
      h.chain.setBalanceFrom(105n, ID, alice.address, 0n);
      h.chain.fresh = 105n;
      h.chain.lagging = 105n;
      h.chain.latestFrom = "fresh";
      h.chain.headFrom = "fresh";
      const swept = await h.issuer.checkHoldings(ID);
      expect([...swept.retired, ...swept.dark]).toEqual([alice.address]);
      record = (await recordOf(h, alice.address))!;
      expect(record.dark === true || record.lastIssuedTo === null).toBe(true);
    }
  });

  it("is dated by its holder's next claim, and a PassUpdate dates it too", async () => {
    for (const how of ["claim", "update"] as const) {
      const h = signedOnly();
      const { alice } = await issuedEarlier(h);
      h.chain.fresh = 104n;
      h.chain.lagging = 104n;
      if (how === "claim") expect((await claim(h, alice, ID)).res.status).toBe(200);
      else await h.issuer.onPassUpdate(ID);
      const record = (await recordOf(h, alice.address))!;
      expect(record.datedByRead).toBe(true);
      expect(record.heldAtBlock).toBe("104");
    }
  });

  it("stays refused, and is not told anything, while its account does not hold: no read can tell a loss from a node behind its issuance", async () => {
    const h = signedOnly();
    const { alice, first, serial } = await issuedEarlier(h);
    // The unit really left, at 102, and every node knows.
    h.chain.setBalanceFrom(102n, ID, alice.address, 0n);
    h.chain.fresh = 103n;
    h.chain.lagging = 103n;
    h.notified.length = 0;
    expect((await h.get(new URL(first.body.formats.apple).pathname)).status).toBe(403);
    expect((await h.issuer.checkHoldings(ID)).dark).toEqual([]);
    const record = (await recordOf(h, alice.address))!;
    expect(record.serial).toBe(serial);
    expect(record.dark).toBeUndefined();
    expect(h.notified).toEqual([]);
    // And the account's own claim is refused, as for anyone who does not hold.
    expect((await claim(h, alice, ID)).res.status).toBe(403);
  });

  it("a transfer log is tested against a marked issuance block only", async () => {
    const h = harness1155();
    // Alice held, sent her unit away at 99 and got one back at 100, then
    // claimed. An earlier version stored 101 for the pass with no read at it.
    const alice = newSigner();
    h.chain.setBalanceFrom(97n, ID, alice.address, 1n);
    h.chain.setBalanceFrom(99n, ID, alice.address, 0n);
    h.chain.setBalanceFrom(100n, ID, alice.address, 1n);
    h.chain.fresh = 101n;
    h.chain.lagging = 101n;
    expect((await claim(h, alice, ID)).res.status).toBe(200);
    // Marked: the log of block 99 is older than the issuance and changes nothing.
    expect(await h.issuer.onTransfer(ID, alice.address, newSigner().address, 99n)).toBe(false);
    const stored = (await recordOf(h, alice.address))!;
    asEarlier(stored, "101");
    await h.issuer.stores.passes.put(stored);
    // Not marked: the block is not trusted, so the log's block is read, as
    // for a pass with no block.
    expect(await h.issuer.onTransfer(ID, alice.address, newSigner().address, 99n)).toBe(true);
    expect((await recordOf(h, alice.address))!.lastIssuedTo).toBeNull();
  });
});

describe("ERC-721: transfer logs and the block a pass is dated with", () => {
  async function soldAndBoughtBack(h: Harness & { chain: Chain721 }) {
    const a = newSigner();
    const b = newSigner();
    h.chain.setOwner(TOKEN_ID, a.address);
    expect((await claim(h, a)).res.status).toBe(200);
    h.chain.setOwner(TOKEN_ID, b.address);
    h.chain.head = 102n;
    expect((await claim(h, b)).res.status).toBe(200);
    h.chain.setOwner(TOKEN_ID, a.address);
    h.chain.head = 104n;
    const again = await claim(h, a);
    expect(again.res.status).toBe(200);
    return { a, b, again, issued: (await h.issuer.stores.passes.get(TOKEN_ID))! };
  }

  it("a log from the block the pass is dated with changes nothing, and a later one retires it", async () => {
    const h = harness721();
    const { a, b, issued } = await soldAndBoughtBack(h);
    expect(issued.issuedAtBlock).toBe("104");
    // The read at 104 is the state at the end of 104.
    expect(await h.issuer.onTransfer(TOKEN_ID, b.address, a.address, 104n)).toBe(false);
    expect(await h.issuer.onTransfer(TOKEN_ID, a.address, b.address, 104n)).toBe(false);
    expect((await h.issuer.stores.passes.get(TOKEN_ID))!.serial).toBe(issued.serial);
    // A sells again at 105.
    h.chain.setOwner(TOKEN_ID, b.address);
    h.chain.head = 105n;
    expect(await h.issuer.onTransfer(TOKEN_ID, a.address, b.address, 105n)).toBe(true);
    expect((await h.issuer.stores.passes.get(TOKEN_ID))!.lastIssuedTo).toBeNull();
  });

  it("a log with no block, and a log for a pass with no marked block, act as before", async () => {
    for (const how of ["no block on the log", "no mark on the pass"] as const) {
      const h = harness721();
      const { a, b, issued } = await soldAndBoughtBack(h);
      if (how === "no mark on the pass") {
        asEarlier(issued, "104");
        await h.issuer.stores.passes.put(issued);
      }
      expect(await h.issuer.onTransfer(TOKEN_ID, a.address, b.address, how === "no block on the log" ? undefined : 101n)).toBe(true);
      expect((await h.issuer.stores.passes.get(TOKEN_ID))!.lastIssuedTo).toBeNull();
    }
  });

  it("a burn log delivered late does not void the pass of a token minted again and claimed", async () => {
    const h = harness721();
    const a = newSigner();
    h.chain.setOwner(TOKEN_ID, a.address);
    expect((await claim(h, a)).res.status).toBe(200);
    // Burned at 101 (seen by a PassUpdate read), minted again to A at 103.
    h.chain.setOwner(TOKEN_ID, null);
    h.chain.head = 102n;
    await h.issuer.onPassUpdate(TOKEN_ID);
    h.chain.setOwner(TOKEN_ID, a.address);
    h.chain.head = 104n;
    const again = await claim(h, a);
    expect(again.res.status).toBe(200);
    const issued = (await h.issuer.stores.passes.get(TOKEN_ID))!;
    expect(await h.issuer.onTransfer(TOKEN_ID, a.address, "0x0000000000000000000000000000000000000000", 101n)).toBe(false);
    const after = (await h.issuer.stores.passes.get(TOKEN_ID))!;
    expect(after.serial).toBe(issued.serial);
    expect(after.lastIssuedTo).toBe(a.address);
    // A burn at 105 voids it.
    h.chain.setOwner(TOKEN_ID, null);
    h.chain.head = 105n;
    expect(await h.issuer.onTransfer(TOKEN_ID, a.address, "0x0000000000000000000000000000000000000000", 105n)).toBe(true);
    expect((await h.issuer.stores.passes.get(TOKEN_ID))!.lastIssuedTo).toBeNull();
  });

  it("watchTransfers hands the log's block to onTransfer", async () => {
    const h = harness721();
    const { a, b, issued } = await soldAndBoughtBack(h);
    let onLogs!: (logs: unknown[]) => Promise<void>;
    const client: WatchEventClient = {
      watchContractEvent(params: { onLogs: (logs: unknown[]) => Promise<void> }) {
        onLogs = params.onLogs;
        return () => undefined;
      },
    };
    watchTransfers({ client, issuer: h.issuer });
    await onLogs([{ blockNumber: 101n, args: { from: a.address, to: b.address, tokenId: BigInt(TOKEN_ID) } }]);
    expect((await h.issuer.stores.passes.get(TOKEN_ID))!.serial).toBe(issued.serial);
    expect((await h.issuer.stores.passes.get(TOKEN_ID))!.lastIssuedTo).toBe(a.address);
  });

  it("a pass with no block is not taken by a PassUpdate read, and is dated when that read finds its holder entitled", async () => {
    const h = harness721();
    const a = newSigner();
    h.chain.setOwner(TOKEN_ID, a.address);
    expect((await claim(h, a)).res.status).toBe(200);
    const stored = (await h.issuer.stores.passes.get(TOKEN_ID))!;
    asEarlier(stored);
    await h.issuer.stores.passes.put(stored);
    // A node that reports no owner (behind the mint, or a burn: one read
    // cannot tell which for a pass with no block).
    h.chain.setOwner(TOKEN_ID, null);
    await h.issuer.onPassUpdate(TOKEN_ID);
    expect((await h.issuer.stores.passes.get(TOKEN_ID))!.lastIssuedTo).toBe(a.address);
    h.chain.setOwner(TOKEN_ID, a.address);
    h.chain.head = 107n;
    await h.issuer.onPassUpdate(TOKEN_ID);
    const dated = (await h.issuer.stores.passes.get(TOKEN_ID))!;
    expect(dated.datedByRead).toBe(true);
    expect(dated.heldAtBlock).toBe("107");
    // Now a burn that a PassUpdate read finds is acted on.
    h.chain.setOwner(TOKEN_ID, null);
    h.chain.head = 108n;
    expect((await h.issuer.onPassUpdate(TOKEN_ID)).burned).toEqual([TOKEN_ID]);
  });
});

describe("render is told what each link is bound to", () => {
  it("names the subject from the record, which a render through a lagging node does not change", async () => {
    const seen: { links: Record<string, string>; linkSubjects: Record<string, string> }[] = [];
    const poll = { open: "6" as string | null, known: true };
    const h = buildHarness({
      actions: {
        "vote-yes": {
          description: "Vote yes",
          capability: true,
          bound: "One vote per proposal",
          subject: () => poll.open,
          subjectClosed: () => {
            if (!poll.known) throw new Error("unknown proposal");
            return false;
          },
          execute: () => ({ ok: true }),
        },
        feed: { description: "Feed", capability: true, bound: "Idempotent", execute: () => ({ fed: true }) },
      },
      render: (ctx) => {
        seen.push({ links: ctx.links, linkSubjects: ctx.linkSubjects });
        return { serial: ctx.serial, organizationName: "Example", description: "d", title: "t", links: [] };
      },
    });
    const owner = newSigner();
    h.chain.setOwner(TOKEN_ID, owner.address);
    expect((await claim(h, owner)).res.status).toBe(200);
    const live = seen.at(-1)!;
    expect(live.linkSubjects).toEqual({ "vote-yes": "6" });
    expect(Object.keys(live.links).sort()).toEqual(["feed", "vote-yes"]);
    // A node behind the opening of 6: it names 5 and cannot say whether 6 closed.
    poll.open = "5";
    poll.known = false;
    await h.issuer.onPassUpdate(TOKEN_ID);
    const behind = seen.at(-1)!;
    expect(behind.links["vote-yes"]).toBeUndefined();
    expect(behind.linkSubjects).toEqual({});
    expect(behind.links.feed).toBe(live.links.feed);
    // A node that knows 6 is still open while it names another as open: the
    // link is shown, and it is named for 6.
    poll.known = true;
    await h.issuer.onPassUpdate(TOKEN_ID);
    const kept = seen.at(-1)!;
    expect(kept.links["vote-yes"]).toBe(live.links["vote-yes"]);
    expect(kept.linkSubjects).toEqual({ "vote-yes": "6" });
  });
});

/// From a cold review of the fixes above, before they were pushed. Each test
/// failed on the first version of the fix.

/// An ERC-721 chain with a history of owners, read through one node that
/// can be behind: it answers for the blocks it has and no others.
class History721 extends FakeChain {
  private steps: { from: bigint; owner: Address | null }[] = [];
  node = 100n;
  setOwnerFrom(block: bigint, owner: Address | null): void {
    this.steps.push({ from: block, owner });
  }
  private at(block: bigint): Address | null {
    let owner: Address | null = null;
    for (const s of this.steps) if (s.from <= block) owner = s.owner;
    return owner;
  }
  blockNumber = async (): Promise<bigint> => this.node;
  override async ownerOf(_token: TokenRef, blockNumber?: bigint): Promise<Address | null> {
    this.reads++;
    if (blockNumber === undefined) return this.at(this.node);
    if (blockNumber > this.node) throw new Error("header not found");
    return this.at(blockNumber);
  }
}

/// A record as 0.5.1 and 0.5.2 wrote it: its blocks, and no mark.
const unmark = (record: PassRecord): void => {
  delete record.datedByRead;
};

describe("review of the fix: a pass from an earlier version and a transfer log that arrives on time (ERC-1155)", () => {
  for (const shape of ["a block with no mark", "no block"] as const) {
    it(`a sale the watcher reports retires the pass or takes it dark (${shape})`, async () => {
      for (const make of [signedOnly, harness1155]) {
        const h = make();
        const alice = newSigner();
        const bob = newSigner();
        h.chain.setBalanceFrom(100n, ID, alice.address, 1n);
        h.chain.fresh = 101n;
        h.chain.lagging = 101n;
        const first = await claim(h, alice, ID);
        expect(first.res.status).toBe(200);
        const stored = (await recordOf(h, alice.address))!;
        if (shape === "no block") asEarlier(stored);
        else unmark(stored);
        await h.issuer.stores.passes.put(stored);
        // Alice sells her unit at 105. Every node is current.
        h.chain.setBalanceFrom(105n, ID, alice.address, 0n);
        h.chain.setBalanceFrom(105n, ID, bob.address, 1n);
        h.chain.fresh = 106n;
        h.chain.lagging = 106n;
        expect(await h.issuer.onTransfer(ID, alice.address, bob.address, 105n)).toBe(true);
        const record = (await recordOf(h, alice.address))!;
        expect(record.dark === true || record.lastIssuedTo === null).toBe(true);
        expect((await h.get(new URL(first.body.formats.apple).pathname)).status).toBe(404);
      }
    });

    it(`the log's block is the floor: a node behind the log takes nothing (${shape})`, async () => {
      const h = signedOnly();
      const alice = newSigner();
      h.chain.setBalanceFrom(100n, ID, alice.address, 1n);
      h.chain.fresh = 101n;
      h.chain.lagging = 101n;
      expect((await claim(h, alice, ID)).res.status).toBe(200);
      const stored = (await recordOf(h, alice.address))!;
      if (shape === "no block") asEarlier(stored);
      else unmark(stored);
      await h.issuer.stores.passes.put(stored);
      // A log of block 105 names Alice, and the node asked is at 99, where
      // she held nothing yet. She holds at 105 and after.
      h.chain.lagging = 99n;
      h.chain.latestFrom = "lagging";
      h.chain.headFrom = "lagging";
      await h.issuer.onTransfer(ID, newSigner().address, alice.address, 105n).catch(() => undefined);
      const record = (await recordOf(h, alice.address))!;
      expect(record.dark).toBeUndefined();
      expect(record.lastIssuedTo).toBe(alice.address);
    });
  }
});

describe("review of the fix: an unmarked block still keeps a claim from behind it out (ERC-721)", () => {
  for (const mode of ["public", "gated"] as const) {
    it(`a request answered by a node behind the sale does not hand the buyer's pass to the seller (${mode})`, async () => {
      const chain = new History721();
      const h = buildHarness({ mode, chain });
      const a = newSigner();
      const b = newSigner();
      // A owned from 90 and sold to B at 115. B's pass was issued at 120.
      chain.setOwnerFrom(90n, a.address);
      chain.setOwnerFrom(115n, b.address);
      chain.node = 120n;
      if (mode === "public") expect((await h.get(`/wallet-pass/${TOKEN_ID}`)).status).toBe(200);
      else expect((await claim(h, b)).res.status).toBe(200);
      const stored = (await h.issuer.stores.passes.get(TOKEN_ID))!;
      expect(stored.issuedAtBlock).toBe("120");
      unmark(stored);
      await h.issuer.stores.passes.put(stored);
      // One request reaches a node at 110, where A still owns.
      chain.node = 110n;
      const res = mode === "public" ? await h.get(`/wallet-pass/${TOKEN_ID}`) : (await claim(h, a)).res;
      expect(res.status).toBe(503);
      const after = (await h.issuer.stores.passes.get(TOKEN_ID))!;
      expect(after.lastIssuedTo).toBe(b.address);
      expect(after.serial).toBe(stored.serial);
    });
  }
});

describe("review of the fix: a pass is not dated below a block an earlier version stored", () => {
  it("ERC-1155: a sweep through a node from an earlier holding period dates nothing, and the next lagging sweep takes nothing", async () => {
    for (const make of [signedOnly, harness1155]) {
      const h = make();
      const alice = newSigner();
      // Held 50 to 79, nothing 80 to 114, holds from 115. Claimed at 120.
      h.chain.setBalanceFrom(50n, ID, alice.address, 1n);
      h.chain.setBalanceFrom(80n, ID, alice.address, 0n);
      h.chain.setBalanceFrom(115n, ID, alice.address, 1n);
      h.chain.fresh = 120n;
      h.chain.lagging = 120n;
      expect((await claim(h, alice, ID)).res.status).toBe(200);
      const stored = (await recordOf(h, alice.address))!;
      unmark(stored);
      await h.issuer.stores.passes.put(stored);
      h.chain.lagging = 70n;
      h.chain.latestFrom = "lagging";
      h.chain.headFrom = "lagging";
      await h.issuer.checkHoldings(ID);
      const swept = (await recordOf(h, alice.address))!;
      expect(swept.datedByRead).toBeUndefined();
      expect(swept.issuedAtBlock).toBe("120");
      h.chain.lagging = 100n;
      const second = await h.issuer.checkHoldings(ID);
      expect([...second.retired, ...second.dark]).toEqual([]);
      const record = (await recordOf(h, alice.address))!;
      expect(record.dark).toBeUndefined();
      expect(record.lastIssuedTo).toBe(alice.address);
      // A sweep through a current node dates it, and marks it.
      h.chain.lagging = 125n;
      h.chain.fresh = 125n;
      await h.issuer.checkHoldings(ID);
      const dated = (await recordOf(h, alice.address))!;
      expect(dated.datedByRead).toBe(true);
      expect(dated.heldAtBlock).toBe("125");
    }
  });

  it("ERC-721: a PassUpdate through such a node dates nothing, and a refused request through a lagging node takes nothing", async () => {
    const chain = new History721();
    const h = buildHarness({ chain });
    const a = newSigner();
    const b = newSigner();
    chain.setOwnerFrom(50n, a.address);
    chain.setOwnerFrom(80n, b.address);
    chain.setOwnerFrom(115n, a.address);
    chain.node = 120n;
    const first = await claim(h, a);
    expect(first.res.status).toBe(200);
    const stored = (await h.issuer.stores.passes.get(TOKEN_ID))!;
    unmark(stored);
    await h.issuer.stores.passes.put(stored);
    chain.node = 70n;
    await h.issuer.onPassUpdate(TOKEN_ID);
    expect((await h.issuer.stores.passes.get(TOKEN_ID))!.datedByRead).toBeUndefined();
    chain.node = 100n;
    expect((await h.get(new URL(first.body.formats.apple).pathname)).status).toBe(403);
    expect((await h.issuer.stores.passes.get(TOKEN_ID))!.lastIssuedTo).toBe(a.address);
  });
});

describe("review of the fix: a loss is tested against the date of the record as it is when the issuer acts", () => {
  it("a download that was waiting on its read while the holder claimed again does not take the pass through a node behind that claim", async () => {
    const h = signedOnly();
    const alice = newSigner();
    h.chain.setBalanceFrom(100n, ID, alice.address, 1n);
    h.chain.lagging = 100n;
    const first = await claim(h, alice, ID);
    expect(first.res.status).toBe(200);
    // Out at 103 and back at 108, seen by nobody.
    h.chain.setBalanceFrom(103n, ID, alice.address, 0n);
    h.chain.setBalanceFrom(108n, ID, alice.address, 1n);
    h.chain.fresh = 110n;
    h.chain.lagging = 105n;
    // A download starts, and its read at the reader's tag is slow.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = h.chain.balanceOf.bind(h.chain);
    let gated = true;
    h.chain.balanceOf = async (token, account, blockNumber) => {
      if (blockNumber === undefined && gated) {
        gated = false;
        await gate;
      }
      return real(token, account, blockNumber);
    };
    h.chain.latestFrom = "lagging";
    const download = h.get(new URL(first.body.formats.apple).pathname);
    await new Promise((r) => setTimeout(r, 10));
    // Meanwhile she claims again through a current node: dated 110.
    h.chain.headFrom = "fresh";
    expect((await claim(h, alice, ID)).res.status).toBe(200);
    expect((await recordOf(h, alice.address))!.heldAtBlock).toBe("110");
    // The download's reads are answered by the node at 105.
    h.chain.headFrom = "lagging";
    release();
    expect((await download).status).toBe(403);
    const record = (await recordOf(h, alice.address))!;
    expect(record.dark).toBeUndefined();
    expect(record.lastIssuedTo).toBe(alice.address);
  });
});
