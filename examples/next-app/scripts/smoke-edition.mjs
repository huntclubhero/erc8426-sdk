// Headless end-to-end check of the ERC-1155 edition (working draft of the
// ERC-1155 binding) on a running instance. One line per step.
//
//   node scripts/smoke-edition.mjs      (local: reads .env.local, makes and funds two keys on anvil)
//
// Against a deployed instance on a testnet, give it two funded throwaway
// keys, since claiming and sending are the accounts' own transactions:
//   BASE=https://... RPC_URL=... CHAIN_ID=... SMOKE_KEY_A=0x... SMOKE_KEY_B=0x... node scripts/smoke-edition.mjs
// Account A must still be able to claim 3 units (a fresh key can).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseChallenge } from "@erc8426/core";
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
const chain = defineChain({
  id: Number(env.CHAIN_ID),
  name: "smoke",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env.RPC_URL] } },
});
const publicClient = createPublicClient({ chain, transport: http(env.RPC_URL), pollingInterval: 500 });
const passes = createWalletPassClient({ publicClient });
const local = chain.id === 31337;

const abi = parseAbi([
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function claim(uint256 id, uint256 amount)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)",
  "function supportsInterface(bytes4 id) view returns (bool)",
]);

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
const post = (url, body) => getJson(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body ?? {}) });
const until = async (check, timeoutMs, everyMs = 1500) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, everyMs));
  }
};

const keyA = process.env.SMOKE_KEY_A ?? (local ? generatePrivateKey() : null);
const keyB = process.env.SMOKE_KEY_B ?? (local ? generatePrivateKey() : null);
if (!keyA || !keyB) {
  console.error("On a public chain set SMOKE_KEY_A and SMOKE_KEY_B to two funded throwaway keys.");
  process.exit(2);
}
const alice = privateKeyToAccount(keyA);
const bob = privateKeyToAccount(keyB);
const walletOf = (account) => createWalletClient({ account, chain, transport: http(env.RPC_URL) });
if (local) {
  for (const a of [alice, bob]) await publicClient.request({ method: "anvil_setBalance", params: [a.address, toHex(parseEther("1"))] });
}

// 0. The instance serves an edition.
const info = await getJson(`${BASE}/api/edition`);
if (!info.res.ok) {
  console.error(`No edition on ${BASE} (HTTP ${info.res.status}).`);
  process.exit(2);
}
const contract = info.body.contract;
const id = BigInt(info.body.id);
const token = { contract, tokenId: id.toString() };
const balance = (who) => publicClient.readContract({ address: contract, abi, functionName: "balanceOf", args: [who.address, id] });
const settled = (who, n) => until(async () => (await balance(who)) === n, 30_000, 500);
const write = async (from, functionName, args) => {
  const hash = await walletOf(from).writeContract({ address: contract, abi, functionName, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  return receipt;
};
const sendUnits = async (from, to, amount) => {
  const [a, b] = [await balance(from), await balance(to)];
  await write(from, "safeTransferFrom", [from.address, to.address, id, amount, "0x"]);
  await settled(from, a - amount);
  await settled(to, b + amount);
  // What a watcher would do; throttled on a hosted instance.
  await post(`${BASE}/api/edition`);
};
const manifestOf = async (who) => {
  const r = await passes.getManifest(token, { signer: who });
  const preview = await getJson(r.manifest.formats.preview, { headers: { accept: "application/json" } });
  return { manifest: r.manifest, content: preview.body, link: preview.body?.links?.find((l) => l.key === "stamp")?.url };
};
const refusal = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
};
console.log(`Edition ${id} at ${contract} on chain ${chain.id}, issuer ${BASE}`);
console.log(`A ${alice.address}\nB ${bob.address}`);

// 1. The contract side.
const supports = (iid) => publicClient.readContract({ address: contract, abi, functionName: "supportsInterface", args: [iid] });
step((await supports("0xef5f1e71")) && (await supports("0xd9b67a26")) && !(await supports("0x80ac58cd")), "contract is ERC-1155 and answers the ERC-8426 interface id 0xef5f1e71");

// 2. A claims three units; B is emptied into A so the run starts clean.
const startB = await balance(bob);
if (startB > 0n) await write(bob, "safeTransferFrom", [bob.address, alice.address, id, startB, "0x"]);
const startA = await balance(alice);
if (startA < 3n) await write(alice, "claim", [id, 3n - startA]);
step((await settled(alice, startA < 3n ? 3n : startA + startB)) && (await balance(alice)) >= 3n, "A holds at least 3 units", `${await balance(alice)}`);
const passUri = await passes.getPassURI(token);
step(passUri === `${BASE}/edition-pass/${id}`, "passURI points at the edition issuer", passUri);

// 3. Gated: no proof, no URLs.
const bare = await getJson(passUri);
step(bare.res.status === 401 && bare.body.error === "proof_required", "manifest without proof is 401 proof_required");
const challenge = await passes.requestChallenge(token, "acquire", alice.address);
step(parseChallenge(challenge.message)?.token?.standard === "erc1155" && challenge.message.toLowerCase().includes(`/erc1155:${contract.toLowerCase()}/${id}`), "the challenge names the token under erc1155");

// 4. A's pass; B, holding none, is refused.
const a1 = await manifestOf(alice);
step(Boolean(a1.manifest.formats.preview) && /unit/.test(JSON.stringify(a1.content.primary)), "A resolves its pass", JSON.stringify(a1.content.primary?.[0]?.value));
step(typeof a1.link === "string", "A's pass carries a stamp link");
const bNone = await refusal(() => passes.getManifest(token, { signer: bob }));
step(bNone?.status === 403 && bNone?.code === "not_owner", "B holds none: 403 not_owner", `${bNone?.status} ${bNone?.code}`);

// 5. Both paths to the action.
const cap = await post(a1.link);
step(cap.res.status === 200 || cap.res.status === 429, "capability link stamps (or the daily bound is reached)", `HTTP ${cap.res.status}`);
const signed = await refusal(() => passes.signedAction({ token, action: "stamp", signer: alice }));
step(signed === null || signed.status === 429, "signed stamp is accepted (or the daily bound is reached)", signed ? `${signed.status} ${signed.code}` : "200");

// 6. Send some, keep some: nothing changes for A; B gets its own pass.
const held = await balance(alice);
await sendUnits(alice, bob, 1n);
const a2 = await manifestOf(alice);
step(a2.link === a1.link, "A sent 1 and still holds: its link is unchanged");
const still = await post(a1.link);
step(still.res.status === 200 || still.res.status === 429, "A's link still works", `HTTP ${still.res.status}`);
const b1 = await manifestOf(bob);
step(typeof b1.link === "string" && b1.link !== a1.link, "B claims its own pass with its own link");

// 7. Send the rest: the fresh read refuses at once, then the link is retired.
await sendUnits(alice, bob, held - 1n);
const gone = await post(a1.link);
step(gone.res.status === 403 || gone.res.status === 404, "A holds none: its link is refused", `HTTP ${gone.res.status} ${gone.body?.error ?? ""}`);
const aNone = await refusal(() => passes.getManifest(token, { signer: alice }));
step(aNone?.status === 403 && aNone?.code === "not_owner", "A's signature is refused too: 403 not_owner");
const retired = await until(async () => {
  await post(`${BASE}/api/edition`);
  return (await post(a1.link)).res.status === 404;
}, 100_000, 5000);
step(retired, "the issuer caught up and retired A's link (404)");
const bStill = await post(b1.link);
step(bStill.res.status === 200 || bStill.res.status === 429, "B was not touched by A's loss", `HTTP ${bStill.res.status}`);

// 8. A holder resets its own links, and only its own.
const aRotate = await refusal(() => passes.rotatePassLinks(token, { signer: alice }));
step(aRotate?.status === 403, "A, holding none, cannot reset anything", `${aRotate?.status} ${aRotate?.code}`);
await passes.rotatePassLinks(token, { signer: bob });
step((await post(b1.link)).res.status === 404, "B reset its links: the old one is 404");
const b2 = await manifestOf(bob);
step(typeof b2.link === "string" && b2.link !== b1.link, "B's next claim carries a new link");

// 9. Coming back is a first claim, never the retired links.
await sendUnits(bob, alice, 1n);
const a3 = await manifestOf(alice);
step(typeof a3.link === "string" && a3.link !== a1.link, "A holds again: a new pass with a new link");
step((await post(a1.link)).res.status === 404, "A's retired link stays retired");

// 10. A double tap counts once: an identical repeat gets the first outcome.
const before = (await getJson(`${BASE}/api/edition?account=${bob.address}`)).body.holder.stamps;
const tap1 = await fetch(b2.link, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const tap2 = await fetch(b2.link, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const after = (await getJson(`${BASE}/api/edition?account=${bob.address}`)).body.holder.stamps;
step(
  tap1.status === tap2.status && tap2.headers.get("x-wallet-pass-repeat") === "true" && after - before <= 1,
  "a double tap on the link stamps once",
  `HTTP ${tap1.status}, stamps ${before} to ${after}`,
);

console.log(failures === 0 ? "\nAll edition checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
