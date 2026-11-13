import { getAddress, isAddress } from "viem";

import { editionAbi, getEditionRuntime } from "@/lib/edition";
import { json } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/// Public state of the edition and its newest proposal, and of one account's
/// holding and ballot when `account` is given. All of it is readable by
/// anyone from the chain; nothing here is gated.
/// POST runs the catch-up a watcher would do (throttled to once a minute).
export async function GET(request: Request): Promise<Response> {
  const loaded = await getEditionRuntime().catch((e: Error) => e);
  if (loaded instanceof Error) return json({ error: "internal_error", message: loaded.message }, { status: 500 });
  if (!loaded) return json({ error: "not_found", message: "No edition is configured" }, { status: 404 });
  const ed = loaded;
  const account = new URL(request.url).searchParams.get("account");
  if (account && !isAddress(account)) return json({ error: "invalid_request", message: "account must be an address" }, { status: 400 });

  const { publicClient } = ed.rt;
  const base = { address: ed.edition.contract, abi: editionAbi } as const;
  const id = ed.edition.id;
  try {
    const [supply, limit, open, proposal] = await Promise.all([
      publicClient.readContract({ ...base, functionName: "totalSupply", args: [id] }),
      publicClient.readContract({ ...base, functionName: "claimLimit" }),
      publicClient.readContract({ ...base, functionName: "open", args: [id] }),
      ed.currentProposal(),
    ]);
    let holder = null;
    if (account) {
      const who = getAddress(account);
      const [balance, claimed, gas, ballot] = await Promise.all([
        publicClient.readContract({ ...base, functionName: "balanceOf", args: [who, id] }),
        publicClient.readContract({ ...base, functionName: "claimed", args: [id, who] }),
        publicClient.getBalance({ address: who }),
        proposal ? ed.ballot(proposal.proposalId, who) : null,
      ]);
      holder = { account: who, balance, claimed, hasGas: gas > 0n, ballot };
    }
    return json({
      contract: ed.edition.contract,
      id,
      supply,
      claimLimit: limit,
      open,
      passUri: ed.issuer.passUri(id.toString()),
      proposal,
      now: Math.floor(Date.now() / 1000),
      holder,
    });
  } catch (e) {
    console.warn(`[edition] state: ${(e as Error).message.split("\n")[0]}`);
    return json({ error: "read_failed", message: "The chain could not be read. Try again in a moment." }, { status: 503, headers: { "retry-after": "5" } });
  }
}

export async function POST(): Promise<Response> {
  const ed = await getEditionRuntime().catch((e: Error) => e);
  if (ed instanceof Error) return json({ error: "internal_error", message: ed.message }, { status: 500 });
  if (!ed) return json({ error: "not_found", message: "No edition is configured" }, { status: 404 });
  try {
    const result = await ed.sync();
    return json(result ?? { skipped: "synced within the last minute" });
  } catch (e) {
    console.warn(`[edition] sync: ${(e as Error).message.split("\n")[0]}`);
    return json({ error: "read_failed", message: "The chain could not be read. Try again in a moment." }, { status: 503 });
  }
}
