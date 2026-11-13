import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { assetId, parseChallenge, tokenRef, type TokenRef } from "@erc8426/core";
import { IssuerConfigError, kvStores, memoryKv, watchTransfers1155, type CreateIssuerOptions, type PassRecord } from "@erc8426/issuer";

import { CONTRACT, FakeChain, buildHarness, claim, newSigner, proof, signChallenge, type Harness } from "./helpers.js";

/// The ERC-1155 binding (working draft): a pass per id and holding account,
///  entitlement by a fresh balanceOf against a minimum, and no single owner.

const ID = "77";

/// Balances per id and account, with the balance as of a named block for the
///  read the holdings check takes at a transfer's block.
class FakeChain1155 extends FakeChain {
  balances = new Map<string, bigint>();
  atBlock = new Map<string, bigint>();
  private key = (id: string, account: string) => `${id}:${account.toLowerCase()}`;
  setBalance(id: string, account: Address, balance: bigint): void {
    this.balances.set(this.key(id, account), balance);
  }
  setBalanceAt(block: bigint, id: string, account: Address, balance: bigint): void {
    this.atBlock.set(`${block}:${this.key(id, account)}`, balance);
  }
  /// The newest block. Undefined stands for a reader that cannot tell.
  head: bigint | undefined = undefined;
  blockNumber = async (): Promise<bigint> => {
    if (this.head === undefined) throw new Error("no block number");
    return this.head;
  };
  async balanceOf(token: TokenRef, account: Address, blockNumber?: bigint): Promise<bigint> {
    this.reads++;
    if (this.failing) throw new Error("rpc unavailable");
    const k = this.key(token.tokenId, account);
    if (blockNumber !== undefined) return this.atBlock.get(`${blockNumber}:${k}`) ?? this.balances.get(k) ?? 0n;
    return this.balances.get(k) ?? 0n;
  }
  override async ownerOf(): Promise<Address | null> {
    throw new Error("ownerOf must never be read under the ERC-1155 binding");
  }
}

type H = Harness & { chain: FakeChain1155 };

function harness(overrides: Partial<CreateIssuerOptions> = {}): H {
  const chain = new FakeChain1155();
  const h = buildHarness({
    standard: "erc1155",
    chain,
    render: (ctx) => ({
      serial: ctx.serial,
      organizationName: "Example",
      description: ctx.dark ? "dark" : ctx.superseded ? "superseded" : "live",
      title: "Member",
      links: Object.entries(ctx.links).map(([key, url]) => ({ key, label: key, url })),
    }),
    ...overrides,
  });
  // buildHarness reports its own chain; the issuer reads this one.
  return { ...h, chain };
}

/// Every action signed: no capability links, so a lost holding goes dark.
function signedOnly(overrides: Partial<CreateIssuerOptions> = {}): H {
  return harness({
    actions: { levelUp: { description: "Level up", execute: () => ({ ok: true }) } },
    capability: { enabled: false },
    ...overrides,
  });
}

async function linksOf(h: H, account: Address, id = ID): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [action, u] of Object.entries(await h.issuer.capabilityLinksFor(id, account))) out[action] = new URL(u).pathname;
  return out;
}

async function recordOf(h: H, account: Address, id = ID): Promise<PassRecord | null> {
  return h.issuer.stores.passes.get(`${id}:${account.toLowerCase()}`);
}

describe("ERC-1155 binding: configuration", () => {
  it("defaults to retire with capability actions and dark without", () => {
    expect(harness().issuer.config.lostEntitlement).toBe("retire");
    expect(signedOnly().issuer.config.lostEntitlement).toBe("dark");
    expect(signedOnly({ lostEntitlement: "retire" }).issuer.config.lostEntitlement).toBe("retire");
  });

  it("refuses a dark pass that would carry a capability link", () => {
    expect(() => harness({ lostEntitlement: "dark" })).toThrow(IssuerConfigError);
  });

  it("refuses the public configuration, which this draft does not build", () => {
    expect(() => harness({ mode: "public" })).toThrow(/requires mode "gated"/);
  });

  it("refuses a pass store that cannot list the accounts it issued to", () => {
    const passes = { get: async () => null, put: async () => undefined };
    expect(() => harness({ stores: { passes } })).toThrow(/accounts\(tokenId\)/);
  });

  it("leaves an ERC-721 issuer as it was", () => {
    const h = buildHarness();
    expect(h.issuer.config.standard).toBe("erc721");
    return expect(h.issuer.checkHoldings(ID)).rejects.toThrow(/erc1155/);
  });
});

describe("ERC-1155 binding: the challenge and the proof", () => {
  it("names the token in the erc1155 namespace", async () => {
    const h = harness();
    const alice = newSigner();
    const { message } = await signChallenge(h, alice, ID);
    expect(message).toContain(assetId(tokenRef(1, CONTRACT, ID, "erc1155")));
    expect(parseChallenge(message)?.token?.standard).toBe("erc1155");
  });

  it("refuses a proof that names the same contract and id as ERC-721", async () => {
    const h = harness();
    const alice = newSigner();
    h.chain.setBalance(ID, alice.address, 1n);
    const res = await h.get(`/wallet-pass/${ID}/challenge?address=${alice.address}`);
    const { message } = (await res.json()) as { message: string };
    const as721 = message.replace("/erc1155:", "/erc721:");
    expect(as721).not.toBe(message);
    const refused = await h.get(`/wallet-pass/${ID}`, proof({ message: as721, signature: await alice.signMessage({ message: as721 }) }));
    expect(((await refused.json()) as { error: string }).error).toBe("binding_mismatch");
    expect(refused.status).toBe(400);
  });

  it("refuses an account with no balance, and admits it once it holds", async () => {
    const h = harness();
    const alice = newSigner();
    const refused = await claim(h, alice, ID);
    expect(refused.res.status).toBe(403);
    expect(refused.body.error).toBe("not_owner");
    h.chain.setBalance(ID, alice.address, 1n);
    expect((await claim(h, alice, ID)).res.status).toBe(200);
  });

  it("honors a documented minimum above one", async () => {
    const { minimumBalance } = await import("@erc8426/issuer");
    const h = harness({ entitlement: minimumBalance({ minimum: 3 }) });
    const alice = newSigner();
    h.chain.setBalance(ID, alice.address, 2n);
    expect((await claim(h, alice, ID)).res.status).toBe(403);
    h.chain.setBalance(ID, alice.address, 3n);
    expect((await claim(h, alice, ID)).res.status).toBe(200);
  });

  it("answers 503 and never 403 when the balance read cannot be taken", async () => {
    const h = harness();
    const alice = newSigner();
    h.chain.setBalance(ID, alice.address, 1n);
    const p = await signChallenge(h, alice, ID);
    h.chain.failing = true;
    const res = await h.get(`/wallet-pass/${ID}`, proof(p));
    expect(res.status).toBe(503);
  });
});

describe("ERC-1155 binding: one pass per id and account", () => {
  it("gives two holders of one id two passes, and neither claim disturbs the other", async () => {
    const h = harness();
    const alice = newSigner();
    const bob = newSigner();
    h.chain.setBalance(ID, alice.address, 1n);
    h.chain.setBalance(ID, bob.address, 5n);
    expect((await claim(h, alice, ID)).res.status).toBe(200);
    const aliceLinks = await linksOf(h, alice.address);
    expect((await claim(h, bob, ID)).res.status).toBe(200);
    const bobLinks = await linksOf(h, bob.address);

    const a = (await recordOf(h, alice.address))!;
    const b = (await recordOf(h, bob.address))!;
    expect(a.serial).not.toBe(b.serial);
    expect(a.lastIssuedTo).toBe(alice.address);
    expect(b.lastIssuedTo).toBe(bob.address);
    expect(aliceLinks.feed).not.toBe(bobLinks.feed);
    // Under ERC-721 the second account's claim supersedes the first pass.
    expect(h.notified).toHaveLength(0);
    expect(await linksOf(h, alice.address)).toEqual(aliceLinks);

    // Each link acts for the account it was issued to.
    expect((await h.post(aliceLinks.feed!, {})).status).toBe(200);
    expect((await h.post(bobLinks.feed!, {})).status).toBe(200);
    expect(h.executed.map((e) => e.account)).toEqual([alice.address, bob.address]);
    expect(h.executed[0]!.token.standard).toBe("erc1155");
  });

  it("returns the same pass to an account that claims again", async () => {
    const h = harness();
    const alice = newSigner();
    h.chain.setBalance(ID, alice.address, 2n);
    const first = await claim(h, alice, ID);
    const second = await claim(h, alice, ID);
    expect(second.body.formats).toEqual(first.body.formats);
  });

  it("keeps the same account's passes of two ids apart", async () => {
    const h = harness();
    const alice = newSigner();
    h.chain.setBalance("1", alice.address, 1n);
    h.chain.setBalance("2", alice.address, 1n);
    await claim(h, alice, "1");
    await claim(h, alice, "2");
    expect((await recordOf(h, alice.address, "1"))!.serial).not.toBe((await recordOf(h, alice.address, "2"))!.serial);
  });
});

describe("ERC-1155 binding: rotation follows the minimum, not the transfer", () => {
  it("leaves the links alone when one of three is sold", async () => {
    const h = harness();
    const alice = newSigner();
    const bob = newSigner();
    h.chain.setBalance(ID, alice.address, 3n);
    await claim(h, alice, ID);
    const links = await linksOf(h, alice.address);
    h.chain.setBalance(ID, alice.address, 2n);
    h.chain.setBalance(ID, bob.address, 1n);
    expect(await h.issuer.onTransfer(ID, alice.address, bob.address)).toBe(false);
    expect(await linksOf(h, alice.address)).toEqual(links);
    expect(h.notified).toHaveLength(0);
    expect((await h.post(links.feed!, {})).status).toBe(200);
  });

  it("retires the seller's pass when the balance crosses below the minimum, and only the seller's", async () => {
    const h = harness();
    const alice = newSigner();
    const bob = newSigner();
    const carol = newSigner();
    h.chain.setBalance(ID, alice.address, 1n);
    h.chain.setBalance(ID, bob.address, 1n);
    await claim(h, alice, ID);
    await claim(h, bob, ID);
    const aliceLinks = await linksOf(h, alice.address);
    const bobLinks = await linksOf(h, bob.address);
    const aliceSerial = (await recordOf(h, alice.address))!.serial;

    h.chain.setBalance(ID, alice.address, 0n);
    h.chain.setBalance(ID, carol.address, 1n);
    // Before anything is observed, the fresh read already refuses the link.
    const beforeRotation = await h.post(aliceLinks.feed!, {});
    expect(beforeRotation.status).toBe(403);
    expect(((await beforeRotation.json()) as { error: string }).error).toBe("not_owner");

    expect(await h.issuer.onTransfer(ID, alice.address, carol.address)).toBe(true);
    expect((await h.post(aliceLinks.feed!, {})).status).toBe(404);
    expect((await recordOf(h, alice.address))!.lastIssuedTo).toBeNull();
    // The old serial is pushed as superseded, to the seller's pass alone.
    expect(h.notified.length).toBeGreaterThan(0);
    for (const n of h.notified) {
      expect(n.ctx.content.serial).toBe(aliceSerial);
      expect(n.ctx.content.voided).toBe(true);
      expect(n.ctx.owner).toBe(alice.address);
    }
    expect(await linksOf(h, bob.address)).toEqual(bobLinks);
    expect((await h.post(bobLinks.feed!, {})).status).toBe(200);
  });

  it("treats the return of a retired account as a first claim with new URLs", async () => {
    const h = harness();
    const alice = newSigner();
    h.chain.setBalance(ID, alice.address, 1n);
    const first = await claim(h, alice, ID);
    const oldLinks = await linksOf(h, alice.address);
    const oldSerial = (await recordOf(h, alice.address))!.serial;

    h.chain.setBalance(ID, alice.address, 0n);
    await h.issuer.checkHoldings(ID);
    h.chain.setBalance(ID, alice.address, 1n);
    const again = await claim(h, alice, ID);
    expect(again.res.status).toBe(200);
    const record = (await recordOf(h, alice.address))!;
    expect(record.serial).not.toBe(oldSerial);
    expect(record.lastIssuedTo).toBe(alice.address);
    const newLinks = await linksOf(h, alice.address);
    expect(newLinks.feed).not.toBe(oldLinks.feed);
    expect(again.body.formats.apple).not.toBe(first.body.formats.apple);
    expect((await h.post(oldLinks.feed!, {})).status).toBe(404);
    expect((await h.get(new URL(first.body.formats.apple).pathname)).status).toBe(404);
    expect((await h.post(newLinks.feed!, {})).status).toBe(200);
  });

  it("finds who fell below the minimum from the issued accounts alone, with no event", async () => {
    const h = harness();
    const alice = newSigner();
    const bob = newSigner();
    h.chain.setBalance(ID, alice.address, 1n);
    h.chain.setBalance(ID, bob.address, 2n);
    await claim(h, alice, ID);
    await claim(h, bob, ID);
    h.chain.setBalance(ID, alice.address, 0n);
    const summary = await h.issuer.checkHoldings(ID);
    expect(summary).toEqual({ checked: 2, retired: [alice.address], dark: [], revived: [] });
    // A second pass over the same state does nothing more.
    expect(await h.issuer.checkHoldings(ID)).toEqual({ checked: 1, retired: [], dark: [], revived: [] });
  });

  it("needs no trigger for the receiver: its first claim serves it", async () => {
    const h = harness();
    const alice = newSigner();
    const bob = newSigner();
    h.chain.setBalance(ID, alice.address, 2n);
    await claim(h, alice, ID);
    h.chain.setBalance(ID, alice.address, 1n);
    h.chain.setBalance(ID, bob.address, 1n);
    expect(await h.issuer.onTransfer(ID, alice.address, bob.address)).toBe(false);
    expect(await recordOf(h, bob.address)).toBeNull();
    expect((await claim(h, bob, ID)).res.status).toBe(200);
  });

  it("retires a balance that left and came back between two reads when the log's block is given", async () => {
    const h = harness();
    const alice = newSigner();
    const bob = newSigner();
    h.chain.setBalance(ID, alice.address, 1n);
    await claim(h, alice, ID);
    // Out at block 100, back before the issuer looks: the fresh read holds.
    h.chain.setBalanceAt(100n, ID, alice.address, 0n);
    expect(await h.issuer.onTransfer(ID, alice.address, bob.address)).toBe(false);
    expect(await h.issuer.onTransfer(ID, alice.address, bob.address, 100n)).toBe(true);
    expect((await recordOf(h, alice.address))!.lastIssuedTo).toBeNull();
  });

  it("does not hold a transfer log against a pass that was claimed after it", async () => {
    const h = harness();
    const alice = newSigner();
    const bob = newSigner();
    h.chain.setBalance(ID, alice.address, 1n);
    h.chain.head = 90n;
    await claim(h, alice, ID);
    // Out at block 100: seen at once, and the pass is retired.
    h.chain.setBalance(ID, alice.address, 0n);
    h.chain.setBalanceAt(100n, ID, alice.address, 0n);
    expect(await h.issuer.onTransfer(ID, alice.address, bob.address, 100n)).toBe(true);
    // Back at block 101, and a new claim at block 105.
    h.chain.setBalance(ID, alice.address, 1n);
    h.chain.head = 105n;
    expect((await claim(h, alice, ID)).res.status).toBe(200);
    expect((await recordOf(h, alice.address))!.issuedAtBlock).toBe("105");
    const links = await linksOf(h, alice.address);
    // The log of block 100 is delivered again, late. The new pass stands.
    expect(await h.issuer.onTransfer(ID, alice.address, bob.address, 100n)).toBe(false);
    expect(await linksOf(h, alice.address)).toEqual(links);
    expect((await recordOf(h, alice.address))!.lastIssuedTo).toBe(alice.address);
    // A dip after the claim still counts.
    h.chain.setBalanceAt(110n, ID, alice.address, 0n);
    expect(await h.issuer.onTransfer(ID, alice.address, bob.address, 110n)).toBe(true);
    expect((await recordOf(h, alice.address))!.lastIssuedTo).toBeNull();
  });

  it("with a reader that cannot tell the block, every log's block is read as before", async () => {
    const h = harness();
    const alice = newSigner();
    const bob = newSigner();
    h.chain.setBalance(ID, alice.address, 1n);
    await claim(h, alice, ID);
    expect((await recordOf(h, alice.address))!.issuedAtBlock).toBeUndefined();
    h.chain.setBalanceAt(100n, ID, alice.address, 0n);
    expect(await h.issuer.onTransfer(ID, alice.address, bob.address, 100n)).toBe(true);
  });

  it("changes nothing for an account whose read failed, and says so", async () => {
    const h = harness();
    const alice = newSigner();
    h.chain.setBalance(ID, alice.address, 1n);
    await claim(h, alice, ID);
    const links = await linksOf(h, alice.address);
    h.chain.failing = true;
    await expect(h.issuer.checkHoldings(ID)).rejects.toThrow(/could not be taken/);
    h.chain.failing = false;
    expect(await linksOf(h, alice.address)).toEqual(links);
    expect((await recordOf(h, alice.address))!.lastIssuedTo).toBe(alice.address);
  });
});

describe("ERC-1155 binding: a signed path pass goes dark and comes back", () => {
  it("keeps the serial, says it is dark, retires the acquisition URL, and returns", async () => {
    const h = signedOnly();
    const alice = newSigner();
    h.chain.setBalance(ID, alice.address, 1n);
    const first = await claim(h, alice, ID);
    const serial = (await recordOf(h, alice.address))!.serial;
    const download = new URL(first.body.formats.apple).pathname;
    expect((await h.get(download)).status).toBe(200);

    h.chain.setBalance(ID, alice.address, 0n);
    expect(await h.issuer.checkHoldings(ID)).toEqual({ checked: 1, retired: [], dark: [alice.address], revived: [] });
    let record = (await recordOf(h, alice.address))!;
    expect(record.dark).toBe(true);
    expect(record.serial).toBe(serial);
    expect(record.lastIssuedTo).toBe(alice.address);
    expect(h.notified.length).toBeGreaterThan(0);
    for (const n of h.notified) {
      expect(n.ctx.content.serial).toBe(serial);
      expect(n.ctx.content.description).toBe("dark");
      expect(n.ctx.content.voided).toBeUndefined();
    }
    // The acquisition URL was a possession proof for the download: retired.
    expect((await h.get(download)).status).toBe(404);
    // A second look at a dark pass pushes nothing more.
    const pushes = h.notified.length;
    expect(await h.issuer.checkHoldings(ID)).toEqual({ checked: 1, retired: [], dark: [], revived: [] });
    expect(h.notified).toHaveLength(pushes);

    h.chain.setBalance(ID, alice.address, 1n);
    expect(await h.issuer.checkHoldings(ID)).toEqual({ checked: 1, retired: [], dark: [], revived: [alice.address] });
    record = (await recordOf(h, alice.address))!;
    expect(record.dark).toBeUndefined();
    expect(record.serial).toBe(serial);
    expect(h.notified.at(-1)!.ctx.content.description).toBe("live");

    const again = await claim(h, alice, ID);
    const fresh = new URL(again.body.formats.apple).pathname;
    expect(fresh).not.toBe(download);
    expect((await h.get(fresh)).status).toBe(200);
    expect((await h.get(download)).status).toBe(404);
  });

  it("brings a dark pass back on the account's own claim", async () => {
    const h = signedOnly();
    const alice = newSigner();
    h.chain.setBalance(ID, alice.address, 1n);
    await claim(h, alice, ID);
    h.chain.setBalance(ID, alice.address, 0n);
    await h.issuer.onTransfer(ID, alice.address, newSigner().address);
    expect((await recordOf(h, alice.address))!.dark).toBe(true);
    expect((await claim(h, alice, ID)).res.status).toBe(403);
    h.chain.setBalance(ID, alice.address, 1n);
    expect((await claim(h, alice, ID)).res.status).toBe(200);
    expect((await recordOf(h, alice.address))!.dark).toBeUndefined();
    expect(h.notified.at(-1)!.ctx.content.description).toBe("live");
  });

  it("refuses a signed action while the balance is short, dark or not", async () => {
    const h = signedOnly();
    const alice = newSigner();
    h.chain.setBalance(ID, alice.address, 1n);
    await claim(h, alice, ID);
    const p = await signChallenge(h, alice, ID, "levelUp");
    h.chain.setBalance(ID, alice.address, 0n);
    const res = await h.post(`/wallet-pass/${ID}/actions/levelUp`, p);
    expect(res.status).toBe(403);
  });

  it("can be told to retire all the same", async () => {
    const h = signedOnly({ lostEntitlement: "retire" });
    const alice = newSigner();
    h.chain.setBalance(ID, alice.address, 1n);
    await claim(h, alice, ID);
    h.chain.setBalance(ID, alice.address, 0n);
    expect((await h.issuer.checkHoldings(ID)).retired).toEqual([alice.address]);
  });
});

describe("ERC-1155 binding: who can retire what", () => {
  it("lets a holder rotate its own links and nobody else's", async () => {
    const h = harness();
    const alice = newSigner();
    const bob = newSigner();
    h.chain.setBalance(ID, alice.address, 1n);
    h.chain.setBalance(ID, bob.address, 1n);
    await claim(h, alice, ID);
    await claim(h, bob, ID);
    const aliceLinks = await linksOf(h, alice.address);
    const bobLinks = await linksOf(h, bob.address);

    const p = await signChallenge(h, alice, ID, "rotate");
    const res = await h.post(`/wallet-pass/${ID}/rotate`, p);
    expect(res.status).toBe(200);
    expect((await h.post(aliceLinks.feed!, {})).status).toBe(404);
    expect((await linksOf(h, alice.address)).feed).not.toBe(aliceLinks.feed);
    expect((await recordOf(h, alice.address))!.lastIssuedTo).toBe(alice.address);
    expect(await linksOf(h, bob.address)).toEqual(bobLinks);
    expect((await h.post(bobLinks.feed!, {})).status).toBe(200);
    for (const n of h.notified) expect(n.ctx.owner).toBe(alice.address);
  });

  it("refuses a rotate proof from an account that holds nothing", async () => {
    const h = harness();
    const alice = newSigner();
    const mallory = newSigner();
    h.chain.setBalance(ID, alice.address, 1n);
    await claim(h, alice, ID);
    const links = await linksOf(h, alice.address);
    const p = await signChallenge(h, mallory, ID, "rotate");
    expect((await h.post(`/wallet-pass/${ID}/rotate`, p)).status).toBe(403);
    expect(await linksOf(h, alice.address)).toEqual(links);
  });

  it("rotates one account, or every issued pass of the id, from the issuer's own side", async () => {
    const h = harness();
    const alice = newSigner();
    const bob = newSigner();
    h.chain.setBalance(ID, alice.address, 1n);
    h.chain.setBalance(ID, bob.address, 1n);
    await claim(h, alice, ID);
    await claim(h, bob, ID);
    const a0 = await linksOf(h, alice.address);
    const b0 = await linksOf(h, bob.address);
    await h.issuer.rotate(ID, alice.address);
    expect((await linksOf(h, alice.address)).feed).not.toBe(a0.feed);
    expect(await linksOf(h, bob.address)).toEqual(b0);
    await h.issuer.rotate(ID);
    expect((await linksOf(h, bob.address)).feed).not.toBe(b0.feed);
  });
});

describe("ERC-1155 binding: PassUpdate reaches every pass of the id", () => {
  it("pushes to each issued account that still holds and retires the one that does not", async () => {
    const h = harness();
    const alice = newSigner();
    const bob = newSigner();
    const carol = newSigner();
    for (const s of [alice, bob, carol]) {
      h.chain.setBalance(ID, s.address, 1n);
      await claim(h, s, ID);
    }
    h.chain.setBalance("78", alice.address, 1n);
    await claim(h, alice, "78");
    h.chain.setBalance(ID, carol.address, 0n);

    h.clock.advance(5000);
    const summary = await h.issuer.onPassUpdate(ID);
    expect(summary.updated).toBe(3);
    expect(summary.rotated).toEqual([`${ID}:${carol.address}`]);
    const live = h.notified.filter((n) => n.ctx.content.description === "live");
    expect(new Set(live.map((n) => n.ctx.owner))).toEqual(new Set([alice.address, bob.address]));
    for (const n of live) expect(n.ctx.token.tokenId).toBe(ID);
    const dead = h.notified.filter((n) => n.ctx.content.voided);
    expect(new Set(dead.map((n) => n.ctx.owner))).toEqual(new Set([carol.address]));
  });

  it("serves an inclusive range", async () => {
    const h = harness();
    const alice = newSigner();
    for (const id of ["5", "6", "7"]) {
      h.chain.setBalance(id, alice.address, 1n);
      await claim(h, alice, id);
    }
    expect((await h.issuer.onPassUpdate(5, 6)).updated).toBe(2);
  });
});

describe("ERC-1155 binding: the transfer watcher", () => {
  it("reports each id a log moves once, with the log's block", async () => {
    const calls: unknown[][] = [];
    let onLogs: (logs: unknown[]) => Promise<void> = async () => undefined;
    const client = {
      watchContractEvent(parameters: { onLogs: typeof onLogs }) {
        onLogs = parameters.onLogs;
        return () => undefined;
      },
    };
    const issuer = {
      config: { contract: CONTRACT },
      onTransfer: async (...args: unknown[]) => {
        calls.push(args);
        return true;
      },
      onPassUpdate: async () => ({ updated: 0, burned: [], rotated: [] }),
    };
    watchTransfers1155({ client, issuer: issuer as never });
    const from = newSigner().address;
    const to = newSigner().address;
    await onLogs([
      { eventName: "TransferSingle", blockNumber: 10n, args: { from, to, id: 7n, value: 1n } },
      { eventName: "TransferBatch", blockNumber: 11n, args: { from, to, ids: [1n, 2n, 1n], values: [1n, 1n, 1n] } },
      { eventName: "TransferSingle", removed: true, blockNumber: 12n, args: { from, to, id: 9n, value: 1n } },
    ]);
    expect(calls).toEqual([
      [7n, from, to, 10n],
      [1n, from, to, 11n],
      [2n, from, to, 11n],
    ]);
  });
});

describe("ERC-1155 binding: the key-value stores", () => {
  it("keeps one row per id and account and lists the accounts of an id", async () => {
    const stores = kvStores(memoryKv(), { chainId: 1, contract: CONTRACT });
    const h = harness({ stores });
    const alice = newSigner();
    const bob = newSigner();
    h.chain.setBalance(ID, alice.address, 1n);
    h.chain.setBalance(ID, bob.address, 1n);
    await claim(h, alice, ID);
    await claim(h, bob, ID);
    await claim(h, alice, ID);
    expect(new Set(await stores.passes.accounts!(ID))).toEqual(new Set([alice.address, bob.address]));
    expect(await stores.passes.accounts!("78")).toEqual([]);
    expect((await recordOf(h, alice.address))!.account).toBe(alice.address);
    expect(await stores.passes.get(ID)).toBeNull();
    h.chain.setBalance(ID, bob.address, 0n);
    expect((await h.issuer.checkHoldings(ID)).retired).toEqual([bob.address]);
  });
});
