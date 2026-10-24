import { normalizeTokenId } from "@erc8426/core";

import { getRuntime, json, readPet, syncAfter } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/// Public on-chain state of one pet: the same reads anyone can take, and no
/// acquisition URL or link (those only leave the issuer behind a proof).
export async function GET(_request: Request, { params }: { params: Promise<{ tokenId: string }> }): Promise<Response> {
  const { tokenId: raw } = await params;
  // The same bound the issuer applies: a non-negative integer within uint256.
  // (A 78-digit id above uint256 max used to pass the digit check and blow
  // up in the contract read.)
  let tokenId: string;
  try {
    tokenId = normalizeTokenId(raw);
  } catch {
    return json({ error: "invalid_request", message: `invalid token id: ${raw.slice(0, 32)}` }, { status: 400 });
  }
  const rt = await getRuntime().catch((e: Error) => e);
  if (rt instanceof Error) return json({ error: "internal_error", message: rt.message }, { status: 500 });
  syncAfter(rt);
  const pet = await readPet(rt.publicClient, rt.config.contract, BigInt(tokenId));
  if (!pet) return json({ error: "unknown_capability", message: "no such pet" }, { status: 404 });
  return json({ pet, passUri: rt.issuer.passUri(tokenId) });
}
