import { getAddress, isAddress, isAddressEqual, type Address, type PublicClient } from "viem";

import type { PetState } from "@/lib/pet";
import { petPassAbi } from "@/lib/petAbi";
import { getRuntime, json, readPet } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A node allows only so many blocks in one log query (the public node this
// demo runs on: ten million), and a chain that makes several blocks a second
// outgrows that in weeks. So the scan walks the range in spans, and makes
// the span smaller when a node refuses it. The number of queries is capped
// so that one request can never turn into an endless scan.
const FIRST_SPAN = 5_000_000n;
const SMALLEST_SPAN = 2_000n;
const MAX_QUERIES = 40;

/// The ids of every pet ever transferred to `who`, from Transfer logs between
/// `fromBlock` and the head.
async function transferredTo(publicClient: PublicClient, contract: Address, who: Address, fromBlock: bigint): Promise<bigint[]> {
  const head = await publicClient.getBlockNumber();
  const ids = new Set<bigint>();
  let span = FIRST_SPAN;
  let from = fromBlock;
  for (let queries = 0; from <= head; queries++) {
    if (queries >= MAX_QUERIES) throw new Error("the Transfer log scan needed too many queries");
    const to = from + span - 1n < head ? from + span - 1n : head;
    try {
      const logs = await publicClient.getContractEvents({ address: contract, abi: petPassAbi, eventName: "Transfer", args: { to: who }, fromBlock: from, toBlock: to });
      for (const log of logs) if (log.args.tokenId !== undefined) ids.add(log.args.tokenId);
      from = to + 1n;
    } catch (e) {
      if (span <= SMALLEST_SPAN) throw e;
      span = span / 4n > SMALLEST_SPAN ? span / 4n : SMALLEST_SPAN;
    }
  }
  return [...ids];
}

/// The pets an address holds now. PetPass is not enumerable, so this scans
/// Transfer logs into the address since the deploy block and keeps the ids
/// whose current owner is still that address. A production app would use an
/// indexer.
export async function GET(request: Request): Promise<Response> {
  const owner = new URL(request.url).searchParams.get("owner");
  if (!owner || !isAddress(owner)) return json({ error: "invalid_request", message: "owner must be an address" }, { status: 400 });
  const rt = await getRuntime().catch((e: Error) => e);
  if (rt instanceof Error) return json({ error: "internal_error", message: rt.message }, { status: 500 });

  const who = getAddress(owner);
  try {
    const ids = await transferredTo(rt.publicClient, rt.config.contract, who, rt.config.deployBlock);
    const states = await Promise.all(ids.map((id) => readPet(rt.publicClient, rt.config.contract, id)));
    const pets = states
      .filter((p): p is PetState => p !== null && isAddressEqual(p.owner as `0x${string}`, who))
      .sort((a, b) => Number(BigInt(a.tokenId) - BigInt(b.tokenId)));
    return json({ owner: who, pets });
  } catch (e) {
    console.warn(`[passes] ${(e as Error).message.split("\n")[0]}`);
    return json({ error: "read_failed", message: "The chain could not be read. Try again in a moment." }, { status: 503, headers: { "retry-after": "5" } });
  }
}
