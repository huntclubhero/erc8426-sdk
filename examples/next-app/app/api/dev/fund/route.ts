import { getAddress, isAddress, parseEther, toHex } from "viem";

import { ANVIL_CHAIN_ID, loadConfig } from "@/lib/config";
import { getRuntime, json } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/// DEV ONLY. Funds the in-browser dev wallet on a local anvil chain through
/// anvil_setBalance. Refused unless DEV_WALLET=1 and the chain answers with
/// id 31337, so it cannot run against a real network.
export async function POST(request: Request): Promise<Response> {
  const loaded = loadConfig();
  if (!loaded.ok || !loaded.config.devWallet) return json({ error: "dev_wallet_disabled" }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { address?: string } | null;
  if (!body?.address || !isAddress(body.address)) return json({ error: "invalid_address" }, { status: 400 });
  const rt = await getRuntime();
  if ((await rt.publicClient.getChainId()) !== ANVIL_CHAIN_ID) return json({ error: "dev_wallet_disabled" }, { status: 404 });
  await rt.publicClient.request({
    method: "anvil_setBalance" as never,
    params: [getAddress(body.address), toHex(parseEther("10"))] as never,
  });
  return json({ funded: getAddress(body.address), amount: "10 ETH" });
}
