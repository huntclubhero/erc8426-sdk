import { getAddress, isAddress, isAddressEqual } from "viem";

import type { PetState } from "@/lib/pet";
import { petPassAbi } from "@/lib/petAbi";
import { getRuntime, json, readPet } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/// The pets an address holds now. PetPass is not enumerable, so this scans
/// Transfer logs into the address since the deploy block and keeps the ids
/// whose current owner is still that address. A production app would use an
/// indexer.
export async function GET(request: Request): Promise<Response> {
  const owner = new URL(request.url).searchParams.get("owner");
  if (!owner || !isAddress(owner)) return json({ error: "invalid_address" }, { status: 400 });
  const rt = await getRuntime().catch((e: Error) => e);
  if (rt instanceof Error) return json({ error: "internal_error", message: rt.message }, { status: 500 });

  const who = getAddress(owner);
  const logs = await rt.publicClient.getContractEvents({
    address: rt.config.contract,
    abi: petPassAbi,
    eventName: "Transfer",
    args: { to: who },
    fromBlock: rt.config.deployBlock,
    toBlock: "latest",
  });
  const ids = [...new Set(logs.map((l) => l.args.tokenId).filter((id): id is bigint => id !== undefined))];
  const states = await Promise.all(ids.map((id) => readPet(rt.publicClient, rt.config.contract, id)));
  const pets = states
    .filter((p): p is PetState => p !== null && isAddressEqual(p.owner as `0x${string}`, who))
    .sort((a, b) => Number(BigInt(a.tokenId) - BigInt(b.tokenId)));
  return json({ owner: who, pets });
}
