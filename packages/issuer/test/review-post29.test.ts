import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { TokenRef } from "@erc8426/core";
import { rental4907, type ChainReader, type CreateIssuerOptions, type PassRecord } from "@erc8426/issuer";

import { CONTRACT, FakeChain, TOKEN_ID, buildHarness, claim, newSigner, type Harness } from "./helpers.js";

/// Claims from a review of 0.5.1 (Magicians t/29358 post 29), each written
///  as the behaviour that should hold. A test that fails here reproduces the
///  claim.

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

// Claims 2 and 3 are reproduced below and NOT fixed: each is written as the
// behaviour that should hold and marked `fails`, so the suite says when one
// of them stops reproducing. They wait on a decision (whether the ERC-721
// path retires on the issuer's own read) and on a reader that can take
// ownerOf and userOf at a named block.
describe("post 29, claim 2: the ERC-721 path acts on one read in onPassUpdate", () => {
  it.fails("a renter who rents again keeps the pass when a node that has not seen the new setUser answers the PassUpdate", async () => {
    const h = buildHarness({ entitlement: rental4907() });
    const house = newSigner();
    const guest = newSigner();
    const nowSeconds = () => BigInt(Math.floor(h.clock.now() / 1000));
    h.chain.setOwner(TOKEN_ID, house.address);
    const firstExpiry = nowSeconds() + 180n;
    h.chain.setUser(TOKEN_ID, guest.address, firstExpiry);
    expect((await claim(h, guest)).res.status).toBe(200);
    const serial = (await h.issuer.stores.passes.get(TOKEN_ID))!.serial;
    // The rental ends by the clock. Nobody claims.
    h.clock.advance(200_000);
    // The guest rents again: setUser emits PassUpdate. The node the issuer
    // reaches for it has not seen that setUser and gives the old expiry.
    h.chain.setUser(TOKEN_ID, guest.address, nowSeconds() + 180n);
    const real = h.chain.userOf.bind(h.chain);
    h.chain.userOf = async () => ({ user: guest.address, expires: firstExpiry });
    await h.issuer.onPassUpdate(TOKEN_ID).catch(() => undefined);
    h.chain.userOf = real;
    const record = (await h.issuer.stores.passes.get(TOKEN_ID))!;
    expect(record.lastIssuedTo, "the pass was retired").toBe(guest.address);
    expect(record.serial).toBe(serial);
  });

  it.fails("a buyer who claims at once keeps the pass when a node that has not seen the sale answers a PassUpdate", async () => {
    const h = buildHarness();
    const seller = newSigner();
    const buyer = newSigner();
    h.chain.setOwner(TOKEN_ID, buyer.address);
    expect((await claim(h, buyer)).res.status).toBe(200);
    const serial = (await h.issuer.stores.passes.get(TOKEN_ID))!.serial;
    const real = h.chain.ownerOf.bind(h.chain);
    h.chain.ownerOf = async () => seller.address;
    await h.issuer.onPassUpdate(TOKEN_ID).catch(() => undefined);
    h.chain.ownerOf = real;
    const record = (await h.issuer.stores.passes.get(TOKEN_ID))!;
    expect(record.lastIssuedTo, "the pass was retired").toBe(buyer.address);
    expect(record.serial).toBe(serial);
  });
});

describe("post 29, claim 3: rental4907 ends the rental by the issuer's clock", () => {
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
  const ask = (now: number, account: Address) => rental4907().evaluate({ token, account, action: "acquire", reader, now });

  it.fails("agrees with the contract at the expires second itself", async () => {
    expect((await ask(Number(expires) * 1000, guest.address)).decision).toBe("allow");
  });

  it.fails("agrees with the contract after the expires second while no later block exists", async () => {
    expect((await ask(Number(expires) * 1000 + 2500, guest.address)).decision).toBe("allow");
  });
});
