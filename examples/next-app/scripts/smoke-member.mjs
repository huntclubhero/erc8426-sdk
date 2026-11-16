// Headless end-to-end check of the member pass (the "go dark and come back"
// case of the ERC-1155 binding draft) on a running instance. One line per step.
//
//   node scripts/smoke-member.mjs      (local: reads .env.local, makes and funds a key on anvil)
//
// Against a deployed instance on a testnet, give it one funded throwaway key
// that can still claim 2 units (a fresh key can):
//   BASE=https://... RPC_URL=... CHAIN_ID=... SMOKE_KEY_A=0x... node scripts/smoke-member.mjs

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createWalletPassClient } from "@erc8426/client";

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, "..", ".env.local");
const env = existsSync(envPath)
  ? Object.fromEntries(
      readFileSync(envPath, "utf8")
        .split(/\r?\n/)
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    )
  : {};
for (const k of ["RPC_URL", "CHAIN_ID", "NEXT_PUBLIC_BASE_URL"]) if (process.env[k]) env[k] = process.env[k];
const BASE = (process.env.BASE ?? env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const chain = defineChain({ id: Number(env.CHAIN_ID), name: "smoke", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [env.RPC_URL] } } });
const publicClient = createPublicClient({ chain, transport: http(env.RPC_URL), pollingInterval: 500 });
const passes = createWalletPassClient({ publicClient });
const local = chain.id === 31337;

const abi = parseAbi([
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function claim(uint256 id, uint256 amount)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)",
  "function supportsInterface(bytes4 id) view returns (bool)",
  "function passURI(uint256 id) view returns (string)",
]);
const AWAY = "0x000000000000000000000000000000000000dEaD";

let failures = 0;
const step = (ok, label, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};
const getJson = async (url, init) => {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { res, body };
};
const until = async (check, timeoutMs, everyMs = 500) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, everyMs));
  }
};

const keyA = process.env.SMOKE_KEY_A ?? (local ? generatePrivateKey() : null);
if (!keyA) {
  console.error("On a public chain set SMOKE_KEY_A to a funded throwaway key.");
  process.exit(2);
}
const alice = privateKeyToAccount(keyA);
const wallet = createWalletClient({ account: alice, chain, transport: http(env.RPC_URL) });
if (local) await publicClient.request({ method: "anvil_setBalance", params: [alice.address, toHex(parseEther("1"))] });

const info = await getJson(`${BASE}/api/member`);
if (!info.res.ok) {
  console.error(`No member pass on ${BASE} (HTTP ${info.res.status}).`);
  process.exit(2);
}
const contract = info.body.contract;
const id = BigInt(info.body.id);
const token = { contract, tokenId: id.toString() };
console.log(`Member pass ${id} at ${contract} on chain ${chain.id}, issuer ${BASE}\nA ${alice.address}`);

const balance = () => publicClient.readContract({ address: contract, abi, functionName: "balanceOf", args: [alice.address, id] });
const write = async (functionName, args) => {
  const hash = await wallet.writeContract({ address: contract, abi, functionName, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
};
const state = async () => (await getJson(`${BASE}/api/member?account=${alice.address}`)).body.holder;
const check = () => getJson(`${BASE}/api/member`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: alice.address }) });
const refusal = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
};
const preview = async (manifest) => {
  const res = await fetch(manifest.formats.preview, { headers: { accept: "application/json" } });
  return { status: res.status, content: res.ok ? await res.json() : null };
};
const fieldOf = (content, key) => [...(content.primary ?? []), ...(content.secondary ?? [])].find((f) => f.key === key)?.value;

// 1. The contract and where it points.
const [is1155, isPass] = await Promise.all([
  publicClient.readContract({ address: contract, abi, functionName: "supportsInterface", args: ["0xd9b67a26"] }),
  publicClient.readContract({ address: contract, abi, functionName: "supportsInterface", args: ["0xef5f1e71"] }),
]);
step(is1155 && isPass, "contract is ERC-1155 and answers the ERC-8426 interface id 0xef5f1e71");

// 2. Nothing for an account that holds none.
const none = await refusal(() => passes.getManifest(token, { signer: alice }));
// 403 from the issuer, or the client finding no pass at all: passURI throws
// for an id nobody holds yet.
step(none !== null, "holding none: no manifest", `${none?.status ?? "client"} ${none?.serverCode ?? none?.code}`);

// 3. Claim, unlock.
await write("claim", [id, 1n]);
await until(async () => (await balance()) === 1n, 30_000);
// passURI throws for an id nobody holds, so it is read once a unit exists.
const uri = await publicClient.readContract({ address: contract, abi, functionName: "passURI", args: [id] });
step(uri === `${BASE}/member-pass/${id}`, "passURI points at the member issuer", uri);
const first = await passes.getManifest(token, { signer: alice });
const live = await preview(first.manifest);
step(live.status === 200 && fieldOf(live.content, "status") === "Active", "holding one: the pass is live", `status ${live.content ? fieldOf(live.content, "status") : live.status}`);
step((live.content?.links ?? []).length === 0, "the pass carries no links");
const serial = live.content?.serial;
const before = await state();
step(Boolean(before.pass) && before.pass.dark === false && before.pass.serial === serial, "the issuer has a live pass on record for A");

// 4. Send the unit away: dark, not retired.
await write("safeTransferFrom", [alice.address, AWAY, id, 1n, "0x"]);
await until(async () => (await balance()) === 0n, 30_000);
const went = await check();
step(went.res.ok && went.body.dark === true, "A holds none: the issuer read the balance and took the pass dark", JSON.stringify(went.body));
const darkState = await state();
step(Boolean(darkState.pass) && darkState.pass.dark === true && darkState.pass.serial === serial, "the pass is dark and kept its serial (it was not retired)");
const oldDownload = await preview(first.manifest);
step(oldDownload.status === 404, "its download address from before was replaced", `HTTP ${oldDownload.status}`);
const whileDark = await refusal(() => passes.getManifest(token, { signer: alice }));
step(whileDark?.status === 403, "while dark the manifest is refused", `${whileDark?.status} ${whileDark?.serverCode ?? whileDark?.code}`);
const again = await check();
step(again.res.ok && again.body.dark === false && again.body.revived === false && again.body.pass?.dark === true, "a second read changes nothing: still dark");

// 5. Hold again: the same card comes back.
await write("claim", [id, 1n]);
await until(async () => (await balance()) === 1n, 30_000);
const back = await check();
step(back.res.ok && back.body.revived === true, "A holds again: the issuer brought the pass back", JSON.stringify(back.body));
const second = await passes.getManifest(token, { signer: alice });
const revived = await preview(second.manifest);
step(revived.status === 200 && fieldOf(revived.content, "status") === "Active", "the pass is live again", `status ${revived.content ? fieldOf(revived.content, "status") : revived.status}`);
step(revived.content?.serial === serial, "it is the same pass: the serial did not change", `${serial} then ${revived.content?.serial}`);
step(second.manifest.formats.preview !== first.manifest.formats.preview, "with new download addresses");
const stillOld = await preview(first.manifest);
step(stillOld.status === 404, "the first download address stays dead", `HTTP ${stillOld.status}`);

console.log(failures === 0 ? "\nAll member pass checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
