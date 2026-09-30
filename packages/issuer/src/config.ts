import { getAddress, isAddress, type Address } from "viem";
import { ACQUIRE_ACTION, ROTATE_ACTION, isValidActionName, type TokenRef } from "@erc8426/core";

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

export interface CorsConfig {
  /// "*" or an explicit allowlist of origins (scheme://host[:port]).
  origins: "*" | string[];
  maxAgeSeconds?: number;
}

export interface IssuerConfig {
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
  /// CORS for browser clients. Default { origins: "*" }: no cookies are
  ///  involved (proofs travel in headers), so a wildcard is safe. `false`
  ///  disables CORS headers entirely.
  cors?: CorsConfig | false;
  /// Largest BatchPassUpdate range walked id by id. Wider ranges are served
  ///  from the pass store's index when it has one. Default 10000.
  maxBatchRange?: number;
}

export interface ResolvedIssuerConfig {
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
export function resolveConfig(config: IssuerConfig): ResolvedIssuerConfig {
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

  let cors: CorsConfig | false = config.cors === undefined ? { origins: "*" } : config.cors;
  if (cors !== false) {
    if (cors.origins !== "*" && !Array.isArray(cors.origins)) {
      throw new IssuerConfigError('cors.origins must be "*" or an array of origins');
    }
    cors = { origins: cors.origins, maxAgeSeconds: cors.maxAgeSeconds ?? 600 };
  }

  return {
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
  };
}
