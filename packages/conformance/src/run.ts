import { createPublicClient, getAddress, http, maxUint256, type Address, type Client, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getChainId, readContract } from "viem/actions";
import {
  ACQUIRE_ACTION,
  PKPASS_MEDIA_TYPE,
  WALLET_PASS_INTERFACE_ID,
  actionUrn,
  assetId,
  erc165Abi,
  erc721Abi,
  normalizeTokenId,
  parseAssetId,
  parseChallenge,
  parseManifest,
  proofHeaders,
  readMetadataMirror,
  sameToken,
  tokenRef,
  walletPassAbi,
  type PassManifest,
  type TokenRef,
} from "@erc8426/core";
import { decodeDataUri, resolveUri, type GatewayOptions } from "@erc8426/client";

import type { CheckLevel, CheckResult, CheckStatus, ConformanceOptions, ConformanceReport } from "./types.js";

const S = {
  contract: "Contract interface",
  manifest: "Pass manifest",
  mirror: "Metadata mirror",
  acquisition: "Acquisition URLs",
  gated: "Gated acquisition",
  floor: "Authorization of pass-reachable actions",
} as const;

interface HttpResult {
  status: number;
  headers: Headers;
  body: unknown;
  text: string;
}

/// Every string in a JSON value that looks like an acquisition URL.
function findUrls(value: unknown, ignore: ReadonlySet<string>, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (!ignore.has(value) && (/^https?:\/\//i.test(value) || /\.pkpass\b/i.test(value) || value.includes("pay.google.com"))) {
      out.push(value);
    }
  } else if (Array.isArray(value)) {
    for (const v of value) findUrls(v, ignore, out);
  } else if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) findUrls(v, ignore, out);
  }
  return out;
}

/// Run the ERC-8426 conformance suite against a contract and the pass server
///  its passURI points at. Checks never stop the run: a failure is recorded
///  and later checks that depend on it are skipped with the reason.
export async function runConformance(options: ConformanceOptions): Promise<ConformanceReport> {
  const checks: CheckResult[] = [];
  const record = (id: string, title: string, section: string, level: CheckLevel, status: CheckStatus, detail?: string) => {
    const r: CheckResult = { id, title, section, level, status };
    if (detail !== undefined) r.detail = detail;
    checks.push(r);
    return status === "pass";
  };

  const doFetch: typeof fetch = options.fetch ?? ((i, init) => globalThis.fetch(i, init));
  const timeoutMs = options.timeoutMs ?? 15_000;
  const gateways: GatewayOptions = {
    ...(options.ipfsGateway ? { ipfsGateway: options.ipfsGateway } : {}),
    ...(options.arweaveGateway ? { arweaveGateway: options.arweaveGateway } : {}),
  };

  const httpGet = async (url: string, headers: Record<string, string> = {}, method = "GET"): Promise<HttpResult> => {
    const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(timeoutMs) : undefined;
    const res = await doFetch(url, { method, headers: { accept: "application/json", ...headers }, ...(signal ? { signal } : {}) });
    const text = method === "HEAD" ? "" : await res.text().catch(() => "");
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, headers: res.headers, body, text };
  };

  let publicClient: Client;
  if (options.publicClient) publicClient = options.publicClient;
  else if (options.rpcUrl) publicClient = createPublicClient({ transport: http(options.rpcUrl) });
  else throw new Error("runConformance needs rpcUrl or publicClient");

  const contract = getAddress(options.contract);
  const tokenId = normalizeTokenId(options.tokenId);
  const report: ConformanceReport = {
    chainId: null,
    contract,
    tokenId,
    configuration: "unknown",
    passUri: null,
    manifestUrl: null,
    ownerAddress: options.ownerPrivateKey ? privateKeyToAccount(options.ownerPrivateKey).address : null,
    checks,
    summary: { pass: 0, fail: 0, warn: 0, skip: 0 },
    ok: false,
  };

  const finish = (): ConformanceReport => {
    for (const c of checks) {
      if (c.status === "pass") report.summary.pass++;
      else if (c.status === "skip") report.summary.skip++;
      else if (c.level === "MUST") report.summary.fail++;
      else report.summary.warn++;
    }
    report.ok = report.summary.fail === 0;
    return report;
  };

  let chainId: number;
  try {
    chainId = publicClient.chain?.id ?? (await getChainId(publicClient));
    report.chainId = chainId;
  } catch (e) {
    record("chain.reachable", "The RPC endpoint answers eth_chainId", S.contract, "MUST", "fail", (e as Error).message);
    return finish();
  }
  const ref: TokenRef = tokenRef(chainId, contract, tokenId);

  // Contract interface.
  const supports = async (id: Hex): Promise<boolean | Error> => {
    try {
      return await readContract(publicClient, { address: contract, abi: erc165Abi, functionName: "supportsInterface", args: [id] });
    } catch (e) {
      return e as Error;
    }
  };
  const describe = (v: boolean | Error) => (v instanceof Error ? `call failed: ${v.message.split("\n")[0]}` : `returned ${v}`);
  const erc165 = await supports("0x01ffc9a7");
  record("contract.erc165", "supportsInterface(0x01ffc9a7) is true (ERC-165)", S.contract, "MUST", erc165 === true ? "pass" : "fail", describe(erc165));
  const invalid = await supports("0xffffffff");
  record("contract.erc165-invalid", "supportsInterface(0xffffffff) is false (ERC-165)", S.contract, "MUST", invalid === false ? "pass" : "fail", describe(invalid));
  const wp = await supports(WALLET_PASS_INTERFACE_ID);
  record("contract.interface-id", `supportsInterface(${WALLET_PASS_INTERFACE_ID}) is true`, S.contract, "MUST", wp === true ? "pass" : "fail", describe(wp));

  let passUri: string | null = null;
  try {
    passUri = await readContract(publicClient, { address: contract, abi: walletPassAbi, functionName: "passURI", args: [BigInt(tokenId)] });
    report.passUri = passUri;
    record("contract.passuri", "passURI(tokenId) returns a URI", S.contract, "MUST", passUri.length > 0 ? "pass" : "fail", passUri || "empty string");
  } catch (e) {
    record("contract.passuri", "passURI(tokenId) returns a URI", S.contract, "MUST", "fail", `reverted: ${(e as Error).message.split("\n")[0]}`);
  }

  const missing = options.nonexistentTokenId !== undefined ? normalizeTokenId(options.nonexistentTokenId) : maxUint256.toString();
  try {
    const v = await readContract(publicClient, { address: contract, abi: walletPassAbi, functionName: "passURI", args: [BigInt(missing)] });
    record("contract.passuri-nonexistent", "passURI throws for a token that does not exist", S.contract, "MUST", "fail", `token ${missing} returned "${v}"`);
  } catch (e) {
    // Only a revert counts: a transport failure proves nothing about the contract.
    const reverted = /revert/i.test(String((e as Error).message));
    record(
      "contract.passuri-nonexistent",
      "passURI throws for a token that does not exist",
      S.contract,
      "MUST",
      reverted ? "pass" : "fail",
      reverted ? `token ${missing} reverted` : `call failed without a revert: ${(e as Error).message.split("\n")[0]}`,
    );
  }

  if (passUri === null || passUri.length === 0) {
    record("manifest.reachable", "The manifest endpoint answers", S.manifest, "MUST", "skip", "no passURI to resolve");
    return finish();
  }

  let manifestUrl: string;
  try {
    manifestUrl = resolveUri(passUri, gateways);
    report.manifestUrl = manifestUrl;
  } catch (e) {
    record("manifest.reachable", "The manifest endpoint answers", S.manifest, "MUST", "fail", (e as Error).message);
    return finish();
  }

  // Manifest validation shared by the public response and the owner's gated one.
  const checkManifest = async (body: unknown, idPrefix: string): Promise<PassManifest | null> => {
    const parsed = parseManifest(body);
    if (!parsed.ok) {
      const detail = parsed.issues.filter((i) => i.level === "error").map((i) => `${i.path || "(root)"}: ${i.message}`).join("; ");
      record(`${idPrefix}.valid`, "The manifest has the required shape (formats, google Save link, updatedAt in seconds)", S.manifest, "MUST", "fail", detail);
      return null;
    }
    const platforms = Object.keys(parsed.manifest.formats).join(", ");
    record(`${idPrefix}.valid`, "The manifest has the required shape (formats, google Save link, updatedAt in seconds)", S.manifest, "MUST", "pass", `formats: ${platforms}`);
    const warnings = parsed.issues.filter((i) => i.level === "warning");
    record(
      `${idPrefix}.lint`,
      "Acquisition URLs are https and updatedAt looks like seconds",
      S.manifest,
      "SHOULD",
      warnings.length === 0 ? "pass" : "fail",
      warnings.length === 0 ? undefined : warnings.map((w) => `${w.path}: ${w.message}`).join("; "),
    );
    const apple = parsed.manifest.formats.apple;
    if (!apple) {
      record(`${idPrefix}.apple-media-type`, `The apple URL is served as ${PKPASS_MEDIA_TYPE}`, S.manifest, "MUST", "skip", "no apple format");
    } else {
      let res: HttpResult | null = null;
      let error = "";
      try {
        res = await httpGet(apple, { accept: PKPASS_MEDIA_TYPE }, "HEAD");
        if (res.status === 405 || res.status === 501) res = await httpGet(apple, { accept: PKPASS_MEDIA_TYPE });
      } catch (e) {
        error = (e as Error).message;
      }
      if (!res || res.status < 200 || res.status >= 300) {
        record(`${idPrefix}.apple-reachable`, "The apple URL can be fetched", S.manifest, "SHOULD", "fail", res ? `HTTP ${res.status}` : error);
        record(`${idPrefix}.apple-media-type`, `The apple URL is served as ${PKPASS_MEDIA_TYPE}`, S.manifest, "MUST", "skip", "the apple URL could not be fetched");
      } else {
        const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
        record(`${idPrefix}.apple-media-type`, `The apple URL is served as ${PKPASS_MEDIA_TYPE}`, S.manifest, "MUST", type === PKPASS_MEDIA_TYPE ? "pass" : "fail", `Content-Type: ${type || "(none)"}`);
      }
    }
    return parsed.manifest;
  };

  // Detect the configuration.
  let first: HttpResult | null = null;
  if (/^data:/i.test(manifestUrl)) {
    try {
      const body = JSON.parse(decodeDataUri(manifestUrl).text);
      first = { status: 200, headers: new Headers(), body, text: "" };
    } catch (e) {
      record("manifest.reachable", "The manifest endpoint answers", S.manifest, "MUST", "fail", `data: URI is not JSON: ${(e as Error).message}`);
      return finish();
    }
  } else {
    try {
      first = await httpGet(manifestUrl);
    } catch (e) {
      record("manifest.reachable", "The manifest endpoint answers", S.manifest, "MUST", "fail", (e as Error).message);
      return finish();
    }
  }

  if (first.status === 200) {
    report.configuration = "public";
    record("manifest.reachable", "The manifest endpoint answers", S.manifest, "MUST", "pass", "200 without a proof: public configuration");
    await checkManifest(first.body, "manifest");
  } else if (first.status === 401) {
    report.configuration = "gated";
    record("manifest.reachable", "The manifest endpoint answers", S.manifest, "MUST", "pass", "401 without a proof: gated configuration");
  } else {
    record("manifest.reachable", "The manifest endpoint answers", S.manifest, "MUST", "fail", `HTTP ${first.status}; expected 200 (public) or 401 (gated)`);
  }

  // Metadata mirror.
  try {
    const tokenUri = await readContract(publicClient, { address: contract, abi: erc721Abi, functionName: "tokenURI", args: [BigInt(tokenId)] });
    const url = resolveUri(tokenUri, gateways);
    const metadata = /^data:/i.test(url) ? JSON.parse(decodeDataUri(url).text) : (await httpGet(url)).body;
    const mirror = readMetadataMirror(metadata);
    if (mirror === null) {
      record("mirror.valid", "A wallet_pass mirror in tokenURI metadata is a valid manifest", S.mirror, "MUST", "skip", "no wallet_pass in metadata");
      if (report.configuration === "gated") {
        record("mirror.gated-no-urls", "A gated implementation does not mirror acquisition URLs into metadata", S.mirror, "MUST", "pass", "no mirror");
      }
    } else {
      record(
        "mirror.valid",
        "A wallet_pass mirror in tokenURI metadata is a valid manifest",
        S.mirror,
        "MUST",
        mirror.ok ? "pass" : "fail",
        mirror.ok ? undefined : mirror.issues.map((i) => `${i.path}: ${i.message}`).join("; "),
      );
      if (report.configuration === "gated") {
        const raw = (metadata as Record<string, unknown>).wallet_pass;
        const leaked = findUrls(raw, new Set());
        record(
          "mirror.gated-no-urls",
          "A gated implementation does not mirror acquisition URLs into metadata",
          S.mirror,
          "MUST",
          leaked.length === 0 ? "pass" : "fail",
          leaked.length === 0 ? undefined : `metadata carries ${leaked.length} acquisition URL(s)`,
        );
      }
    }
  } catch (e) {
    record("mirror.valid", "A wallet_pass mirror in tokenURI metadata is a valid manifest", S.mirror, "MUST", "skip", `tokenURI unavailable: ${(e as Error).message.split("\n")[0]}`);
  }

  if (report.configuration !== "gated") return finish();

  // Gated acquisition: the 401.
  const body401 = first.body as Record<string, unknown> | null;
  const challengeRef = typeof body401?.challenge === "string" ? body401.challenge : null;
  record(
    "gated.401-proof-required",
    "A request without a proof gets 401 with error proof_required and a challenge URI",
    S.gated,
    "MUST",
    body401?.error === "proof_required" && challengeRef !== null ? "pass" : "fail",
    `error=${JSON.stringify(body401?.error)}, challenge=${JSON.stringify(body401?.challenge)}`,
  );
  const leaked = findUrls(first.body, new Set(challengeRef ? [challengeRef] : []));
  record(
    "gated.401-no-urls",
    "The 401 body carries no acquisition URLs",
    S.gated,
    "MUST",
    leaked.length === 0 ? "pass" : "fail",
    leaked.length === 0 ? undefined : `found: ${leaked.join(", ")}`,
  );

  const skipRest = (reason: string) => {
    const rest: Array<[string, string, string]> = [
      ["challenge.missing-address", "The challenge endpoint answers 400 without an address", S.gated],
      ["challenge.invalid-address", "The challenge endpoint answers 400 for an invalid address", S.gated],
      ["challenge.floor", "The acquire challenge meets the floor", S.floor],
      ["challenge.fresh-nonce", "Every challenge request issues a fresh nonce", S.gated],
      ["gated.garbage-proof", "A garbage proof is refused, and not with 403", S.gated],
      ["gated.non-owner-403", "A valid proof from a non-entitled account is refused with exactly 403", S.gated],
    ];
    for (const [id, title, section] of rest) record(id, title, section, "MUST", "skip", reason);
  };
  if (challengeRef === null) {
    skipRest("no challenge URI in the 401 body");
    return finish();
  }
  const challengeUrl = new URL(challengeRef, manifestUrl);
  const withAddress = (address: string | null) => {
    const u = new URL(challengeUrl);
    if (address === null) u.searchParams.delete("address");
    else u.searchParams.set("address", address);
    return u.toString();
  };

  try {
    const r = await httpGet(withAddress(null));
    record("challenge.missing-address", "The challenge endpoint answers 400 without an address", S.gated, "MUST", r.status === 400 ? "pass" : "fail", `HTTP ${r.status}`);
  } catch (e) {
    record("challenge.missing-address", "The challenge endpoint answers 400 without an address", S.gated, "MUST", "fail", (e as Error).message);
  }
  try {
    const r = await httpGet(withAddress("0x1234"));
    record("challenge.invalid-address", "The challenge endpoint answers 400 for an invalid address", S.gated, "MUST", r.status === 400 ? "pass" : "fail", `HTTP ${r.status}`);
  } catch (e) {
    record("challenge.invalid-address", "The challenge endpoint answers 400 for an invalid address", S.gated, "MUST", "fail", (e as Error).message);
  }

  const fetchChallenge = async (address: Address): Promise<string | null> => {
    try {
      const r = await httpGet(withAddress(address));
      const m = (r.body as { message?: unknown } | null)?.message;
      return r.status === 200 && typeof m === "string" ? m : null;
    } catch {
      return null;
    }
  };

  // The challenge floor, field by field, for a fresh probe account.
  const probe = privateKeyToAccount(generatePrivateKey());
  const message = await fetchChallenge(probe.address);
  if (message === null) {
    record("challenge.issued", "The challenge endpoint returns a JSON body with a message for a valid address", S.gated, "MUST", "fail", "no message");
  } else {
    record("challenge.issued", "The challenge endpoint returns a JSON body with a message for a valid address", S.gated, "MUST", "pass");
    const parsed = parseChallenge(message);
    record("challenge.siwe", "The challenge is serialized as an ERC-4361 message", S.floor, "SHOULD", parsed ? "pass" : "fail", parsed ? undefined : "not parseable as ERC-4361; floor fields cannot be checked");
    if (parsed) {
      const f = (id: string, title: string, ok: boolean, detail?: string, level: CheckLevel = "MUST") =>
        record(`challenge.${id}`, title, S.floor, level, ok ? "pass" : "fail", detail);
      f("domain", "The challenge names the verifier (domain)", parsed.domain.length > 0, parsed.domain);
      f(
        "domain-host",
        "The verifier domain is the host serving the challenge, so clients can check it",
        parsed.domain.toLowerCase() === challengeUrl.host.toLowerCase() || parsed.domain.toLowerCase() === challengeUrl.hostname.toLowerCase(),
        `domain ${parsed.domain}, host ${challengeUrl.host}`,
        "SHOULD",
      );
      f("address", "The challenge names the claimed account from the request", parsed.address.toLowerCase() === probe.address.toLowerCase(), parsed.address);
      f("chain-id", "The challenge chain id is the token's chain", parsed.chainId === chainId, `Chain ID ${parsed.chainId}, expected ${chainId}`);
      f("nonce", "The challenge carries a nonce", parsed.nonce.length >= 8, parsed.nonce);
      const exp = parsed.expirationTime;
      f("expiration", "The challenge carries an Expiration Time in the future", !!exp && exp.getTime() > Date.now(), exp ? exp.toISOString() : "missing");
      const expected = assetId(ref);
      const firstRes = parsed.resources[0];
      const firstRef = firstRes ? parseAssetId(firstRes) : null;
      f(
        "token-resource",
        "The first resource is the CAIP-19 id of this exact token",
        firstRef !== null && sameToken(firstRef, ref),
        firstRes === expected ? firstRes : `got ${firstRes ?? "nothing"}, expected ${expected}`,
      );
      const urn = actionUrn(ACQUIRE_ACTION);
      f(
        "action-resource",
        `The action resource is ${urn}`,
        parsed.resources[1] === urn,
        parsed.resources[1] === urn ? undefined : `resources: ${parsed.resources.join(", ")}`,
      );
    }
  }

  const n1 = await fetchChallenge(probe.address);
  const n2 = await fetchChallenge(probe.address);
  const nonce1 = n1 ? parseChallenge(n1)?.nonce : undefined;
  const nonce2 = n2 ? parseChallenge(n2)?.nonce : undefined;
  if (nonce1 === undefined || nonce2 === undefined) {
    record("challenge.fresh-nonce", "Every challenge request issues a fresh nonce", S.gated, "MUST", "skip", "nonce not readable");
  } else {
    record("challenge.fresh-nonce", "Every challenge request issues a fresh nonce", S.gated, "MUST", nonce1 !== nonce2 ? "pass" : "fail", nonce1 === nonce2 ? `nonce ${nonce1} issued twice` : undefined);
  }

  // A garbage proof: well-formed headers around a message that is no challenge.
  try {
    const r = await httpGet(manifestUrl, proofHeaders({ message: "not a challenge", signature: `0x${"ab".repeat(65)}` }));
    const ok = r.status >= 400 && r.status !== 403;
    record(
      "gated.garbage-proof",
      "A garbage proof is refused, and not with 403",
      S.gated,
      "MUST",
      ok ? "pass" : "fail",
      r.status === 403 ? "HTTP 403 is reserved for a verified proof from a non-entitled account" : `HTTP ${r.status}`,
    );
    const leakedGarbage = r.status >= 400 ? findUrls(r.body, new Set(challengeRef ? [challengeRef, challengeUrl.toString()] : [])) : [];
    if (leakedGarbage.length > 0) {
      record("gated.refusal-no-urls", "A refused request carries no acquisition URLs", S.gated, "MUST", "fail", leakedGarbage.join(", "));
    }
  } catch (e) {
    record("gated.garbage-proof", "A garbage proof is refused, and not with 403", S.gated, "MUST", "fail", (e as Error).message);
  }

  // A valid proof from an account that owns nothing.
  const stranger = privateKeyToAccount(generatePrivateKey());
  const strangerMessage = await fetchChallenge(stranger.address);
  if (strangerMessage === null) {
    record("gated.non-owner-403", "A valid proof from a non-entitled account is refused with exactly 403", S.gated, "MUST", "skip", "no challenge issued");
  } else {
    try {
      const signature = await stranger.signMessage({ message: strangerMessage });
      const r = await httpGet(manifestUrl, proofHeaders({ message: strangerMessage, signature }));
      record("gated.non-owner-403", "A valid proof from a non-entitled account is refused with exactly 403", S.gated, "MUST", r.status === 403 ? "pass" : "fail", `HTTP ${r.status}`);
    } catch (e) {
      record("gated.non-owner-403", "A valid proof from a non-entitled account is refused with exactly 403", S.gated, "MUST", "fail", (e as Error).message);
    }
  }

  // Owner checks.
  const ownerIds: Array<[string, string]> = [
    ["gated.owner-200", "A valid proof from the owner resolves the manifest"],
    ["gated.no-store", "The verified manifest response carries Cache-Control: no-store"],
    ["gated.replay-refused", "Replaying a spent proof is refused, and not with 403 (single-use nonce)"],
  ];
  let ownerSkip: string | null = null;
  const owner = options.ownerPrivateKey ? privateKeyToAccount(options.ownerPrivateKey) : null;
  if (!owner) ownerSkip = "no owner key supplied";
  else {
    try {
      const current = await readContract(publicClient, { address: contract, abi: erc721Abi, functionName: "ownerOf", args: [BigInt(tokenId)] });
      if (current.toLowerCase() !== owner.address.toLowerCase()) ownerSkip = `supplied key is ${owner.address}, but ownerOf is ${current}`;
    } catch {
      // ownerOf unreadable; an issuer with an extended entitlement may still accept the key.
    }
  }
  if (ownerSkip || !owner) {
    for (const [id, title] of ownerIds) record(id, title, S.gated, "MUST", "skip", ownerSkip ?? "no owner key supplied");
  } else {
    const ownerMessage = await fetchChallenge(owner.address);
    if (ownerMessage === null) {
      for (const [id, title] of ownerIds) record(id, title, S.gated, "MUST", "skip", "no challenge issued for the owner");
    } else {
      const signature = await owner.signMessage({ message: ownerMessage });
      const headers = proofHeaders({ message: ownerMessage, signature });
      const r = await httpGet(manifestUrl, headers);
      record(ownerIds[0]![0], ownerIds[0]![1], S.gated, "MUST", r.status === 200 ? "pass" : "fail", `HTTP ${r.status}`);
      if (r.status === 200) {
        const cc = (r.headers.get("cache-control") ?? "").toLowerCase();
        record(ownerIds[1]![0], ownerIds[1]![1], S.gated, "MUST", /\bno-store\b/.test(cc) ? "pass" : "fail", `Cache-Control: ${cc || "(none)"}`);
        await checkManifest(r.body, "gated.manifest");
      } else {
        record(ownerIds[1]![0], ownerIds[1]![1], S.gated, "MUST", "skip", "owner proof was not accepted");
      }
      const replay = await httpGet(manifestUrl, headers);
      const replayOk = replay.status >= 400 && replay.status !== 403;
      record(ownerIds[2]![0], ownerIds[2]![1], S.gated, "MUST", replayOk ? "pass" : "fail", `HTTP ${replay.status}`);
    }
  }

  for (const [id, title] of [
    ["gated.expired-proof", "An expired proof is refused"],
    ["gated.wrong-domain-proof", "A proof naming another verifier is refused"],
  ] as const) {
    record(id, title, S.floor, "MUST", "skip", "cannot be produced without the server's cooperation; covered by the issuer's own tests");
  }

  return finish();
}
