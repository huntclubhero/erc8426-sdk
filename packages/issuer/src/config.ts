import { getAddress, isAddress, type Address } from "viem";
import { ACQUIRE_ACTION, ROTATE_ACTION, isValidActionName, type TokenRef } from "@erc8426/core";

import { defaultClientKey, memoryRateLimiter, unlimited, type ClientKeyFn, type RateLimitRule, type RateLimiter } from "./rateLimit.js";
import type { RepeatStore } from "./repeat.js";

/// The two configurations the standard defines under Acquisition URLs.
///
///  - "public": the manifest is served to anyone. Its acquisition URLs are one
///    chain read away from anyone who can enumerate token ids, so they are
///    hygiene only and MUST NOT be treated as a proof of possession.
///  - "gated": the manifest is returned only to a request that carries a
///    verified control proof for the `acquire` action. Only here may an
///    acquisition URL (or a capability link) carry the possession role.
export type IssuerMode = "public" | "gated";

/// What an action's `execute` receives. It runs only after the floor (signed
///  path) or the capability conditions (capability path) have passed AND a
///  fresh entitlement read has named `account` as entitled.
export interface ActionContext {
  token: TokenRef;
  action: string;
  /// The entitled account: the proven signer on the signed path, the holder
  ///  the link was issued to on the capability path.
  account: Address;
  /// Which authorization path admitted the request.
  path: "signed" | "capability";
  /// The entitlement that admitted `account`, for example "owner", "rental"
  ///  or "delegate" (see entitlement.ts).
  via: string;
  /// The optional `params` member of the request body. Params are NOT covered
  ///  by the signature (a challenge binds token and action only), so use them
  ///  for choices that carry no authority, and keep the documented bound true
  ///  for every possible value on the capability path.
  params: unknown;
  request: Request;
  /// Bump the token's `updatedAt` and push fresh content to installed passes.
  ///  Call it when the action changed state rendered on the pass.
  notifyUpdate(): Promise<void>;
}

export interface ActionDefinition<Result = unknown> {
  /// Human description, shown on the capability link confirm page.
  description: string;
  /// Make this action reachable through a capability link embedded in the
  ///  pass (The capability configuration). Default false: the action is only
  ///  reachable with a per-action signed challenge.
  capability?: boolean;
  /// The documented bound on the action's total effect under unlimited
  ///  repetition, including any value it moves. REQUIRED for a capability
  ///  action: "the implementation MUST document that bound". Example:
  ///  "Feeds the pet once per hour; costs nothing; cannot move tokens".
  bound?: string;
  /// Set true when the action transfers, burns or approves the token, or
  ///  changes who is entitled to it. Such an action MUST NOT be reachable
  ///  through a capability link, so config validation refuses the pair.
  transfersOrBurns?: boolean;
  /// Apply the effect. Throw an `ActionError` to refuse with a chosen status;
  ///  the return value is sent back as `result` (keep it JSON serializable).
  execute(ctx: ActionContext): Result | Promise<Result>;
}

/// What a capability link confirm page is rendered from.
export interface LinkPageContext {
  token: TokenRef;
  action: string;
  description: string;
  bound: string;
  /// The URL the confirm page POSTs to (the link itself).
  postUrl: string;
  request: Request;
}

export interface CapabilityConfig {
  /// Operate the capability configuration: the gated configuration with
  ///  capability links standing in for check (1) on actions marked
  ///  `capability: true`. Requires mode "gated".
  enabled: boolean;
  /// Render the page a device shows when a pass link is opened (a GET). The
  ///  GET MUST stay side-effect free, so the page should POST to `postUrl`
  ///  on a user gesture. Defaults to a minimal built-in HTML page for
  ///  browsers and a JSON description otherwise.
  confirmPage?: (ctx: LinkPageContext) => Response | Promise<Response>;
}

/// Rate limits on the anonymous surface. Each endpoint family has one rule
///  (at most `limit` attempts per `windowSeconds`), keyed by client address
///  plus the token in the path, so one client cannot exhaust an endpoint for
///  everyone and one token's traffic cannot hide another's. Over the limit
///  the issuer answers 429 `{ "error": "rate_limited" }` with `Retry-After`.
export interface RateLimitConfig {
  /// Where counts live. Default `memoryRateLimiter()` (exact sliding window,
  ///  one process). Pass `kvRateLimiter(kv)` for one limit across instances,
  ///  or any `RateLimiter`.
  limiter?: RateLimiter;
  /// GET /:tokenId/challenge, keyed by client and token. Default 30 per 60 s.
  ///  Every request mints a nonce and a store write. `false` disables.
  challenge?: RateLimitRule | false;
  /// GET /:tokenId (the manifest), keyed by client and token. Default 60 per
  ///  60 s. A gated request costs a signature check and a chain read.
  manifest?: RateLimitRule | false;
  /// GET and POST /links/:link and GET /passes/:link, keyed by client and
  ///  link. Default 60 per 60 s. A POST costs a chain read and an action.
  capability?: RateLimitRule | false;
  /// POST /:tokenId/actions/:action, keyed by client and token. Default 30
  ///  per 60 s. Every presentation costs a parse and a signature check.
  action?: RateLimitRule | false;
  /// POST /:tokenId/rotate, keyed by client and token. Default 10 per 60 s.
  rotate?: RateLimitRule | false;
  /// A second bucket per family keyed by the client ALONE, with no token in
  ///  the key, so a client cannot start a fresh bucket for every token id or
  ///  link it names and mint nonces or chain reads without bound. Default
  ///  120 per 60 s per family. `false` disables it (the per-token buckets
  ///  stay).
  perClient?: RateLimitRule | false;
  /// The client identity a request is counted under. Default
  ///  `defaultClientKey`: the socket address the Node adapter recorded, and
  ///  nothing a client can send. Behind a proxy use `forwardedClientKey(n)`
  ///  or `trustedHeaderClientKey(name)`. Return null to count every unknown
  ///  client together.
  clientKey?: ClientKeyFn;
}

export interface ResolvedRateLimitConfig {
  limiter: RateLimiter;
  challenge: RateLimitRule | false;
  manifest: RateLimitRule | false;
  capability: RateLimitRule | false;
  action: RateLimitRule | false;
  rotate: RateLimitRule | false;
  perClient: RateLimitRule | false;
  clientKey: ClientKeyFn;
}

/// Identical repeats answered with the first outcome (see repeat.ts). iOS
///  in-app browsers resend a POST the phone aborted, so without this every
///  tap on a pass link could run an action twice or meet `nonce_invalid`.
export interface RepeatConfig {
  /// How long after a request completes an identical repeat still gets its
  ///  outcome. Default 30 seconds.
  windowSeconds?: number;
  /// Where outcomes live. Default `memoryRepeatStore()` (one process). Pass
  ///  `kvRepeatStore(kv)` so instances share completed outcomes.
  store?: RepeatStore;
}

export interface ResolvedRepeatConfig {
  windowSeconds: number;
  /// Absent means the in-memory store, built by the issuer on its own clock.
  store?: RepeatStore;
}

export interface CorsConfig {
  /// "*" or an explicit allowlist of origins (scheme://host[:port]).
  origins: "*" | string[];
  maxAgeSeconds?: number;
}

/// Chains the issuer treats as mainnets when deciding whether to warn that
///  production mode is undetermined: Ethereum, Optimism, Polygon, Base,
///  Arbitrum One. Kept short on purpose; any other chain id is neither
///  assumed production nor test.
export const MAINNET_CHAIN_IDS: readonly number[] = [1, 10, 137, 8453, 42161];

export function isKnownMainnet(chainId: number): boolean {
  return MAINNET_CHAIN_IDS.includes(chainId);
}

export type IssuerEnvironment = "production" | "development";

export interface IssuerConfig {
  /// Whether this issuer is the real thing. "production" refuses every
  ///  setup that only works for one process or one session (today: the
  ///  in-memory store fallback); "development" allows them with a warning.
  ///  When set it decides; when left out, NODE_ENV=production means
  ///  production and any other NODE_ENV means development. When neither is
  ///  set and `chainId` is a known mainnet (MAINNET_CHAIN_IDS) the issuer
  ///  warns once that production mode is undetermined, because a guard keyed
  ///  on a variable nobody set protects nothing. Set it explicitly.
  environment?: IssuerEnvironment;
  /// Secret the capability and download link tokens are derived from (HMAC
  ///  over a random seed kept in the pass record), so that a read of the
  ///  store alone yields no usable link: the store holds seeds and token
  ///  digests, never a token. At least 32 bytes (`openssl rand -base64 32`),
  ///  the same on every instance, and rotated only when every link should
  ///  die at once. REQUIRED in production. Left out in development, the
  ///  issuer makes a random one and warns: links then stop resolving when
  ///  the process restarts.
  linkSecret?: string | Uint8Array;
  /// Verifier identity: the SIWE `domain` every challenge names and every
  ///  proof is checked against, for example "issuer.example". An authority,
  ///  with no scheme or path.
  domain: string;
  /// Absolute origin every emitted URL is built on, for example
  ///  "https://issuer.example". Emitted URLs never echo the request's Host.
  baseUrl: string;
  /// Path prefix the HTTP surface lives under. Default "/wallet-pass", so the
  ///  contract's passURI is `${baseUrl}/wallet-pass/${tokenId}`.
  basePath?: string;
  /// SIWE `URI` field. Default `${baseUrl}${basePath}/actions`, the shape of
  ///  the spec's worked example.
  uri?: string;
  /// The chain and contract this issuer serves. A proof is bound against
  ///  these, never against values supplied with a request.
  chainId: number;
  contract: string;
  mode: IssuerMode;
  /// Lifetime of an issued challenge. Default 300.
  challengeTtlSeconds?: number;
  /// Nonce retention. Default twice the challenge lifetime, and never less
  ///  than it, so a late submission is refused precisely as
  ///  challenge_expired rather than as an unknown nonce. Single-use
  ///  consumption, not eviction, is what stops replay.
  nonceTtlSeconds?: number;
  /// Retry-After sent with every 503 read_failed. Default 5.
  retryAfterSeconds?: number;
  /// Pass-reachable actions, keyed by action name.
  actions?: Record<string, ActionDefinition>;
  capability?: CapabilityConfig;
  /// CORS for browser clients: a marketplace or wallet web app that fetches
  ///  the manifest and resolves a gated one from its own origin. Default:
  ///  none. With no `cors` the issuer sends no Access-Control headers and a
  ///  browser on another origin cannot read any response, which is what a
  ///  deployment whose only browser caller is its own site wants. To serve
  ///  browser clients on other origins, name them (`{ origins: [...] }`) or
  ///  say `{ origins: "*" }` explicitly. Until 0.3.0 the default was `"*"`,
  ///  which made every manifest, including a gated one resolved with a
  ///  stolen proof, readable cross-origin by any page; no cookies are
  ///  involved, so a wildcard is not a credential leak, but it is a decision
  ///  the operator should make rather than inherit. `false` is the same as
  ///  leaving it out and is kept for explicitness.
  cors?: CorsConfig | false;
  /// Largest BatchPassUpdate range walked id by id. Wider ranges are served
  ///  from the pass store's index when it has one. Default 10000.
  maxBatchRange?: number;
  /// Rate limits on the challenge, manifest and capability endpoints. On by
  ///  default with an in-process limiter and the defaults in
  ///  `RateLimitConfig`; `false` turns limiting off entirely.
  rateLimit?: RateLimitConfig | false;
  /// Answer an identical repeat of a POST (same link or nonce, same bytes)
  ///  with the first request's outcome instead of running it again or
  ///  refusing it. On by default with a 30 second window; `false` turns it
  ///  off, so every presentation is judged on its own.
  repeat?: RepeatConfig | false;
}

export interface ResolvedIssuerConfig {
  /// The explicit option, or what NODE_ENV implied, or "unknown" when
  ///  neither was set.
  environment: IssuerEnvironment | "unknown";
  /// The configured link secret as bytes, or null when none was given.
  linkSecret: Uint8Array | null;
  domain: string;
  baseUrl: string;
  basePath: string;
  uri: string;
  chainId: number;
  contract: Address;
  mode: IssuerMode;
  challengeTtlSeconds: number;
  nonceTtlSeconds: number;
  retryAfterSeconds: number;
  actions: Record<string, ActionDefinition>;
  /// Names of the actions reachable through capability links. Empty unless
  ///  the capability configuration is enabled.
  capabilityActions: string[];
  capability: CapabilityConfig;
  cors: CorsConfig | false;
  maxBatchRange: number;
  rateLimit: ResolvedRateLimitConfig;
  repeat: ResolvedRepeatConfig | false;
}

/// Thrown by `createIssuer` for a configuration the spec does not allow or
///  that cannot work. The message names the field and the rule.
export class IssuerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssuerConfigError";
  }
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/i;

function positiveInt(name: string, value: number | undefined, fallback: number): number {
  const v = value ?? fallback;
  if (!Number.isSafeInteger(v) || v <= 0) throw new IssuerConfigError(`${name} must be a positive integer, got ${String(value)}`);
  return v;
}

/// Validate a configuration and fill defaults. Every refusal here is a rule
///  of the standard or a setup that would fail at the first request.
/// The environment the issuer runs in: the explicit option wins; NODE_ENV is
///  only the fallback when it is unset. Guarded so the issuer still runs
///  where there is no `process`.
export function resolveEnvironment(explicit: IssuerEnvironment | undefined): IssuerEnvironment | "unknown" {
  if (explicit !== undefined) {
    if (explicit !== "production" && explicit !== "development") {
      throw new IssuerConfigError(`environment must be "production" or "development", got "${String(explicit)}"`);
    }
    return explicit;
  }
  const nodeEnv = typeof process !== "undefined" ? process.env?.NODE_ENV : undefined;
  if (nodeEnv === undefined || nodeEnv === "") return "unknown";
  return nodeEnv === "production" ? "production" : "development";
}

export function resolveConfig(config: IssuerConfig): ResolvedIssuerConfig {
  const environment = resolveEnvironment(config.environment);
  let linkSecret: Uint8Array | null = null;
  if (config.linkSecret !== undefined) {
    if (typeof config.linkSecret === "string") linkSecret = new TextEncoder().encode(config.linkSecret);
    else if (config.linkSecret instanceof Uint8Array) linkSecret = config.linkSecret;
    else throw new IssuerConfigError("linkSecret must be a string or a Uint8Array");
    if (linkSecret.byteLength < 32) {
      throw new IssuerConfigError(`linkSecret must be at least 32 bytes (got ${linkSecret.byteLength}); generate one with "openssl rand -base64 32"`);
    }
  }
  if (typeof config.domain !== "string" || !DOMAIN_RE.test(config.domain)) {
    throw new IssuerConfigError(
      `domain must be a bare authority such as "issuer.example" or "localhost:8787" (no scheme, no path), got "${String(config.domain)}"`,
    );
  }

  let base: URL;
  try {
    base = new URL(config.baseUrl);
  } catch {
    throw new IssuerConfigError(`baseUrl must be an absolute URL such as "https://issuer.example", got "${String(config.baseUrl)}"`);
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new IssuerConfigError(`baseUrl must be http or https, got "${config.baseUrl}"`);
  }
  if (base.search || base.hash) throw new IssuerConfigError("baseUrl must not carry a query or fragment");
  // Wallets and the SDK client refuse to sign a challenge whose domain is not
  // the origin serving it (the phishing check ERC-4361 expects), so a domain
  // that differs from baseUrl's host yields challenges nobody will sign.
  const domain = config.domain.toLowerCase();
  if (domain !== base.host.toLowerCase() && domain !== base.hostname.toLowerCase()) {
    throw new IssuerConfigError(
      `domain "${config.domain}" must match baseUrl's host "${base.host}": clients refuse to sign a challenge for a domain other than the one serving it`,
    );
  }
  const baseUrl = config.baseUrl.replace(/\/+$/, "");

  let basePath = config.basePath ?? "/wallet-pass";
  if (basePath !== "" && !basePath.startsWith("/")) {
    throw new IssuerConfigError(`basePath must start with "/", got "${basePath}"`);
  }
  basePath = basePath.replace(/\/+$/, "");

  if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0) {
    throw new IssuerConfigError(`chainId must be a positive integer, got ${String(config.chainId)}`);
  }
  if (typeof config.contract !== "string" || !isAddress(config.contract, { strict: false })) {
    throw new IssuerConfigError(`contract must be an address, got "${String(config.contract)}"`);
  }
  if (config.mode !== "public" && config.mode !== "gated") {
    throw new IssuerConfigError(`mode must be "public" or "gated", got "${String(config.mode)}"`);
  }

  const challengeTtlSeconds = positiveInt("challengeTtlSeconds", config.challengeTtlSeconds, 300);
  const nonceTtlSeconds = positiveInt("nonceTtlSeconds", config.nonceTtlSeconds, challengeTtlSeconds * 2);
  if (nonceTtlSeconds < challengeTtlSeconds) {
    throw new IssuerConfigError(
      `nonceTtlSeconds (${nonceTtlSeconds}) must be at least challengeTtlSeconds (${challengeTtlSeconds}), or a live challenge could lose its nonce`,
    );
  }
  const retryAfterSeconds = positiveInt("retryAfterSeconds", config.retryAfterSeconds, 5);
  const maxBatchRange = positiveInt("maxBatchRange", config.maxBatchRange, 10_000);
  const rateLimit = resolveRateLimit(config.rateLimit);
  const repeat = resolveRepeat(config.repeat);

  const capability: CapabilityConfig = config.capability ?? { enabled: false };
  if (capability.enabled && config.mode !== "gated") {
    // The capability configuration is "the gated configuration operated so
    // that the capability URL carries the possession role". A public
    // manifest is public data, so a link derived from it proves nothing.
    throw new IssuerConfigError('capability.enabled requires mode "gated": the capability configuration is only sound in the gated configuration');
  }

  const actions = config.actions ?? {};
  const capabilityActions: string[] = [];
  for (const [name, def] of Object.entries(actions)) {
    if (name === ACQUIRE_ACTION || name === ROTATE_ACTION) {
      throw new IssuerConfigError(`action name "${name}" is reserved: acquire and rotate have their own routes and always take a signed proof`);
    }
    if (!isValidActionName(name)) {
      throw new IssuerConfigError(`action name "${name}" is not valid in an action URN (letters, digits, ".", "_", "-", at most 64)`);
    }
    if (!def || typeof def.execute !== "function") throw new IssuerConfigError(`action "${name}" needs an execute function`);
    if (typeof def.description !== "string" || def.description.trim() === "") {
      throw new IssuerConfigError(`action "${name}" needs a description`);
    }
    if (!def.capability) continue;
    if (!capability.enabled) {
      throw new IssuerConfigError(`action "${name}" is marked capability but capability.enabled is not set`);
    }
    if (def.transfersOrBurns) {
      throw new IssuerConfigError(
        `action "${name}" transfers, burns or approves the token or changes entitlement, so it MUST NOT be reachable through a capability link; drop capability and use the signed path`,
      );
    }
    if (typeof def.bound !== "string" || def.bound.trim() === "") {
      throw new IssuerConfigError(
        `capability action "${name}" needs a documented bound: the effect under unlimited repetition MUST be bounded and the implementation MUST document that bound`,
      );
    }
    capabilityActions.push(name);
  }

  // No CORS unless asked for: a wildcard has to be written down.
  let cors: CorsConfig | false = config.cors === undefined ? false : config.cors;
  if (cors !== false) {
    if (cors.origins !== "*" && !Array.isArray(cors.origins)) {
      throw new IssuerConfigError('cors.origins must be "*" or an array of origins');
    }
    if (Array.isArray(cors.origins)) {
      for (const o of cors.origins) {
        if (typeof o !== "string" || !/^[a-z][a-z0-9+.-]*:\/\/[^/]+$/i.test(o)) {
          throw new IssuerConfigError(`cors.origins entries must be origins (scheme://host[:port]) with no path, got "${String(o)}"`);
        }
      }
    }
    cors = { origins: cors.origins, maxAgeSeconds: cors.maxAgeSeconds ?? 600 };
  }

  return {
    environment,
    linkSecret,
    domain: config.domain,
    baseUrl,
    basePath,
    uri: config.uri ?? `${baseUrl}${basePath}/actions`,
    chainId: config.chainId,
    contract: getAddress(config.contract),
    mode: config.mode,
    challengeTtlSeconds,
    nonceTtlSeconds,
    retryAfterSeconds,
    actions,
    capabilityActions,
    capability,
    cors,
    maxBatchRange,
    rateLimit,
    repeat,
  };
}

export const DEFAULT_REPEAT_WINDOW_SECONDS = 30;

function resolveRepeat(config: RepeatConfig | false | undefined): ResolvedRepeatConfig | false {
  if (config === false) return false;
  const c = config ?? {};
  if (c.store !== undefined && (typeof c.store.get !== "function" || typeof c.store.put !== "function")) {
    throw new IssuerConfigError("repeat.store must implement get() and put()");
  }
  return { windowSeconds: positiveInt("repeat.windowSeconds", c.windowSeconds, DEFAULT_REPEAT_WINDOW_SECONDS), ...(c.store ? { store: c.store } : {}) };
}

export const DEFAULT_RATE_LIMITS: Readonly<Record<"challenge" | "manifest" | "capability" | "action" | "rotate" | "perClient", RateLimitRule>> = {
  challenge: { limit: 30, windowSeconds: 60 },
  manifest: { limit: 60, windowSeconds: 60 },
  capability: { limit: 60, windowSeconds: 60 },
  action: { limit: 30, windowSeconds: 60 },
  rotate: { limit: 10, windowSeconds: 60 },
  perClient: { limit: 120, windowSeconds: 60 },
};

function rule(name: string, value: RateLimitRule | false | undefined, fallback: RateLimitRule): RateLimitRule | false {
  if (value === false) return false;
  if (value === undefined) return fallback;
  if (typeof value !== "object" || value === null) throw new IssuerConfigError(`rateLimit.${name} must be { limit, windowSeconds } or false`);
  return { limit: positiveInt(`rateLimit.${name}.limit`, value.limit, fallback.limit), windowSeconds: positiveInt(`rateLimit.${name}.windowSeconds`, value.windowSeconds, fallback.windowSeconds) };
}

function resolveRateLimit(config: RateLimitConfig | false | undefined): ResolvedRateLimitConfig {
  if (config === false) {
    return { limiter: unlimited, challenge: false, manifest: false, capability: false, action: false, rotate: false, perClient: false, clientKey: defaultClientKey };
  }
  const c = config ?? {};
  if (c.limiter !== undefined && typeof c.limiter.hit !== "function") throw new IssuerConfigError("rateLimit.limiter must implement hit()");
  if (c.clientKey !== undefined && typeof c.clientKey !== "function") throw new IssuerConfigError("rateLimit.clientKey must be a function");
  return {
    limiter: c.limiter ?? memoryRateLimiter(),
    challenge: rule("challenge", c.challenge, DEFAULT_RATE_LIMITS.challenge),
    manifest: rule("manifest", c.manifest, DEFAULT_RATE_LIMITS.manifest),
    capability: rule("capability", c.capability, DEFAULT_RATE_LIMITS.capability),
    action: rule("action", c.action, DEFAULT_RATE_LIMITS.action),
    rotate: rule("rotate", c.rotate, DEFAULT_RATE_LIMITS.rotate),
    perClient: rule("perClient", c.perClient, DEFAULT_RATE_LIMITS.perClient),
    clientKey: c.clientKey ?? defaultClientKey,
  };
}
