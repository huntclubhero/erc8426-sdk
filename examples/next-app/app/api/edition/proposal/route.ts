import { after } from "next/server";

import { editionAbi, getEditionRuntime, PROPOSAL_SECONDS } from "@/lib/edition";
import { allowSpend } from "@/lib/limits";
import { json } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/// DEMO ONLY. Opens a new proposal for the edition's holders, so a visitor
/// who claimed after the last snapshot has something to vote on. In a real
/// deployment proposals come from governance, not from a public button.
///
/// What keeps a public button from being a weapon:
/// - One proposal is open at a time. The next opens only when this one has
///   closed, so nobody can cut a vote short, and holders are told of a new
///   proposal at most once per proposal length.
/// - Another site cannot press it through a visitor's browser (the request
///   must come from this origin).
/// - Requests are let through one at a time, so a burst opens one proposal.
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

  // A browser names the page a cross-site request came from. A request
  // with no Origin (a script, a test) is not a browser being used.
  const origin = request.headers.get("origin");
  if ((origin && origin !== new URL(rt.config.baseUrl).origin) || request.headers.get("sec-fetch-site") === "cross-site") {
    return json({ error: "forbidden_origin", message: "Proposals are opened from the demo site itself." }, { status: 400 });
  }

  const openOne = async (): Promise<Response | null> => {
    const latest = await ed.currentProposal();
    const now = Math.floor(Date.now() / 1000);
    if (!latest || latest.closes < now) return null;
    const wait = Math.max(1, latest.closes - now + 1);
    return json(
      { error: "proposal_open", message: `Proposal ${latest.proposalId} is still open. The next one can be opened in ${wait} seconds.`, retryAfter: wait, proposal: latest },
      { status: 429, headers: { "retry-after": String(wait) } },
    );
  };

  try {
    const busy = await openOne();
    if (busy) return busy;
    if (!(await ed.proposalGate())) {
      return json({ error: "proposal_open", message: "A proposal is being opened right now. Try again in a few seconds.", retryAfter: 5 }, { status: 429, headers: { "retry-after": "5" } });
    }
    // Asked again now that this request holds the gate.
    const raced = await openOne();
    if (raced) return raced;
  } catch (e) {
    console.warn(`[edition propose] ${(e as Error).message.split("\n")[0]}`);
    return json({ error: "read_failed", message: "The chain could not be read. Try again in a moment." }, { status: 503 });
  }
  if (!(await allowSpend(rt, "propose", request, 20, 400))) {
    return json({ error: "rate_limited", message: "This demo opens a limited number of proposals per visitor per day. Try again tomorrow." }, { status: 429 });
  }

  let hash: `0x${string}`;
  let blockNumber: bigint;
  try {
    const count = await rt.publicClient.readContract({ address: edition.contract, abi: editionAbi, functionName: "proposalCount" });
    const title = TITLES[Number(count % BigInt(TITLES.length))]!;
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
    blockNumber = receipt.blockNumber;
  } catch (e) {
    const message = (e as Error).message.split("\n")[0] ?? "";
    console.warn(`[edition propose] ${message}`);
    if (/VoteEditionNoSupply/.test((e as Error).message)) {
      return json({ error: "no_holders", message: "Nobody holds a unit yet. Claim one first, then open a proposal." }, { status: 409 });
    }
    return json({ error: "propose_failed", message: "The proposal transaction could not be sent. Try again in a moment." }, { status: 502 });
  }
  // The contract emitted PassUpdate(id). Where no watcher runs, fan it out
  // after the response: every issued account is read fresh and its pass is
  // pushed, once. (Where a watcher runs, it does this from the log.)
  if (!rt.config.watchers) {
    after(() => ed.announce(blockNumber).then(() => undefined, (e: Error) => console.warn(`[edition propose] fan-out: ${e.message}`)));
  }
  // currentProposal waits out the snapshot second, so this answers votable.
  return json({ proposal: await ed.currentProposal().catch(() => null), transactionHash: hash });
}
