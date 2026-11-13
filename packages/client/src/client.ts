import { getAddress, type Address, type Client, type Hex } from "viem";
import { getChainId, getContractEvents, readContract, watchContractEvent } from "viem/actions";
import {
  ACQUIRE_ACTION,
  ROTATE_ACTION,
  WALLET_PASS_INTERFACE_ID,
  WALLET_PASS_ISSUER_INTERFACE_ID,
  diffPassIssuer,
  erc165Abi,
  erc721Abi,
  isValidActionName,
  manifestPlatforms,
  parseManifest,
  parsePassIssuerJson,
  proofHeaders,
  readMetadataMirror as readMirror,
  tokenRef,
  walletPassAbi,
  walletPassIssuerAbi,
  type ManifestIssue,
  type ManifestParseResult,
  type ParsedChallenge,
  type PassIssuerIdentity,
  type PassManifest,
  type TokenRef,
  type TokenStandard,
} from "@erc8426/core";

import { WalletPassClientError, errorFromChainRead, errorFromResponse } from "./errors.js";
import { choosePlatform, detectPlatform, type FormatKey, type WalletPlatform } from "./platform.js";
import { checkChallengeScope, domainsForUrl, DEFAULT_MAX_CHALLENGE_TTL_SECONDS } from "./scope.js";
import type { WalletPassSigner } from "./signer.js";
import { normalizePassUpdateLog, type PassUpdateNotice } from "./updates.js";
import { decodeDataUri, isAllowedUrl, isSafeNavigationUrl, passBase, resolveUri, uriOrigin, type GatewayOptions } from "./uri.js";

/// Redirects `request` follows by hand: the same limit as the Apple image
///  fetcher. 301, 302, 303, 307 and 308 are the statuses fetch itself follows.
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/// A token as callers usually hold it. The chain comes from the public client.
export interface TokenInput {
  contract: Address | string;
  tokenId: bigint | number | string;
  /// The contract's token standard, which decides the namespace the
  ///  challenge must name the token in (`erc721` or `erc1155`). Left out,
  ///  the client asks the contract once (ERC-165, id 0xd9b67a26 for
  ///  ERC-1155) and takes ERC-721 when it does not claim ERC-1155. The
  ///  ERC-1155 binding is a working draft.
  standard?: TokenStandard;
}

export interface WalletPassClientOptions extends GatewayOptions {
  /// Any viem client with a transport for the token's chain (a PublicClient,
  ///  or a WalletClient extended with public actions).
  publicClient: Client;
  /// fetch implementation. Defaults to the global fetch.
  fetch?: typeof fetch;
  /// Longest challenge lifetime the client will agree to sign. Default 3600.
  maxChallengeTtlSeconds?: number;
  /// Extra SIWE domains accepted in challenges, beyond the host the proof is
  ///  sent to. For development setups whose verifier identity is not the
  ///  serving host; leave empty in production.
  trustedChallengeDomains?: readonly string[];
  /// Follow a challenge URL on a different origin from the endpoint the proof
  ///  will be presented to. Off by default: a signature for one verifier must
  ///  never be handed to another, and a manifest server must not be able to
  ///  steer the client at arbitrary hosts. Development only.
  allowCrossOriginChallenge?: boolean;
  /// Fetch plain http from non-loopback hosts. Off by default (https, or
  ///  http on localhost only). Server-side development only.
  allowInsecureHttp?: boolean;
  /// Default for `verifyIssuer` on `getManifest`, `getAcquisitionUrl` and
  ///  `addToWallet`: check every manifest against the contract's issuer
  ///  identity commitment. Off by default (the standard makes the read a
  ///  MAY, and it costs four contract reads per manifest).
  verifyIssuer?: boolean;
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
  /// Set only when `verifyIssuer` was on: the identity the contract commits
  ///  to through `passIssuer()`, which the manifest's `issuer` was found
  ///  equal to, or null when the contract makes no commitment.
  issuerCommitment?: PassIssuerIdentity | null;
}

export interface GetManifestOptions {
  /// Signs the acquire challenge when the manifest is gated. Without it a
  ///  gated manifest throws `proof_required`.
  signer?: WalletPassSigner;
  signal?: AbortSignal;
  /// Read the contract's issuer identity commitment (`passIssuer()`) and
  ///  refuse the manifest unless its `issuer` member equals it member for
  ///  member. A contract that makes no commitment passes. Defaults to the
  ///  client's `verifyIssuer` option. This compares the contract with the
  ///  manifest; checking the signer identifiers of the pass file itself is
  ///  platform-specific and is not done here.
  verifyIssuer?: boolean;
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
  /// The URL the signed proof will be presented to. The challenge must name
  ///  its host as the SIWE domain and be served from its origin. Defaults to
  ///  the resolved passURI.
  presentTo?: string;
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
  const urlPolicy = { allowInsecureHttp: options.allowInsecureHttp === true };

  // The chain id is fixed for a client, so it is the one thing worth memoizing.
  let chainIdPromise: Promise<number> | undefined;
  const chainId = (): Promise<number> => {
    if (publicClient.chain?.id !== undefined) return Promise.resolve(publicClient.chain.id);
    chainIdPromise ??= getChainId(publicClient).catch((e: unknown) => {
      chainIdPromise = undefined;
      throw errorFromChainRead(e, "eth_chainId");
    });
    return chainIdPromise;
  };

  // Which namespace a contract's tokens are named in. A challenge that
  // names the requested contract and id under the other standard is refused
  // before signing, so the client has to know which one to expect. Only a
  // contract that passes the ERC-165 procedure and claims ERC-1155 is read
  // as one; anything else, a revert included, is ERC-721 as before (a node
  // that could not be reached is an error, not an answer). A
  // wrong guess cannot widen what gets signed: it only refuses a challenge.
  // Answers are kept per contract; a read that failed is asked again.
  const standards = new Map<string, Promise<TokenStandard>>();
  const standardOf = (contract: Address | string): Promise<TokenStandard> => {
    const address = getAddress(contract);
    let known = standards.get(address);
    if (!known) {
      const call = (interfaceId: Hex) =>
        readContract(publicClient, { address, abi: erc165Abi, functionName: "supportsInterface", args: [interfaceId] });
      known = Promise.all([call("0x01ffc9a7"), call("0xffffffff"), call("0xd9b67a26")]).then(
        ([erc165, invalid, erc1155]): TokenStandard => (erc165 === true && invalid === false && erc1155 === true ? "erc1155" : "erc721"),
        (e: unknown): TokenStandard => {
          standards.delete(address);
          // A node that could not be reached is not an answer. Reading it
          // as ERC-721 would refuse an honest ERC-1155 issuer's challenge
          // as a mismatch, which looks like a hostile issuer and is not
          // something a retry would be offered for.
          const err = errorFromChainRead(e, "supportsInterface");
          if (err.code === "network") throw err;
          return "erc721";
        },
      );
      standards.set(address, known);
    }
    return known;
  };

  const toRef = async (token: TokenInput): Promise<TokenRef> =>
    tokenRef(await chainId(), token.contract, token.tokenId, token.standard ?? (await standardOf(token.contract)));

  const request = async (url: string, init: RequestInit): Promise<{ res: Response; body: unknown }> => {
    // Every URL here came from a contract or an issuer response, so none is
    // fetched unless it is https (or http on a loopback host). Redirects are
    // followed by hand so each hop gets the same check; an automatic follow
    // would let an allowed URL bounce to an internal or plain-http one.
    let current = url;
    let req = init;
    for (let hop = 0; ; hop += 1) {
      if (!isAllowedUrl(current, urlPolicy)) {
        throw new WalletPassClientError(
          "unsupported",
          `refusing to ${hop === 0 ? "fetch" : "follow a redirect to"} ${current}: only https (or http on localhost) is allowed`,
          { source: "client" },
        );
      }
      let res: Response;
      try {
        res = await doFetch(current, { ...req, redirect: "manual" });
      } catch (e) {
        if ((e as { name?: string }).name === "AbortError") throw e;
        throw new WalletPassClientError("network", `request to ${current} failed: ${(e as Error).message}`, {
          source: "server",
          retryable: true,
        });
      }
      if (res.type === "opaqueredirect") {
        // A browser hides the target of a manual redirect, so it cannot be
        // checked before it is fetched. For a GET, ask once more and let the
        // browser follow: only the URL the answer came from can be checked, and
        // the body is dropped unless that one passes. Anything else fails closed.
        if ((req.method ?? "GET").toUpperCase() !== "GET") {
          throw new WalletPassClientError("unsupported", `refusing to follow a redirect from ${current}: its target cannot be checked here`, {
            source: "client",
          });
        }
        let followed: Response;
        try {
          followed = await doFetch(current, { ...req, redirect: "follow" });
        } catch (e) {
          if ((e as { name?: string }).name === "AbortError") throw e;
          throw new WalletPassClientError("network", `request to ${current} failed: ${(e as Error).message}`, {
            source: "server",
            retryable: true,
          });
        }
        if (!isAllowedUrl(followed.url, urlPolicy)) {
          await followed.body?.cancel().catch(() => undefined);
          throw new WalletPassClientError(
            "unsupported",
            `refusing the redirect from ${current} to ${followed.url === "" ? "an unknown address" : followed.url}: only https (or http on localhost) is allowed`,
            { source: "client" },
          );
        }
        return { res: followed, body: await readBody(followed) };
      }
      const location = REDIRECT_STATUSES.has(res.status) ? res.headers.get("location") : null;
      if (location === null) return { res, body: await readBody(res) };
      await res.body?.cancel().catch(() => undefined);
      if (hop >= MAX_REDIRECTS) {
        throw new WalletPassClientError("unsupported", `refusing ${url}: it redirected more than ${MAX_REDIRECTS} times`, {
          source: "client",
        });
      }
      let next: string;
      try {
        next = new URL(location, current).toString();
      } catch {
        throw new WalletPassClientError("unsupported", `refusing to follow a redirect from ${current}: its Location is not a URL`, {
          source: "client",
        });
      }
      // As fetch does: 303, and 301 or 302 after a POST, continue as a body-less GET.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && req.method === "POST")) {
        const { body: _body, ...rest } = req;
        const headers = new Headers(rest.headers);
        headers.delete("content-type");
        req = { ...rest, method: "GET", headers };
      }
      current = next;
    }
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

  /// The identity a contract commits to on chain (Issuer identity
  ///  commitment), or null when it does not implement the interface
  ///  (ERC-165 id 0x470be7e9). A contract that claims the interface and
  ///  then reverts, or returns something that is not the JSON object the
  ///  standard defines, throws: that is not the same as making no commitment.
  async function getIssuerCommitment(contract: Address | string): Promise<PassIssuerIdentity | null> {
    const address = getAddress(contract);
    const call = (interfaceId: Hex) =>
      readContract(publicClient, { address, abi: erc165Abi, functionName: "supportsInterface", args: [interfaceId] });
    let claims: boolean;
    try {
      const [erc165, invalid, commitment] = await Promise.all([call("0x01ffc9a7"), call("0xffffffff"), call(WALLET_PASS_ISSUER_INTERFACE_ID)]);
      claims = erc165 === true && invalid === false && commitment === true;
    } catch (e) {
      const err = errorFromChainRead(e, "supportsInterface");
      // No ERC-165 at all (a revert, or no data) is a contract that commits
      // to nothing. An RPC that could not answer is not: it is retried.
      if (err.code === "network") throw err;
      return null;
    }
    if (!claims) return null;
    let text: string;
    try {
      text = await readContract(publicClient, { address, abi: walletPassIssuerAbi, functionName: "passIssuer" });
    } catch (e) {
      const err = errorFromChainRead(e, "passIssuer");
      if (err.code === "network") throw err;
      // Not a missing token: this read takes no token id.
      throw new WalletPassClientError(
        "invalid_manifest",
        "the contract claims the issuer identity commitment (ERC-165 id 0x470be7e9) but passIssuer() reverted or returned nothing, so it commits to no identity",
        { source: "chain" },
      );
    }
    const parsed = parsePassIssuerJson(text);
    if (!parsed.ok) {
      const detail = parsed.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
      throw new WalletPassClientError("invalid_manifest", `the contract's passIssuer() is not an issuer object: ${detail}`, { source: "chain" });
    }
    return parsed.issuer;
  }

  /// "When a Contract implements this interface, the Pass Issuer MUST include
  ///  `issuer` in every manifest it serves for that Contract, equal member for
  ///  member to the object the Contract returns", and a Client SHOULD NOT
  ///  install a pass that does not match.
  async function checkIssuer(token: TokenInput, result: ManifestResult, opts: GetManifestOptions): Promise<ManifestResult> {
    if (!(opts.verifyIssuer ?? options.verifyIssuer ?? false)) return result;
    const commitment = await getIssuerCommitment(token.contract);
    if (commitment === null) return { ...result, issuerCommitment: null };
    const served = result.manifest.issuer;
    if (served === undefined) {
      throw new WalletPassClientError("invalid_manifest", "the contract commits to an issuer identity and the manifest carries no issuer member", {
        source: "client",
      });
    }
    const diffs = diffPassIssuer(commitment, served);
    if (diffs.length > 0) {
      throw new WalletPassClientError(
        "invalid_manifest",
        `the manifest's issuer differs from the identity the contract commits to (${diffs.join(", ")}): the endpoint may be serving passes signed by someone the contract does not name`,
        { source: "client" },
      );
    }
    return { ...result, issuerCommitment: commitment };
  }

  /// Every token read goes through here so a nonexistent or burned token is
  ///  a typed `unknown_capability` and an RPC failure a retryable `network` error,
  ///  never a raw viem error.
  async function readToken<T>(what: string, read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (e) {
      throw errorFromChainRead(e, what);
    }
  }

  async function getPassURI(token: TokenInput): Promise<string> {
    return readToken("passURI", () =>
      readContract(publicClient, {
        address: getAddress(token.contract),
        abi: walletPassAbi,
        functionName: "passURI",
        args: [BigInt(token.tokenId)],
      }),
    );
  }

  function resolvePassURI(uri: string): string {
    return resolveUri(uri, gateways);
  }

  /// Fetch and scope-check a challenge. `presentTo` is the URL the signed
  ///  proof will be sent to: the challenge must be served from that origin
  ///  and must name that host as its verifier, so a signature meant for one
  ///  verifier can never be handed to another.
  async function fetchChallenge(
    challengeUrl: string,
    presentTo: string,
    action: string,
    ref: TokenRef,
    account: Address,
    signal?: AbortSignal,
  ): Promise<ChallengeResult> {
    const url = new URL(challengeUrl);
    const target = new URL(presentTo);
    if (url.origin !== target.origin && !options.allowCrossOriginChallenge) {
      throw new WalletPassClientError(
        "domain_mismatch",
        `refusing a challenge from ${url.origin} for a proof that would be sent to ${target.origin}`,
        { source: "client" },
      );
    }
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
      domains: [...domainsForUrl(target.toString()), ...trustedDomains],
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
      return checkIssuer(token, { ...validManifest(body, "data: URI"), configuration: "public", passUri, url }, opts);
    }

    const signalInit = opts.signal ? { signal: opts.signal } : {};
    // A plain GET with no custom headers, so the first request needs no CORS
    // preflight; only the gated retry carries the proof headers.
    const first = await request(url, { method: "GET", headers: { accept: "application/json" }, ...signalInit });
    if (first.res.status === 200) {
      return checkIssuer(token, { ...validManifest(first.body, url), configuration: "public", passUri, url }, opts);
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
    const challenge = await fetchChallenge(challengeUrl, url, ACQUIRE_ACTION, ref, opts.signer.address, opts.signal);
    const signature = await opts.signer.signMessage({ message: challenge.message });
    const second = await request(url, {
      method: "GET",
      headers: { accept: "application/json", ...proofHeaders({ message: challenge.message, signature }) },
      ...signalInit,
    });
    if (second.res.status !== 200) throw errorFromResponse(second.res.status, second.res.headers, second.body);
    return checkIssuer(token, { ...validManifest(second.body, url), configuration: "gated", passUri, url }, opts);
  }

  async function getAcquisitionUrl(
    token: TokenInput,
    platform: FormatKey,
    opts: GetManifestOptions = {},
  ): Promise<string> {
    const { manifest } = await getManifest(token, opts);
    const url = Object.hasOwn(manifest.formats, platform) ? manifest.formats[platform] : undefined;
    if (!url) {
      throw new WalletPassClientError("unsupported", `this pass has no ${platform} format`, { source: "client" });
    }
    return safeNavigation(url);
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
      url: safeNavigation(result.manifest.formats[platform] as string),
      platform,
      configuration: result.configuration,
      manifest: result.manifest,
    };
  }

  /// Defence in depth: core's parseManifest already refuses non-https
  ///  acquisition URLs, but nothing that reaches window.location may be
  ///  anything else, whatever path it took.
  function safeNavigation(url: string): string {
    if (!isSafeNavigationUrl(url)) {
      throw new WalletPassClientError("invalid_manifest", "refusing an acquisition URL that is not https", { source: "client" });
    }
    return url;
  }

  async function readMetadataMirror(token: TokenInput): Promise<MetadataMirrorResult> {
    const tokenUri = await readToken("tokenURI", () =>
      readContract(publicClient, {
        address: getAddress(token.contract),
        abi: erc721Abi,
        functionName: "tokenURI",
        args: [BigInt(token.tokenId)],
      }),
    );
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

  async function discoverChallengeEndpoint(
    token: TokenInput,
    signal?: AbortSignal,
  ): Promise<{ challengeUrl: string; base: string; url: string }> {
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
    return { challengeUrl, base, url };
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
    let challengeUrl = opts.endpoint;
    let presentTo = opts.presentTo;
    if (!challengeUrl || !presentTo) {
      const found = await discoverChallengeEndpoint(token, opts.signal);
      challengeUrl ??= found.challengeUrl;
      presentTo ??= found.url;
    }
    return fetchChallenge(challengeUrl, presentTo, action, ref, getAddress(account), opts.signal);
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
    const challenge = await fetchChallenge(challengeUrl, endpoint, action, ref, signer.address, opts.signal);
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
    const challenge = await fetchChallenge(challengeUrl, endpoint, ROTATE_ACTION, ref, opts.signer.address, opts.signal);
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
    getIssuerCommitment,
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
