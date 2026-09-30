import { getAddress, isAddress, isAddressEqual, type Address } from "viem";
import {
  ACQUIRE_ACTION,
  ROTATE_ACTION,
  buildChallenge,
  createManifest,
  generateNonce,
  normalizeTokenId,
  tokenRef,
  isPassFileProvider,
  type PassContent,
  type PassContext,
  type PassDeliveryProvider,
  type PassFormatProvider,
  type PassManifest,
  type TokenRef,
} from "@erc8426/core";

import { authorize as runFloor, type AuthorizeInput, type AuthorizeResult } from "./authorize.js";
import { newLinkToken, newSerial, isLinkTokenShape } from "./capability.js";
import { publicClientChainReader, type ChainReader, type ReadBlockTag, type ReadContractClient } from "./chain.js";
import { IssuerConfigError, resolveConfig, type IssuerConfig, type ResolvedIssuerConfig } from "./config.js";
import { checkEntitlement, ownerOnly, type EntitlementPolicy, type EntitlementResult } from "./entitlement.js";
import { IssuerError } from "./errors.js";
import { createRouter } from "./http.js";
import { eoaSignatureVerifier, publicClientSignatureVerifier, type SignatureVerifier, type VerifyMessageClient } from "./signature.js";
import { memoryStores, type IssuerStores, type LinkBinding, type PassRecord } from "./stores.js";

/// Providers are core's delivery seam: a `PassFormatProvider` returns an
///  acquisition URL; a `PassFileProvider` returns the file, which the issuer
///  serves at a capability URL it mints, binds to one token and format, and
///  rotates with every other link. `IssuerProvider` and `isFileProvider` are
///  kept as aliases of the core names.
export type IssuerProvider = PassDeliveryProvider;
export const isFileProvider = isPassFileProvider;

/// What `render` is called with.
export interface RenderContext {
  token: TokenRef;
  /// The account the pass is issued to.
  owner: Address;
  /// The pass serial the issuer owns. Whatever `serial` render returns is
  ///  replaced with this one.
  serial: string;
  /// Capability action links keyed by action name, ready to place on the
  ///  back of the pass. Empty unless the capability configuration is on.
  links: Record<string, string>;
  /// True when rendering the previous holder's pass to mark it superseded
  ///  after a transfer. The issuer sets `voided` and drops links on the
  ///  result regardless; use the flag to change wording.
  superseded: boolean;
  /// Unix seconds of the last content change.
  updatedAt: number;
}

export interface IssuerErrorContext {
  operation: string;
  tokenId?: string;
}

export interface CreateIssuerOptions extends IssuerConfig {
  /// One provider per manifest format, for example `apple` and `google`.
  providers: IssuerProvider[];
  /// Describe the pass for a token and holder. Called when a manifest is
  ///  built, a pass file is served, and an update is pushed.
  render(ctx: RenderContext): PassContent | Promise<PassContent>;
  /// A viem PublicClient. Supplies the fresh-read chain reader and the
  ///  ERC-1271 / ERC-6492 capable signature verifier unless those are given.
  publicClient?: ReadContractClient & VerifyMessageClient;
  /// Block the fresh reads are taken against (see ReadBlockTag). Default "latest".
  blockTag?: ReadBlockTag;
  chain?: ChainReader;
  /// Default: the publicClient verifier, else the offline EOA-only verifier.
  verifier?: SignatureVerifier;
  /// Default `ownerOnly()`.
  entitlement?: EntitlementPolicy;
  /// Default in-memory stores (single instance only).
  stores?: Partial<IssuerStores>;
  /// Clock, epoch milliseconds. Default Date.now.
  now?: () => number;
  /// Failures that must not fail the request that triggered them (a push
  ///  that did not land, a render for a superseded pass). Default logs to
  ///  console.error.
  onError?(error: unknown, context: IssuerErrorContext): void;
}

export interface IssuedChallenge {
  /// The ERC-4361 message to sign.
  message: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export interface PassUpdateSummary {
  /// Tokens whose record was found and whose `updatedAt` was bumped.
  updated: number;
}

export interface Issuer {
  readonly config: ResolvedIssuerConfig;
  readonly stores: IssuerStores;
  readonly chain: ChainReader;
  /// The WHATWG fetch handler for the whole surface under basePath. Answers
  ///  404 for paths outside it.
  handler(request: Request): Promise<Response>;
  /// Like `handler`, but null for a path outside basePath, so middleware can
  ///  fall through.
  route(request: Request): Promise<Response | null>;
  /// The URI the contract's `passURI(tokenId)` should return.
  passUri(tokenId: string | number | bigint): string;
  /// The challenge endpoint URI for a token (and action, default acquire).
  challengeUri(tokenId: string | number | bigint, action?: string): string;
  /// Issue a fresh challenge. Throws IssuerError for an invalid token id,
  ///  account or action.
  issueChallenge(input: { tokenId: string | number | bigint; account: string; action?: string }): Promise<IssuedChallenge>;
  /// Run the two-check floor for a signed proof. Spends the nonce.
  authorize(input: AuthorizeInput): Promise<AuthorizeResult>;
  /// Rotate every link for a token (owner request). The caller is
  ///  responsible for having authorized the request; the HTTP rotate route
  ///  does so with a signed rotate proof. `account` is who the fresh links are
  ///  issued to (default: the current holder of record).
  rotate(tokenId: string | number | bigint, options?: { account?: string }): Promise<void>;
  /// A transfer was observed (watcher, indexer webhook). Rotates the token's
  ///  links and marks the previous holder's pass superseded. Idempotent
  ///  enough for at-least-once delivery. Returns whether it rotated.
  onTransfer(tokenId: string | number | bigint, from: string, to: string): Promise<boolean>;
  /// PassUpdate (one id) or BatchPassUpdate (inclusive range): bump
  ///  `updatedAt` and push fresh content through every provider.
  onPassUpdate(fromTokenId: string | number | bigint, toTokenId?: string | number | bigint): Promise<PassUpdateSummary>;
  /// The token's current capability action links, keyed by action. Empty
  ///  when the token has no record yet or the capability configuration is off.
  capabilityLinksFor(tokenId: string | number | bigint): Promise<Record<string, string>>;
}

/// Everything the HTTP layer needs from the engine. Internal.
export interface IssuerInternals {
  config: ResolvedIssuerConfig;
  stores: IssuerStores;
  providers: IssuerProvider[];
  now: () => number;
  onError(error: unknown, context: IssuerErrorContext): void;
  token(tokenId: string): TokenRef;
  challengeUri(tokenId: string, action?: string): string;
  linkUrl(linkToken: string): string;
  issueChallenge: Issuer["issueChallenge"];
  authorize(input: AuthorizeInput): Promise<AuthorizeResult>;
  entitled(tokenId: string, account: Address, action: string): Promise<EntitlementResult>;
  ownerOf(tokenId: string): Promise<Address | null>;
  recordIssuance(tokenId: string, account: Address): Promise<PassRecord>;
  rotateOnRequest(tokenId: string, account: Address): Promise<PassRecord>;
  buildManifest(record: PassRecord, owner: Address): Promise<PassManifest>;
  renderContent(record: PassRecord, owner: Address, superseded: boolean): Promise<PassContent>;
  resolveLink(linkToken: string, kind: LinkBinding["kind"]): Promise<{ binding: LinkBinding; record: PassRecord } | null>;
  onPassUpdate: Issuer["onPassUpdate"];
}

type RotationReason = "transfer" | "claim" | "owner_request";

/// Build an issuer. Validates the configuration up front (IssuerConfigError)
///  so a setup the spec forbids never serves a request.
export function createIssuer(options: CreateIssuerOptions): Issuer {
  const config = resolveConfig(options);

  const providers = options.providers;
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new IssuerConfigError("providers must list at least one provider: a manifest MUST contain at least one format");
  }
  const seen = new Set<string>();
  for (const p of providers) {
    if (!p || typeof p.format !== "string" || p.format === "") throw new IssuerConfigError("every provider needs a format key");
    if (seen.has(p.format)) throw new IssuerConfigError(`two providers claim the format "${p.format}"`);
    if (!isFileProvider(p) && typeof (p as PassFormatProvider).acquisitionUrl !== "function") {
      throw new IssuerConfigError(`provider "${p.format}" needs acquisitionUrl or passFile`);
    }
    seen.add(p.format);
  }
  if (typeof options.render !== "function") throw new IssuerConfigError("render is required: it describes the pass for a token and holder");

  const now = options.now ?? Date.now;
  const chain =
    options.chain ?? (options.publicClient ? publicClientChainReader(options.publicClient, { blockTag: options.blockTag ?? "latest" }) : undefined);
  if (!chain) throw new IssuerConfigError("pass publicClient or chain: check (2), the fresh entitlement read, needs a chain reader");
  const verifier = options.verifier ?? (options.publicClient ? publicClientSignatureVerifier(options.publicClient) : eoaSignatureVerifier());
  const entitlement = options.entitlement ?? ownerOnly();
  const defaults = memoryStores({ now });
  const stores: IssuerStores = {
    nonces: options.stores?.nonces ?? defaults.nonces,
    passes: options.stores?.passes ?? defaults.passes,
    links: options.stores?.links ?? defaults.links,
  };
  const onError =
    options.onError ?? ((error: unknown, ctx: IssuerErrorContext) => console.error(`[erc8426/issuer] ${ctx.operation} failed`, error));
  const fileProviders = providers.filter(isFileProvider);
  const nowSeconds = () => Math.floor(now() / 1000);
  const base = `${config.baseUrl}${config.basePath}`;

  const token = (tokenId: string) => tokenRef(config.chainId, config.contract, tokenId);
  const passUri = (tokenId: string | number | bigint) => `${base}/${normalizeTokenId(tokenId)}`;
  const challengeUri = (tokenId: string | number | bigint, action: string = ACQUIRE_ACTION) =>
    `${passUri(tokenId)}/challenge${action === ACQUIRE_ACTION ? "" : `?action=${encodeURIComponent(action)}`}`;
  const linkUrl = (t: string) => `${base}/links/${t}`;
  const downloadUrl = (t: string) => `${base}/passes/${t}`;
  const linkUrls = (record: PassRecord) => {
    const out: Record<string, string> = {};
    for (const [action, t] of Object.entries(record.links)) out[action] = linkUrl(t);
    return out;
  };

  // Mint link tokens for whatever the record is missing: every capability
  // action and every file format. Tokens already present are kept.
  async function fill(record: PassRecord): Promise<boolean> {
    let changed = false;
    for (const action of config.capabilityActions) {
      if (record.links[action]) continue;
      const t = newLinkToken();
      await stores.links.put(t, { kind: "action", tokenId: record.tokenId, name: action, generation: record.generation });
      record.links[action] = t;
      changed = true;
    }
    for (const p of fileProviders) {
      if (record.downloads[p.format]) continue;
      const t = newLinkToken();
      await stores.links.put(t, { kind: "download", tokenId: record.tokenId, name: p.format, generation: record.generation });
      record.downloads[p.format] = t;
      changed = true;
    }
    return changed;
  }

  async function loadOrCreate(tokenId: string): Promise<PassRecord> {
    let record = await stores.passes.get(tokenId);
    if (!record) {
      const t = nowSeconds();
      record = { tokenId, serial: newSerial(), generation: 0, lastIssuedTo: null, links: {}, downloads: {}, updatedAt: t, rotatedAt: t };
      await fill(record);
      await stores.passes.put(record);
    } else if (await fill(record)) {
      await stores.passes.put(record);
    }
    return record;
  }

  async function renderContent(record: PassRecord, owner: Address, superseded: boolean): Promise<PassContent> {
    const content = await options.render({
      token: token(record.tokenId),
      owner,
      serial: record.serial,
      links: superseded ? {} : linkUrls(record),
      superseded,
      updatedAt: record.updatedAt,
    });
    const out: PassContent = { ...content, serial: record.serial };
    if (superseded) {
      // Issuer requirements: the previous owner's pass SHOULD be updated,
      // invalidated, or visibly marked as superseded. Voided presents it as
      // expired on both platforms; its links are dead after rotation anyway.
      out.voided = true;
      out.links = [];
    }
    return out;
  }

  // Push content to installed passes. A failed push never fails the caller:
  // the state change it follows has already happened.
  async function notify(record: PassRecord, owner: Address, superseded: boolean, operation: string): Promise<void> {
    const targets = providers.filter((p) => typeof p.notifyUpdate === "function");
    if (targets.length === 0) return;
    let content: PassContent;
    try {
      content = await renderContent(record, owner, superseded);
    } catch (error) {
      onError(error, { operation: `${operation}:render`, tokenId: record.tokenId });
      return;
    }
    const ctx: PassContext = { token: token(record.tokenId), owner, content };
    const results = await Promise.allSettled(targets.map((p) => p.notifyUpdate!(ctx)));
    results.forEach((r, i) => {
      if (r.status === "rejected") onError(r.reason, { operation: `${operation}:${targets[i]!.format}`, tokenId: record.tokenId });
    });
  }

  // Retire every link and download token the record holds and mint fresh
  // ones. A change of holder also gets a new serial, and the previous
  // holder's pass is pushed as superseded; a rotation on the owner's request
  // keeps the serial and pushes the fresh links to the owner's own pass.
  async function rotateRecord(record: PassRecord, reason: RotationReason, holder: Address | null): Promise<PassRecord> {
    if (reason === "owner_request" && holder && record.lastIssuedTo && !isAddressEqual(holder, record.lastIssuedTo)) {
      reason = "claim";
    }
    const next: PassRecord = {
      ...record,
      generation: record.generation + 1,
      serial: reason === "owner_request" ? record.serial : newSerial(),
      lastIssuedTo: reason === "transfer" ? null : (holder ?? record.lastIssuedTo),
      links: {},
      downloads: {},
      rotatedAt: nowSeconds(),
    };
    await fill(next);
    // The record is the source of truth for which tokens are current, so it
    // is written first: from this moment the old tokens resolve to nothing
    // even if deleting them below fails.
    await stores.passes.put(next);
    await stores.links.delete([...Object.values(record.links), ...Object.values(record.downloads)]);
    if (reason !== "owner_request" && record.lastIssuedTo) {
      await notify(record, record.lastIssuedTo, true, "supersede");
    } else if (reason === "owner_request" && next.lastIssuedTo) {
      await notify(next, next.lastIssuedTo, false, "rotate");
    }
    return next;
  }

  const internals: IssuerInternals = {
    config,
    stores,
    providers,
    now,
    onError,
    token,
    challengeUri: (tokenId, action) => challengeUri(tokenId, action),
    linkUrl,

    async issueChallenge(input) {
      let tokenId: string;
      try {
        tokenId = normalizeTokenId(input.tokenId);
      } catch {
        throw new IssuerError("invalid_token", `invalid token id: ${String(input.tokenId)}`);
      }
      if (typeof input.account !== "string" || !isAddress(input.account, { strict: false })) {
        throw new IssuerError("invalid_address", "address must be a valid account address");
      }
      const action = input.action ?? ACQUIRE_ACTION;
      if (action !== ACQUIRE_ACTION && action !== ROTATE_ACTION && !Object.hasOwn(config.actions, action)) {
        throw new IssuerError("unknown_action", `unknown action: ${action}`);
      }
      const account = getAddress(input.account);
      // Because the nonce is single-use, every request issues a fresh one.
      const nonce = generateNonce();
      const issuedAt = new Date(now());
      const expirationTime = new Date(issuedAt.getTime() + config.challengeTtlSeconds * 1000);
      await stores.nonces.issue(nonce, { account, tokenId, action, expiresAt: expirationTime.getTime() }, config.nonceTtlSeconds);
      const message = buildChallenge({
        domain: config.domain,
        uri: config.uri,
        account,
        token: token(tokenId),
        action,
        nonce,
        issuedAt,
        expirationTime,
      });
      return { message, nonce, issuedAt: issuedAt.toISOString(), expiresAt: expirationTime.toISOString() };
    },

    authorize: (input) => runFloor(input, { config, nonces: stores.nonces, verifier, chain, entitlement, now }),

    entitled: (tokenId, account, action) =>
      checkEntitlement(entitlement, { token: token(tokenId), account, action, reader: chain, now: now() }),

    ownerOf: (tokenId) => chain.ownerOf(token(tokenId)),

    // Gated acquisition: "Acquisition by a proven account that is not the
    // account the implementation last issued passes to is that account's
    // first claim: acquisition URLs MUST rotate before the manifest is
    // returned." The very first issuance only records the account: no earlier
    // holder has URLs to retire.
    async recordIssuance(tokenId, account) {
      const record = await loadOrCreate(tokenId);
      if (record.lastIssuedTo === null) {
        record.lastIssuedTo = account;
        await stores.passes.put(record);
        return record;
      }
      if (isAddressEqual(record.lastIssuedTo, account)) return record;
      return rotateRecord(record, "claim", account);
    },

    async rotateOnRequest(tokenId, account) {
      return rotateRecord(await loadOrCreate(tokenId), "owner_request", account);
    },

    async buildManifest(record, owner) {
      const content = await renderContent(record, owner, false);
      const ctx: PassContext = { token: token(record.tokenId), owner, content };
      const entries = await Promise.all(
        providers.map(async (p) => [p.format, isFileProvider(p) ? downloadUrl(record.downloads[p.format]!) : await p.acquisitionUrl(ctx)] as const),
      );
      return createManifest(Object.fromEntries(entries) as PassManifest["formats"], record.updatedAt);
    },

    renderContent,

    // A link resolves only while the pass record still lists it as current:
    // rotation rewrites the record first, so a rotated link is dead even if
    // its store entry lingers.
    async resolveLink(linkToken, kind) {
      if (!isLinkTokenShape(linkToken)) return null;
      const binding = await stores.links.get(linkToken);
      if (!binding || binding.kind !== kind) return null;
      const record = await stores.passes.get(binding.tokenId);
      if (!record) return null;
      const current = kind === "action" ? record.links[binding.name] : record.downloads[binding.name];
      return current === linkToken ? { binding, record } : null;
    },

    async onPassUpdate(fromTokenId, toTokenId) {
      let from: bigint;
      let to: bigint;
      try {
        from = BigInt(normalizeTokenId(fromTokenId));
        to = toTokenId === undefined ? from : BigInt(normalizeTokenId(toTokenId));
      } catch {
        throw new IssuerError("invalid_token", "invalid token id in pass update");
      }
      if (to < from) throw new IssuerError("invalid_request", "BatchPassUpdate range is inverted: toTokenId < fromTokenId");
      let ids: string[];
      // The range is inclusive of both ends.
      if (to - from + 1n <= BigInt(config.maxBatchRange)) {
        ids = [];
        for (let i = from; i <= to; i++) ids.push(i.toString());
      } else if (stores.passes.tokenIds) {
        ids = (await stores.passes.tokenIds()).filter((id) => {
          const n = BigInt(id);
          return n >= from && n <= to;
        });
      } else {
        throw new IssuerError(
          "invalid_request",
          `BatchPassUpdate range of ${to - from + 1n} ids exceeds maxBatchRange (${config.maxBatchRange}) and the pass store has no tokenIds() index`,
        );
      }
      let updated = 0;
      for (const id of ids) {
        const record = await stores.passes.get(id);
        if (!record) continue;
        // updatedAt SHOULD change whenever PassUpdate is emitted for the token.
        record.updatedAt = Math.max(nowSeconds(), record.updatedAt);
        await stores.passes.put(record);
        updated++;
        if (record.lastIssuedTo) await notify(record, record.lastIssuedTo, false, "update");
      }
      return { updated };
    },
  };

  const route = createRouter(internals);

  return {
    config,
    stores,
    chain,
    route,
    async handler(request) {
      return (await route(request)) ?? new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    },
    passUri,
    challengeUri,
    issueChallenge: internals.issueChallenge,
    authorize: internals.authorize,
    async rotate(tokenId, opts = {}) {
      const id = normalizeTokenId(tokenId);
      const record = await stores.passes.get(id);
      if (!record) return;
      await rotateRecord(record, "owner_request", opts.account ? getAddress(opts.account) : null);
    },
    async onTransfer(tokenId, _from, to) {
      const id = normalizeTokenId(tokenId);
      const record = await stores.passes.get(id);
      // Nothing was ever issued for this token: no URL to retire.
      if (!record) return false;
      // Already issued to the recipient (the buyer's first claim beat the
      // indexer, or a self transfer): its links are the new owner's already.
      if (record.lastIssuedTo && isAddress(to, { strict: false }) && isAddressEqual(record.lastIssuedTo, to as Address)) return false;
      await rotateRecord(record, "transfer", null);
      return true;
    },
    onPassUpdate: internals.onPassUpdate,
    async capabilityLinksFor(tokenId) {
      const record = await stores.passes.get(normalizeTokenId(tokenId));
      return record ? linkUrls(record) : {};
    },
  };
}
