// Local mode: start anvil, deploy PetPass, appoint the operator, and write
// .env.local for the Next.js app. Keeps anvil running until Ctrl+C.
//
// If something already answers on the RPC port, it deploys to that chain
// instead and exits, so a rerun against a running anvil just redeploys.
//
// Env overrides: ANVIL_BIN, ANVIL_PORT (8545), NEXT_PUBLIC_BASE_URL
// (http://localhost:3000), LAPSE_SECONDS (259200, three days).

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const envPath = join(appDir, ".env.local");
const require = (await import("node:module")).createRequire(import.meta.url);
const artifact = JSON.parse(readFileSync(require.resolve("@erc8426/contracts/artifacts/PetPass.json"), "utf8"));

const port = Number(process.env.ANVIL_PORT ?? 8545);
const rpcUrl = `http://127.0.0.1:${port}`;
const baseUrl = (process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const lapseSeconds = BigInt(process.env.LAPSE_SECONDS ?? 3 * 24 * 3600);

function anvilBinary() {
  if (process.env.ANVIL_BIN) return process.env.ANVIL_BIN;
  const exe = process.platform === "win32" ? "anvil.exe" : "anvil";
  const foundry = join(homedir(), ".foundry", "bin", exe);
  return existsSync(foundry) ? foundry : "anvil";
}

async function rpcAnswers() {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    const body = await res.json();
    return typeof body.result === "string" ? Number(body.result) : null;
  } catch {
    return null;
  }
}

async function waitForRpc(timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const id = await rpcAnswers();
    if (id !== null) return id;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`anvil did not answer on ${rpcUrl} within ${timeoutMs / 1000}s`);
}

/// Rewrite the managed keys of .env.local and keep every other line, so
/// Apple and Google credentials added by hand survive a redeploy.
function writeEnv(values) {
  const keep = existsSync(envPath)
    ? readFileSync(envPath, "utf8")
        .split(/\r?\n/)
        .filter((line) => {
          const key = line.split("=")[0]?.trim();
          return line.trim() !== "" && !(key in values) && !line.startsWith("# Written by scripts/chain.mjs");
        })
    : [];
  const managed = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  writeFileSync(envPath, ["# Written by scripts/chain.mjs. Local anvil only; never reuse this key.", ...managed, ...keep, ""].join("\n"));
}

let anvil = null;
const existing = await rpcAnswers();
if (existing === null) {
  const bin = anvilBinary();
  console.log(`Starting ${bin} on port ${port}...`);
  anvil = spawn(bin, ["--port", String(port), "--chain-id", "31337", "--silent"], { stdio: ["ignore", "inherit", "inherit"] });
  anvil.on("error", (e) => {
    console.error(`Could not start anvil (${e.message}). Install Foundry (https://getfoundry.sh) or set ANVIL_BIN.`);
    process.exit(1);
  });
  anvil.on("exit", (code) => {
    console.log(`anvil exited (${code ?? "signal"})`);
    process.exit(code ?? 0);
  });
  await waitForRpc();
} else {
  console.log(`An RPC already answers on ${rpcUrl} (chain ${existing}); deploying to it.`);
}

const chainId = await waitForRpc();
const chain = defineChain({
  id: chainId,
  name: "Local anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

// A fresh operator for every deploy, generated here and written only to the
// gitignored .env.local. It owns the collection and is its action operator.
const operatorKey = generatePrivateKey();
const operator = privateKeyToAccount(operatorKey);
await publicClient.request({ method: "anvil_setBalance", params: [operator.address, toHex(parseEther("1000"))] });
const wallet = createWalletClient({ account: operator, chain, transport: http(rpcUrl) });

const passBaseUri = `${baseUrl}/wallet-pass/`;
console.log(`Deploying PetPass with passURI base ${passBaseUri} ...`);
const deployHash = await wallet.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  args: [passBaseUri, operator.address, lapseSeconds],
});
const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
const contract = receipt.contractAddress;
if (!contract) throw new Error("deployment produced no contract address");

// The operator relays capability actions, so it must be an action operator
// for BoundedAction; every relayed care is then held to the on-chain bound.
const opHash = await wallet.writeContract({
  address: contract,
  abi: artifact.abi,
  functionName: "setActionOperator",
  args: [operator.address, true],
});
await publicClient.waitForTransactionReceipt({ hash: opHash });

writeEnv({
  RPC_URL: rpcUrl,
  CHAIN_ID: String(chainId),
  CONTRACT_ADDRESS: contract,
  DEPLOY_BLOCK: String(receipt.blockNumber),
  OPERATOR_PRIVATE_KEY: operatorKey,
  NEXT_PUBLIC_BASE_URL: baseUrl,
  DEV_WALLET: "1",
});

console.log("");
console.log(`PetPass    ${contract}`);
console.log(`Operator   ${operator.address}`);
console.log(`Chain      ${chainId} at ${rpcUrl}`);
console.log(`Wrote      ${envPath}`);
console.log("");
if (anvil) {
  console.log("Chain ready. In another terminal run: pnpm dev   (Ctrl+C here stops anvil)");
  const stop = () => {
    anvil.kill();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} else {
  console.log("Done. Restart pnpm dev so it picks up the new contract.");
}
