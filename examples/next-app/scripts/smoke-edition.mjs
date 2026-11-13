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
  const link = (key) => preview.body?.links?.find((l) => l.key === key)?.url;
  return { manifest: r.manifest, content: preview.body, yes: link("vote-yes"), no: link("vote-no") };
};
const refusal = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
};
const state = async (who) => (await getJson(`${BASE}/api/edition${who ? `?account=${who.address}` : ""}`)).body;
/// Open a demo proposal, waiting out the gap the demo keeps between them,
/// then wait until the contract accepts votes on it.
const openProposal = async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await post(`${BASE}/api/edition/proposal`);
    if (r.res.ok) {
      const pid = r.body.proposal.proposalId;
      await until(async () => {
        const p = (await state()).proposal;
        return p?.proposalId === pid && p.votable;
      }, 30_000, 1000);
      return pid;
    }
    if (r.res.status !== 429 || !r.body?.retryAfter) throw new Error(`could not open a proposal: HTTP ${r.res.status} ${JSON.stringify(r.body)}`);
    console.log(`      (waiting ${r.body.retryAfter}s: the demo keeps a gap between proposals)`);
    await new Promise((res) => setTimeout(res, (r.body.retryAfter + 2) * 1000));
  }
  throw new Error("could not open a proposal");
};
console.log(`Edition ${id} at ${contract} on chain ${chain.id}, issuer ${BASE}`);
console.log(`A ${alice.address}\nB ${bob.address}`);

// 1. The contract side.
const supports = (iid) => publicClient.readContract({ address: contract, abi, functionName: "supportsInterface", args: [iid] });
step((await supports("0xef5f1e71")) && (await supports("0xd9b67a26")) && !(await supports("0x80ac58cd")), "contract is ERC-1155 and answers the ERC-8426 interface id 0xef5f1e71");

// 2. A ends up with exactly 3 units and B with none, so the run starts clean.
const startB = await balance(bob);
if (startB > 0n) await write(bob, "safeTransferFrom", [bob.address, alice.address, id, startB, "0x"]);
let startA = await balance(alice);
if (startA < 3n) await write(alice, "claim", [id, 3n - startA]);
if (startA > 3n) await write(alice, "safeTransferFrom", [alice.address, "0x000000000000000000000000000000000000dEaD", id, startA - 3n, "0x"]);
step(await settled(alice, 3n), "A holds 3 units, B holds none");
const passUri = await passes.getPassURI(token);
step(passUri === `${BASE}/edition-pass/${id}`, "passURI points at the edition issuer", passUri);

// 3. Gated: no proof, no URLs.
const bare = await getJson(passUri);
step(bare.res.status === 401 && bare.body.error === "proof_required", "manifest without proof is 401 proof_required");
const challenge = await passes.requestChallenge(token, "acquire", alice.address);
step(parseChallenge(challenge.message)?.token?.standard === "erc1155" && challenge.message.toLowerCase().includes(`/erc1155:${contract.toLowerCase()}/${id}`), "the challenge names the token under erc1155");

// 4. A proposal opens: the snapshot is now, with A holding 3 and B none.
const p1 = await openProposal();
step(Boolean(p1), "a proposal opened", `proposal ${p1}`);
const a1 = await manifestOf(alice);
step(typeof a1.yes === "string" && a1.yes.endsWith(`?p=${p1}`) && typeof a1.no === "string", "A's pass carries vote links that name the proposal");
const bareLink = await post(a1.yes.split("?")[0]);
step(bareLink.res.status === 400 && bareLink.body?.error === "proposal_required", "a vote link that names no proposal does nothing: 400 proposal_required", `HTTP ${bareLink.res.status} ${bareLink.body?.error ?? ""}`);
const confirm = await fetch(a1.yes, { headers: { accept: "text/html" } });
const confirmHtml = await confirm.text();
step(confirm.status === 200 && confirmHtml.includes(`Proposal ${p1}`) && (await state(alice)).holder.ballot.choice === "none", "opening the link shows which proposal it is for and votes nothing");
step((await state(alice)).holder.ballot.power === "3", "A has 3 votes on it (its balance at the snapshot)");
const bNone = await refusal(() => passes.getManifest(token, { signer: bob }));
step(bNone?.status === 403 && bNone?.code === "not_owner", "B holds none: 403 not_owner", `${bNone?.status} ${bNone?.code}`);

// 5. The cheat: move a unit to a second account after the snapshot and vote
// with it there too.
await sendUnits(alice, bob, 1n);
const a2 = await manifestOf(alice);
step(a2.yes === a1.yes && a2.no === a1.no, "A sent 1 and still holds: its links are unchanged");
const b1 = await manifestOf(bob);
step(Boolean(b1.manifest.formats.preview) && !b1.yes && !b1.no, "B gets its own pass, with no vote links: it held nothing at the snapshot");
const bVote = await refusal(() => passes.signedAction({ token, action: "vote-yes", signer: bob, params: { proposalId: p1 } }));
step(bVote?.status === 409 && bVote?.serverCode === "no_voting_power", "B's signed vote with the moved unit is refused: no_voting_power", `${bVote?.status} ${bVote?.serverCode ?? bVote?.code}`);

// 6. A votes from the pass link. It weighs 3: what A held at the snapshot,
// though A holds 2 now.
const linkYes = await post(a1.yes);
step(linkYes.res.status === 200, "A votes yes with the pass link (no signature)", `HTTP ${linkYes.res.status} ${linkYes.body?.error ?? ""}`);
let p = (await state(alice)).proposal;
step(p.yes === "3" && p.no === "0", "the vote weighs 3, the snapshot balance", `yes ${p.yes}, no ${p.no}`);
const linkNo = await post(a1.no);
step(linkNo.res.status === 409 && linkNo.body?.error === "already_voted", "a link cannot change the vote: 409 already_voted", `HTTP ${linkNo.res.status} ${linkNo.body?.error ?? ""}`);
const a3 = await manifestOf(alice);
step(!a3.yes && !a3.no, "after voting, A's pass no longer shows vote links");

// 7. The holder disagrees with what the link did, and signs.
const signedNo = await refusal(() => passes.signedAction({ token, action: "vote-no", signer: alice, params: { proposalId: p1 } }));
step(signedNo === null, "A replaces the link vote with a signed vote", signedNo ? `${signedNo.status} ${signedNo.serverCode ?? signedNo.code}` : "200");
p = (await state(alice)).proposal;
step(p.yes === "0" && p.no === "3", "the tally moved with it", `yes ${p.yes}, no ${p.no}`);
const again = await refusal(() => passes.signedAction({ token, action: "vote-yes", signer: alice, params: { proposalId: p1 } }));
step(again?.status === 409 && again?.serverCode === "already_voted", "a signed vote is final: 409 already_voted", `${again?.status} ${again?.serverCode ?? again?.code}`);
const b = (await state(alice)).holder.ballot;
step(b.choice === "no" && b.signed === true, "the chain records A's vote as No, signed");

// 8. A sends the rest: the fresh read refuses at once, then the links are retired.
await sendUnits(alice, bob, 2n);
const gone = await post(a1.yes);
step(gone.res.status === 403 || gone.res.status === 404, "A holds none: its link is refused", `HTTP ${gone.res.status} ${gone.body?.error ?? ""}`);
const aNone = await refusal(() => passes.getManifest(token, { signer: alice }));
step(aNone?.status === 403 && aNone?.code === "not_owner", "A's signature is refused too: 403 not_owner");
const retired = await until(async () => {
  await post(`${BASE}/api/edition`);
  return (await post(a1.yes)).res.status === 404;
}, 100_000, 5000);
step(retired, "the issuer caught up and retired A's links (404)");

// 9. A new proposal: now B holds 3 and A none.
const p2 = await openProposal();
step(Boolean(p2) && p2 !== p1, "a second proposal opened", `proposal ${p2}`);
const b2 = await manifestOf(bob);
step(typeof b2.yes === "string" && (await state(bob)).holder.ballot.power === "3", "B has 3 votes on the new proposal, and vote links");

// 10. A holder resets its own links, and only its own.
const aRotate = await refusal(() => passes.rotatePassLinks(token, { signer: alice }));
step(aRotate?.status === 403, "A, holding none, cannot reset anything", `${aRotate?.status} ${aRotate?.code}`);
await passes.rotatePassLinks(token, { signer: bob });
const oldB = await post(b2.yes);
step(oldB.res.status === 404, "B reset its links: the old one is 404 and did not vote", `HTTP ${oldB.res.status}`);
const b3 = await manifestOf(bob);
step(typeof b3.yes === "string" && b3.yes !== b2.yes, "B's next claim carries new links");
const bLink = await fetch(b3.yes, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const bTap2 = await fetch(b3.yes, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
p = (await state(bob)).proposal;
step(bLink.status === 200 && bTap2.status === 200 && bTap2.headers.get("x-wallet-pass-repeat") === "true" && p.yes === "3", "B votes with the new link; a double tap counts once", `HTTP ${bLink.status}/${bTap2.status}, yes ${p.yes}`);

// 11. Coming back is a first claim, never the retired links.
await sendUnits(bob, alice, 1n);
const a4 = await manifestOf(alice);
step(a4.content.serial !== a1.content.serial, "A holds again: a new pass, not the retired one");
step((await post(a1.yes)).res.status === 404, "A's retired link stays retired");
const lateVote = await refusal(() => passes.signedAction({ token, action: "vote-yes", signer: alice, params: { proposalId: p2 } }));
step(lateVote?.status === 409 && lateVote?.serverCode === "no_voting_power", "A's returned unit carries no vote on the open proposal", `${lateVote?.status} ${lateVote?.serverCode ?? lateVote?.code}`);
p = (await state()).proposal;
step(BigInt(p.yes) + BigInt(p.no) <= 3n, "votes on the proposal never exceed the units that existed at its snapshot", `yes ${p.yes}, no ${p.no}`);

console.log(failures === 0 ? "\nAll edition checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
