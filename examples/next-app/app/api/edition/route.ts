import { getAddress, isAddress } from "viem";

import { editionAbi, getEditionRuntime, STAMPS_PER_DAY } from "@/lib/edition";
import { json } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/// Public state of the edition, and of one account's holding when `account`
/// is given. Everything here is readable by anyone from the chain, except
/// the stamp count, which is the issuer's own and is not secret.
/// POST runs the catch-up a watcher would do (throttled to once a minute).
export async function GET(request: Request): Promise<Response> {
  const ed = await getEditionRuntime().catch((e: Error) => e);
  if (ed instanceof Error) return json({ error: "internal_error", message: ed.message }, { status: 500 });
  if (!ed) return json({ error: "not_found", message: "No edition is configured" }, { status: 404 });
  const account = new URL(request.url).searchParams.get("account");
  if (account && !isAddress(account)) return json({ error: "invalid_request", message: "account must be an address" }, { status: 400 });

  const { publicClient } = ed.rt;
  const base = { address: ed.edition.contract, abi: editionAbi } as const;
  const id = ed.edition.id;
  const [supply, limit, open] = await Promise.all([
    publicClient.readContract({ ...base, functionName: "totalSupply", args: [id] }),
    publicClient.readContract({ ...base, functionName: "claimLimit" }),
    publicClient.readContract({ ...base, functionName: "open", args: [id] }),
  ]);
  let holder = null;
  if (account) {
    const who = getAddress(account);
    const [balance, claimed, gas, stamps] = await Promise.all([
      publicClient.readContract({ ...base, functionName: "balanceOf", args: [who, id] }),
      publicClient.readContract({ ...base, functionName: "claimed", args: [id, who] }),
      publicClient.getBalance({ address: who }),
      ed.stamps(who),
    ]);
    holder = { account: who, balance, claimed, hasGas: gas > 0n, stamps };
  }
  return json({ contract: ed.edition.contract, id, supply, claimLimit: limit, open, stampsPerDay: STAMPS_PER_DAY, passUri: ed.issuer.passUri(id.toString()), holder });
}

export async function POST(): Promise<Response> {
  const ed = await getEditionRuntime().catch((e: Error) => e);
  if (ed instanceof Error) return json({ error: "internal_error", message: ed.message }, { status: 500 });
  if (!ed) return json({ error: "not_found", message: "No edition is configured" }, { status: 404 });
  const result = await ed.sync();
  return json(result ?? { skipped: "synced within the last minute" });
}
