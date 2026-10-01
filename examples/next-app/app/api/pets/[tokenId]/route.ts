import { getRuntime, json, readPet, syncAfter } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/// Public on-chain state of one pet: the same reads anyone can take, and no
/// acquisition URL or link (those only leave the issuer behind a proof).
export async function GET(_request: Request, { params }: { params: Promise<{ tokenId: string }> }): Promise<Response> {
  const { tokenId } = await params;
  if (!/^[0-9]{1,78}$/.test(tokenId)) return json({ error: "invalid_token" }, { status: 400 });
  const rt = await getRuntime().catch((e: Error) => e);
  if (rt instanceof Error) return json({ error: "internal_error", message: rt.message }, { status: 500 });
  syncAfter(rt);
  const pet = await readPet(rt.publicClient, rt.config.contract, BigInt(tokenId));
  if (!pet) return json({ error: "not_found" }, { status: 404 });
  return json({ pet, passUri: rt.issuer.passUri(tokenId) });
}
