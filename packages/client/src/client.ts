import { getAddress, type Address, type Client, type Hex } from "viem";
import { getChainId, getContractEvents, readContract, watchContractEvent } from "viem/actions";
import {
  ACQUIRE_ACTION,
  ROTATE_ACTION,
  WALLET_PASS_INTERFACE_ID,
  erc165Abi,
  erc721Abi,
  isValidActionName,
  manifestPlatforms,
  parseManifest,
  proofHeaders,
  readMetadataMirror as readMirror,
  tokenRef,
  walletPassAbi,
  type ManifestIssue,
  type ManifestParseResult,
  type ParsedChallenge,
  type PassManifest,
  type TokenRef,
} from "@erc8426/core";

import { WalletPassClientError, errorFromResponse } from "./errors.js";
import { choosePlatform, detectPlatform, type FormatKey, type WalletPlatform } from "./platform.js";
import { checkChallengeScope, domainsForUrl, DEFAULT_MAX_CHALLENGE_TTL_SECONDS } from "./scope.js";
import type { WalletPassSigner } from "./signer.js";
import { normalizePassUpdateLog, type PassUpdateNotice } from "./updates.js";
import { decodeDataUri, passBase, resolveUri, uriOrigin, type GatewayOptions } from "./uri.js";

/// A token as callers usually hold it. The chain comes from the public client.
export interface TokenInput {
  contract: Address | string;
  tokenId: bigint | number | string;
}

export interface WalletPassClientOptions extends GatewayOptions {
  /// Any viem client with a transport for the token's chain (a PublicClient,
  ///  or a WalletClient extended with public actions).
  publicClient: Client;
  /// fetch implementation. Defaults to the global fetch.
  fetch?: typeof fetch;
  /// Longest challenge lifetime the client will agree to sign. Default 3600.
  maxChallengeTtlSeconds?: number;
  /// Extra SIWE domains accepted in challenges, beyond the host the challenge
  ///  was fetched from. For development setups whose verifier identity is not
  ///  the serving host; leave empty in production.
  trustedChallengeDomains?: readonly string[];
}

export type ManifestConfiguration = "public" | "gated";

export interface ManifestResult {
  manifest: PassManifest;
  /// Which configuration the issuer operates, learned from the response
  ///  (Acquisition URLs): a manifest served without a proof is public.
  configuration: ManifestConfiguration;
  /// The raw value `passURI` returned.
  passUri: string;
  /// The URL actually fetched (after gateway rewriting).
  url: string;
  /// Warnings from validation (errors throw).
  issues: ManifestIssue[];
}

export interface GetManifestOptions {
  /// Signs the acquire challenge when the manifest is gated. Without it a
  ///  gated manifest throws `proof_required`.
  signer?: WalletPassSigner;
  signal?: AbortSignal;
}

export interface AddToWalletOptions extends GetManifestOptions {
  /// Force a platform. When omitted it is detected from `userAgent`.
  platform?: FormatKey;
  /// Defaults to `navigator.userAgent` when running in a browser.
  userAgent?: string;
}

export interface AddToWalletResult {
  /// Navigate here (window.location.assign) to add the pass.
  url: string;
  platform: FormatKey;
  configuration: ManifestConfiguration;
  manifest: PassManifest;
}

export interface ChallengeResult {
  message: string;
  parsed: ParsedChallenge;
  /// The exact URL the challenge was fetched from.
  challengeUrl: string;
}

export interface RequestChallengeOptions {
  /// Challenge endpoint to use instead of discovering it.
  endpoint?: string;
  signal?: AbortSignal;
}

export interface SignedActionOptions {
  token: TokenInput;
  action: string;
  signer: WalletPassSigner;
  /// Full URL to POST the signed action to. Defaults to
  ///  `{passBase}/actions/{action}`, an SDK convention (the spec standardizes
  ///  the proof, not the route).
  endpoint?: string;
  /// Challenge endpoint override, see `requestChallenge`.
  challengeEndpoint?: string;
  /// Action parameters, sent as the `params` member beside the proof.
  params?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface RotatePassLinksOptions {
  /// Must be the current owner: the issuer takes a fresh ownership read.
  signer: WalletPassSigner;
  /// Full URL to POST the rotation to. Defaults to `{passBase}/rotate`.
  endpoint?: string;
  /// Challenge endpoint override, see `requestChallenge`.
  challengeEndpoint?: string;
  signal?: AbortSignal;
}

export interface SignedActionResult {
  status: number;
  body: unknown;
}

export interface MetadataMirrorResult {
  /// Always false: when both exist, the manifest reached through passURI is
  ///  authoritative (Metadata mirror), so treat the mirror as a hint.
  authoritative: false;
  tokenUri: string;
  /// Null when the metadata has no `wallet_pass` member.
  result: ManifestParseResult | null;
}

export interface IssuerDisplay {
  chainId: number;
  /// Checksummed issuing contract, to present alongside the action (Client
  ///  requirements).
  contract: Address;
  /// `0x5F9B...c2e1`, for compact UI.
  contractShort: string;
  tokenId: string;
  passUri: string;
  /// Web origin of passURI, or null for ipfs://, ar:// and data: URIs, which
  ///  have no issuer origin.
  origin: string | null;
}

export interface WatchPassUpdatesOptions {
  onError?: (error: Error) => void;
  pollingInterval?: number;
  /// Force polling (eth_getLogs) instead of filters or subscriptions.
  poll?: boolean;
}

export interface GetPassUpdatesOptions {
  /// Omit to scan every contract on the chain, which is what an indexer or a
  ///  pass distributor serving many collections wants.
  contract?: Address | string;
  fromBlock?: bigint | "earliest" | "latest";
  toBlock?: bigint | "earliest" | "latest";
}

/// `0x5F9B...c2e1`: the first four and last four hex digits, checksummed.
export function shortAddress(address: string): string {
  const a = getAddress(address);
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export type WalletPassClient = ReturnType<typeof createWalletPassClient>;

/// Create a client for discovering and acquiring ERC-8426 passes. Nothing it
///  fetches is cached: acquisition URLs are fetched at the moment of use and
///  never stored (Client requirements), and passURI is re-read each time
///  because an issuer can repoint it.
export function createWalletPassClient(options: WalletPassClientOptions) {
  const { publicClient } = options;
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const gateways: GatewayOptions = {
    ...(options.ipfsGateway !== undefined ? { ipfsGateway: options.ipfsGateway } : {}),
    ...(options.arweaveGateway !== undefined ? { arweaveGateway: options.arweaveGateway } : {}),
  };
  const maxTtlSeconds = options.maxChallengeTtlSeconds ?? DEFAULT_MAX_CHALLENGE_TTL_SECONDS;
  const trustedDomains = options.trustedChallengeDomains ?? [];

  // The chain id is fixed for a client, so it is the one thing worth memoizing.
  let chainIdPromise: Promise<number> | undefined;
  const chainId = (): Promise<number> => {
    if (publicClient.chain?.id !== undefined) return Promise.resolve(publicClient.chain.id);
    chainIdPromise ??= getChainId(publicClient).catch((e: unknown) => {
      chainIdPromise = undefined;
      throw e;
    });
    return chainIdPromise;
  };

  const toRef = async (token: TokenInput): Promise<TokenRef> => tokenRef(await chainId(), token.contract, token.tokenId);

  const request = async (url: string, init: RequestInit): Promise<{ res: Response; body: unknown }> => {
    let res: Response;
    try {
      res = await doFetch(url, init);
    } catch (e) {
      if ((e as { name?: string }).name === "AbortError") throw e;
      throw new WalletPassClientError("network", `request to ${url} failed: ${(e as Error).message}`, {
        source: "server",
        retryable: true,
      });
    }
    return { res, body: await readBody(res) };
  };

  const validManifest = (body: unknown, url: string): { manifest: PassManifest; issues: ManifestIssue[] } => {
    const parsed = parseManifest(body);
    if (!parsed.ok) {
      const detail = parsed.issues.map((i) => `${i.path || "(root)"}: ${i.message}`).join("; ");
      throw new WalletPassClientError("invalid_manifest", `invalid manifest from ${url}: ${detail}`, {
        source: "server",
        body,
      });
    }
    return { manifest: parsed.manifest, issues: parsed.issues };
  };

  async function supportsWalletPass(contract: Address | string): Promise<boolean> {
    const address = getAddress(contract);
    const call = (interfaceId: Hex) =>
      readContract(publicClient, { address, abi: erc165Abi, functionName: "supportsInterface", args: [interfaceId] });
    try {
      // The ERC-165 detection procedure: the contract must claim ERC-165
      // itself and deny 0xffffffff before its answer for our id means
      // anything. A contract with a permissive fallback fails the second test.
      const [erc165, invalid, walletPass] = await Promise.all([
        call("0x01ffc9a7"),
        call("0xffffffff"),
        call(WALLET_PASS_INTERFACE_ID),
      ]);
      return erc165 === true && invalid === false && walletPass === true;
    } catch {
      return false;
    }
  }

  async function getPassURI(token: TokenInput): Promise<string> {
    return readContract(publicClient, {
      address: getAddress(token.contract),
      abi: walletPassAbi,
      functionName: "passURI",
      args: [BigInt(token.tokenId)],
    });
  }

  function resolvePassURI(uri: string): string {
    return resolveUri(uri, gateways);
  }

  async function fetchChallenge(
    challengeUrl: string,
    action: string,
    ref: TokenRef,
    account: Address,
    signal?: AbortSignal,
  ): Promise<ChallengeResult> {
    const url = new URL(challengeUrl);
    // searchParams.set, not concatenation: an issuer's 401 can name a
    // challenge URL that already carries a query, such as ?action=rotate.
    // The action is always explicit so a URL naming another one is overridden.
    url.searchParams.set("address", getAddress(account));
    url.searchParams.set("action", action);
    const { res, body } = await request(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw errorFromResponse(res.status, res.headers, body);
    const message = (body as { message?: unknown } | null)?.message;
    if (typeof message !== "string") {
      throw new WalletPassClientError("invalid_message", "challenge endpoint returned no message", {
        status: res.status,
        source: "server",
        body,
      });
    }
    const scope = checkChallengeScope(message, {
      token: ref,
      action,
      account,
      domains: [...domainsForUrl(url.toString()), ...trustedDomains],
      maxTtlSeconds: maxTtlSeconds,
    });
    if (!scope.ok) {
      throw new WalletPassClientError(scope.code, `refusing to sign the issuer's challenge: ${scope.detail}`, {
        source: "client",
        body,
      });
    }
    return { message, parsed: scope.parsed, challengeUrl: url.toString() };
  }

  async function getManifest(token: TokenInput, opts: GetManifestOptions = {}): Promise<ManifestResult> {
    const passUri = await getPassURI(token);
    const url = resolvePassURI(passUri);

    // An inline manifest has no server, so it can only be public.
    if (/^data:/i.test(url)) {
      let body: unknown;
      try {
        body = JSON.parse(decodeDataUri(url).text);
      } catch {
        throw new WalletPassClientError("invalid_manifest", "passURI data: URI is not JSON", { source: "server" });
      }
      return { ...validManifest(body, "data: URI"), configuration: "public", passUri, url };
    }

    const signalInit = opts.signal ? { signal: opts.signal } : {};
    // A plain GET with no custom headers, so the first request needs no CORS
    // preflight; only the gated retry carries the proof headers.
    const first = await request(url, { method: "GET", headers: { accept: "application/json" }, ...signalInit });
    if (first.res.status === 200) {
      return { ...validManifest(first.body, url), configuration: "public", passUri, url };
    }
    if (first.res.status !== 401) throw errorFromResponse(first.res.status, first.res.headers, first.body);

    // Any 401 that names a challenge is treated alike: proof_required is the
    // MUST, and other 401s SHOULD carry the same member because the next step
    // is the same fresh challenge.
    const challengeRef = (first.body as { challenge?: unknown } | null)?.challenge;
    if (typeof challengeRef !== "string") throw errorFromResponse(401, first.res.headers, first.body);
    const challengeUrl = new URL(challengeRef, url).toString();
    if (!opts.signer) {
      throw new WalletPassClientError(
        "proof_required",
        "this pass is gated: connect the owning wallet to sign for it",
        { status: 401, source: "server", challenge: challengeUrl, body: first.body },
      );
    }
    const ref = await toRef(token);
    const challenge = await fetchChallenge(challengeUrl, ACQUIRE_ACTION, ref, opts.signer.address, opts.signal);
    const signature = await opts.signer.signMessage({ message: challenge.message });
    const second = await request(url, {
      method: "GET",
      headers: { accept: "application/json", ...proofHeaders({ message: challenge.message, signature }) },
      ...signalInit,
    });
    if (second.res.status !== 200) throw errorFromResponse(second.res.status, second.res.headers, second.body);
    return { ...validManifest(second.body, url), configuration: "gated", passUri, url };
  }

  async function getAcquisitionUrl(
    token: TokenInput,
    platform: FormatKey,
    opts: GetManifestOptions = {},
  ): Promise<string> {
    const { manifest } = await getManifest(token, opts);
    const url = manifest.formats[platform];
    if (!url) {
      throw new WalletPassClientError("unsupported", `this pass has no ${platform} format`, { source: "client" });
    }
    return url;
  }

  async function addToWallet(token: TokenInput, opts: AddToWalletOptions = {}): Promise<AddToWalletResult> {
    const result = await getManifest(token, opts);
    const available = Object.keys(result.manifest.formats);
    let platform: FormatKey | null;
    if (opts.platform) {
      platform = available.includes(opts.platform) ? opts.platform : null;
    } else {
      const ua = opts.userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent : undefined);
      platform = choosePlatform(manifestPlatforms(result.manifest), detectPlatform(ua));
    }
    if (!platform) {
      throw new WalletPassClientError(
        "unsupported",
        opts.platform ? `this pass has no ${opts.platform} format` : "this pass offers no Apple or Google format",
        { source: "client" },
      );
    }
    return {
      url: result.manifest.formats[platform] as string,
      platform,
      configuration: result.configuration,
      manifest: result.manifest,
    };
  }

  async function readMetadataMirror(token: TokenInput): Promise<MetadataMirrorResult> {
    const tokenUri = await readContract(publicClient, {
      address: getAddress(token.contract),
      abi: erc721Abi,
      functionName: "tokenURI",
      args: [BigInt(token.tokenId)],
    });
    const url = resolvePassURI(tokenUri);
    let metadata: unknown;
    if (/^data:/i.test(url)) {
      try {
        metadata = JSON.parse(decodeDataUri(url).text);
      } catch {
        metadata = null;
      }
    } else {
      const { res, body } = await request(url, { method: "GET", headers: { accept: "application/json" } });
      if (!res.ok) throw errorFromResponse(res.status, res.headers, body);
      metadata = body;
    }
    return { authoritative: false, tokenUri, result: readMirror(metadata) };
  }

  async function discoverChallengeEndpoint(token: TokenInput, signal?: AbortSignal): Promise<{ challengeUrl: string; base: string }> {
    const url = resolvePassURI(await getPassURI(token));
    if (/^data:/i.test(url)) {
      throw new WalletPassClientError("unsupported", "an inline passURI has no issuer to challenge", { source: "client" });
    }
    const base = passBase(url);
    const { res, body } = await request(url, {
      method: "GET",
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    const named = res.status === 401 ? (body as { challenge?: unknown } | null)?.challenge : undefined;
    const challengeUrl = typeof named === "string" ? new URL(named, url).toString() : `${base}/challenge`;
    return { challengeUrl, base };
  }

  async function requestChallenge(
    token: TokenInput,
    action: string,
    account: Address | string,
    opts: RequestChallengeOptions = {},
  ): Promise<ChallengeResult> {
    if (!isValidActionName(action)) {
      throw new WalletPassClientError("unknown_action", `invalid action name: ${action}`, { source: "client" });
    }
    const ref = await toRef(token);
    const challengeUrl = opts.endpoint ?? (await discoverChallengeEndpoint(token, opts.signal)).challengeUrl;
    return fetchChallenge(challengeUrl, action, ref, getAddress(account), opts.signal);
  }

  async function signedAction(opts: SignedActionOptions): Promise<SignedActionResult> {
    const { token, action, signer } = opts;
    if (action === ACQUIRE_ACTION) {
      // An acquire proof resolves the manifest and nothing else.
      throw new WalletPassClientError("unknown_action", "use getManifest for the acquire action", { source: "client" });
    }
    if (action === ROTATE_ACTION) {
      throw new WalletPassClientError("unknown_action", "use rotatePassLinks for the rotate action", { source: "client" });
    }
    if (!isValidActionName(action)) {
      throw new WalletPassClientError("unknown_action", `invalid action name: ${action}`, { source: "client" });
    }
    const ref = await toRef(token);
    let endpoint = opts.endpoint;
    let challengeUrl = opts.challengeEndpoint;
    if (!endpoint || !challengeUrl) {
      const found = await discoverChallengeEndpoint(token, opts.signal);
      endpoint ??= `${found.base}/actions/${action}`;
      challengeUrl ??= found.challengeUrl;
    }
    const challenge = await fetchChallenge(challengeUrl, action, ref, signer.address, opts.signal);
    const signature = await signer.signMessage({ message: challenge.message });
    const { res, body } = await request(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      // The token and action travel alongside the proof for issuers that
      // declare the target in the body; a verifier still checks them against
      // what it holds, never against these values.
      body: JSON.stringify({
        message: challenge.message,
        signature,
        ...(opts.params !== undefined ? { params: opts.params } : {}),
        chainId: ref.chainId,
        contract: ref.contract,
        tokenId: ref.tokenId,
        action,
      }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok) throw errorFromResponse(res.status, res.headers, body);
    return { status: res.status, body };
  }

  /// Ask the issuer to rotate every acquisition URL and capability link for a
  ///  token. This is the owner's remedy for a leaked link under an unchanged
  ///  owner, which issuers MUST offer in the capability configuration. The
  ///  proof is for the rotate action, so it cannot acquire or act.
  async function rotatePassLinks(token: TokenInput, opts: RotatePassLinksOptions): Promise<SignedActionResult> {
    const ref = await toRef(token);
    let endpoint = opts.endpoint;
    let challengeUrl = opts.challengeEndpoint;
    if (!endpoint || !challengeUrl) {
      const found = await discoverChallengeEndpoint(token, opts.signal);
      endpoint ??= `${found.base}/rotate`;
      challengeUrl ??= found.challengeUrl;
    }
    const challenge = await fetchChallenge(challengeUrl, ROTATE_ACTION, ref, opts.signer.address, opts.signal);
    const signature = await opts.signer.signMessage({ message: challenge.message });
    const { res, body } = await request(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...proofHeaders({ message: challenge.message, signature }),
      },
      body: JSON.stringify({ message: challenge.message, signature }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok) throw errorFromResponse(res.status, res.headers, body);
    return { status: res.status, body };
  }

  async function issuerDisplay(token: TokenInput): Promise<IssuerDisplay> {
    const ref = await toRef(token);
    const passUri = await getPassURI(token);
    return {
      chainId: ref.chainId,
      contract: ref.contract,
      contractShort: shortAddress(ref.contract),
      tokenId: ref.tokenId,
      passUri,
      origin: uriOrigin(passUri),
    };
  }

  async function getPassUpdates(opts: GetPassUpdatesOptions = {}): Promise<PassUpdateNotice[]> {
    const logs = await getContractEvents(publicClient, {
      abi: walletPassAbi,
      ...(opts.contract !== undefined ? { address: getAddress(opts.contract) } : {}),
      ...(opts.fromBlock !== undefined ? { fromBlock: opts.fromBlock } : {}),
      ...(opts.toBlock !== undefined ? { toBlock: opts.toBlock } : {}),
    });
    return logs.map((l) => normalizePassUpdateLog(l as never)).filter((u): u is PassUpdateNotice => u !== null);
  }

  /// Watch both freshness events and deliver them in one shape. Returns the
  ///  unwatch function. Pass `undefined` as the contract to watch every
  ///  collection on the chain.
  function watchPassUpdates(
    contract: Address | string | undefined,
    onUpdate: (update: PassUpdateNotice) => void,
    opts: WatchPassUpdatesOptions = {},
  ): () => void {
    return watchContractEvent(publicClient, {
      abi: walletPassAbi,
      ...(contract !== undefined ? { address: getAddress(contract) } : {}),
      ...(opts.pollingInterval !== undefined ? { pollingInterval: opts.pollingInterval } : {}),
      ...(opts.poll ? { poll: true as const } : {}),
      ...(opts.onError ? { onError: opts.onError } : {}),
      onLogs: (logs) => {
        for (const log of logs) {
          const update = normalizePassUpdateLog(log as never);
          if (update) onUpdate(update);
        }
      },
    });
  }

  return {
    publicClient,
    chainId,
    supportsWalletPass,
    getPassURI,
    resolvePassURI,
    getManifest,
    getAcquisitionUrl,
    addToWallet,
    readMetadataMirror,
    requestChallenge,
    signedAction,
    rotatePassLinks,
    issuerDisplay,
    getPassUpdates,
    watchPassUpdates,
  };
}

export type { WalletPlatform };
