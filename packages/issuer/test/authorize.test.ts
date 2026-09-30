import { describe, expect, it } from "vitest";
import { parseSiweMessage } from "viem/siwe";
import { buildChallenge, generateNonce, tokenRef } from "@erc8426/core";
import { authorize, publicClientSignatureVerifier } from "@erc8426/issuer";

import { CONTRACT, TOKEN_ID, buildHarness, newSigner, signChallenge, type Harness } from "./helpers.js";

const ACTION_PATH = (action: string, tokenId = TOKEN_ID) => `/wallet-pass/${tokenId}/actions/${action}`;

/// Owner signs a real feed challenge from the challenge endpoint.
async function primed(h: Harness, action = "feed") {
  const account = newSigner();
  h.chain.setOwner(TOKEN_ID, account.address);
  const p = await signChallenge(h, account, TOKEN_ID, action);
  return { account, ...p };
}

/// Issue a nonce the way the challenge endpoint would, for a message the
///  test builds itself (to put fields the endpoint would never issue).
async function forged(h: Harness, overrides: { chainId?: number; contract?: string; domain?: string; tokenId?: string; action?: string; notBefore?: Date }) {
  const account = newSigner();
  h.chain.setOwner(TOKEN_ID, account.address);
  const nonce = generateNonce();
  const now = h.clock.now();
  const action = overrides.action ?? "feed";
  const tokenId = overrides.tokenId ?? TOKEN_ID;
  await h.issuer.stores.nonces.issue(nonce, { account: account.address, tokenId, action, expiresAt: now + 300_000 }, 600);
  let message = buildChallenge({
    domain: overrides.domain ?? "issuer.example",
    uri: "https://issuer.example/wallet-pass/actions",
    account: account.address,
    token: tokenRef(overrides.chainId ?? 1, overrides.contract ?? CONTRACT, tokenId),
    action,
    nonce,
    issuedAt: new Date(now),
    expirationTime: new Date(now + 300_000),
  });
  if (overrides.notBefore) message = message.replace("\nResources:", `\nNot Before: ${overrides.notBefore.toISOString()}\nResources:`);
  return { account, message, signature: await account.signMessage({ message }) };
}

describe("challenge endpoint", () => {
  it("issues an ERC-4361 challenge shaped like the spec's worked example", async () => {
    const h = buildHarness();
    const account = newSigner();
    const res = await h.get(`/wallet-pass/412/challenge?address=${account.address}&action=feed`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string; nonce: string; expiresAt: string };
    expect(body.message.startsWith("issuer.example wants you to sign in with your Ethereum account:")).toBe(true);
    expect(body.message).toContain("Authorize the feed action for wallet pass token 412 on issuer.example.");
    const parsed = parseSiweMessage(body.message);
    expect(parsed.uri).toBe("https://issuer.example/wallet-pass/actions");
    expect(parsed.chainId).toBe(1);
    expect(parsed.address).toBe(account.address);
    expect(parsed.resources).toEqual([`eip155:1/erc721:${CONTRACT}/412`, "urn:wallet-pass:action:feed"]);
    expect(parsed.nonce).toBe(body.nonce);
    expect(body.nonce.length).toBeGreaterThanOrEqual(8);
    expect(parsed.expirationTime!.getTime() - parsed.issuedAt!.getTime()).toBe(300_000);
  });

  it("defaults the action to acquire", async () => {
    const h = buildHarness();
    const res = await h.get(`/wallet-pass/412/challenge?address=${newSigner().address}`);
    expect(((await res.json()) as { message: string }).message).toContain("urn:wallet-pass:action:acquire");
  });

  it("issues a fresh challenge on every request, because the nonce is single-use", async () => {
    const h = buildHarness();
    const address = newSigner().address;
    const a = (await (await h.get(`/wallet-pass/412/challenge?address=${address}`)).json()) as { nonce: string };
    const b = (await (await h.get(`/wallet-pass/412/challenge?address=${address}`)).json()) as { nonce: string };
    expect(a.nonce).not.toBe(b.nonce);
  });

  it("is never cached", async () => {
    const h = buildHarness();
    const res = await h.get(`/wallet-pass/412/challenge?address=${newSigner().address}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses a missing or invalid address with 400", async () => {
    const h = buildHarness();
    const missing = await h.get("/wallet-pass/412/challenge");
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toBe("invalid_address");
    expect((await h.get("/wallet-pass/412/challenge?address=not-an-address")).status).toBe(400);
  });

  it("refuses an unknown action with 400", async () => {
    const h = buildHarness();
    const res = await h.get(`/wallet-pass/412/challenge?address=${newSigner().address}&action=transferFrom`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unknown_action");
  });

  it("refuses an invalid token id with 400 invalid_token", async () => {
    const h = buildHarness();
    const res = await h.get(`/wallet-pass/abc/challenge?address=${newSigner().address}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_token");
  });
});

describe("signed action (the two-check floor)", () => {
  it("runs the action end to end for the owner", async () => {
    const h = buildHarness();
    const { account, message, signature } = await primed(h);
    const res = await h.post(ACTION_PATH("feed"), { message, signature, params: { treat: "apple" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, executed: true, action: "feed", tokenId: TOKEN_ID, account: account.address, via: "owner", result: { fed: true } });
    expect(h.executed).toHaveLength(1);
    expect(h.executed[0]!.path).toBe("signed");
    expect(h.executed[0]!.params).toEqual({ treat: "apple" });
  });

  it("accepts the proof in the two proof headers too", async () => {
    const h = buildHarness();
    const { message, signature } = await primed(h);
    const { proofHeaders } = await import("@erc8426/core");
    const res = await h.post(ACTION_PATH("feed"), undefined, proofHeaders({ message, signature }));
    expect(res.status).toBe(200);
  });

  it("answers a request with no proof 401 proof_required, pointing at this action's challenge", async () => {
    const h = buildHarness();
    const res = await h.post(ACTION_PATH("feed"), {});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "proof_required", challenge: "https://issuer.example/wallet-pass/412/challenge?action=feed" });
  });

  it("the single-use nonce makes a captured proof worthless a second time", async () => {
    const h = buildHarness();
    const { message, signature } = await primed(h);
    expect((await h.post(ACTION_PATH("feed"), { message, signature })).status).toBe(200);
    const replay = await h.post(ACTION_PATH("feed"), { message, signature });
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { error: string }).error).toBe("nonce_invalid");
    expect(h.executed).toHaveLength(1);
  });

  it("spends the nonce even when a later check fails, so a failed attempt cannot be retried", async () => {
    const h = buildHarness();
    const { message, signature } = await primed(h);
    h.chain.failing = true;
    expect((await h.post(ACTION_PATH("feed"), { message, signature })).status).toBe(503);
    h.chain.failing = false;
    const retry = await h.post(ACTION_PATH("feed"), { message, signature });
    expect(((await retry.json()) as { error: string }).error).toBe("nonce_invalid");
  });

  it("the expiration makes a leaked proof go stale", async () => {
    const h = buildHarness();
    const { message, signature } = await primed(h);
    h.clock.advance(301_000);
    const res = await h.post(ACTION_PATH("feed"), { message, signature });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "challenge_expired", challenge: expect.stringContaining("/challenge?action=feed") });
  });

  it("refuses a challenge whose Not Before is in the future", async () => {
    const h = buildHarness();
    const { message, signature } = await forged(h, { notBefore: new Date(h.clock.now() + 60_000) });
    const res = await h.post(ACTION_PATH("feed"), { message, signature });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("not_yet_valid");
  });

  it("the verifier identity keeps a challenge signed for one issuer from being presented to another", async () => {
    const h = buildHarness();
    const { message, signature } = await forged(h, { domain: "evil.example" });
    const res = await h.post(ACTION_PATH("feed"), { message, signature });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("domain_mismatch");
  });

  it("a proof obtained for one action cannot be presented for another", async () => {
    const h = buildHarness();
    const { message, signature } = await primed(h, "feed");
    const res = await h.post(ACTION_PATH("water"), { message, signature });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("binding_mismatch");
    expect(h.executed).toHaveLength(0);
  });

  it("a proof for token X cannot be presented for token Y", async () => {
    const h = buildHarness();
    const { account, message, signature } = await primed(h);
    h.chain.setOwner("999", account.address);
    const res = await h.post(ACTION_PATH("feed", "999"), { message, signature });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("binding_mismatch");
  });

  it("refuses a proof scoped to a chain the verifier does not serve", async () => {
    const h = buildHarness();
    const { message, signature } = await forged(h, { chainId: 137 });
    const res = await h.post(ACTION_PATH("feed"), { message, signature });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("binding_mismatch");
  });

  it("refuses a proof scoped to a contract the verifier does not serve", async () => {
    const h = buildHarness();
    const { message, signature } = await forged(h, { contract: newSigner().address });
    const res = await h.post(ACTION_PATH("feed"), { message, signature });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("binding_mismatch");
  });

  it("refuses a message rebuilt around a live nonce for a different account", async () => {
    const h = buildHarness();
    const owner = newSigner();
    const attacker = newSigner();
    h.chain.setOwner(TOKEN_ID, attacker.address);
    const issued = (await (await h.get(`/wallet-pass/412/challenge?address=${owner.address}&action=feed`)).json()) as { message: string };
    const message = issued.message.replace(owner.address, attacker.address);
    const res = await h.post(ACTION_PATH("feed"), { message, signature: await attacker.signMessage({ message }) });
    expect(((await res.json()) as { error: string }).error).toBe("nonce_invalid");
  });

  it("refuses a signature from the wrong account", async () => {
    const h = buildHarness();
    const account = newSigner();
    h.chain.setOwner(TOKEN_ID, account.address);
    const { message } = await signChallenge(h, account, TOKEN_ID, "feed");
    const res = await h.post(ACTION_PATH("feed"), { message, signature: await newSigner().signMessage({ message }) });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("signature_invalid");
  });

  it("refuses a message that is not a challenge", async () => {
    const h = buildHarness();
    const account = newSigner();
    const message = "this is not a sign-in with ethereum message";
    const res = await h.post(ACTION_PATH("feed"), { message, signature: await account.signMessage({ message }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_message");
  });

  it("refuses a malformed signature without crashing", async () => {
    const h = buildHarness();
    const short = await primed(h);
    const res = await h.post(ACTION_PATH("feed"), { message: short.message, signature: "0xdeadbeef" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("signature_invalid");
    const notHex = await primed(h);
    const bad = await h.post(ACTION_PATH("feed"), { message: notHex.message, signature: "nothex" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("malformed_proof");
  });

  it("the fresh read closes the transfer window: a token sold after the challenge stops acting", async () => {
    const h = buildHarness();
    const { message, signature } = await primed(h);
    h.chain.setOwner(TOKEN_ID, newSigner().address);
    const res = await h.post(ACTION_PATH("feed"), { message, signature });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("not_owner");
    expect(h.executed).toHaveLength(0);
  });

  it("refuses a burned token as not_owner", async () => {
    const h = buildHarness();
    const { message, signature } = await primed(h);
    h.chain.setOwner(TOKEN_ID, null);
    const res = await h.post(ACTION_PATH("feed"), { message, signature });
    expect(res.status).toBe(403);
  });

  it("answers a read that cannot be taken 503 read_failed with Retry-After, never 403", async () => {
    const h = buildHarness();
    const { message, signature } = await primed(h);
    h.chain.failing = true;
    const res = await h.post(ACTION_PATH("feed"), { message, signature });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(((await res.json()) as { error: string }).error).toBe("read_failed");
    expect(h.executed).toHaveLength(0);
  });

  it("an acquire proof MUST NOT authorize any other action", async () => {
    const h = buildHarness();
    const { message, signature } = await primed(h, "acquire");
    const res = await h.post(ACTION_PATH("acquire"), { message, signature });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unknown_action");
    const asFeed = await h.post(ACTION_PATH("feed"), { message, signature });
    expect(((await asFeed.json()) as { error: string }).error).toBe("binding_mismatch");
    expect(h.executed).toHaveLength(0);
  });

  it("refuses the rotate action on the action route", async () => {
    const h = buildHarness();
    const { message, signature } = await primed(h, "rotate");
    const res = await h.post(ACTION_PATH("rotate"), { message, signature });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unknown_action");
  });

  it("refuses an action that is not registered", async () => {
    const h = buildHarness();
    const res = await h.post(ACTION_PATH("transferFrom"), {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unknown_action");
  });

  it("maps an ActionError thrown by execute to its status", async () => {
    const { ActionError } = await import("@erc8426/issuer");
    const h = buildHarness({
      actions: {
        levelUp: {
          description: "Level up",
          execute: () => {
            throw new ActionError(429, "cooldown", "Try again in an hour");
          },
        },
      },
      capability: { enabled: false },
    });
    const { message, signature } = await primed(h, "levelUp");
    const res = await h.post(ACTION_PATH("levelUp"), { message, signature });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "cooldown", message: "Try again in an hour" });
  });

  it("answers 500 action_failed when execute throws unexpectedly, and reports it", async () => {
    const h = buildHarness({
      actions: {
        levelUp: {
          description: "Level up",
          execute: () => {
            throw new Error("relayer down");
          },
        },
      },
      capability: { enabled: false },
    });
    const { message, signature } = await primed(h, "levelUp");
    const res = await h.post(ACTION_PATH("levelUp"), { message, signature });
    expect(res.status).toBe(500);
    expect(h.errors).toHaveLength(1);
  });
});

describe("authorize (programmatic)", () => {
  it("returns the proven account and the entitlement that admitted it", async () => {
    const h = buildHarness();
    const { account, message, signature } = await primed(h, "levelUp");
    const result = await h.issuer.authorize({ message, signature, tokenId: TOKEN_ID, action: "levelUp" });
    expect(result).toMatchObject({ ok: true, account: account.address, via: "owner" });
  });

  it("checks contract account signatures through the client's verifyMessage (ERC-1271 / ERC-6492)", async () => {
    const h = buildHarness();
    const { message } = await primed(h, "levelUp");
    const calls: unknown[] = [];
    const verifier = publicClientSignatureVerifier({
      async verifyMessage(args: unknown) {
        calls.push(args);
        return true;
      },
    });
    const result = await authorize(
      { message, signature: "0x1234", tokenId: TOKEN_ID, action: "levelUp" },
      {
        config: h.issuer.config,
        nonces: h.issuer.stores.nonces,
        verifier,
        chain: h.chain,
        entitlement: (await import("@erc8426/issuer")).ownerOnly(),
        now: h.clock.now,
      },
    );
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
