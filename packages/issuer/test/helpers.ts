import { expect } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { GOOGLE_SAVE_URL_PREFIX, PKPASS_MEDIA_TYPE, proofHeaders, type PassContext, type TokenRef } from "@erc8426/core";
import {
  createIssuer,
  type ActionContext,
  type ChainReader,
  type CreateIssuerOptions,
  type Issuer,
  type IssuerProvider,
} from "@erc8426/issuer";

export const CONTRACT = getAddress("0x5F9B5a1cdED9d6B3f5E8a2C47B0e13d6A8F4c2e1");
export const BASE = "https://issuer.example";
export const TOKEN_ID = "412";

/// A controllable clock, starting at the instant of the spec's worked
///  example, 2026-08-07T15:04:05Z.
export function createClock(startMs: number = Date.UTC(2026, 7, 7, 15, 4, 5)) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/// A throwaway signer, generated at runtime. No key literal appears anywhere.
export function newSigner(): PrivateKeyAccount {
  return privateKeyToAccount(generatePrivateKey());
}

/// A chain stand-in. Ownership, rentals and delegations are set by tests and
///  can flip between challenge and action. `failReads` makes every read throw
///  (an RPC outage). `reads` counts calls so tests can prove freshness.
export class FakeChain implements ChainReader {
  owners = new Map<string, Address>();
  users = new Map<string, { user: Address; expires: bigint }>();
  delegations = new Set<string>();
  failing = false;
  reads = 0;

  setOwner(tokenId: string, owner: Address | null): void {
    if (owner === null) this.owners.delete(tokenId);
    else this.owners.set(tokenId, owner);
  }
  setUser(tokenId: string, user: Address, expires: bigint): void {
    this.users.set(tokenId, { user, expires });
  }
  delegate(from: Address, to: Address): void {
    this.delegations.add(`${from.toLowerCase()}>${to.toLowerCase()}`);
  }
  async ownerOf(token: TokenRef): Promise<Address | null> {
    this.reads++;
    if (this.failing) throw new Error("rpc unavailable");
    if (token.contract !== CONTRACT) return null;
    return this.owners.get(token.tokenId) ?? null;
  }
  async userOf(token: TokenRef): Promise<{ user: Address | null; expires: bigint }> {
    this.reads++;
    if (this.failing) throw new Error("rpc unavailable");
    const u = this.users.get(token.tokenId);
    return u ? { user: u.user, expires: u.expires } : { user: null, expires: 0n };
  }
  async checkDelegateForERC721(input: { to: Address; from: Address }): Promise<boolean> {
    this.reads++;
    if (this.failing) throw new Error("rpc unavailable");
    return this.delegations.has(`${input.from.toLowerCase()}>${input.to.toLowerCase()}`);
  }
}

export interface Notified {
  format: string;
  ctx: PassContext;
}

/// A Google-like URL provider and an Apple-like file provider, both
///  recording pushes.
export function fakeProviders(notified: Notified[]): IssuerProvider[] {
  return [
    {
      format: "google",
      async acquisitionUrl(ctx: PassContext) {
        return `${GOOGLE_SAVE_URL_PREFIX}${ctx.content.serial}`;
      },
      async notifyUpdate(ctx: PassContext) {
        notified.push({ format: "google", ctx });
      },
    },
    {
      format: "apple",
      async passFile(ctx: PassContext) {
        return { body: new TextEncoder().encode(`pkpass:${ctx.content.serial}:${ctx.owner}`), contentType: PKPASS_MEDIA_TYPE, filename: "pass.pkpass" };
      },
      async notifyUpdate(ctx: PassContext) {
        notified.push({ format: "apple", ctx });
      },
    },
  ];
}

export interface Harness {
  issuer: Issuer;
  chain: FakeChain;
  clock: ReturnType<typeof createClock>;
  executed: ActionContext[];
  notified: Notified[];
  errors: unknown[];
  get(path: string, headers?: Record<string, string>): Promise<Response>;
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
}

/// Assemble an issuer with the test collaborators: fake chain, EOA-only
///  verifier (the default without a publicClient), controllable clock, two
///  capability actions (feed, water) and one signed-only action (levelUp).
export function buildHarness(overrides: Partial<CreateIssuerOptions> = {}): Harness {
  const clock = createClock();
  const chain = new FakeChain();
  const executed: ActionContext[] = [];
  const notified: Notified[] = [];
  const errors: unknown[] = [];
  const mode = overrides.mode ?? "gated";
  const record = (ctx: ActionContext) => {
    executed.push(ctx);
    return { fed: true };
  };
  const issuer = createIssuer({
    domain: "issuer.example",
    baseUrl: BASE,
    chainId: 1,
    contract: CONTRACT,
    mode,
    actions: {
      feed: { description: "Feed the pet", capability: mode === "gated", bound: "Once fed, idempotent for an hour; moves no value", execute: record },
      water: { description: "Water the pet", capability: mode === "gated", bound: "Idempotent; moves no value", execute: record },
      levelUp: { description: "Level up", execute: record },
    },
    capability: { enabled: mode === "gated" },
    chain,
    providers: fakeProviders(notified),
    render: (ctx) => ({
      serial: ctx.serial,
      organizationName: "Example",
      description: `Token ${ctx.token.tokenId}`,
      title: "Pet",
      links: Object.entries(ctx.links).map(([key, url]) => ({ key, label: key, url })),
    }),
    now: clock.now,
    onError: (e) => {
      errors.push(e);
    },
    ...overrides,
  });
  const url = (path: string) => (path.startsWith("http") ? path : `${BASE}${path}`);
  return {
    issuer,
    chain,
    clock,
    executed,
    notified,
    errors,
    get: (path, headers = {}) => issuer.handler(new Request(url(path), { headers })),
    post: (path, body, headers = {}) =>
      issuer.handler(
        new Request(url(path), {
          method: "POST",
          headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      ),
  };
}

/// Fetch a challenge from the real endpoint and sign it.
export async function signChallenge(
  h: Harness,
  account: PrivateKeyAccount,
  tokenId = TOKEN_ID,
  action?: string,
): Promise<{ message: string; signature: Hex }> {
  const q = action ? `&action=${action}` : "";
  const res = await h.get(`/wallet-pass/${tokenId}/challenge?address=${account.address}${q}`);
  expect(res.status).toBe(200);
  const { message } = (await res.json()) as { message: string };
  return { message, signature: await account.signMessage({ message }) };
}

export function proof(p: { message: string; signature: Hex }): Record<string, string> {
  return proofHeaders(p);
}

/// Claim a gated manifest as `account`: challenge, sign, present.
export async function claim(h: Harness, account: PrivateKeyAccount, tokenId = TOKEN_ID) {
  const p = await signChallenge(h, account, tokenId);
  const res = await h.get(`/wallet-pass/${tokenId}`, proof(p));
  return { res, body: (await res.json()) as Record<string, any>, proof: p };
}

/// Make `owner` the owner and claim the pass, returning the capability
///  links (as paths) the pass would carry.
export async function issuePassTo(h: Harness, owner: PrivateKeyAccount, tokenId = TOKEN_ID): Promise<Record<string, string>> {
  h.chain.setOwner(tokenId, owner.address);
  const { res } = await claim(h, owner, tokenId);
  expect(res.status).toBe(200);
  const links: Record<string, string> = {};
  for (const [action, u] of Object.entries(await h.issuer.capabilityLinksFor(tokenId))) links[action] = new URL(u).pathname;
  return links;
}
