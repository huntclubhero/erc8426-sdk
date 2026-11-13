import { getAddress, isAddress, isAddressEqual, zeroAddress, type Address } from "viem";
import {
  ACQUIRE_ACTION,
  ROTATE_ACTION,
  buildChallenge,
  createManifest,
  generateNonce,
  normalizeTokenId,
  parsePassIssuer,
  tokenRef,
  isPassFileProvider,
  type PassContent,
  type PassContext,
  type PassDeliveryProvider,
  type PassFormatProvider,
  type PassIssuerIdentity,
  type PassManifest,
  type SupersededReason,
  type TokenRef,
} from "@erc8426/core";

import { authorize as runFloor, type AuthorizeInput, type AuthorizeResult } from "./authorize.js";
import { LinkKeyring, ephemeralLinkSecret, isLinkTokenShape, linkDigest, newLinkSeed, newSerial } from "./capability.js";
import { publicClientChainReader, type ChainReader, type ReadBlockTag, type ReadContractClient } from "./chain.js";
import { IssuerConfigError, isKnownMainnet, resolveConfig, resolveEnvironment, type IssuerConfig, type ResolvedIssuerConfig } from "./config.js";
import { checkEntitlement, minimumBalance, ownerOnly, type EntitlementPolicy, type EntitlementResult } from "./entitlement.js";
import { IssuerError } from "./errors.js";
import { createRouter } from "./http.js";
import { eoaSignatureVerifier, publicClientSignatureVerifier, type SignatureVerifier, type VerifyMessageClient } from "./signature.js";
import { memoryStores, passKeyFor, type IssuerStores, type LinkBinding, type PassRecord } from "./stores.js";

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
  ///  after a transfer or a reset. The issuer sets `voided` and drops links
  ///  on the result regardless; use the flag to change wording.
  superseded: boolean;
  /// Why, when `superseded`: "transfer" (the token changed hands) or
  ///  "reset" (the owner rotated the pass links). The old pass should say
  ///  which, and on a reset tell the holder to add the current pass.
  supersededReason?: SupersededReason;
  /// ERC-1155 binding, `lostEntitlement: "dark"` only: the account is below
  ///  the minimum holding and this pass is being told so. The card is the
  ///  same one and comes back when the holding returns, so it should say
  ///  that it is dark and why, and not present itself as usable.
  dark?: boolean;
  /// Unix seconds of the last content change.
  updatedAt: number;
}

/// What a holdings check did (ERC-1155 binding).
export interface HoldingsSummary {
  /// Issued accounts whose entitlement was read.
  checked: number;
  /// Accounts found below the minimum whose pass was retired.
  retired: Address[];
  /// Accounts found below the minimum whose pass went dark.
  dark: Address[];
  /// Accounts with a dark pass found holding again: the pass came back.
  revived: Address[];
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
  /// What a burned token's installed pass is pushed as. `render` is never
  ///  called for a token that no longer exists (it would read a dead token),
  ///  so this gets only what the issuer knows. The issuer sets `voided` and
  ///  drops links regardless. Default: a card titled "No longer exists".
  renderBurned?(ctx: { token: TokenRef; serial: string; owner: Address }): PassContent | Promise<PassContent>;
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
  /// The manifest's OPTIONAL `issuer` member: who signs the passes of each
  ///  format (`apple`: `teamIdentifier` and `passTypeIdentifier`; `google`:
  ///  `issuerId`). Sent in every manifest when set. REQUIRED when the
  ///  contract implements the issuer identity commitment
  ///  (`IERC721WalletPassIssuer`, ERC-165 id 0x470be7e9), and then it MUST
  ///  equal, member for member, the object `passIssuer()` returns: the
  ///  issuer does not read the contract, so keeping the two equal is the
  ///  integrator's job (`@erc8426/conformance` checks it).
  manifestIssuer?: PassIssuerIdentity;
  /// Nonce, pass record and link stores. Any store left out falls back to
  ///  the in-memory one, which serves one process and forgets everything on
  ///  restart. With NODE_ENV=production the fallback is refused at startup
  ///  (IssuerConfigError): pass `kvStores(kv, { chainId, contract })` for a shared store, or an
  ///  explicit `memoryStores()` for a deployment that really runs one
  ///  instance. Outside production the fallback logs one warning through
  ///  `onWarning` (default console.warn).
  stores?: Partial<IssuerStores>;
  /// Where a startup warning goes (an in-memory store fallback outside
  ///  production). Default console.warn.
  onWarning?(message: string): void;
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
  /// Tokens the fresh read found burned: their passes were voided and their
  ///  links retired, and render was not called.
  burned: string[];
  /// Tokens the fresh read found held by someone the pass was not issued
  ///  to: an unobserved transfer, rotated here as onTransfer would. Under
  ///  the ERC-1155 binding: "id:account" for each account found below the
  ///  minimum, whose pass was retired or went dark.
  rotated: string[];
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
  /// Rotate every link for a token (owner request): a new serial, fresh
  ///  links, and the old serial pushed as superseded so leaked copies go
  ///  dead. The holder of record is unchanged; they re-add the pass through
  ///  the manifest. The caller is responsible for having authorized the
  ///  request; the HTTP rotate route does so with a signed rotate proof.
  ///  ERC-1155 binding: there is no single owner, so `account` names whose
  ///  pass is rotated and no other holder's pass is touched. Left out, every
  ///  issued pass of the id is rotated, which only the issuer itself may
  ///  decide: no holder's request reaches that.
  rotate(tokenId: string | number | bigint, account?: string): Promise<void>;
  /// A transfer was observed (watcher, indexer webhook). Rotates the token's
  ///  links and marks the previous holder's pass superseded. A transfer to
  ///  the zero address is a burn: the holder's passes are voided (without
  ///  calling render) and every link is retired. Idempotent enough for
  ///  at-least-once delivery. Returns whether it rotated.
  ///  ERC-1155 binding: a transfer is a hint, not a verdict. It runs
  ///  `checkHoldings` for the two accounts it names, so selling one of three
  ///  at a minimum of 1 changes nothing. Pass the log's `blockNumber` to
  ///  also catch a balance that left and came back before the check ran.
  onTransfer(tokenId: string | number | bigint, from: string, to: string, blockNumber?: bigint): Promise<boolean>;
  /// ERC-1155 binding only. Read, fresh, the entitlement of the accounts
  ///  this issuer issued a pass of `tokenId` to (all of them, or only those
  ///  in `accounts`), and act on what the read says: an account below the
  ///  minimum has its pass retired or made dark (`lostEntitlement`), an
  ///  account with a dark pass that holds again gets it back. This read is
  ///  the truth and the transfer events are a hint, so calling it on a
  ///  timer needs no index of the chain's transfers and survives a missed
  ///  event. An account that newly reaches the minimum needs nothing here:
  ///  its own first claim serves it.
  ///
  ///  With `blockNumber` (the block of a transfer log) and "retire", an
  ///  account that holds now but was below the minimum at that block is
  ///  retired too. A log redelivered long after the fact can therefore
  ///  retire a pass claimed since; the holder adds the pass again.
  ///
  ///  A read that could not be taken throws IssuerError read_failed after
  ///  the other accounts are processed, and changes nothing for its account.
  checkHoldings(tokenId: string | number | bigint, options?: { accounts?: string[]; blockNumber?: bigint }): Promise<HoldingsSummary>;
  /// PassUpdate (one id) or BatchPassUpdate (inclusive range): bump
  ///  `updatedAt`, take a fresh ownerOf read for every issued pass, and push
  ///  fresh content through every provider. A token read as burned (a burn
  ///  emits PassUpdate) is voided instead of rendered; one held by someone
  ///  the pass was not issued to is rotated as an observed transfer. A read
  ///  that could not be taken throws IssuerError read_failed after the rest
  ///  of the range is processed.
  onPassUpdate(fromTokenId: string | number | bigint, toTokenId?: string | number | bigint): Promise<PassUpdateSummary>;
  /// The token's current capability action links, keyed by action. Empty
  ///  when the token has no record yet or the capability configuration is off.
  ///  ERC-1155 binding: `account` names whose pass.
  capabilityLinksFor(tokenId: string | number | bigint, account?: string): Promise<Record<string, string>>;
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
  /// `account` (the prover) selects the record under the ERC-1155 binding
  ///  and is ignored for ERC-721.
  rotateOnRequest(tokenId: string, account?: Address): Promise<PassRecord>;
  /// The account passes were last issued to, or null.
  holderOf(tokenId: string, account?: Address): Promise<Address | null>;
  buildManifest(record: PassRecord, owner: Address): Promise<PassManifest>;
  renderContent(record: PassRecord, owner: Address, superseded: SupersededReason | false): Promise<PassContent>;
  resolveLink(linkToken: string, kind: LinkBinding["kind"]): Promise<{ binding: LinkBinding; record: PassRecord } | null>;
  onPassUpdate: Issuer["onPassUpdate"];
}

type RotationReason = "transfer" | "claim" | "owner_request";

/// True under NODE_ENV=production and nothing else. Guarded so the issuer
///  still runs where there is no `process` (Workers, Deno without Node
///  compatibility).
/// @deprecated NODE_ENV is only the fallback; the issuer's own answer is
///  `issuer.config.environment` (the explicit `environment` option, else
///  NODE_ENV, else "unknown"), or `resolveEnvironment(explicit)` before an
///  issuer exists. Nothing in the issuer reads this function any more.
export function isProductionEnv(): boolean {
  return resolveEnvironment(undefined) === "production";
}

/// Fill in any store the options leave out with the in-memory one, refusing
///  to in production: a nonce spent on one instance would still be live on
///  another, and every pass record and link would vanish on restart, so a
///  deployment that reaches production without naming its stores almost
///  certainly did not mean to. An explicit `stores: memoryStores()` passes,
///  since every store is then named. Production is `config.environment`
///  (explicit option first, NODE_ENV as the fallback); when neither says and
///  the chain is a known mainnet, one warning says the guard is undecided.
/// The keyring links are derived with. A configured secret is used as is;
///  without one, production refuses (a store read would otherwise be the
///  only thing standing between a dump and every live link, and an
///  ephemeral secret would kill every link on restart) and anything else
///  gets a random secret and one warning.
function resolveLinkKeyring(options: CreateIssuerOptions, config: ResolvedIssuerConfig): LinkKeyring {
  if (config.linkSecret) return new LinkKeyring(config.linkSecret);
  if (config.environment === "production") {
    throw new IssuerConfigError(
      `${options.environment === "production" ? 'environment is "production"' : "NODE_ENV is production"} but no linkSecret was configured: capability and download links are derived from it, so a store read alone yields no link and every instance renders the same links. Set linkSecret to at least 32 bytes ("openssl rand -base64 32"), the same on every instance.`,
    );
  }
  const warn = options.onWarning ?? ((message: string) => console.warn(message));
  warn(
    "[erc8426/issuer] no linkSecret configured: using a random one for this process, so every capability and download link stops resolving when it restarts. Production refuses this; set linkSecret to at least 32 bytes, the same on every instance.",
  );
  return new LinkKeyring(ephemeralLinkSecret());
}

function resolveStores(options: CreateIssuerOptions, config: ResolvedIssuerConfig, now: () => number): IssuerStores {
  const warn = options.onWarning ?? ((message: string) => console.warn(message));
  if (config.environment === "unknown" && isKnownMainnet(config.chainId)) {
    warn(
      `[erc8426/issuer] production mode is undetermined: chain ${config.chainId} is a mainnet but neither the environment option nor NODE_ENV is set, so the production guards (the in-memory store refusal) cannot tell this is real. Set environment: "production" (or "development") in createIssuer.`,
    );
  } else if (options.environment === "development" && isKnownMainnet(config.chainId)) {
    // The explicit option only: a NODE_ENV-derived development (a test
    // runner against a mainnet fork) is covered by the undetermined case
    // above when NODE_ENV is unset, and is not worth a warning when set.
    warn(
      `[erc8426/issuer] environment is "development" but chain ${config.chainId} is a mainnet: the production guards (the in-memory store refusal, the linkSecret requirement) are off for an issuer that serves real tokens. If this is the real deployment, set environment: "production".`,
    );
  }
  const given = options.stores ?? {};
  const missing = (["nonces", "passes", "links"] as const).filter((k) => !given[k]);
  if (missing.length === 0) return { nonces: given.nonces!, passes: given.passes!, links: given.links! };
  const names = missing.join(", ");
  if (config.environment === "production") {
    const how = options.environment === "production" ? 'environment is "production"' : "NODE_ENV is production";
    throw new IssuerConfigError(
      `${how} but no ${names} store${missing.length > 1 ? "s were" : " was"} configured: the in-memory fallback serves one process and loses every nonce, pass record and link on restart. Pass stores: kvStores(kv, { chainId, contract }) (Redis, Upstash, Vercel KV), or stores: memoryStores() to run one instance deliberately.`,
    );
  }
  warn(
    `[erc8426/issuer] no ${names} store${missing.length > 1 ? "s" : ""} configured: falling back to the in-memory store${missing.length > 1 ? "s" : ""} (one process, lost on restart). Production refuses this; pass stores: kvStores(kv, { chainId, contract }) or an explicit memoryStores().`,
  );
  const defaults = memoryStores({ now });
  return {
    nonces: given.nonces ?? defaults.nonces,
    passes: given.passes ?? defaults.passes,
    links: given.links ?? defaults.links,
  };
}

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
  const is1155 = config.standard === "erc1155";
  const entitlement = options.entitlement ?? (is1155 ? minimumBalance() : ownerOnly());
  let manifestIssuer: PassIssuerIdentity | undefined;
  if (options.manifestIssuer !== undefined) {
    const parsed = parsePassIssuer(options.manifestIssuer, "manifestIssuer");
    if (!parsed.ok) throw new IssuerConfigError(parsed.issues.map((i) => `${i.path}: ${i.message}`).join("; "));
    manifestIssuer = parsed.issuer;
  }
  const stores = resolveStores(options, config, now);
  if (is1155 && typeof stores.passes.accounts !== "function") {
    throw new IssuerConfigError(
      'standard "erc1155" needs a pass store with accounts(tokenId): the issuer keeps one record per id and holding account and must list the accounts it issued to (memoryStores and kvStores provide it)',
    );
  }
  // The record key: per token for ERC-721, per id and account for ERC-1155.
  const keyOf = (tokenId: string, account?: string | null) => passKeyFor(tokenId, is1155 ? account : null);
  const bindingOf = (record: PassRecord, kind: LinkBinding["kind"], name: string): LinkBinding => ({
    kind,
    tokenId: record.tokenId,
    ...(record.account ? { account: record.account } : {}),
    name,
    generation: record.generation,
  });
  const keyring = resolveLinkKeyring(options, config);
  const onError =
    options.onError ?? ((error: unknown, ctx: IssuerErrorContext) => console.error(`[erc8426/issuer] ${ctx.operation} failed`, error));
  const fileProviders = providers.filter(isFileProvider);
  const nowSeconds = () => Math.floor(now() / 1000);
  const base = `${config.baseUrl}${config.basePath}`;

  const token = (tokenId: string) => tokenRef(config.chainId, config.contract, tokenId, config.standard);
  const passUri = (tokenId: string | number | bigint) => `${base}/${normalizeTokenId(tokenId)}`;
  const challengeUri = (tokenId: string | number | bigint, action: string = ACQUIRE_ACTION) =>
    `${passUri(tokenId)}/challenge${action === ACQUIRE_ACTION ? "" : `?action=${encodeURIComponent(action)}`}`;
  const linkUrl = (t: string) => `${base}/links/${t}`;
  const downloadUrl = (t: string) => `${base}/passes/${t}`;
  // The record holds seeds; the URL carries the token derived from each.
  const linkUrls = async (record: PassRecord) => {
    const out: Record<string, string> = {};
    for (const [action, seed] of Object.entries(record.links)) out[action] = linkUrl(await keyring.token(seed));
    return out;
  };
  // The store keys of every link and download the record currently holds.
  const digestsOf = (record: PassRecord) => Promise.all([...Object.values(record.links), ...Object.values(record.downloads)].map((seed) => keyring.digestOfSeed(seed)));

  // A record bound under another linkSecret (a rotation, a dev restart with
  // an ephemeral secret, or a 0.3.0 record with no stamp) has link rows the
  // current keyring can never reach: the digests it computes from the seeds
  // differ from the ones stored, so every link and download would answer
  // unknown_capability forever. Rewrite the bindings under the current
  // secret and stamp the record. The seeds themselves stay, so the URLs
  // the holder sees change (a secret rotation retires every old link, as
  // documented) but the record stays whole and the next claim works.
  async function rebind(record: PassRecord): Promise<boolean> {
    const id = await keyring.id();
    if (record.linkKeyring === id) return false;
    for (const [action, seed] of Object.entries(record.links)) {
      await stores.links.put(await keyring.digestOfSeed(seed), bindingOf(record, "action", action));
    }
    for (const [format, seed] of Object.entries(record.downloads)) {
      await stores.links.put(await keyring.digestOfSeed(seed), bindingOf(record, "download", format));
    }
    record.linkKeyring = id;
    return true;
  }

  // Mint links for whatever the record is missing: every capability action
  // and every file format. A link is a random seed in the record plus a
  // binding stored under the digest of the token derived from that seed;
  // the token itself is never written anywhere. Links already present are
  // kept (and re-bound first if the secret changed under them).
  async function fill(record: PassRecord): Promise<boolean> {
    let changed = await rebind(record);
    for (const action of config.capabilityActions) {
      if (record.links[action]) continue;
      const seed = newLinkSeed();
      await stores.links.put(await keyring.digestOfSeed(seed), bindingOf(record, "action", action));
      record.links[action] = seed;
      changed = true;
    }
    for (const p of fileProviders) {
      if (record.downloads[p.format]) continue;
      const seed = newLinkSeed();
      await stores.links.put(await keyring.digestOfSeed(seed), bindingOf(record, "download", p.format));
      record.downloads[p.format] = seed;
      changed = true;
    }
    return changed;
  }

  // A record read through from a 0.2.x row (stores.ts, `migratedFrom`) is
  // settled on first use: rotated under a new serial with fresh links, and
  // the old serial pushed as superseded with reason "reset", so the holder's
  // installed pass says it was replaced and how to re-add it, rather than
  // sitting frozen with links that can never resolve again.
  async function settle(record: PassRecord): Promise<PassRecord> {
    if (!record.migratedFrom) return record;
    return rotateRecord(record, "owner_request", null);
  }

  async function loadOrCreate(tokenId: string, account?: Address): Promise<PassRecord> {
    if (is1155 && !account) throw new Error("an ERC-1155 pass record needs its account");
    let record = await stores.passes.get(keyOf(tokenId, account));
    if (record) record = await settle(record);
    if (!record) {
      const t = nowSeconds();
      record = {
        tokenId,
        ...(is1155 ? { account: account! } : {}),
        serial: newSerial(),
        generation: 0,
        lastIssuedTo: null,
        links: {},
        downloads: {},
        updatedAt: t,
        rotatedAt: t,
      };
      await fill(record);
      await stores.passes.put(record);
    } else if (await fill(record)) {
      await stores.passes.put(record);
    }
    return record;
  }

  async function renderContent(record: PassRecord, owner: Address, superseded: SupersededReason | false): Promise<PassContent> {
    const content = await options.render({
      token: token(record.tokenId),
      owner,
      serial: record.serial,
      links: superseded ? {} : await linkUrls(record),
      superseded: Boolean(superseded),
      ...(superseded ? { supersededReason: superseded } : {}),
      ...(record.dark && !superseded ? { dark: true } : {}),
      updatedAt: record.updatedAt,
    });
    const out: PassContent = { ...content, serial: record.serial };
    if (superseded) {
      // Issuer requirements: the previous owner's pass SHOULD be updated,
      // invalidated, or visibly marked as superseded. Voided presents it as
      // expired on both platforms; its links are dead after rotation anyway.
      out.voided = true;
      out.links = [];
      out.supersededReason = superseded;
    }
    return out;
  }

  // Push content to installed passes. A failed push never fails the caller:
  // the state change it follows has already happened.
  async function notify(record: PassRecord, owner: Address, superseded: SupersededReason | false, operation: string): Promise<void> {
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
  // ones under a NEW serial, then push the old serial as superseded (voided,
  // no links). Every copy of the old pass, the holder's own and any that
  // leaked (a forwarded .pkpass, a shared Google save link), refreshes into
  // a dead card and never receives the new links. That is what makes a
  // rotation on the owner's request a remedy for a leak: the owner re-adds
  // the new pass by fetching the manifest again with an acquire proof.
  //  - "transfer": the holder of record is cleared until the next claim.
  //  - "claim": a new account's first claim; it becomes the holder.
  //  - "owner_request": the holder of record is unchanged.
  async function rotateRecord(record: PassRecord, reason: RotationReason, holder: Address | null): Promise<PassRecord> {
    // So the deletes below hit the rows that exist under the current secret.
    if (await rebind(record)) await stores.passes.put(record);
    const { migratedFrom: _settled, ...base } = record;
    const next: PassRecord = {
      ...base,
      generation: record.generation + 1,
      serial: newSerial(),
      lastIssuedTo: reason === "transfer" ? null : reason === "claim" ? holder : record.lastIssuedTo,
      links: {},
      downloads: {},
      rotatedAt: nowSeconds(),
    };
    // A retired pass is gone, not dark: the next claim starts a new one.
    if (reason === "transfer") delete next.dark;
    await fill(next);
    // The record is the source of truth for which tokens are current, so it
    // is written first: from this moment the old tokens resolve to nothing
    // even if deleting them below fails.
    await stores.passes.put(next);
    await stores.links.delete(await digestsOf(record));
    // A new account's claim is a change of hands like an observed transfer;
    // only the owner's own request keeps the holder, and its pass says so.
    if (record.lastIssuedTo) await notify(record, record.lastIssuedTo, reason === "owner_request" ? "reset" : "transfer", "supersede");
    return next;
  }

  // A burned token: void the holder's installed passes without rendering
  // (render would read a token that no longer exists) and retire every link
  // and download. Nothing is minted in their place; a re-mint starts over.
  async function burnRecord(record: PassRecord): Promise<void> {
    if (await rebind(record)) await stores.passes.put(record);
    const { migratedFrom: _settled, ...base } = record;
    const next: PassRecord = {
      ...base,
      generation: record.generation + 1,
      serial: newSerial(),
      lastIssuedTo: null,
      links: {},
      downloads: {},
      rotatedAt: nowSeconds(),
    };
    await stores.passes.put(next);
    await stores.links.delete(await digestsOf(record));
    const holder = record.lastIssuedTo;
    if (!holder) return;
    const targets = providers.filter((p) => typeof p.notifyUpdate === "function");
    if (targets.length === 0) return;
    const t = token(record.tokenId);
    let content: PassContent;
    try {
      content = options.renderBurned
        ? await options.renderBurned({ token: t, serial: record.serial, owner: holder })
        : {
            serial: record.serial,
            organizationName: config.domain,
            description: `Token ${record.tokenId} no longer exists`,
            title: "No longer exists",
            primary: [{ key: "status", label: "STATUS", value: "Burned" }],
          };
    } catch (error) {
      onError(error, { operation: "burn:render", tokenId: record.tokenId });
      return;
    }
    const ctx: PassContext = { token: t, owner: holder, content: { ...content, serial: record.serial, voided: true, links: [] } };
    const results = await Promise.allSettled(targets.map((p) => p.notifyUpdate!(ctx)));
    results.forEach((r, i) => {
      if (r.status === "rejected") onError(r.reason, { operation: `burn:${targets[i]!.format}`, tokenId: record.tokenId });
    });
  }

  // ERC-1155 binding: an issued account was read below the minimum.
  //  - "retire": as an observed ERC-721 transfer. Links and acquisition
  //    URLs are retired, the old serial is pushed as superseded, and the
  //    account is no longer issued to, so its return is a first claim.
  //  - "dark" (no capability links exist): the acquisition URLs are still
  //    retired, since in the gated configuration they are possession proofs
  //    for the download. The serial stays, and the pass is pushed with
  //    `dark` set.
  async function lose(record: PassRecord): Promise<"retired" | "dark"> {
    if (config.lostEntitlement === "retire") {
      await rotateRecord(record, "transfer", null);
      return "retired";
    }
    if (await rebind(record)) await stores.passes.put(record);
    const retired = await Promise.all(Object.values(record.downloads).map((seed) => keyring.digestOfSeed(seed)));
    const next: PassRecord = { ...record, dark: true, downloads: {}, updatedAt: Math.max(nowSeconds(), record.updatedAt) };
    await fill(next);
    await stores.passes.put(next);
    await stores.links.delete(retired);
    if (next.lastIssuedTo) await notify(next, next.lastIssuedTo, false, "dark");
    return "dark";
  }

  // A dark pass whose account holds again: the same card, live.
  async function revive(record: PassRecord): Promise<void> {
    delete record.dark;
    record.updatedAt = Math.max(nowSeconds(), record.updatedAt);
    await stores.passes.put(record);
    if (record.lastIssuedTo) await notify(record, record.lastIssuedTo, false, "revive");
  }

  async function checkHoldings(
    tokenId: string | number | bigint,
    opts: { accounts?: string[]; blockNumber?: bigint } = {},
  ): Promise<HoldingsSummary> {
    if (!is1155) throw new IssuerError("invalid_request", 'checkHoldings serves standard "erc1155" only');
    let id: string;
    try {
      id = normalizeTokenId(tokenId);
    } catch {
      throw new IssuerError("invalid_request", `invalid token id: ${String(tokenId)}`);
    }
    const issued = await stores.passes.accounts!(id);
    const named = opts.accounts?.filter((a) => typeof a === "string" && isAddress(a, { strict: false })) as Address[] | undefined;
    const wanted = named ? issued.filter((a) => named.some((b) => isAddressEqual(a, b))) : issued;
    const summary: HoldingsSummary = { checked: 0, retired: [], dark: [], revived: [] };
    const failed: Address[] = [];
    for (const account of wanted) {
      const record = await stores.passes.get(keyOf(id, account));
      // Never issued, or retired since: no pass of this account is out.
      if (!record || record.lastIssuedTo === null) continue;
      summary.checked++;
      let holds: boolean;
      try {
        holds = (await internals.entitled(id, account, ACQUIRE_ACTION)).entitled;
        // The fresh read cannot see a balance that left and came back
        // between two reads. For a pass that is retired on loss that gap
        // counts, so the block of the transfer that was reported is read
        // as well. A dark pass comes back anyway, so there it is skipped.
        // It is skipped as well for a pass issued after that block: the
        // account was read as holding after whatever the log reports, and
        // only then got its URLs. Without this, a log delivered late (a
        // catch-up job, a redelivered webhook) retires the pass an account
        // claimed after its unit came back.
        const issuedAfter = opts.blockNumber !== undefined && record.issuedAtBlock !== undefined && BigInt(record.issuedAtBlock) > opts.blockNumber;
        if (holds && opts.blockNumber !== undefined && config.lostEntitlement === "retire" && !issuedAfter) {
          holds = (
            await checkEntitlement(entitlement, { token: token(id), account, action: ACQUIRE_ACTION, reader: chain!, now: now(), blockNumber: opts.blockNumber })
          ).entitled;
        }
      } catch (error) {
        onError(error, { operation: "holdings:read", tokenId: id });
        failed.push(account);
        continue;
      }
      if (!holds) {
        if (record.dark) continue;
        summary[(await lose(record)) === "retired" ? "retired" : "dark"].push(account);
      } else if (record.dark) {
        await revive(record);
        summary.revived.push(account);
      }
    }
    if (failed.length > 0) {
      throw new IssuerError("read_failed", `the fresh entitlement read could not be taken for ${failed.join(", ")} on id ${id}; nothing changed for them`);
    }
    return summary;
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
        throw new IssuerError("invalid_request", `invalid token id: ${String(input.tokenId)}`);
      }
      if (typeof input.account !== "string" || !isAddress(input.account, { strict: false })) {
        throw new IssuerError("invalid_request", "address must be a valid account address");
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
      if (is1155) {
        // One record per id and account, so a claim never touches another
        // holder's pass. The prover was just read as entitled. A record
        // with nobody issued (new, or retired since) makes this a first
        // claim: the links it holds were minted at creation or at the
        // retirement and nobody has seen them. A dark pass comes back.
        const mine = await loadOrCreate(tokenId, account);
        if (mine.lastIssuedTo !== null && !mine.dark) return mine;
        const wasDark = mine.dark === true && mine.lastIssuedTo !== null;
        mine.lastIssuedTo = account;
        // Date the issuance, so a transfer log from before it is not held
        // against this pass (see checkHoldings). Best effort: without it the
        // check falls back to reading the log's block for every pass.
        const head = await chain?.blockNumber?.().catch(() => undefined);
        if (head === undefined) delete mine.issuedAtBlock;
        else mine.issuedAtBlock = head.toString();
        if (wasDark) await revive(mine);
        else {
          delete mine.dark;
          await stores.passes.put(mine);
        }
        return mine;
      }
      const record = await loadOrCreate(tokenId);
      if (record.lastIssuedTo === null) {
        record.lastIssuedTo = account;
        await stores.passes.put(record);
        return record;
      }
      if (isAddressEqual(record.lastIssuedTo, account)) return record;
      // Under an additive policy (delegation) the holder of record may still
      // be entitled: then this is not a new holder, just another entitled
      // account, and it shares the holder's pass rather than voiding it. The
      // pass stays issued to the holder of record, so its links keep acting
      // on that account's entitlement. Only when the holder of record is no
      // longer entitled (a sale, an exclusive rental) is this a first claim.
      let previousStillEntitled: boolean;
      try {
        previousStillEntitled = (await internals.entitled(tokenId, record.lastIssuedTo, ACQUIRE_ACTION)).entitled;
      } catch {
        throw new IssuerError("read_failed", "the fresh entitlement read of the previous holder could not be taken");
      }
      if (previousStillEntitled) return record;
      return rotateRecord(record, "claim", account);
    },

    async holderOf(tokenId, account) {
      return (await stores.passes.get(keyOf(tokenId, account)))?.lastIssuedTo ?? null;
    },

    // ERC-1155: the prover's own record and no other holder's.
    async rotateOnRequest(tokenId, account) {
      return rotateRecord(await loadOrCreate(tokenId, account), "owner_request", null);
    },

    async buildManifest(record, owner) {
      const content = await renderContent(record, owner, false);
      const ctx: PassContext = { token: token(record.tokenId), owner, content };
      const entries = await Promise.all(
        providers.map(
          async (p) => [p.format, isFileProvider(p) ? downloadUrl(await keyring.token(record.downloads[p.format]!)) : await p.acquisitionUrl(ctx)] as const,
        ),
      );
      return createManifest(Object.fromEntries(entries) as PassManifest["formats"], record.updatedAt, manifestIssuer ? { issuer: manifestIssuer } : {});
    },

    renderContent,

    // A link resolves only while the pass record still lists it as current:
    // rotation rewrites the record first, so a rotated link is dead even if
    // its store entry lingers.
    // The presented token is hashed before lookup; the raw token is never
    // compared against anything stored. The record's current seed must
    // derive to the presented token, so a binding left behind by a racing
    // rotation resolves to nothing.
    async resolveLink(linkToken, kind) {
      if (!isLinkTokenShape(linkToken)) return null;
      const binding = await stores.links.get(await linkDigest(linkToken));
      if (!binding || binding.kind !== kind) return null;
      const record = await stores.passes.get(passKeyFor(binding.tokenId, binding.account));
      if (!record) return null;
      const seed = kind === "action" ? record.links[binding.name] : record.downloads[binding.name];
      if (!seed) return null;
      return (await keyring.token(seed)) === linkToken ? { binding, record } : null;
    },

    async onPassUpdate(fromTokenId, toTokenId) {
      let from: bigint;
      let to: bigint;
      try {
        from = BigInt(normalizeTokenId(fromTokenId));
        to = toTokenId === undefined ? from : BigInt(normalizeTokenId(toTokenId));
      } catch {
        throw new IssuerError("invalid_request", "invalid token id in pass update");
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
      const summary: PassUpdateSummary = { updated: 0, burned: [], rotated: [] };
      const failed: string[] = [];
      for (const id of ids) {
        if (is1155) {
          // PassUpdate(id) concerns every pass issued for the id: one per
          // account this issuer issued to. Each gets its own fresh read
          // first, so content is never pushed to an account that no longer
          // holds.
          for (const account of await stores.passes.accounts!(id)) {
            const mine = await stores.passes.get(keyOf(id, account));
            if (!mine || mine.lastIssuedTo === null) continue;
            mine.updatedAt = Math.max(nowSeconds(), mine.updatedAt);
            await stores.passes.put(mine);
            summary.updated++;
            let holds: boolean;
            try {
              holds = (await internals.entitled(id, account, ACQUIRE_ACTION)).entitled;
            } catch (error) {
              onError(error, { operation: "update:read", tokenId: id });
              failed.push(`${id}:${account}`);
              continue;
            }
            if (!holds) {
              if (mine.dark) continue;
              await lose(mine);
              summary.rotated.push(`${id}:${account}`);
            } else if (mine.dark) await revive(mine);
            else await notify(mine, account, false, "update");
          }
          continue;
        }
        let record = await stores.passes.get(id);
        if (!record) continue;
        // A migrated 0.2.x record is settled first (old serial superseded,
        // new serial minted), so the fresh content below goes to the new
        // pass and never to a pass that still shows dead links.
        record = await settle(record);
        // updatedAt SHOULD change whenever PassUpdate is emitted for the token.
        record.updatedAt = Math.max(nowSeconds(), record.updatedAt);
        await stores.passes.put(record);
        summary.updated++;
        const holder = record.lastIssuedTo;
        if (!holder) continue;
        // Fresh read before rendering: a burn emits PassUpdate too, and a
        // transfer no watcher has seen yet must not push the new owner's
        // state to the previous holder's pass.
        let owner: Address | null;
        let stillEntitled: boolean;
        try {
          owner = await chain.ownerOf(token(id));
          stillEntitled = owner !== null && (await internals.entitled(id, holder, ACQUIRE_ACTION)).entitled;
        } catch (error) {
          onError(error, { operation: "update:read", tokenId: id });
          failed.push(id);
          continue;
        }
        if (owner === null) {
          await burnRecord(record);
          summary.burned.push(id);
        } else if (!stillEntitled) {
          await rotateRecord(record, "transfer", null);
          summary.rotated.push(id);
        } else {
          await notify(record, holder, false, "update");
        }
      }
      if (failed.length > 0) {
        throw new IssuerError(
          "read_failed",
          `the fresh ${is1155 ? "entitlement" : "ownerOf"} read could not be taken for token(s) ${failed.join(", ")}; nothing was rendered for them`,
        );
      }
      return summary;
    },
  };

  const route = createRouter(internals);

  return {
    config,
    stores,
    chain,
    route,
    async handler(request) {
      return (await route(request)) ?? new Response(JSON.stringify({ error: "unknown_capability" }), { status: 404, headers: { "Content-Type": "application/json" } });
    },
    passUri,
    challengeUri,
    issueChallenge: internals.issueChallenge,
    authorize: internals.authorize,
    async rotate(tokenId, account) {
      const id = normalizeTokenId(tokenId);
      if (is1155) {
        const accounts = account === undefined ? await stores.passes.accounts!(id) : [getAddress(account)];
        for (const a of accounts) {
          const mine = await stores.passes.get(keyOf(id, a));
          if (mine) await rotateRecord(mine, "owner_request", null);
        }
        return;
      }
      const record = await stores.passes.get(id);
      if (!record) return;
      await rotateRecord(record, "owner_request", null);
    },
    async onTransfer(tokenId, from, to, blockNumber) {
      const id = normalizeTokenId(tokenId);
      if (is1155) {
        const s = await checkHoldings(id, { accounts: [from, to], ...(blockNumber === undefined ? {} : { blockNumber }) });
        return s.retired.length + s.dark.length + s.revived.length > 0;
      }
      const record = await stores.passes.get(id);
      // Nothing was ever issued for this token: no URL to retire.
      if (!record) return false;
      // A transfer to the zero address is a burn.
      if (isAddress(to, { strict: false }) && isAddressEqual(to as Address, zeroAddress)) {
        await burnRecord(record);
        return true;
      }
      // Already issued to the recipient (the buyer's first claim beat the
      // indexer, or a self transfer): its links are the new owner's already.
      if (record.lastIssuedTo && isAddress(to, { strict: false }) && isAddressEqual(record.lastIssuedTo, to as Address)) return false;
      await rotateRecord(record, "transfer", null);
      return true;
    },
    onPassUpdate: internals.onPassUpdate,
    checkHoldings,
    async capabilityLinksFor(tokenId, account) {
      let record = await stores.passes.get(keyOf(normalizeTokenId(tokenId), account));
      if (record) record = await settle(record);
      return record ? await linkUrls(record) : {};
    },
  };
}
