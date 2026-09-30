// Headless end-to-end check of a running local instance (pnpm chain, then
// pnpm dev). Exercises the protocol over plain HTTP and viem, the way a
// wallet, a marketplace and an attacker would, and prints one line per step.
//
//   node scripts/smoke.mjs            (reads .env.local; BASE defaults to NEXT_PUBLIC_BASE_URL)
//
// Every key here is generated at runtime and thrown away.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeBase64Url } from "@erc8426/core";
import { createWalletPassClient } from "@erc8426/client";

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(here, "..", ".env.local"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const BASE = process.env.BASE ?? env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
const chain = defineChain({
  id: Number(env.CHAIN_ID),
  name: "local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env.RPC_URL] } },
});
const publicClient = createPublicClient({ chain, transport: http(env.RPC_URL) });
const passes = createWalletPassClient({ publicClient });

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

const alice = privateKeyToAccount(generatePrivateKey());
const bobKey = generatePrivateKey();
const bob = privateKeyToAccount(bobKey);

// 1. Mint through the app's API.
const minted = await post(`${BASE}/api/mint`, { to: alice.address });
const tokenId = minted.body?.tokenId;
step(minted.res.ok && tokenId, "mint via /api/mint", `token ${tokenId}`);
const token = { contract: env.CONTRACT_ADDRESS, tokenId };

// 2. The contract advertises the interface and points at this app.
step(await passes.supportsWalletPass(env.CONTRACT_ADDRESS), "supportsInterface(0xef5f1e71)");
const passUri = await passes.getPassURI(token);
step(passUri === `${BASE}/wallet-pass/${tokenId}`, "passURI points at the issuer", passUri);

// 3. Gated manifest without a proof: 401 proof_required, a challenge, no URLs.
const bare = await getJson(passUri);
step(bare.res.status === 401 && bare.body.error === "proof_required" && typeof bare.body.challenge === "string", "manifest without proof is 401 proof_required", bare.body.challenge);
step(!/pkpass|pay\.google|\/passes\//.test(JSON.stringify(bare.body)), "401 body carries no acquisition URLs");

// 4. Challenge endpoint: 400 without an address, a SIWE message with one.
const noAddr = await getJson(bare.body.challenge);
step(noAddr.res.status === 400, "challenge without address is 400");
const ch = await getJson(`${bare.body.challenge}?address=${alice.address}`);
const message = ch.body.message;
step(
  ch.res.ok && message.startsWith(`${new URL(BASE).host} wants you to sign in`) && message.includes(`eip155:${env.CHAIN_ID}/erc721:`) && message.includes("urn:wallet-pass:action:acquire"),
  "challenge is SIWE, domain is this host, token and acquire action bound",
);

// 5. Sign by hand with viem and resolve the manifest.
const signature = await alice.signMessage({ message });
const headers = { "X-Wallet-Pass-Proof": encodeBase64Url(message), "X-Wallet-Pass-Signature": signature };
const proven = await getJson(passUri, { headers });
step(proven.res.status === 200 && proven.body.formats?.preview, "signed proof resolves the manifest", Object.keys(proven.body.formats ?? {}).join(", "));
step(/no-store/.test(proven.res.headers.get("cache-control") ?? ""), "verified manifest is Cache-Control: no-store");
const replay = await getJson(passUri, { headers });
step(replay.res.status === 401, "replaying the same proof is refused (single-use nonce)", `HTTP ${replay.res.status} ${replay.body.error}`);

// 6. The preview file and its capability links.
const preview = await getJson(proven.body.formats.preview);
const links = Object.fromEntries((preview.body.links ?? []).map((l) => [l.key, l.url]));
step(preview.res.ok && links.feed && links.water && links.play, "preview file lists feed, water and play links");
const linkGet = await getJson(links.feed, { headers: { accept: "application/json" } });
step(linkGet.res.ok && linkGet.body.executed !== true, "GET on a capability link has no effect", JSON.stringify(linkGet.body).slice(0, 80));
const fed = await post(links.feed);
step(fed.res.ok, "POST a capability link feeds the pet (capability path)", `HTTP ${fed.res.status}`);

// 7. A signed action through @erc8426/client.
const watered = await passes.signedAction({ token, action: "water", signer: alice }).catch((e) => e);
step(watered.status === 200, "signed action water via client.signedAction", watered.status ? `HTTP ${watered.status}` : watered.message);

// 8. A stranger's valid proof is refused with exactly 403.
const stranger = await passes.getManifest(token, { signer: bob }).catch((e) => e);
step(stranger.status === 403 && stranger.code === "not_owner", "non-owner proof is 403 not_owner");

// 9. Transfer to bob. The dev faucet funds alice for gas (anvil only).
await post(`${BASE}/api/dev/fund`, { address: alice.address });
const aliceWallet = createWalletClient({ account: alice, chain, transport: http(env.RPC_URL) });
const hash = await aliceWallet.writeContract({
  address: env.CONTRACT_ADDRESS,
  abi: [{ type: "function", name: "transferFrom", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }], outputs: [] }],
  functionName: "transferFrom",
  args: [alice.address, bob.address, BigInt(tokenId)],
});
await publicClient.waitForTransactionReceipt({ hash });
step(true, "alice transferred the pet to bob");

// 10. The previous owner: 403 on the manifest, refusal on the old link.
const oldOwner = await passes.getManifest(token, { signer: alice }).catch((e) => e);
step(oldOwner.status === 403, "previous owner's proof is now 403", `${oldOwner.status} ${oldOwner.code}`);
const oldLink = await post(links.feed);
step(!oldLink.res.ok && oldLink.res.status !== 200, "previous owner's capability link is refused", `HTTP ${oldLink.res.status} ${oldLink.body?.error}`);

// 11. Bob claims (first claim rotates), then resets his links on request.
const bobPass = await passes.getManifest(token, { signer: bob });
step(bobPass.configuration === "gated" && bobPass.manifest.formats.preview !== proven.body.formats.preview, "new owner's first claim gets rotated URLs");
const bobPreview = await getJson(bobPass.manifest.formats.preview);
const bobFeed = bobPreview.body.links.find((l) => l.key === "feed").url;
const rotated = await passes.rotatePassLinks(token, { signer: bob });
step(rotated.status === 200, "owner-requested rotation via client.rotatePassLinks");
const afterRotate = await post(bobFeed);
step(afterRotate.res.status === 404, "a rotated link answers 404", `HTTP ${afterRotate.res.status}`);
const oldPreview = await getJson(bobPass.manifest.formats.preview);
step(oldPreview.res.status === 404, "the pre-rotation pass download answers 404", `HTTP ${oldPreview.res.status}`);
// Rotation mints a new serial and returns no manifest: the owner re-fetches
// it with a fresh acquire proof.
const afterPass = await passes.getManifest(token, { signer: bob });
const afterBody = (await getJson(afterPass.manifest.formats.preview)).body;
step(afterBody.serial && afterBody.serial !== bobPreview.body.serial, "after rotation the owner re-acquires and gets a new serial");

// 12. The documented bound holds on the capability path: 4 plays a day,
// enforced on chain by BoundedAction, then 429 bound_reached.
const fresh = await passes.getManifest(token, { signer: bob });
const freshPreview = await getJson(fresh.manifest.formats.preview);
const playLink = freshPreview.body.links.find((l) => l.key === "play").url;
const statuses = [];
for (let i = 0; i < 5; i++) statuses.push((await post(playLink)).res.status);
step(statuses.slice(0, 4).every((s) => s === 200) && statuses[4] === 429, "capability bound: 4 plays pass, the 5th is 429", statuses.join(","));

// 13. The browser RPC proxy refuses anything outside its allowlist.
const rpc = await post(`${BASE}/api/rpc`, { jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [bob.address, "0x1"] });
step(rpc.body?.error?.code === -32601, "RPC proxy refuses non-allowlisted methods");

// 14. The conformance suite, as the new owner, when it is built.
try {
  const { runConformance, formatReport } = await import("../../../packages/conformance/dist/index.js");
  const report = await runConformance({ publicClient, contract: env.CONTRACT_ADDRESS, tokenId, nonexistentTokenId: 999999, ownerPrivateKey: bobKey });
  const failed = report.checks.filter((c) => c.status === "fail");
  step(report.ok, "conformance suite: every MUST passes", `${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.warn} warn, ${report.summary.skip} skip`);
  if (failed.length) console.log(formatReport(report));
} catch (e) {
  console.log(`SKIP  conformance suite (${e.message.split("\n")[0]})`);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
