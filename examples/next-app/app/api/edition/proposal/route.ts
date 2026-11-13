import { after } from "next/server";

import { editionAbi, getEditionRuntime, PROPOSAL_MIN_GAP_SECONDS, PROPOSAL_SECONDS } from "@/lib/edition";
import { allowSpend } from "@/lib/limits";
import { json } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/// DEMO ONLY. Opens a new proposal for the edition's holders, so a visitor
/// who claimed after the last snapshot has something to vote on. In a real
/// deployment proposals come from governance, not from a public button.
///
/// The snapshot is the moment the proposal opens. Opening one announces it
/// to every pass of the edition (PassUpdate), which is a push to every
/// holder's phone, so it is held to one every few minutes and capped per
/// visitor and per day.
const TITLES = [
  "Paint the clubhouse purple",
  "Move the meetup to Thursdays",
  "Add a second coffee machine",
  "Adopt a clubhouse cat",
  "Print the edition on a tote bag",
  "Plant a tree out front",
];

export async function POST(request: Request): Promise<Response> {
  const ed = await getEditionRuntime().catch((e: Error) => e);
  if (ed instanceof Error) return json({ error: "internal_error", message: ed.message }, { status: 500 });
  if (!ed) return json({ error: "not_found", message: "No edition is configured" }, { status: 404 });
  const { rt, edition } = ed;

  const latest = await ed.currentProposal();
  const now = Math.floor(Date.now() / 1000);
  if (latest && latest.closes >= now && now - latest.snapshot < PROPOSAL_MIN_GAP_SECONDS) {
    const wait = PROPOSAL_MIN_GAP_SECONDS - (now - latest.snapshot);
    return json(
      { error: "too_soon", message: `Proposal ${latest.proposalId} opened moments ago. A new one can be opened in ${wait} seconds.`, retryAfter: wait },
      { status: 429, headers: { "retry-after": String(wait) } },
    );
  }
  if (!(await allowSpend(rt, "propose", request, 6, 150))) {
    return json({ error: "rate_limited", message: "This demo opens a few proposals per visitor per day. Try again tomorrow." }, { status: 429 });
  }

  const title = TITLES[Number(BigInt(latest?.proposalId ?? "0") % BigInt(TITLES.length))]!;
  let hash: `0x${string}`;
  try {
    hash = await rt.withOperator(async (nonce) => {
      const { request: tx } = await rt.publicClient.simulateContract({
        account: rt.operator.account,
        address: edition.contract,
        abi: editionAbi,
        functionName: "propose",
        args: [edition.id, title, PROPOSAL_SECONDS],
      });
      return rt.operator.writeContract({ ...tx, nonce });
    });
    const receipt = await rt.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("propose reverted");
  } catch (e) {
    console.warn(`[edition propose] ${(e as Error).message.split("\n")[0]}`);
    return json({ error: "propose_failed", message: "The proposal transaction could not be sent. Try again in a moment." }, { status: 502 });
  }
  // The contract emitted PassUpdate(id). Where no watcher runs, fan it out
  // now: every issued account is read fresh and its pass is pushed.
  if (!rt.config.watchers) {
    after(() => ed.issuer.onPassUpdate(edition.id).then(() => undefined, (e: Error) => console.warn(`[edition propose] fan-out: ${e.message}`)));
  }
  return json({ proposal: await ed.currentProposal(), transactionHash: hash });
}
