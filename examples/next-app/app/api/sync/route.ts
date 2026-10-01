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
  return json(result ?? { skipped: "synced within the last minute" });
}

export { handle as GET, handle as POST };
