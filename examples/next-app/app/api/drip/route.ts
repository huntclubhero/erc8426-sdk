import { getAddress, isAddress } from "viem";

import { allowSpend } from "@/lib/limits";
import { getRuntime, json } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/// TESTNET ONLY. Sends a burner wallet a few cents' worth of testnet gas,
/// once per address, so a visitor without a wallet can try a transfer. Off
/// unless DRIP_WEI is set, never on anvil (the dev faucet covers that), and
/// capped per IP and per day so a script cannot drain the operator.
export async function POST(request: Request): Promise<Response> {
  const rt = await getRuntime().catch((e: Error) => e);
  if (rt instanceof Error) return json({ error: "internal_error", message: rt.message }, { status: 500 });
  if (rt.config.dripWei === 0n || !rt.redis) return json({ error: "drip_disabled" }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { address?: string } | null;
  if (!body?.address || !isAddress(body.address)) return json({ error: "invalid_address" }, { status: 400 });
  const to = getAddress(body.address);

  const balance = await rt.publicClient.getBalance({ address: to });
  if (balance >= rt.config.dripWei) return json({ to, dripped: false, reason: "already funded" });
  // Once per address, ever: claim the address before spending anything.
  if ((await rt.redis.set(`${rt.prefix}drip:${to}`, "1", { nx: true })) !== "OK") {
    return json({ to, dripped: false, reason: "already dripped" });
  }
  if (!(await allowSpend(rt, "drip", request, 3, 300))) {
    await rt.redis.del(`${rt.prefix}drip:${to}`);
    return json({ error: "rate_limited", message: "The testnet drip is used up for today." }, { status: 429 });
  }
  const hash = await rt.withOperator((nonce) => rt.operator.sendTransaction({ to, value: rt.config.dripWei, nonce }));
  await rt.publicClient.waitForTransactionReceipt({ hash });
  return json({ to, dripped: true, wei: rt.config.dripWei.toString(), transactionHash: hash });
}
