import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { TokenRef } from "@erc8426/core";
import { rental4907, type ChainReader, type CreateIssuerOptions, type PassRecord } from "@erc8426/issuer";

import { CONTRACT, FakeChain, TOKEN_ID, buildHarness, claim, newSigner, type Harness } from "./helpers.js";

/// From a review of 0.5.1 (Magicians t/29358 post 29). Each test is written
///  as the behaviour that should hold, and each failed on 0.5.1.

const ID = "77";

/// A provider that answers from two nodes. Each node has its own newest
/// block; a read at `latest` is that node's newest block, and a node cannot
/// answer for a block it has not reached. The balance is a history by block,
/// so every node tells the truth about the blocks it has.
class TwoNodes extends FakeChain {
  /// The balance of `account` from `block` on.
  private history = new Map<string, { from: bigint; balance: bigint }[]>();
  fresh = 100n;
  lagging = 98n;
  /// Which node answers a read at `latest`, and which names the head.
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
    // A read at a named block goes to the node that named it.
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

describe("post 29, claim 1: the read that admits a claim is the read that dates the pass", () => {
  // On 0.5.1 the claim below was admitted by a read at `latest`, the pass
  // was dated by a second read at a head fetched for it, that read said
  // "not entitled" at block 98, the pass was issued with no block, and the
  // download through the lagging node then retired it or took it dark.
  it("an account that claims right after it receives its unit keeps its pass when lagging nodes answer", async () => {
    for (const make of [signedOnly, harness1155]) {
      const h = make();
      const alice = newSigner();
      // Block 100: Alice receives her unit. She holds from then on.
      h.chain.setBalanceFrom(100n, ID, alice.address, 1n);
      // The claim: the node asked for the head is at 98 on the first try and
      // has caught up on the second.
      h.chain.latestFrom = "fresh";
      h.chain.headFrom = "lagging";
      const named = h.chain.blockNumber;
      let asked = 0;
      h.chain.blockNumber = async () => {
        if (++asked === 2) h.chain.lagging = 100n;
        return named();
      };
      const first = await claim(h, alice, ID);
      h.chain.blockNumber = named;
      expect(first.res.status).toBe(200);
      expect((await recordOf(h, alice.address))!.issuedAtBlock).toBe("100");
      const download = new URL(first.body.formats.apple).pathname;
      const serial = (await recordOf(h, alice.address))!.serial;
      // The next download reaches a node that is at 99.
      h.chain.lagging = 99n;
      h.chain.latestFrom = "lagging";
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
  });

  it("issues nothing, and answers 503, while the node that names the head stays behind the node that holds the unit", async () => {
    const h = signedOnly();
    const alice = newSigner();
    h.chain.setBalanceFrom(100n, ID, alice.address, 1n);
    h.chain.latestFrom = "fresh";
    h.chain.headFrom = "lagging";
    const first = await claim(h, alice, ID);
    expect(first.res.status).toBe(503);
    expect(first.body.error).toBe("read_failed");
    expect((await recordOf(h, alice.address))?.lastIssuedTo ?? null).toBeNull();
    // The nodes agree again: the next claim is admitted and dated.
    h.chain.lagging = 101n;
    h.chain.fresh = 101n;
    h.chain.headFrom = "fresh";
    expect((await claim(h, alice, ID)).res.status).toBe(200);
    expect((await recordOf(h, alice.address))!.issuedAtBlock).toBe("101");
  });

  it("refuses at once, with no second try, an account that holds nothing on any node", async () => {
    const h = signedOnly();
    const mallory = newSigner();
    let heads = 0;
    const named = h.chain.blockNumber;
    h.chain.blockNumber = async () => {
      heads++;
      return named();
    };
    const res = (await claim(h, mallory, ID)).res;
    expect(res.status).toBe(403);
    expect(heads).toBe(1);
  });

  it("tries a read the node cannot answer at the head it named again inside the request", async () => {
    const h = signedOnly();
    const alice = newSigner();
    h.chain.setBalanceFrom(100n, ID, alice.address, 1n);
    // The head is named by a node at 100, the read at 100 reaches one at 98
    // twice (header not found), then one that has the block.
    const real = h.chain.balanceOf.bind(h.chain);
    let misses = 2;
    h.chain.balanceOf = async (token, account, blockNumber) => {
      if (blockNumber !== undefined && misses-- > 0) throw new Error("header not found");
      return real(token, account, blockNumber);
    };
    expect((await claim(h, alice, ID)).res.status).toBe(200);
    expect((await recordOf(h, alice.address))!.issuedAtBlock).toBe("100");
  });

  it("brings a dark pass back only on a read at a named head, and dates it by that block", async () => {
    const h = signedOnly();
    const alice = newSigner();
    h.chain.setBalanceFrom(100n, ID, alice.address, 1n);
    expect((await claim(h, alice, ID)).res.status).toBe(200);
    // Out at 102: the pass goes dark.
    h.chain.setBalanceFrom(102n, ID, alice.address, 0n);
    h.chain.fresh = 102n;
    h.chain.lagging = 102n;
    expect((await h.issuer.checkHoldings(ID)).dark).toEqual([alice.address]);
    // Back at 104. A node at 104 says so at `latest`; the node that names
    // the head is at 103, where she held nothing: the pass stays dark.
    h.chain.setBalanceFrom(104n, ID, alice.address, 1n);
    h.chain.fresh = 104n;
    h.chain.lagging = 103n;
    h.chain.headFrom = "lagging";
    expect((await h.issuer.checkHoldings(ID)).revived).toEqual([]);
    expect((await recordOf(h, alice.address))!.dark).toBe(true);
    // The head catches up: back, and dated at the block it was read at.
    h.chain.lagging = 104n;
    expect((await h.issuer.checkHoldings(ID)).revived).toEqual([alice.address]);
    const record = (await recordOf(h, alice.address))!;
    expect(record.dark).toBeUndefined();
    expect(record.issuedAtBlock).toBe("104");
  });
});

/// An ERC-721 chain whose reader can name its newest block, and that can be
/// answered by a node that is behind: `lag` is that node's newest block and
/// the owner and rental user as it knows them. It cannot answer for a block
/// it has not reached.
class Chain721 extends FakeChain {
  head = 100n;
  lag: { head: bigint; owner: Address | null; user: Address | null } | null = null;
  blockNumber = async (): Promise<bigint> => (this.lag ? this.lag.head : this.head);
  override async ownerOf(token: TokenRef, blockNumber?: bigint): Promise<Address | null> {
    if (!this.lag) return super.ownerOf(token);
    this.reads++;
    if (blockNumber !== undefined && blockNumber > this.lag.head) throw new Error("header not found");
    return this.lag.owner;
  }
  override async userOf(token: TokenRef, blockNumber?: bigint): Promise<{ user: Address | null; expires: bigint }> {
    if (!this.lag) return super.userOf(token);
    this.reads++;
    if (blockNumber !== undefined && blockNumber > this.lag.head) throw new Error("header not found");
    return { user: this.lag.user, expires: 0n };
  }
}

type H721 = Harness & { chain: Chain721 };

function harness721(overrides: Partial<CreateIssuerOptions> = {}): H721 {
  const chain = new Chain721();
  const h = buildHarness({ chain, ...overrides });
  chain.clock = h.clock.now;
  return { ...h, chain };
}

const record721 = (h: H721): Promise<PassRecord | null> => h.issuer.stores.passes.get(TOKEN_ID);
const linksOf = async (h: H721): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const [action, u] of Object.entries(await h.issuer.capabilityLinksFor(TOKEN_ID))) out[action] = new URL(u).pathname;
  return out;
};

describe("post 29: the issuer's own read is the moment a rental ends (ERC-721, ERC-4907)", () => {
  it("retires the renter's link at the first read after the end, and a new rental of the same account does not wake it", async () => {
    const h = harness721({ entitlement: rental4907() });
    const house = newSigner();
    const guest = newSigner();
    const nowSeconds = () => BigInt(Math.floor(h.clock.now() / 1000));
    h.chain.setOwner(TOKEN_ID, house.address);
    // Block 100: the guest rents for three minutes and claims the pass.
    h.chain.setUser(TOKEN_ID, guest.address, nowSeconds() + 180n);
    expect((await claim(h, guest)).res.status).toBe(200);
    expect((await record721(h))!.issuedAtBlock).toBe("100");
    const first = await linksOf(h);
    const firstSerial = (await record721(h))!.serial;
    expect((await h.post(first.feed!, {})).status).toBe(200);

    // The rental ends by the clock: no transaction, no event.
    h.clock.advance(200_000);
    h.chain.head = 150n;
    const pushes = h.notified.length;
    // The guest taps the link. The read refuses it, and that read is the
    // issuer observing the end of the rental: the link is retired by it.
    expect((await h.post(first.feed!, {})).status).toBe(403);
    expect((await h.post(first.feed!, {})).status).toBe(404);
    expect((await record721(h))!.lastIssuedTo).toBeNull();
    // The installed card is told it is over.
    const told = h.notified.slice(pushes);
    expect(told.length).toBeGreaterThan(0);
    for (const n of told) {
      expect(n.ctx.content.serial).toBe(firstSerial);
      expect(n.ctx.content.voided).toBe(true);
    }

    // Block 160: the same guest rents again. The house never claimed.
    h.chain.setUser(TOKEN_ID, guest.address, nowSeconds() + 180n);
    h.chain.head = 160n;
    // The link from the first rental does not wake up.
    expect((await h.post(first.feed!, {})).status).toBe(404);
    // The guest claims again: a new pass, new links, dated at this block.
    expect((await claim(h, guest)).res.status).toBe(200);
    const again = (await record721(h))!;
    expect(again.serial).not.toBe(firstSerial);
    expect(again.issuedAtBlock).toBe("160");
    const second = await linksOf(h);
    expect(second.feed).not.toBe(first.feed);

    // The PassUpdate that setUser emitted reaches the issuer, and the node
    // it asks is at 159: it has not seen the new rental.
    h.chain.lag = { head: 159n, owner: house.address, user: null };
    const summary = await h.issuer.onPassUpdate(TOKEN_ID);
    expect(summary.rotated).toEqual([]);
    expect(summary.burned).toEqual([]);
    h.chain.lag = null;
    expect((await record721(h))!.serial).toBe(again.serial);
    expect((await record721(h))!.lastIssuedTo).toBe(guest.address);
    expect((await h.post(second.feed!, {})).status).toBe(200);
  });

  it("retires the renter's download and signed access at the end too, and the owner's claim starts clean", async () => {
    const h = harness721({ entitlement: rental4907() });
    const house = newSigner();
    const guest = newSigner();
    h.chain.setOwner(TOKEN_ID, house.address);
    h.chain.setUser(TOKEN_ID, guest.address, BigInt(Math.floor(h.clock.now() / 1000)) + 180n);
    const first = await claim(h, guest);
    const download = new URL(first.body.formats.apple).pathname;
    expect((await h.get(download)).status).toBe(200);
    h.clock.advance(200_000);
    h.chain.head = 150n;
    expect((await h.get(download)).status).toBe(403);
    expect((await h.get(download)).status).toBe(404);
    expect((await record721(h))!.lastIssuedTo).toBeNull();
    expect((await claim(h, house)).res.status).toBe(200);
    expect((await record721(h))!.lastIssuedTo).toBe(house.address);
  });

  it("the renter's own refused proof is the same finding, and a stranger's refused proof is not", async () => {
    const h = harness721({ entitlement: rental4907() });
    const house = newSigner();
    const guest = newSigner();
    const stranger = newSigner();
    h.chain.setOwner(TOKEN_ID, house.address);
    h.chain.setUser(TOKEN_ID, guest.address, BigInt(Math.floor(h.clock.now() / 1000)) + 180n);
    expect((await claim(h, guest)).res.status).toBe(200);
    expect((await claim(h, stranger)).res.status).toBe(403);
    expect((await record721(h))!.lastIssuedTo).toBe(guest.address);
    h.clock.advance(200_000);
    h.chain.head = 150n;
    expect((await claim(h, stranger)).res.status).toBe(403);
    expect((await record721(h))!.lastIssuedTo).toBe(guest.address);
    expect((await claim(h, guest)).res.status).toBe(403);
    expect((await record721(h))!.lastIssuedTo).toBeNull();
  });

  it("an extension seen late does not end the rental: a node that has not seen the new setUser still answers the user", async () => {
    const h = harness721({ entitlement: rental4907() });
    const house = newSigner();
    const guest = newSigner();
    const start = BigInt(Math.floor(h.clock.now() / 1000));
    h.chain.setOwner(TOKEN_ID, house.address);
    h.chain.setUser(TOKEN_ID, guest.address, start + 180n);
    expect((await claim(h, guest)).res.status).toBe(200);
    const links = await linksOf(h);
    // Block 130, before the end: the house extends the rental. The issuer's
    // clock then passes the old end.
    h.chain.setUser(TOKEN_ID, guest.address, start + 600n);
    h.chain.head = 130n;
    h.clock.advance(200_000);
    // A node at 129 answers. By its block time the old rental still runs,
    // so the contract's answer there is the user. An issuer that compared
    // its own clock with the old `expires` would call the rental over.
    h.chain.lag = { head: 129n, owner: house.address, user: guest.address };
    expect((await h.post(links.feed!, {})).status).toBe(200);
    await h.issuer.onPassUpdate(TOKEN_ID);
    h.chain.lag = null;
    expect((await record721(h))!.lastIssuedTo).toBe(guest.address);
  });
});

describe("post 29: the ERC-721 path does not act on one read", () => {
  it("a buyer who claims at once keeps the pass when a node that has not seen the sale answers a PassUpdate", async () => {
    const h = harness721();
    const seller = newSigner();
    const buyer = newSigner();
    const third = newSigner();
    h.chain.head = 200n;
    h.chain.setOwner(TOKEN_ID, buyer.address);
    expect((await claim(h, buyer)).res.status).toBe(200);
    const serial = (await record721(h))!.serial;
    expect((await record721(h))!.issuedAtBlock).toBe("200");
    h.chain.lag = { head: 199n, owner: seller.address, user: null };
    expect((await h.issuer.onPassUpdate(TOKEN_ID)).rotated).toEqual([]);
    h.chain.lag = null;
    expect((await record721(h))!.lastIssuedTo).toBe(buyer.address);
    expect((await record721(h))!.serial).toBe(serial);
    // A sale read at a later block is acted on.
    h.chain.setOwner(TOKEN_ID, third.address);
    h.chain.head = 201n;
    expect((await h.issuer.onPassUpdate(TOKEN_ID)).rotated).toEqual([TOKEN_ID]);
    expect((await record721(h))!.lastIssuedTo).toBeNull();
  });

  it("a pass claimed right after the mint is not voided by a node that has not reached the mint", async () => {
    const h = harness721();
    const minter = newSigner();
    h.chain.head = 200n;
    h.chain.setOwner(TOKEN_ID, minter.address);
    expect((await claim(h, minter)).res.status).toBe(200);
    const pushes = h.notified.length;
    h.chain.lag = { head: 199n, owner: null, user: null };
    expect((await h.issuer.onPassUpdate(TOKEN_ID)).burned).toEqual([]);
    h.chain.lag = null;
    expect(h.notified).toHaveLength(pushes);
    expect((await record721(h))!.lastIssuedTo).toBe(minter.address);
    // A burn read at a later block is acted on.
    h.chain.setOwner(TOKEN_ID, null);
    h.chain.head = 201n;
    expect((await h.issuer.onPassUpdate(TOKEN_ID)).burned).toEqual([TOKEN_ID]);
  });

  it("a claim whose head is named by a node behind the sale is not refused as not the owner", async () => {
    const h = harness721();
    const seller = newSigner();
    const buyer = newSigner();
    h.chain.head = 200n;
    h.chain.setOwner(TOKEN_ID, buyer.address);
    // The head and the read at it come from a node at 199 on the first try.
    const named = h.chain.blockNumber;
    const owner = h.chain.ownerOf.bind(h.chain);
    let behind = true;
    h.chain.blockNumber = async () => (behind ? 199n : named());
    h.chain.ownerOf = async (token: TokenRef, blockNumber?: bigint) => {
      if (blockNumber === 199n) {
        behind = false;
        return seller.address;
      }
      return owner(token, blockNumber);
    };
    expect((await claim(h, buyer)).res.status).toBe(200);
    expect((await record721(h))!.issuedAtBlock).toBe("200");
  });
});

describe("post 29: rental4907 ends a rental by the contract's answer", () => {
  const token: TokenRef = { chainId: 1, contract: CONTRACT, tokenId: TOKEN_ID, standard: "erc721" } as TokenRef;
  const house = newSigner();
  const guest = newSigner();
  const expires = 1_800_000_000n;
  // The contract's own answer: `expires >= block.timestamp ? user : 0`. Until
  // a block later than `expires` exists it answers the guest.
  const reader = {
    ownerOf: async () => house.address,
    userOf: async () => ({ user: guest.address, expires }),
  } as unknown as ChainReader;
  const ask = (now: number, account: Address, options: Parameters<typeof rental4907>[0] = {}) =>
    rental4907(options).evaluate({ token, account, action: "acquire", reader, now });

  it("agrees with the contract at the expires second itself", async () => {
    expect((await ask(Number(expires) * 1000, guest.address)).decision).toBe("allow");
    expect((await ask(Number(expires) * 1000, house.address)).decision).toBe("deny");
  });

  it("agrees with the contract after the expires second while no later block exists", async () => {
    expect((await ask(Number(expires) * 1000 + 2500, guest.address)).decision).toBe("allow");
  });

  it('with expiry "clock" the issuer\'s clock also ends it, for a contract that keeps answering the user', async () => {
    expect((await ask(Number(expires) * 1000 - 1, guest.address, { expiry: "clock" })).decision).toBe("allow");
    expect((await ask(Number(expires) * 1000, guest.address, { expiry: "clock" })).decision).toBe("abstain");
    expect((await ask(Number(expires) * 1000, house.address, { expiry: "clock" })).decision).toBe("allow");
  });

  it("refuses an unknown expiry setting", () => {
    expect(() => rental4907({ expiry: "block" as never })).toThrow(/invalid expiry/);
  });
});
