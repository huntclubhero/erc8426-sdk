/// Test doubles shared by the client, react and conformance suites: a fake
///  chain behind a viem custom transport, and a fake issuer behind a fetch
///  function. The issuer is conformant by default and can be broken one
///  property at a time, which is what the conformance suite needs to prove it
///  catches each violation.
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  numberToHex,
  verifyMessage,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  PKPASS_MEDIA_TYPE,
  buildChallenge,
  erc165Abi,
  erc721Abi,
  generateNonce,
  parseChallenge,
  readProofHeaders,
  sameToken,
  tokenRef,
  walletPassAbi,
} from "@erc8426/core";

const chainAbi = [...erc165Abi, ...erc721Abi, ...walletPassAbi] as const;

export interface FakeContract {
  /// Interface ids the contract claims. `null` models a contract without
  ///  ERC-165 at all (empty return data).
  interfaces?: string[] | null;
  /// Answer for passURI; throw to revert.
  passURI?: (tokenId: bigint) => string;
  tokenURI?: (tokenId: bigint) => string;
  ownerOf?: (tokenId: bigint) => Address;
}

export interface FakeLog {
  address: Address;
  event: "PassUpdate" | "BatchPassUpdate";
  args: bigint[];
  blockNumber: bigint;
}

export class RevertError extends Error {
  code = 3;
  data = "0x";
  constructor() {
    super("execution reverted");
  }
}

export interface FakeChain {
  client: PublicClient;
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
  logs: FakeLog[];
  /// Append a log in a new block, as if a transaction had just landed.
  mine(log: Omit<FakeLog, "blockNumber">): void;
}

/// A viem public client over an in-memory chain. `logs` can be pushed to
///  after creation to simulate new blocks for watchers.
export function fakeChain(opts: { chainId?: number; contracts: Record<string, FakeContract>; logs?: FakeLog[] }): FakeChain {
  const chainId = opts.chainId ?? 1;
  const logs = opts.logs ?? [];
  const contracts = new Map(Object.entries(opts.contracts).map(([k, v]) => [k.toLowerCase(), v]));
  let block = 100n;
  const filters = new Map<string, number>();

  const encodeLog = (l: FakeLog, index: number) => {
    const topics =
      l.event === "PassUpdate"
        ? encodeEventTopics({ abi: walletPassAbi, eventName: "PassUpdate", args: { tokenId: l.args[0]! } })
        : encodeEventTopics({ abi: walletPassAbi, eventName: "BatchPassUpdate" });
    const data =
      l.event === "PassUpdate"
        ? "0x"
        : encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [l.args[0]!, l.args[1]!]);
    return {
      address: l.address,
      topics,
      data,
      blockNumber: numberToHex(l.blockNumber),
      blockHash: `0x${"ab".repeat(32)}`,
      transactionHash: `0x${index.toString(16).padStart(64, "0")}`,
      transactionIndex: "0x0",
      logIndex: numberToHex(index),
      removed: false,
    };
  };
  const matching = (params: { address?: string; fromBlock?: string; toBlock?: string }) =>
    logs
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => !params.address || l.address.toLowerCase() === params.address.toLowerCase())
      .filter(({ l }) => !params.fromBlock || !params.fromBlock.startsWith("0x") || l.blockNumber >= BigInt(params.fromBlock))
      .filter(({ l }) => !params.toBlock || !params.toBlock.startsWith("0x") || l.blockNumber <= BigInt(params.toBlock))
      .map(({ l, i }) => encodeLog(l, i));

  const request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    const p = (params ?? []) as unknown[];
    switch (method) {
      case "eth_chainId":
        return numberToHex(chainId);
      case "eth_blockNumber":
        return numberToHex(block);
      case "eth_call": {
        const call = p[0] as { to: string; data: Hex };
        const c = contracts.get(call.to.toLowerCase());
        if (!c) return "0x";
        const decoded = decodeFunctionData({ abi: chainAbi, data: call.data });
        switch (decoded.functionName) {
          case "supportsInterface": {
            if (c.interfaces === null) return "0x";
            const id = (decoded.args[0] as string).toLowerCase();
            const claims = ["0x01ffc9a7", ...(c.interfaces ?? [])].map((x) => x.toLowerCase());
            return encodeFunctionResult({ abi: erc165Abi, functionName: "supportsInterface", result: id !== "0xffffffff" && claims.includes(id) });
          }
          case "passURI": {
            if (!c.passURI) throw new RevertError();
            return encodeFunctionResult({ abi: walletPassAbi, functionName: "passURI", result: c.passURI(decoded.args[0] as bigint) });
          }
          case "tokenURI": {
            if (!c.tokenURI) throw new RevertError();
            return encodeFunctionResult({ abi: erc721Abi, functionName: "tokenURI", result: c.tokenURI(decoded.args[0] as bigint) });
          }
          case "ownerOf": {
            if (!c.ownerOf) throw new RevertError();
            return encodeFunctionResult({ abi: erc721Abi, functionName: "ownerOf", result: c.ownerOf(decoded.args[0] as bigint) });
          }
          default:
            throw new RevertError();
        }
      }
      case "eth_getLogs":
        return matching(p[0] as { address?: string; fromBlock?: string; toBlock?: string });
      case "eth_newFilter": {
        const id = numberToHex(filters.size + 1);
        filters.set(id, logs.length);
        return id;
      }
      case "eth_getFilterChanges": {
        const id = p[0] as string;
        const seen = filters.get(id) ?? 0;
        filters.set(id, logs.length);
        return logs.slice(seen).map((l, k) => encodeLog(l, seen + k));
      }
      case "eth_uninstallFilter":
        return true;
      default:
        throw new Error(`fake chain: unsupported method ${method}`);
    }
  };

  const client = createPublicClient({ transport: custom({ request }, { retryCount: 0 }), pollingInterval: 20 });
  return {
    client,
    request,
    logs,
    mine(log: Omit<FakeLog, "blockNumber">) {
      block += 1n;
      logs.push({ ...log, blockNumber: block });
    },
  };
}

/// Ways to break the fake issuer, one property per flag.
export interface IssuerFaults {
  /// Answer a garbage proof with 403 (reserved for not-entitled accounts).
  garbageProof403?: boolean;
  /// Put acquisition URLs in the 401 body.
  leakUrlsIn401?: boolean;
  /// Issue the same nonce every time.
  staticNonce?: boolean;
  /// Accept a replayed proof (nonce not consumed).
  acceptReplay?: boolean;
  /// Serve the apple URL as application/octet-stream.
  wrongPkpassType?: boolean;
  /// Omit Cache-Control: no-store on the gated manifest.
  noStore?: boolean;
  /// Answer the challenge endpoint 200 without an address.
  challengeWithoutAddress?: boolean;
  /// Refuse a non-owner's valid proof with 401 instead of 403.
  notOwner401?: boolean;
  /// Issue challenges whose SIWE domain is not the serving host.
  wrongDomain?: string;
  /// Issue challenges for a different token id.
  wrongTokenInChallenge?: boolean;
  /// Issue challenges already expired.
  expiredChallenge?: boolean;
  /// Answer the gated manifest request 200 even without a proof.
  noGate?: boolean;
  /// Invalid manifest (google URL not a Save link).
  badGoogleLink?: boolean;
}

export interface FakeIssuerOptions {
  base?: string;
  chainId?: number;
  contract: Address;
  mode: "public" | "gated";
  ownerOf: (tokenId: string) => Address | null;
  faults?: IssuerFaults;
  /// Optional hook for signed actions.
  onAction?: (action: string, tokenId: string, account: Address, params: unknown) => unknown;
  /// Answer actions with a custom error code outside the core set.
  customActionError?: string;
  /// Answer the fresh read as failed (503).
  readFails?: boolean;
}

/// A fetch function implementing an issuer with routes:
///   GET  {base}/pass/:id                   manifest or 401 proof_required
///   GET  {base}/pass/:id/challenge         ?address=&action=
///   POST {base}/pass/:id/actions/:action   {message, signature}
///   GET  {base}/files/:id.pkpass           the Apple pass
export function fakeIssuer(opts: FakeIssuerOptions) {
  const base = opts.base ?? "https://issuer.test";
  const host = new URL(base).host;
  const chainId = opts.chainId ?? 1;
  const faults = opts.faults ?? {};
  const nonces = new Set<string>();
  const requests: Array<{ method: string; url: string; headers: Headers }> = [];
  let rotation = 0;

  const manifestFor = (tokenId: string) => ({
    formats: {
      apple: `${base}/files/${tokenId}-${rotation}.pkpass`,
      google: faults.badGoogleLink ? "https://example.com/not-google" : `https://pay.google.com/gp/v/save/jwt${tokenId}r${rotation}`,
    },
    updatedAt: 1754500000,
  });

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  const verify = async (message: string, signature: Hex, tokenId: string, action: string) => {
    const parsed = parseChallenge(message);
    if (!parsed) return { ok: false as const, status: 400, error: "invalid_message" };
    if (parsed.domain !== (faults.wrongDomain ?? host)) return { ok: false as const, status: 400, error: "domain_mismatch" };
    if (!parsed.token || !sameToken(parsed.token, tokenRef(chainId, opts.contract, tokenId)) || parsed.action !== action) {
      return { ok: false as const, status: 400, error: "binding_mismatch" };
    }
    if (!nonces.has(parsed.nonce)) return { ok: false as const, status: 401, error: "nonce_invalid" };
    if (!parsed.expirationTime || parsed.expirationTime.getTime() <= Date.now()) {
      return { ok: false as const, status: 401, error: "challenge_expired" };
    }
    let valid = false;
    try {
      valid = await verifyMessage({ address: parsed.address, message, signature });
    } catch {
      valid = false;
    }
    if (!valid) return { ok: false as const, status: 401, error: "signature_invalid" };
    if (!faults.acceptReplay && !faults.staticNonce) nonces.delete(parsed.nonce);
    if (opts.readFails) return { ok: false as const, status: 503, error: "read_failed" };
    const owner = opts.ownerOf(tokenId);
    if (!owner || owner.toLowerCase() !== parsed.address.toLowerCase()) {
      return { ok: false as const, status: faults.notOwner401 ? 401 : 403, error: "not_owner" };
    }
    return { ok: true as const, account: parsed.address };
  };

  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    if (url.origin !== new URL(base).origin) return json(404, { error: "not_found" });
    const path = url.pathname;
    let m: RegExpExecArray | null;

    if ((m = /^\/files\/([0-9]+)-[0-9]+\.pkpass$/.exec(path))) {
      return new Response("PK", {
        status: 200,
        headers: { "content-type": faults.wrongPkpassType ? "application/octet-stream" : PKPASS_MEDIA_TYPE },
      });
    }

    if ((m = /^\/pass\/([0-9]+)\/challenge$/.exec(path)) && req.method === "GET") {
      const tokenId = m[1]!;
      const address = url.searchParams.get("address");
      const action = url.searchParams.get("action") ?? "acquire";
      let account: Address;
      try {
        if (!address) {
          if (!faults.challengeWithoutAddress) throw new Error("missing");
          account = getAddress("0x000000000000000000000000000000000000dEaD");
        } else account = getAddress(address);
      } catch {
        return json(400, { error: "invalid_address" });
      }
      const nonce = faults.staticNonce ? "staticnonce1234" : generateNonce();
      nonces.add(nonce);
      const now = Date.now();
      const message = buildChallenge({
        domain: faults.wrongDomain ?? host,
        uri: `${base}/pass/${tokenId}`,
        account,
        token: tokenRef(chainId, opts.contract, faults.wrongTokenInChallenge ? BigInt(tokenId) + 1n : tokenId),
        action,
        nonce,
        issuedAt: new Date(faults.expiredChallenge ? now - 600_000 : now),
        expirationTime: new Date(faults.expiredChallenge ? now - 300_000 : now + 300_000),
      });
      return json(200, { message }, { "cache-control": "no-store" });
    }

    if ((m = /^\/pass\/([0-9]+)$/.exec(path)) && req.method === "GET") {
      const tokenId = m[1]!;
      if (opts.ownerOf(tokenId) === null) return json(404, { error: "not_found" });
      if (opts.mode === "public" || faults.noGate) return json(200, manifestFor(tokenId), { "cache-control": "no-store" });
      const challenge = `${base}/pass/${tokenId}/challenge`;
      const proof = readProofHeaders(req.headers);
      if (proof.kind === "absent") {
        const body: Record<string, unknown> = { error: "proof_required", challenge };
        if (faults.leakUrlsIn401) body.formats = manifestFor(tokenId).formats;
        return json(401, body);
      }
      if (proof.kind === "malformed") {
        return json(faults.garbageProof403 ? 403 : 400, { error: "malformed_proof" });
      }
      const result = await verify(proof.proof.message, proof.proof.signature, tokenId, "acquire");
      if (!result.ok) {
        const status = faults.garbageProof403 && result.status !== 503 ? 403 : result.status;
        return json(status, status === 401 ? { error: result.error, challenge } : { error: result.error }, status === 503 ? { "retry-after": "5" } : {});
      }
      rotation += 1;
      return json(200, manifestFor(tokenId), faults.noStore ? {} : { "cache-control": "no-store" });
    }

    if ((m = /^\/pass\/([0-9]+)\/actions\/([A-Za-z0-9._-]+)$/.exec(path)) && req.method === "POST") {
      const tokenId = m[1]!;
      const action = m[2]!;
      if (opts.customActionError) return json(422, { error: opts.customActionError });
      const body = (await req.json().catch(() => null)) as { message?: string; signature?: Hex; params?: unknown } | null;
      if (!body || typeof body.message !== "string" || typeof body.signature !== "string") {
        return json(400, { error: "invalid_message" });
      }
      const result = await verify(body.message, body.signature, tokenId, action);
      if (!result.ok) return json(result.status, { error: result.error }, result.status === 503 ? { "retry-after": "5" } : {});
      return json(200, { ok: true, result: opts.onAction?.(action, tokenId, result.account, body.params) ?? null });
    }

    if ((m = /^\/pass\/([0-9]+)\/rotate$/.exec(path)) && req.method === "POST") {
      const tokenId = m[1]!;
      const challenge = `${base}/pass/${tokenId}/challenge?action=rotate`;
      const proof = readProofHeaders(req.headers);
      if (proof.kind !== "present") return json(401, { error: "proof_required", challenge });
      const result = await verify(proof.proof.message, proof.proof.signature, tokenId, "rotate");
      if (!result.ok) return json(result.status, { error: result.error });
      rotation += 1;
      return json(200, { ok: true, rotated: true, ...manifestFor(tokenId) }, { "cache-control": "no-store" });
    }

    return json(404, { error: "not_found" });
  };

  return {
    fetch: handler as typeof fetch,
    requests,
    base,
    passUri: (tokenId: bigint | string) => `${base}/pass/${tokenId}`,
    issuedNonces: nonces,
  };
}
