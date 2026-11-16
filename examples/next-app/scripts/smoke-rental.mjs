// Headless end-to-end check of the rental on a running instance: an account
// loses its pass with no transfer and no event. One line per step. It waits
// for a real rental to end, so it takes about a minute.
//
//   node scripts/smoke-rental.mjs      (reads .env.local; BASE, RPC_URL, CHAIN_ID override)
//
// The renter never sends a transaction, so no funded key is needed.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, defineChain, http, parseAbi } from "viem";
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
const SECONDS = Number(process.env.RENTAL_SECONDS ?? 40);
const chain = defineChain({ id: Number(env.CHAIN_ID), name: "smoke", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [env.RPC_URL] } } });
const publicClient = createPublicClient({ chain, transport: http(env.RPC_URL), pollingInterval: 500 });
const passes = createWalletPassClient({ publicClient });
const abi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function userOf(uint256 tokenId) view returns (address)",
  "function userExpires(uint256 tokenId) view returns (uint256)",
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
const house = (body) => getJson(`${BASE}/api/rental`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const tap = (url) => getJson(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ attempt: crypto.randomUUID() }) });
const refusal = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const preview = async (manifest) => {
  const res = await fetch(manifest.formats.preview, { headers: { accept: "application/json" } });
  return { status: res.status, content: res.ok ? await res.json() : null };
};

const renter = privateKeyToAccount(generatePrivateKey());
const info = await getJson(`${BASE}/api/rental`);
if (!info.res.ok) {
  console.error(`No rental on ${BASE} (HTTP ${info.res.status}).`);
  process.exit(2);
}
const contract = info.body.contract;
console.log(`Rental at ${contract} on chain ${chain.id}, issuer ${BASE}\nrenter ${renter.address}, rental of ${SECONDS} s`);

// 1. Rent.
const rented = await house({ do: "rent", account: renter.address, seconds: SECONDS });
step(rented.res.ok && rented.body.tokenId, "the house rents a key to the renter", `key ${rented.body?.tokenId}, ${JSON.stringify(rented.body?.error ?? "ok")}`);
if (!rented.res.ok) process.exit(1);
const tokenId = rented.body.tokenId;
const token = { contract, tokenId };
const id = BigInt(tokenId);
const [owner, user, is4907] = await Promise.all([
  publicClient.readContract({ address: contract, abi, functionName: "ownerOf", args: [id] }),
  publicClient.readContract({ address: contract, abi, functionName: "userOf", args: [id] }),
  publicClient.readContract({ address: contract, abi, functionName: "supportsInterface", args: ["0xad092b5c"] }),
]);
step(is4907 && user.toLowerCase() === renter.address.toLowerCase() && owner.toLowerCase() !== renter.address.toLowerCase(), "on chain: the house owns the key, the renter is its ERC-4907 user", `owner ${owner.slice(0, 10)}`);

// 2. During the rental: the renter holds the pass, the owner does not.
const first = await passes.getManifest(token, { signer: renter });
const live = await preview(first.manifest);
const link = live.content?.links?.find((l) => l.key === "unlock")?.url;
step(live.status === 200 && Boolean(link), "during the rental the renter gets the pass, with a door link");
step(Boolean(live.content?.expiresAt), "the pass carries its check out time", String(live.content?.expiresAt));
const open1 = await tap(link);
step(open1.res.status === 200, "the door link opens the door, no signature", `HTTP ${open1.res.status}`);
const early = await house({ do: "owner-claims", tokenId });
step(early.body?.status === 403, "during the rental the owner is refused the pass (the rental is exclusive)", `HTTP ${early.body?.status} ${early.body?.error ?? ""}`);
const still = await tap(link);
step(still.res.status === 200, "and the owner's refused claim changed nothing for the renter", `HTTP ${still.res.status}`);

// 3. The rental ends: by the clock, with no transaction and no event.
const expires = Number(await publicClient.readContract({ address: contract, abi, functionName: "userExpires", args: [id] }));
const wait = Math.max(0, expires * 1000 - Date.now()) + 6000;
console.log(`      (waiting ${Math.round(wait / 1000)} s for the rental to end)`);
await sleep(wait);
const userAfter = await publicClient.readContract({ address: contract, abi, functionName: "userOf", args: [id] });
step(/^0x0+$/.test(userAfter), "the rental ended on chain: userOf is nobody, and no transaction did it", userAfter.slice(0, 10));

// 4. Before anyone observes it: what does the renter's pass still do?
const view1 = (await getJson(`${BASE}/api/rental?tokenId=${tokenId}`)).body.key;
step(view1.issuedTo === "renter", "the issuer has observed nothing yet: its record still says the pass is the renter's", view1.issuedTo);
const open2 = await tap(link);
step(open2.res.status === 403 && open2.body?.error === "not_owner", "the renter's link is refused by the fresh read at once", `HTTP ${open2.res.status} ${open2.body?.error}`);
const file2 = await preview(first.manifest);
step(file2.status === 403, "the renter's download is refused by the fresh read too", `HTTP ${file2.status}`);
const again = await refusal(() => passes.getManifest(token, { signer: renter }));
step(again?.status === 403, "the renter's own signed request is refused", `${again?.status} ${again?.serverCode ?? again?.code}`);
const view2 = (await getJson(`${BASE}/api/rental?tokenId=${tokenId}`)).body.key;
const open3 = await tap(link);
// THE QUESTION this run exists to answer: after the issuer itself has read
// the chain and refused the renter three times, are the renter's links
// retired (404), or still only refused (403)?
console.log(`      observed by three refused requests: issuer record says "${view2.issuedTo}", the renter's link now answers HTTP ${open3.res.status} ${open3.body?.error ?? ""}`);
const retiredOnRefusal = open3.res.status === 404;
step(open3.res.status === 403 || open3.res.status === 404, retiredOnRefusal ? "RESULT: the refused requests retired the renter's link (404)" : "RESULT: the refused requests did NOT retire the renter's link: still 403, the link is still known", `HTTP ${open3.res.status}`);

// 5. If nothing retired it: the same key rented to the same account again.
if (!retiredOnRefusal) {
  const re = await house({ do: "rent-again", tokenId, account: renter.address, seconds: SECONDS });
  step(re.res.ok, "the same key is rented to the same account again, the owner never having claimed", JSON.stringify(re.body?.error ?? "ok"));
  const open4 = await tap(link);
  console.log(`      the link from the FIRST rental now answers HTTP ${open4.res.status} ${open4.body?.error ?? ""}`);
  step(open4.res.status === 200 || open4.res.status === 404, open4.res.status === 200 ? "RESULT: the old link works again in the second rental (it was never retired)" : "RESULT: the old link was retired, the second rental needs a new claim", `HTTP ${open4.res.status}`);
  const expires2 = Number(await publicClient.readContract({ address: contract, abi, functionName: "userExpires", args: [id] }));
  const wait2 = Math.max(0, expires2 * 1000 - Date.now()) + 6000;
  console.log(`      (waiting ${Math.round(wait2 / 1000)} s for the second rental to end)`);
  await sleep(wait2);
}

// 6. The owner takes the key back: its first claim.
const back = await house({ do: "owner-claims", tokenId });
step(back.body?.status === 200, "after check out the owner claims its pass", `HTTP ${back.body?.status} ${back.body?.error ?? ""}`);
const view3 = (await getJson(`${BASE}/api/rental?tokenId=${tokenId}`)).body.key;
step(view3.issuedTo === "owner", "the issuer now records the pass as the owner's", view3.issuedTo);
const open5 = await tap(link);
step(open5.res.status === 404, "the renter's link is retired for good", `HTTP ${open5.res.status} ${open5.body?.error ?? ""}`);
const file5 = await preview(first.manifest);
step(file5.status === 404, "the renter's download is retired", `HTTP ${file5.status}`);

console.log(failures === 0 ? "\nAll rental checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
