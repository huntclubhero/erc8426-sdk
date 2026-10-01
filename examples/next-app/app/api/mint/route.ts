import { decodeEventLog, getAddress, isAddress } from "viem";

import { allowSpend } from "@/lib/limits";
import { petPassAbi } from "@/lib/petAbi";
import { getRuntime, json } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/// Hatch a pet for `to`. PetPass.mint is owner-only, so the operator (the
/// collection owner in this example) sends it and pays the gas. Anyone can
/// call this route; with a shared store it is capped per IP and per day
/// (MINT_LIMIT_PER_IP, MINT_LIMIT_PER_DAY). Set MINT_API=off to close it.
export async function POST(request: Request): Promise<Response> {
  const rt = await getRuntime().catch((e: Error) => e);
  if (rt instanceof Error) return json({ error: "internal_error", message: rt.message }, { status: 500 });
  if (!rt.config.mintEnabled) return json({ error: "mint_disabled" }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { to?: string } | null;
  if (!body?.to || !isAddress(body.to)) return json({ error: "invalid_address" }, { status: 400 });
  const to = getAddress(body.to);
  if (!(await allowSpend(rt, "mint", request, rt.config.mintLimitPerIp, rt.config.mintLimitPerDay))) {
    return json({ error: "rate_limited", message: "This demo hatches a few pets per visitor per day. Try again tomorrow." }, { status: 429 });
  }

  let hash: `0x${string}`;
  let receipt;
  try {
    hash = await rt.withOperator((nonce) =>
      rt.operator.writeContract({ address: rt.config.contract, abi: petPassAbi, functionName: "mint", args: [to], nonce }),
    );
    receipt = await rt.publicClient.waitForTransactionReceipt({ hash });
  } catch (e) {
    console.warn(`[mint] ${(e as Error).message.split("\n")[0]}`);
    return json({ error: "mint_failed", message: "The mint transaction could not be sent. Try again in a moment." }, { status: 502 });
  }
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
