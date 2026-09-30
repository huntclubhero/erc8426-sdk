import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseEther,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type TestClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { appleFormatProvider } from "@erc8426/apple";
import { googleFormatProvider, googleWalletClient, TOKEN_URL, WALLET_API } from "@erc8426/google";
import { toNodeHandler } from "@erc8426/issuer";

import { TINY_PNG, makeTestCerts, unzip } from "../../packages/apple/test/helpers.js";

/// Shared end-to-end plumbing: a real anvil per test file, real HTTP on a
///  random port, contracts deployed from the committed artifacts, and keys
///  generated at runtime only.

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ANVIL = join(homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");

export { unzip };

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export interface Chain {
  rpcUrl: string;
  publicClient: PublicClient;
  testClient: TestClient;
  stop(): Promise<void>;
}

async function rpcReady(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/// Spawn anvil on a free port and wait for it to answer. Retries on a port
///  race. `stop` kills the process and waits for it to exit, so Windows
///  releases the port before the next file starts.
export async function startAnvil(): Promise<Chain> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort();
    const child: ChildProcess = spawn(ANVIL, ["--port", String(port), "--host", "127.0.0.1"], { stdio: "ignore", windowsHide: true });
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    const rpcUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 20_000;
    let ready = false;
    while (Date.now() < deadline && child.exitCode === null) {
      if (await rpcReady(rpcUrl)) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!ready) {
      child.kill();
      await exited;
      continue;
    }
    const chain = { ...foundry, rpcUrls: { default: { http: [rpcUrl] } } };
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 50 }) as PublicClient;
    const testClient = createTestClient({ chain, mode: "anvil", transport: http(rpcUrl) }) as unknown as TestClient;
    return {
      rpcUrl,
      publicClient,
      testClient,
      async stop() {
        if (child.exitCode === null) {
          child.kill();
          await exited;
        }
      },
    };
  }
  throw new Error("anvil did not start");
}

export interface Actor {
  account: PrivateKeyAccount;
  key: Hex;
  address: Address;
  wallet: ReturnType<typeof walletFor>;
}

function walletFor(chain: Chain, account: PrivateKeyAccount) {
  return createWalletClient({ account, chain: chain.publicClient.chain!, transport: http(chain.rpcUrl) });
}

/// A runtime key, funded through anvil_setBalance.
export async function newActor(chain: Chain): Promise<Actor> {
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  await chain.testClient.setBalance({ address: account.address, value: parseEther("100") });
  return { account, key, address: account.address, wallet: walletFor(chain, account) };
}

export function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(join(ROOT, "packages", "contracts", "artifacts", `${name}.json`), "utf8")) as { abi: Abi; bytecode: Hex };
  return { abi: json.abi, bytecode: json.bytecode };
}

export async function deploy(chain: Chain, from: Actor, name: string, args: unknown[]): Promise<{ address: Address; abi: Abi }> {
  const { abi, bytecode } = artifact(name);
  const hash = await from.wallet.deployContract({ abi, bytecode, args });
  const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`${name} did not deploy`);
  return { address: receipt.contractAddress, abi };
}

/// Simulate then send, so a revert surfaces as a thrown error before any
///  transaction is broadcast, and wait for the receipt.
export async function send(chain: Chain, from: Actor, address: Address, abi: Abi, functionName: string, args: unknown[]) {
  const { request } = await chain.publicClient.simulateContract({ account: from.account, address, abi, functionName, args });
  const hash = await from.wallet.writeContract(request as never);
  const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  return receipt;
}

export interface HttpServer {
  port: number;
  baseUrl: string;
  /// The verifier identity: the host the challenge is served from.
  domain: string;
  setHandler(handler: (request: Request) => Promise<Response>): void;
  close(): Promise<void>;
}

/// A real node http server on a random port whose handler is set after
///  listening, because the issuer needs the origin (for its domain and
///  baseUrl) and the contract needs the issuer's passURI base.
export async function startServer(): Promise<HttpServer> {
  let current: (request: Request) => Promise<Response> = async () => new Response("not ready", { status: 503 });
  const server: Server = createServer(toNodeHandler((r) => current(r)) as never);
  // Keep-alive sockets would hold close() open on Windows.
  server.keepAliveTimeout = 1;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    domain: `127.0.0.1:${port}`,
    setHandler(h) {
      current = h;
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

/// The Apple provider with runtime self-signed certificates.
export function appleProvider(origin: string) {
  return appleFormatProvider({
    passTypeIdentifier: "pass.example.e2e",
    teamIdentifier: "E2ETEAM001",
    certificates: makeTestCerts(),
    origin,
    images: { icon: { data: TINY_PNG } },
  });
}

/// A stand-in for the Google Wallet REST API: token grants and a resource
///  map, behind a fetch function.
export function fakeGoogleFetch() {
  const resources = new Map<string, unknown>();
  const calls: string[] = [];
  const fn = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url}`);
    if (url === TOKEN_URL) return Response.json({ access_token: "tok", expires_in: 3600, token_type: "Bearer" });
    const path = decodeURIComponent(url.slice(WALLET_API.length + 1));
    const parts = path.split("/");
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    if (parts[2] === "addMessage") return Response.json({});
    if (method === "POST" && parts.length === 1) {
      const key = `${parts[0]}/${String(body!.id)}`;
      if (resources.has(key)) return Response.json({ error: { code: 409 } }, { status: 409 });
      resources.set(key, body);
      return Response.json(body);
    }
    const existing = resources.get(path) as Record<string, unknown> | undefined;
    if (!existing) return Response.json({ error: { code: 404 } }, { status: 404 });
    if (method === "PATCH") {
      const merged = { ...existing, ...body };
      resources.set(path, merged);
      return Response.json(merged);
    }
    return Response.json(existing);
  }) as unknown as typeof fetch;
  return { fetch: fn, resources, calls };
}

/// The Google provider over the fake API with a runtime RSA service account.
export function googleProvider(origin: string) {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const api = fakeGoogleFetch();
  const client = googleWalletClient({
    serviceAccount: { client_email: "issuer@e2e.iam.gserviceaccount.com", private_key: privateKey },
    issuerId: "3388000000012345678",
    fetch: api.fetch,
  });
  return { provider: googleFormatProvider({ client, classSuffix: `e2e_${randomBytes(3).toString("hex")}`, origins: [origin] }), api };
}

/// Poll until `check` holds, for effects that arrive through a watcher.
export async function eventually(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("condition not met in time");
}
