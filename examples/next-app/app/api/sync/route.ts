import { getMemberRuntime } from "@/lib/member";
import { getRuntime, json } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/// Serverless stand-in for the chain watchers: applies Transfer and
/// PassUpdate logs since the last call (rotation on transfer, pushes on
/// update). Idempotent and throttled to once a minute across instances, so a
/// cron, the app itself and a curious visitor can all call it. Authorization never depends on it: every
/// request reads the owner fresh.
async function handle(): Promise<Response> {
  const rt = await getRuntime().catch((e: Error) => e);
  if (rt instanceof Error) return json({ error: "internal_error", message: rt.message }, { status: 500 });
  const result = await rt.sync();
  // The member pass has no logs to apply: its catch-up is the read over the
  // accounts it issued to, under its own once a minute lease.
  const member = await getMemberRuntime()
    .then((m) => (m ? m.sync() : undefined))
    .then((s) => (s ? { checked: s.checked, dark: s.dark.length, revived: s.revived.length } : s))
    .catch((e: Error) => {
      console.warn(`[member sync] ${e.message}`);
      return undefined;
    });
  return json({ ...(result ?? { skipped: "synced within the last minute" }), ...(member === undefined ? {} : { member: member ?? "checked within the last minute" }) });
}

export { handle as GET, handle as POST };
