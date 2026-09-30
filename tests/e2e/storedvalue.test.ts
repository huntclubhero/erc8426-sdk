import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BaseError, ContractFunctionRevertedError, type Abi, type Address, type Hex } from "viem";
import { createWalletPassClient } from "@erc8426/client";
import { ActionError, IssuerConfigError, createIssuer, isRevert, type ActionContext, type Issuer } from "@erc8426/issuer";

import { deploy, googleProvider, newActor, send, startAnvil, startServer, type Actor, type Chain, type HttpServer } from "./harness.js";

const USD = 1_000_000n; // 6 decimals
const PER_TX = 5n * USD;
const DAILY = 12n * USD;

let chain: Chain;
let server: HttpServer;
let issuer: Issuer;
let usd: { address: Address; abi: Abi };
let card: { address: Address; abi: Abi };
let deployer: Actor, operator: Actor, owner: Actor, merchant: Actor, stranger: Actor;
let chargeLink: string;

/// The custom error a revert carried, for example BoundedActionValueTooHigh.
function revertName(e: unknown): string | undefined {
  const r = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
  return (r as ContractFunctionRevertedError | null)?.data?.errorName;
}

const balanceOf = (a: Address) => chain.publicClient.readContract({ ...usd, functionName: "balanceOf", args: [a] }) as Promise<bigint>;
const cardBalance = () => chain.publicClient.readContract({ ...card, functionName: "balanceOfCard", args: [1n] }) as Promise<bigint>;
const charge = (amount: bigint) =>
  fetch(chargeLink, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ params: { amount: amount.toString() } }) });

async function chargeAction(ctx: ActionContext) {
  const raw = (ctx.params as { amount?: unknown } | undefined)?.amount;
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,30}$/.test(raw)) throw new ActionError(400, "invalid_amount");
  try {
    const receipt = await send(chain, operator, card.address, card.abi, "charge", [BigInt(ctx.token.tokenId), BigInt(raw), merchant.address]);
    return { tx: receipt.transactionHash };
  } catch (e) {
    if (!isRevert(e)) throw e;
    // The chain, not the server, enforced the bound.
    throw new ActionError(429, "bounded_action_refused", revertName(e) ?? "reverted");
  }
}

beforeAll(async () => {
  chain = await startAnvil();
  [deployer, operator, owner, merchant, stranger] = await Promise.all([newActor(chain), newActor(chain), newActor(chain), newActor(chain), newActor(chain)]);
  server = await startServer();
  usd = await deploy(chain, deployer, "MockERC20", ["Test USD", "TUSD", 6]);
  card = await deploy(chain, deployer, "StoredValueCard", [`${server.baseUrl}/wallet-pass/`, deployer.address, usd.address, 3, PER_TX, DAILY, 10]);
  await send(chain, deployer, card.address, card.abi, "setActionOperator", [operator.address, true]);
  await send(chain, deployer, card.address, card.abi, "setMerchant", [merchant.address, true]);
  await send(chain, deployer, card.address, card.abi, "mint", [owner.address]);
  await send(chain, owner, usd.address, usd.abi, "mint", [owner.address, 100n * USD]);
  await send(chain, owner, usd.address, usd.abi, "approve", [card.address, 100n * USD]);
  await send(chain, owner, card.address, card.abi, "topUp", [1n, 100n * USD]);

  const chargeId = (await chain.publicClient.readContract({ ...card, functionName: "CHARGE" })) as Hex;
  const b = (await chain.publicClient.readContract({ ...card, functionName: "actionBound", args: [chargeId] })) as {
    maxPerWindow: number;
    windowSeconds: number;
    maxValuePerCall: bigint;
    maxValuePerWindow: bigint;
  };
  expect([b.maxValuePerCall, b.maxValuePerWindow]).toEqual([PER_TX, DAILY]);

  issuer = createIssuer({
    domain: server.domain,
    baseUrl: server.baseUrl,
    chainId: chain.publicClient.chain!.id,
    contract: card.address,
    mode: "gated",
    publicClient: chain.publicClient,
    providers: [googleProvider(server.baseUrl).provider],
    capability: { enabled: true },
    actions: {
      charge: {
        description: "Pay at a registered merchant",
        capability: true,
        bound: `At most ${b.maxValuePerCall} base units (6 decimals) per charge and ${b.maxValuePerWindow} per card per ${b.windowSeconds} second window, ${b.maxPerWindow} charges per window, paid only to registered merchants; fixed windows allow twice that inside one span; enforced on chain by BoundedAction.`,
        execute: chargeAction,
      },
    },
    render: ({ token, serial, links }) => ({
      serial,
      organizationName: "Card",
      description: `Card #${token.tokenId}`,
      title: "Card",
      links: Object.entries(links).map(([key, url]) => ({ key, label: key, url })),
    }),
  });
  server.setHandler((r) => issuer.handler(r));

  const client = createWalletPassClient({ publicClient: chain.publicClient });
  await client.getManifest({ contract: card.address, tokenId: 1n }, { signer: owner.account });
  chargeLink = (await issuer.capabilityLinksFor(1n)).charge!;
}, 120_000);

afterAll(async () => {
  await server?.close();
  await chain?.stop();
});

describe("StoredValueCard", () => {
  it("charges through the capability link within the per-transaction and daily caps", async () => {
    for (let i = 0; i < 2; i++) expect((await charge(PER_TX)).status).toBe(200);
    expect(await balanceOf(merchant.address)).toBe(2n * PER_TX);
    expect(await cardBalance()).toBe(100n * USD - 2n * PER_TX);
  }, 60_000);

  it("refuses a charge over the per-transaction cap on chain", async () => {
    const res = await charge(PER_TX + 1n);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "bounded_action_refused", message: "BoundedActionValueTooHigh" });
    expect(await balanceOf(merchant.address)).toBe(2n * PER_TX);
  });

  it("refuses a charge past the daily cap on chain, then allows exactly the remainder", async () => {
    const remaining = DAILY - 2n * PER_TX;
    const over = await charge(remaining + 1n);
    expect(over.status).toBe(429);
    expect(((await over.json()) as { message: string }).message).toBe("BoundedActionWindowCapExceeded");
    expect((await charge(remaining)).status).toBe(200);
    expect(await balanceOf(merchant.address)).toBe(DAILY);
    // The documented worst case of a leaked link is the daily cap, reached.
    expect((await charge(1n)).status).toBe(429);
  }, 60_000);

  it("refuses a malformed amount before touching the chain", async () => {
    const block = await chain.publicClient.getBlockNumber();
    expect((await charge(0n)).status).toBe(400);
    expect(await chain.publicClient.getBlockNumber()).toBe(block);
  });

  it("withdraw is owner only: the operator and a stranger revert, the owner succeeds", async () => {
    for (const who of [operator, stranger]) {
      const err = await send(chain, who, card.address, card.abi, "withdraw", [1n, USD, who.address]).catch((e: unknown) => e);
      expect(revertName(err)).toBe("CardNotOwner");
    }
    const before = await balanceOf(owner.address);
    await send(chain, owner, card.address, card.abi, "withdraw", [1n, 10n * USD, owner.address]);
    expect(await balanceOf(owner.address)).toBe(before + 10n * USD);
  }, 60_000);

  it("the issuer refuses withdraw as a capability action: an unbounded transfer never reaches a link", () => {
    expect(() =>
      createIssuer({
        domain: server.domain,
        baseUrl: server.baseUrl,
        chainId: 31337,
        contract: card.address,
        mode: "gated",
        publicClient: chain.publicClient,
        providers: [googleProvider(server.baseUrl).provider],
        capability: { enabled: true },
        actions: { withdraw: { description: "Withdraw", capability: true, bound: "none", transfersOrBurns: true, execute: () => null } },
        render: ({ serial }) => ({ serial, organizationName: "o", description: "d", title: "t" }),
      }),
    ).toThrowError(IssuerConfigError);
  });
});
