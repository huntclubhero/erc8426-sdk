import { describe, expect, it } from "vitest";
import { getAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { WALLET_PASS_INTERFACE_ID } from "@erc8426/core";
import { formatReport, parseArgs, runCli, runConformance, type ConformanceReport } from "@erc8426/conformance";

import { RevertError, fakeChain, fakeIssuer, type FakeContract, type IssuerFaults } from "../../client/test/fixtures.js";

const CONTRACT = getAddress("0x5F9B5a1cdED9d6B3f5E8a2C47B0e13d6A8F4c2e1");

function world(opts: { mode: "public" | "gated"; faults?: IssuerFaults; contract?: Partial<FakeContract>; mirror?: unknown }) {
  const ownerKey = generatePrivateKey();
  const owner = privateKeyToAccount(ownerKey);
  const issuer = fakeIssuer({
    contract: CONTRACT,
    mode: opts.mode,
    ownerOf: (id) => (id === "7" ? owner.address : null),
    ...(opts.faults ? { faults: opts.faults } : {}),
  });
  const chain = fakeChain({
    contracts: {
      [CONTRACT]: {
        interfaces: [WALLET_PASS_INTERFACE_ID],
        passURI: (id) => {
          if (id !== 7n) throw new RevertError();
          return issuer.passUri(id);
        },
        ownerOf: () => owner.address,
        tokenURI: () =>
          `data:application/json,${encodeURIComponent(JSON.stringify({ name: "Seven", ...(opts.mirror !== undefined ? { wallet_pass: opts.mirror } : {}) }))}`,
        ...opts.contract,
      },
    },
  });
  const run = (extra: { ownerPrivateKey?: Hex } = {}) =>
    runConformance({ publicClient: chain.client, fetch: issuer.fetch, contract: CONTRACT, tokenId: 7, nonexistentTokenId: 999, ...extra });
  return { run, ownerKey, owner, issuer, chain };
}

const byId = (r: ConformanceReport, id: string) => {
  const c = r.checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}; have ${r.checks.map((x) => x.id).join(", ")}`);
  return c;
};

describe("conformant implementations", () => {
  it("a public issuer passes every MUST", async () => {
    const { run } = world({ mode: "public" });
    const r = await run();
    expect(r.configuration).toBe("public");
    expect(r.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(r.ok).toBe(true);
    expect(byId(r, "contract.interface-id").status).toBe("pass");
    expect(byId(r, "contract.passuri-nonexistent").status).toBe("pass");
    expect(byId(r, "manifest.valid").status).toBe("pass");
    expect(byId(r, "manifest.apple-media-type").status).toBe("pass");
  });

  it("a gated issuer passes every MUST, including the owner checks", async () => {
    const { run, ownerKey } = world({ mode: "gated" });
    const r = await run({ ownerPrivateKey: ownerKey });
    expect(r.configuration).toBe("gated");
    expect(r.checks.filter((c) => c.status === "fail")).toEqual([]);
    for (const id of [
      "gated.401-proof-required",
      "gated.401-no-urls",
      "challenge.missing-address",
      "challenge.invalid-address",
      "challenge.token-resource",
      "challenge.action-resource",
      "challenge.expiration",
      "challenge.fresh-nonce",
      "gated.garbage-proof",
      "gated.non-owner-403",
      "gated.owner-200",
      "gated.no-store",
      "gated.replay-refused",
      "gated.manifest.valid",
      "mirror.gated-no-urls",
    ]) {
      expect(byId(r, id).status, id).toBe("pass");
    }
    expect(byId(r, "gated.expired-proof").status).toBe("skip");
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain(ownerKey.slice(2));
  });

  it("skips the owner checks without a key and still conforms", async () => {
    const { run } = world({ mode: "gated" });
    const r = await run();
    expect(byId(r, "gated.owner-200")).toMatchObject({ status: "skip", detail: "no owner key supplied" });
    expect(r.ok).toBe(true);
  });

  it("skips the owner checks when the key does not own the token", async () => {
    const { run } = world({ mode: "gated" });
    const r = await run({ ownerPrivateKey: generatePrivateKey() });
    expect(byId(r, "gated.owner-200").status).toBe("skip");
    expect(byId(r, "gated.owner-200").detail).toMatch(/ownerOf is/);
  });
});

describe("broken implementations are caught", () => {
  it.each<[string, IssuerFaults, string, boolean]>([
    ["403 on a garbage proof", { garbageProof403: true }, "gated.garbage-proof", true],
    ["acquisition URLs leaked in the 401", { leakUrlsIn401: true }, "gated.401-no-urls", true],
    ["a nonce reused across challenges", { staticNonce: true }, "challenge.fresh-nonce", true],
    ["a spent proof accepted again", { acceptReplay: true }, "gated.replay-refused", true],
    ["no Cache-Control on the verified manifest", { noStore: true }, "gated.no-store", true],
    ["a challenge issued without an address", { challengeWithoutAddress: true }, "challenge.missing-address", true],
    ["401 instead of 403 for a non-owner", { notOwner401: true }, "gated.non-owner-403", true],
    ["a challenge for another token", { wrongTokenInChallenge: true }, "challenge.token-resource", true],
    ["an already expired challenge", { expiredChallenge: true }, "challenge.expiration", true],
    ["the apple pass served with the wrong media type", { wrongPkpassType: true }, "gated.manifest.apple-media-type", true],
    ["a verifier domain unrelated to the serving host", { wrongDomain: "elsewhere.example" }, "challenge.domain-host", false],
  ])("%s", async (_name, faults, id, isMust) => {
    const { run, ownerKey } = world({ mode: "gated", faults });
    const r = await run({ ownerPrivateKey: ownerKey });
    expect(byId(r, id).status).toBe("fail");
    expect(byId(r, id).level).toBe(isMust ? "MUST" : "SHOULD");
    expect(r.ok).toBe(!isMust);
  });

  it("an ungated manifest is detected as public, and a public mirror is validated", async () => {
    const { run } = world({ mode: "public", mirror: { formats: { google: "https://not-google.example/x" } } });
    const r = await run();
    expect(byId(r, "mirror.valid").status).toBe("fail");
    expect(r.ok).toBe(false);
  });

  it("a gated issuer that mirrors acquisition URLs into metadata fails", async () => {
    const { run } = world({ mode: "gated", mirror: { formats: { apple: "https://issuer.test/files/7-0.pkpass" } } });
    const r = await run();
    expect(byId(r, "mirror.gated-no-urls").status).toBe("fail");
    expect(r.ok).toBe(false);
  });

  it("a public manifest with a wrong pkpass media type fails the MUST", async () => {
    const { run } = world({ mode: "public", faults: { wrongPkpassType: true } });
    const r = await run();
    expect(byId(r, "manifest.apple-media-type")).toMatchObject({ status: "fail", detail: "Content-Type: application/octet-stream" });
  });

  it("an invalid public manifest fails", async () => {
    const { run } = world({ mode: "public", faults: { badGoogleLink: true } });
    const r = await run();
    expect(byId(r, "manifest.valid").status).toBe("fail");
  });

  it("contract faults: no interface, passURI that never reverts", async () => {
    const { run } = world({ mode: "public", contract: { interfaces: [], passURI: () => "https://issuer.test/pass/7" } });
    const r = await run();
    expect(byId(r, "contract.interface-id").status).toBe("fail");
    expect(byId(r, "contract.passuri-nonexistent").status).toBe("fail");
    expect(r.ok).toBe(false);
  });

  it("a contract without ERC-165 fails the ERC-165 checks without crashing", async () => {
    const { run } = world({ mode: "public", contract: { interfaces: null } });
    const r = await run();
    expect(byId(r, "contract.erc165").status).toBe("fail");
    expect(byId(r, "manifest.valid").status).toBe("pass");
  });

  it("an unreachable apple URL is a SHOULD warning, not a MUST failure", async () => {
    const { issuer, chain } = world({ mode: "public" });
    const original = issuer.fetch;
    const r = await runConformance({
      publicClient: chain.client,
      contract: CONTRACT,
      tokenId: 7,
      nonexistentTokenId: 999,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes(".pkpass")) throw new TypeError("fetch failed");
        return original(input, init);
      }) as typeof fetch,
    });
    expect(byId(r, "manifest.apple-reachable")).toMatchObject({ status: "fail", level: "SHOULD" });
    expect(byId(r, "manifest.apple-media-type").status).toBe("skip");
  });
});

describe("report and CLI", () => {
  it("formats a readable table with a summary", async () => {
    const { run } = world({ mode: "gated", faults: { garbageProof403: true } });
    const text = formatReport(await run());
    expect(text).toMatch(/^ERC-8426 conformance: contract 0x5F9B5a1cdED9d6B3f5E8a2C47B0e13d6A8F4c2e1 token 7 on chain 1/);
    expect(text).toMatch(/FAIL\s+MUST\s+gated\.garbage-proof/);
    expect(text).toMatch(/\d+ passed, 1 failed \(MUST\), \d+ warnings \(SHOULD\), \d+ skipped/);
    expect(text).toContain("Result: DOES NOT CONFORM");
    expect(text).not.toMatch(new RegExp("-{2}|\\u2014"));
  });

  it("parses flags by hand and refuses a key on the command line", () => {
    expect(parseArgs(["--rpc", "http://x", "--contract=0xabc", "--token", "7", "--json"])).toMatchObject({ rpc: "http://x", contract: "0xabc", token: "7", json: true });
    expect(() => parseArgs(["--owner-key", "0x11"])).toThrow(/environment variable/);
    expect(() => parseArgs(["--private-key=0x11"])).toThrow(/environment variable/);
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--token"])).toThrow(/needs a value/);
  });

  it("runs end to end, reads the key from the named env var, and exits by MUST result", async () => {
    const good = world({ mode: "gated" });
    let out = "";
    let err = "";
    const io = (w: ReturnType<typeof world>, env: Record<string, string>) => ({
      env,
      stdout: (t: string) => (out += t),
      stderr: (t: string) => (err += t),
      publicClient: w.chain.client,
      fetch: w.issuer.fetch,
    });
    const code = await runCli(["--contract", CONTRACT, "--token", "7", "--nonexistent-token", "999", "--owner-key-env", "MY_KEY", "--json"], io(good, { MY_KEY: good.ownerKey }));
    expect(err).toBe("");
    expect(code).toBe(0);
    const report = JSON.parse(out) as ConformanceReport;
    expect(report.ownerAddress).toBe(good.owner.address);
    expect(report.checks.find((c) => c.id === "gated.owner-200")?.status).toBe("pass");
    expect(out).not.toContain(good.ownerKey.slice(2));

    out = "";
    const bad = world({ mode: "gated", faults: { leakUrlsIn401: true } });
    expect(await runCli(["--contract", CONTRACT, "--token", "7", "--nonexistent-token", "999"], io(bad, {}))).toBe(1);
    expect(out).toContain("DOES NOT CONFORM");

    err = "";
    expect(await runCli(["--contract", CONTRACT, "--token", "7"], io(bad, { ERC8426_OWNER_KEY: "not-a-key" }))).toBe(2);
    expect(err).toContain("ERC8426_OWNER_KEY");
    expect(err).not.toContain("not-a-key");

    expect(await runCli(["--token", "7"], { env: {}, stdout: () => {}, stderr: () => {} })).toBe(2);
  });
});

describe("over real HTTP", () => {
  it("a gated issuer behind a node http server conforms", async () => {
    const { createServer } = await import("node:http");
    let issuer: ReturnType<typeof fakeIssuer> | undefined;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length > 0 && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const answer = await issuer!.fetch(`${issuer!.base}${req.url}`, { method: req.method!, headers, ...(body ? { body } : {}) });
      const out: Record<string, string> = {};
      answer.headers.forEach((v, k) => (out[k] = v));
      res.writeHead(answer.status, out);
      res.end(req.method === "HEAD" ? undefined : Buffer.from(await answer.arrayBuffer()));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as { port: number }).port;
      const ownerKey = generatePrivateKey();
      const owner = privateKeyToAccount(ownerKey);
      issuer = fakeIssuer({ base: `http://127.0.0.1:${port}`, contract: CONTRACT, mode: "gated", ownerOf: () => owner.address });
      const chain = fakeChain({
        contracts: {
          [CONTRACT]: {
            interfaces: [WALLET_PASS_INTERFACE_ID],
            passURI: (id) => {
              if (id !== 7n) throw new RevertError();
              return issuer!.passUri(id);
            },
            ownerOf: () => owner.address,
          },
        },
      });
      const r = await runConformance({ publicClient: chain.client, contract: CONTRACT, tokenId: 7, nonexistentTokenId: 8, ownerPrivateKey: ownerKey });
      expect(r.checks.filter((c) => c.status === "fail")).toEqual([]);
      expect(r.ok).toBe(true);
      expect(byId(r, "gated.owner-200").status).toBe("pass");
      expect(byId(r, "challenge.domain-host").status).toBe("pass");
    } finally {
      server.close();
    }
  });
});
