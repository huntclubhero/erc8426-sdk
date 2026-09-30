import { isAddressEqual, type Address, type Hex } from "viem";
import type { TokenRef } from "@erc8426/core";

import { DELEGATE_REGISTRY_V2, type ChainReader } from "./chain.js";

/// Entitlement policies (Extended entitlement).
///
///  Absent a documented extension, `ownerOf` is the entitlement. A policy may
///  extend it (an ERC-4907 renter, a delegation registry delegate) provided
///  it is documented, reads every input fresh at request time, and defines
///  precedence. Every policy here takes its reads through the `ChainReader`
///  on each call and caches nothing.
///
///  A policy answers one of three ways:
///  - "allow": this account is entitled, and `via` says why;
///  - "deny": a veto, used only by an exclusive rental, which overrides any
///    "allow" from another policy in `anyOf`;
///  - "abstain": this policy does not entitle the account.
///  A throw means a read could not be taken; the issuer answers 503.

export type EntitlementDecision =
  | { decision: "allow"; via: string }
  | { decision: "deny"; via: string; reason: string }
  | { decision: "abstain" };

export interface EntitlementRequest {
  token: TokenRef;
  /// The claimed account (the proven signer, or the holder a capability link
  ///  was issued to).
  account: Address;
  action: string;
  reader: ChainReader;
  /// Wall clock, epoch milliseconds, for expiry checks.
  now: number;
}

export interface EntitlementPolicy {
  /// Short name, used in `via` and in docs.
  readonly name: string;
  evaluate(request: EntitlementRequest): Promise<EntitlementDecision>;
}

export type EntitlementResult = { entitled: true; via: string } | { entitled: false; reason: string };

/// Resolve a policy's decision to entitled or not. "abstain" and "deny" both
///  refuse.
export async function checkEntitlement(policy: EntitlementPolicy, request: EntitlementRequest): Promise<EntitlementResult> {
  const d = await policy.evaluate(request);
  if (d.decision === "allow") return { entitled: true, via: d.via };
  return { entitled: false, reason: d.decision === "deny" ? d.reason : "not_entitled" };
}

/// The default: the fresh `ownerOf` is the entitlement.
export function ownerOnly(): EntitlementPolicy {
  return {
    name: "owner",
    async evaluate({ token, account, reader }) {
      const owner = await reader.ownerOf(token);
      return owner !== null && isAddressEqual(owner, account) ? { decision: "allow", via: "owner" } : { decision: "abstain" };
    },
  };
}

export interface Rental4907Options {
  /// An active rental is exclusive of the owner (and of everyone else) for
  ///  the actions it covers. Default true, as the spec RECOMMENDS: "A rental
  ///  entitlement (an active ERC-4907 userOf) SHOULD be exclusive of the
  ///  owner for the actions it covers". With false, owner and renter are
  ///  both entitled during the rental.
  exclusive?: boolean;
  /// Actions the rental covers. Default: every action, including acquire
  ///  (the renter gets the pass) and rotate. Uncovered actions fall back to
  ///  the owner alone.
  actions?: string[];
}

/// ERC-4907 rentals. Documented policy:
///  - A rental is active when `userOf` is non-zero AND `userExpires` is in
///    the future by the issuer's clock. Both are read fresh on every call.
///    (Conforming ERC-4907 contracts already return zero from `userOf` after
///    expiry; the expiry check guards contracts that do not.)
///  - During an active rental, for a covered action, the user is entitled.
///    With `exclusive` (the default) every other account, the owner
///    included, is vetoed ("deny"), which also overrides delegation in
///    `anyOf`. Without `exclusive` the owner stays entitled too.
///  - With no active rental, or for an uncovered action, the owner alone is
///    entitled: an expired rental falls back to the owner.
export function rental4907(options: Rental4907Options = {}): EntitlementPolicy {
  const exclusive = options.exclusive ?? true;
  const covered = options.actions ? new Set(options.actions) : null;
  return {
    name: "rental4907",
    async evaluate({ token, account, action, reader, now }) {
      if (!reader.userOf) throw new Error("rental4907 needs a ChainReader with userOf (publicClientChainReader provides it)");
      const [owner, rental] = await Promise.all([reader.ownerOf(token), reader.userOf(token)]);
      const isOwner = owner !== null && isAddressEqual(owner, account);
      const active = rental.user !== null && rental.expires * 1000n > BigInt(now);
      const applies = covered === null || covered.has(action);
      if (active && applies) {
        if (isAddressEqual(rental.user!, account)) return { decision: "allow", via: "rental" };
        if (exclusive) return { decision: "deny", via: "rental", reason: "rented" };
      }
      return isOwner ? { decision: "allow", via: "owner" } : { decision: "abstain" };
    },
  };
}

export interface DelegateRegistryOptions {
  /// Registry address. Default the delegate.xyz v2 deployment.
  registry?: Address;
  /// The `rights` value delegations must carry. Default bytes32(0), which
  ///  matches full delegations only. A non-zero value also accepts full
  ///  delegations, per the registry's semantics.
  rights?: Hex;
}

/// delegate.xyz v2 delegation, additive by intent: the owner is entitled,
///  and so is any account the owner delegated to for this token (or its
///  contract, or all of the owner's assets). The owner and the delegation are
///  both read fresh on every call. Used in `anyOf` with an exclusive rental,
///  the rental's veto wins, so an owner's delegate cannot act during a
///  rental the owner could not act in either.
export function delegateRegistry(options: DelegateRegistryOptions = {}): EntitlementPolicy {
  const registry = options.registry ?? DELEGATE_REGISTRY_V2;
  const rights = options.rights ?? (`0x${"0".repeat(64)}` as Hex);
  return {
    name: "delegateRegistry",
    async evaluate({ token, account, reader }) {
      if (!reader.checkDelegateForERC721) {
        throw new Error("delegateRegistry needs a ChainReader with checkDelegateForERC721 (publicClientChainReader provides it)");
      }
      const owner = await reader.ownerOf(token);
      if (owner === null) return { decision: "abstain" };
      if (isAddressEqual(owner, account)) return { decision: "allow", via: "owner" };
      const delegated = await reader.checkDelegateForERC721({ registry, to: account, from: owner, token, rights });
      return delegated ? { decision: "allow", via: "delegate" } : { decision: "abstain" };
    },
  };
}

/// Compose policies. Precedence, documented as the spec requires:
///  1. any "deny" (an exclusive rental's veto) wins over every "allow";
///  2. otherwise the first "allow", in argument order, entitles;
///  3. otherwise the account is not entitled.
///  Every policy is evaluated on every call (their reads run in parallel), so
///  a veto is never skipped by an earlier allow. A throw from any policy
///  propagates: a read that could not be taken is never read as a refusal.
export function anyOf(...policies: EntitlementPolicy[]): EntitlementPolicy {
  if (policies.length === 0) throw new Error("anyOf needs at least one policy");
  return {
    name: `anyOf(${policies.map((p) => p.name).join(",")})`,
    async evaluate(request) {
      const decisions = await Promise.all(policies.map((p) => p.evaluate(request)));
      const veto = decisions.find((d) => d.decision === "deny");
      if (veto) return veto;
      return decisions.find((d) => d.decision === "allow") ?? { decision: "abstain" };
    },
  };
}
