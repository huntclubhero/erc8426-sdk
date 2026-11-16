import { after } from "next/server";
import { getAddress, isAddress } from "viem";

import { underLimit } from "@/lib/kv";
import { clientIp } from "@/lib/limits";
import { getMemberRuntime, memberAbi } from "@/lib/member";
import { json } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/// Member pass state for the page: the id, and for `?account=` its balance
/// and whether it has a pass and whether that pass is dark.
export async function GET(request: Request): Promise<Response> {
  const loaded = await getMemberRuntime().catch((e: Error) => e);
  if (loaded instanceof Error) return json({ error: "internal_error", message: loaded.message }, { status: 500 });
  if (!loaded) return json({ error: "not_found", message: "No member pass is configured" }, { status: 404 });
  const m = loaded;
  // The page polls this, so on a serverless host it also drives the read
  // over every issued account (at most once a minute across instances).
  if (!m.rt.config.watchers) after(() => m.sync().then(() => undefined, (e: Error) => console.warn(`[member sync] ${e.message}`)));
  const account = new URL(request.url).searchParams.get("account");
  if (account && !isAddress(account)) return json({ error: "invalid_request", message: "account must be an address" }, { status: 400 });

  const { publicClient } = m.rt;
  const base = { address: m.member.contract, abi: memberAbi } as const;
  const id = m.member.id;
  try {
    const [supply, limit, open] = await Promise.all([
      publicClient.readContract({ ...base, functionName: "totalSupply", args: [id] }),
      publicClient.readContract({ ...base, functionName: "claimLimit" }),
      publicClient.readContract({ ...base, functionName: "open", args: [id] }),
    ]);
    let holder = null;
    if (account) {
      const who = getAddress(account);
      const [balance, claimed, gas, pass] = await Promise.all([
        publicClient.readContract({ ...base, functionName: "balanceOf", args: [who, id] }),
        publicClient.readContract({ ...base, functionName: "claimed", args: [id, who] }),
        publicClient.getBalance({ address: who }),
        m.passOf(who),
      ]);
      holder = { account: who, balance, claimed, hasGas: gas > 0n, pass };
    }
    return json({ contract: m.member.contract, id, supply, claimLimit: limit, open, passUri: m.issuer.passUri(id.toString()), holder });
  } catch (e) {
    console.warn(`[member] state: ${(e as Error).message.split("\n")[0]}`);
    return json({ error: "read_failed", message: "The chain could not be read. Try again in a moment." }, { status: 503, headers: { "retry-after": "5" } });
  }
}

/// Ask the issuer to read one account's balance now and act on it, as a
/// watcher would have on the transfer: dark when it holds no unit, live
/// again when it does. It needs no proof because it only makes the issuer
/// look: the issuer takes a pass dark only when two reads agree. A node
/// that lags can still answer both, so the look is capped per visitor and
/// per account, and a pass taken dark by mistake comes back on the next
/// read that sees the unit.
export async function POST(request: Request): Promise<Response> {
  const m = await getMemberRuntime().catch((e: Error) => e);
  if (m instanceof Error) return json({ error: "internal_error", message: m.message }, { status: 500 });
  if (!m) return json({ error: "not_found", message: "No member pass is configured" }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { account?: unknown } | null;
  const account = typeof body?.account === "string" && isAddress(body.account) ? getAddress(body.account) : null;
  if (!account) return json({ error: "invalid_request", message: "account must be an address" }, { status: 400 });
  if (
    m.rt.redis &&
    (!(await underLimit(m.rt.redis, `${m.rt.prefix}limit:member-check:ip:${clientIp(request)}`, 120, 3600)) ||
      !(await underLimit(m.rt.redis, `${m.rt.prefix}limit:member-check:account:${account.toLowerCase()}`, 12, 600)))
  ) {
    return json({ error: "rate_limited", message: "Too many checks. Try again in a few minutes." }, { status: 429 });
  }
  try {
    const s = await m.check(account);
    return json({ checked: s.checked, dark: s.dark.length > 0, revived: s.revived.length > 0, pass: await m.passOf(account) });
  } catch (e) {
    console.warn(`[member] check: ${(e as Error).message.split("\n")[0]}`);
    return json({ error: "read_failed", message: "The chain could not be read. Try again in a moment." }, { status: 503 });
  }
}
