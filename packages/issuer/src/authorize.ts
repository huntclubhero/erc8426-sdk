import { isAddressEqual, type Address, type Hex } from "viem";
import { parseChallenge, sameToken, tokenRef, type AuthError, type ParsedChallenge, type TokenRef } from "@erc8426/core";

import type { ResolvedIssuerConfig } from "./config.js";
import type { ChainReader } from "./chain.js";
import { checkEntitlement, type EntitlementPolicy } from "./entitlement.js";
import type { SignatureVerifier } from "./signature.js";
import type { NonceStore } from "./stores.js";

export interface AuthorizeDeps {
  config: ResolvedIssuerConfig;
  nonces: NonceStore;
  verifier: SignatureVerifier;
  chain: ChainReader;
  entitlement: EntitlementPolicy;
  /// Epoch milliseconds.
  now: () => number;
}

/// A presented proof and what the verifier is being asked to do with it. The
///  chain id and contract are deliberately absent: they are the verifier's
///  own (its config), and a request never gets to name them.
export interface AuthorizeInput {
  message: string;
  signature: Hex;
  tokenId: string;
  action: string;
}

export type AuthorizeResult =
  | {
      ok: true;
      /// The proven, entitled account.
      account: Address;
      /// The entitlement that admitted it ("owner", "rental", "delegate").
      via: string;
      token: TokenRef;
      challenge: ParsedChallenge;
    }
  | { ok: false; error: AuthError };

/// The two-check floor (Authorization of pass-reachable actions).
///
///  Check (1), the control proof: every challenge field is checked against
///  what the verifier itself holds (its identity, the nonce it issued and
///  what it issued it for, its clock, the token it serves, the action being
///  executed) and never against values supplied with the request. Check (2),
///  the fresh entitlement read, runs last and unconditionally.
///
///  The nonce is spent before anything after it runs, so one presentation
///  spends it whether or not the rest succeeds and a failed attempt cannot be
///  retried with the same proof.
export async function authorize(input: AuthorizeInput, deps: AuthorizeDeps): Promise<AuthorizeResult> {
  const { config } = deps;
  const nowMs = deps.now();

  // The token this verifier serves, from its own config.
  let served: TokenRef;
  try {
    served = tokenRef(config.chainId, config.contract, input.tokenId);
  } catch {
    return { ok: false, error: "binding_mismatch" };
  }

  // Parse. A message missing any floor field (domain, address, chain id,
  // nonce) is not a challenge.
  const parsed = parseChallenge(input.message);
  if (!parsed) return { ok: false, error: "invalid_message" };

  // Verifier identity: keeps a challenge signed for one issuer from being
  // presented to another that gates the same token.
  if (parsed.domain !== config.domain) return { ok: false, error: "domain_mismatch" };

  // Single-use nonce issued by this verifier, spent atomically. A replay
  // finds it gone. The record also pins the account the challenge was issued
  // to, so a message rebuilt around a live nonce for some other account is
  // refused here.
  const record = await deps.nonces.consume(parsed.nonce);
  if (!record || !isAddressEqual(record.account, parsed.address)) return { ok: false, error: "nonce_invalid" };

  // Expiration, by the verifier's clock, capped at the expiry the verifier
  // issued: a message that claims a later expiry than its nonce was issued
  // with does not extend its life.
  if (!parsed.expirationTime) return { ok: false, error: "challenge_expired" };
  const expiresAt = Math.min(parsed.expirationTime.getTime(), record.expiresAt);
  if (!(nowMs < expiresAt)) return { ok: false, error: "challenge_expired" };
  if (parsed.notBefore && parsed.notBefore.getTime() > nowMs) return { ok: false, error: "not_yet_valid" };

  // Exact binding: chain id, token (chain, contract, id as one CAIP-19 id),
  // and action, each against the verifier's own target, and against what the
  // nonce was issued for. A proof for action A or token X is refused for B
  // or Y; a proof for a chain or contract this verifier does not serve is
  // refused whoever issued it.
  const bound =
    parsed.chainId === config.chainId &&
    parsed.token !== null &&
    sameToken(parsed.token, served) &&
    parsed.action === input.action &&
    record.tokenId === served.tokenId &&
    record.action === input.action;
  if (!bound) return { ok: false, error: "binding_mismatch" };

  // Signature for the claimed account (EOA, ERC-1271 or ERC-6492, per the
  // verifier). A verifier that throws has not validated anything.
  let valid: boolean;
  try {
    valid = await deps.verifier.verify({ address: parsed.address, message: input.message, signature: input.signature });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, error: "signature_invalid" };

  // Check (2): the fresh entitlement read, now. It closes the transfer
  // window. A read that could not be taken fails closed as retryable and is
  // never reported as a verdict on the account.
  let entitled: Awaited<ReturnType<typeof checkEntitlement>>;
  try {
    entitled = await checkEntitlement(deps.entitlement, {
      token: served,
      account: parsed.address,
      action: input.action,
      reader: deps.chain,
      now: nowMs,
    });
  } catch {
    return { ok: false, error: "read_failed" };
  }
  if (!entitled.entitled) return { ok: false, error: "not_owner" };

  return { ok: true, account: parsed.address, via: entitled.via, token: served, challenge: parsed };
}
