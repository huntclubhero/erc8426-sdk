import { decodeEventLog, getAddress, isAddress } from "viem";

import { petPassAbi } from "@/lib/petAbi";
import { getRuntime, json } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/// Hatch a pet for `to`. PetPass.mint is owner-only, so the operator (the
/// collection owner in this example) sends it. Anyone can call this route:
/// fine for a demo, but set MINT_API=off on a public deployment you care about.
export async function POST(request: Request): Promise<Response> {
  const rt = await getRuntime().catch((e: Error) => e);
  if (rt instanceof Error) return json({ error: "internal_error", message: rt.message }, { status: 500 });
  if (!rt.config.mintEnabled) return json({ error: "mint_disabled" }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { to?: string } | null;
  if (!body?.to || !isAddress(body.to)) return json({ error: "invalid_address" }, { status: 400 });
  const to = getAddress(body.to);

  const hash = await rt.withOperator(() =>
    rt.operator.writeContract({ address: rt.config.contract, abi: petPassAbi, functionName: "mint", args: [to] }),
  );
  const receipt = await rt.publicClient.waitForTransactionReceipt({ hash });
  let tokenId: string | null = null;
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: petPassAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "Transfer") tokenId = ev.args.tokenId.toString();
    } catch {
      // Not a Transfer log (PassUpdate, for example).
    }
  }
  return json({ tokenId, to, transactionHash: hash, passUri: tokenId ? rt.issuer.passUri(tokenId) : null });
}
