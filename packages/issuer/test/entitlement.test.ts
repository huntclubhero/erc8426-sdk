import { describe, expect, it } from "vitest";
import { tokenRef } from "@erc8426/core";
import { anyOf, checkEntitlement, delegateRegistry, minimumBalance, ownerOnly, rental4907, type ChainReader, type EntitlementPolicy } from "@erc8426/issuer";

import { CONTRACT, FakeChain, TOKEN_ID, buildHarness, claim, newSigner } from "./helpers.js";

const NOW = Date.UTC(2026, 7, 7, 15, 4, 5);
const token = tokenRef(1, CONTRACT, TOKEN_ID);
const inAnHour = BigInt(Math.floor(NOW / 1000) + 3600);
const anHourAgo = BigInt(Math.floor(NOW / 1000) - 3600);

function setup() {
  const chain = new FakeChain();
  const owner = newSigner().address;
  const renter = newSigner().address;
  const delegate = newSigner().address;
  chain.setOwner(TOKEN_ID, owner);
  const check = (policy: EntitlementPolicy, account: string, action = "feed") =>
    checkEntitlement(policy, { token, account: account as `0x${string}`, action, reader: chain, now: NOW });
  return { chain, owner, renter, delegate, check };
}

describe("ownerOnly", () => {
  it("entitles the owner and no one else", async () => {
    const { owner, renter, check } = setup();
    expect(await check(ownerOnly(), owner)).toEqual({ entitled: true, via: "owner" });
    expect((await check(ownerOnly(), renter)).entitled).toBe(false);
  });

  it("entitles no one for a token with no owner", async () => {
    const { chain, owner, check } = setup();
    chain.setOwner(TOKEN_ID, null);
    expect((await check(ownerOnly(), owner)).entitled).toBe(false);
  });

  it("reads fresh on every call", async () => {
    const { chain, owner, check } = setup();
    await check(ownerOnly(), owner);
    chain.setOwner(TOKEN_ID, newSigner().address);
    expect((await check(ownerOnly(), owner)).entitled).toBe(false);
    expect(chain.reads).toBe(2);
  });

  it("propagates a failed read instead of refusing", async () => {
    const { chain, owner, check } = setup();
    chain.failing = true;
    await expect(check(ownerOnly(), owner)).rejects.toThrow();
  });
});

describe("rental4907", () => {
  it("an active rental is exclusive of the owner for the actions it covers", async () => {
    const { chain, owner, renter, check } = setup();
    chain.setUser(TOKEN_ID, renter, inAnHour);
    expect(await check(rental4907(), renter)).toEqual({ entitled: true, via: "rental" });
    expect(await check(rental4907(), owner)).toEqual({ entitled: false, reason: "rented" });
  });

  it("an expired rental falls back to the owner", async () => {
    const { chain, owner, renter, check } = setup();
    chain.setUser(TOKEN_ID, renter, anHourAgo);
    expect(await check(rental4907(), owner)).toEqual({ entitled: true, via: "owner" });
    expect((await check(rental4907(), renter)).entitled).toBe(false);
  });

  it("covers only the listed actions; others stay with the owner", async () => {
    const { chain, owner, renter, check } = setup();
    chain.setUser(TOKEN_ID, renter, inAnHour);
    const policy = rental4907({ actions: ["feed"] });
    expect((await check(policy, owner, "rotate")).entitled).toBe(true);
    expect((await check(policy, renter, "rotate")).entitled).toBe(false);
    expect((await check(policy, owner, "feed")).entitled).toBe(false);
  });

  it("non-exclusive lets owner and renter act at once", async () => {
    const { chain, owner, renter, check } = setup();
    chain.setUser(TOKEN_ID, renter, inAnHour);
    const policy = rental4907({ exclusive: false });
    expect((await check(policy, owner)).entitled).toBe(true);
    expect((await check(policy, renter)).entitled).toBe(true);
  });

  it("refuses to run on a reader without userOf", async () => {
    const { owner } = setup();
    const bare = { ownerOf: async () => owner as `0x${string}` };
    await expect(checkEntitlement(rental4907(), { token, account: owner as `0x${string}`, action: "feed", reader: bare, now: NOW })).rejects.toThrow(/userOf/);
  });
});

describe("delegateRegistry", () => {
  it("is additive: the owner and the owner's delegate are both entitled", async () => {
    const { chain, owner, delegate, check } = setup();
    chain.delegate(owner as `0x${string}`, delegate as `0x${string}`);
    expect(await check(delegateRegistry(), owner)).toEqual({ entitled: true, via: "owner" });
    expect(await check(delegateRegistry(), delegate)).toEqual({ entitled: true, via: "delegate" });
    expect((await check(delegateRegistry(), newSigner().address)).entitled).toBe(false);
  });

  it("follows the current owner: a delegation from a previous owner stops counting on transfer", async () => {
    const { chain, owner, delegate, check } = setup();
    chain.delegate(owner as `0x${string}`, delegate as `0x${string}`);
    chain.setOwner(TOKEN_ID, newSigner().address);
    expect((await check(delegateRegistry(), delegate)).entitled).toBe(false);
  });
});

describe("anyOf precedence", () => {
  it("an exclusive rental's veto overrides delegation", async () => {
    const { chain, owner, renter, delegate, check } = setup();
    chain.delegate(owner as `0x${string}`, delegate as `0x${string}`);
    chain.setUser(TOKEN_ID, renter, inAnHour);
    const policy = anyOf(delegateRegistry(), rental4907());
    expect((await check(policy, renter)).entitled).toBe(true);
    expect((await check(policy, owner)).entitled).toBe(false);
    expect((await check(policy, delegate)).entitled).toBe(false);
  });

  it("with no active rental, owner and delegate are both entitled", async () => {
    const { chain, owner, delegate, check } = setup();
    chain.delegate(owner as `0x${string}`, delegate as `0x${string}`);
    const policy = anyOf(rental4907(), delegateRegistry());
    expect((await check(policy, owner)).entitled).toBe(true);
    expect(await check(policy, delegate)).toEqual({ entitled: true, via: "delegate" });
  });

  it("a failed read in any policy propagates", async () => {
    const { chain, owner, check } = setup();
    chain.failing = true;
    await expect(check(anyOf(ownerOnly(), delegateRegistry()), owner)).rejects.toThrow();
  });
});

describe("entitlement through the issuer", () => {
  it("a renter claims the gated pass; the owner is refused 403 during the rental", async () => {
    const h = buildHarness({ entitlement: rental4907() });
    const owner = newSigner();
    const renter = newSigner();
    h.chain.setOwner(TOKEN_ID, owner.address);
    h.chain.setUser(TOKEN_ID, renter.address, BigInt(Math.floor(h.clock.now() / 1000) + 3600));
    expect((await claim(h, renter)).res.status).toBe(200);
    expect((await claim(h, owner)).res.status).toBe(403);
    // The rental ends; the owner's first claim rotates the renter's links away.
    h.clock.advance(3_601_000);
    const back = await claim(h, owner);
    expect(back.res.status).toBe(200);
  });
});

describe("minimumBalance (ERC-1155 binding, working draft)", () => {
  const id = tokenRef(1, CONTRACT, TOKEN_ID, "erc1155");

  function ledger() {
    const balances = new Map<string, bigint>();
    let failing = false;
    let reads = 0;
    const reader: ChainReader = {
      async ownerOf() {
        throw new Error("an ERC-1155 id has no owner");
      },
      async balanceOf(token, account) {
        reads++;
        if (failing) throw new Error("rpc unavailable");
        return balances.get(`${token.tokenId}:${account.toLowerCase()}`) ?? 0n;
      },
    };
    const set = (account: string, value: bigint) => balances.set(`${TOKEN_ID}:${account.toLowerCase()}`, value);
    const check = (policy: EntitlementPolicy, account: string) =>
      checkEntitlement(policy, { token: id, account: account as `0x${string}`, action: "acquire", reader, now: NOW });
    return { set, check, fail: () => (failing = true), reads: () => reads };
  }

  it("entitles every account at or above the minimum, each on its own balance", async () => {
    const { set, check } = ledger();
    const a = newSigner().address;
    const b = newSigner().address;
    const c = newSigner().address;
    set(a, 1n);
    set(b, 5n);
    expect(await check(minimumBalance(), a)).toEqual({ entitled: true, via: "balance" });
    expect(await check(minimumBalance(), b)).toEqual({ entitled: true, via: "balance" });
    expect((await check(minimumBalance(), c)).entitled).toBe(false);
  });

  it("selling one of three keeps the seller entitled at a minimum of 1 and not at a minimum of 3", async () => {
    const { set, check } = ledger();
    const seller = newSigner().address;
    set(seller, 3n);
    expect((await check(minimumBalance({ minimum: 3 }), seller)).entitled).toBe(true);
    set(seller, 2n);
    expect((await check(minimumBalance(), seller)).entitled).toBe(true);
    expect((await check(minimumBalance({ minimum: 3 }), seller)).entitled).toBe(false);
  });

  it("reads fresh on every call: 1 to 0 to 1 is refused in the middle and entitled again after", async () => {
    const { set, check, reads } = ledger();
    const holder = newSigner().address;
    set(holder, 1n);
    expect((await check(minimumBalance(), holder)).entitled).toBe(true);
    set(holder, 0n);
    expect((await check(minimumBalance(), holder)).entitled).toBe(false);
    set(holder, 1n);
    expect((await check(minimumBalance(), holder)).entitled).toBe(true);
    expect(reads()).toBe(3);
  });

  it("throws when the read cannot be taken, so the issuer answers 503 and not 403", async () => {
    const { set, check, fail } = ledger();
    const holder = newSigner().address;
    set(holder, 1n);
    fail();
    await expect(check(minimumBalance(), holder)).rejects.toThrow(/rpc unavailable/);
  });

  it("refuses a minimum below 1 and a reader that cannot read balances", async () => {
    expect(() => minimumBalance({ minimum: 0 })).toThrow(/at least 1/);
    expect(() => minimumBalance({ minimum: -1n })).toThrow(/at least 1/);
    expect(() => minimumBalance({ minimum: 1.5 })).toThrow(/invalid minimum/);
    const { chain, owner } = setup();
    await expect(
      checkEntitlement(minimumBalance(), { token: id, account: owner as `0x${string}`, action: "acquire", reader: chain, now: NOW }),
    ).rejects.toThrow(/needs a ChainReader with balanceOf/);
  });
});
