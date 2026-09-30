import { appleWebService } from "@/lib/appleProvider";
import { getRuntime, json } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/// The Apple PassKit web service (/apple/v1/...): device registration,
/// updated serials and pass refresh. Mounted only when Apple credentials are
/// configured. Apple calls it only over public https, so on localhost passes
/// install but never update.
async function handle(request: Request): Promise<Response> {
  let runtime;
  try {
    runtime = await getRuntime();
  } catch (e) {
    return json({ error: "internal_error", message: (e as Error).message }, { status: 500 });
  }
  const apple = runtime.config.apple ? appleWebService() : undefined;
  return apple ? apple.webService(request) : json({ error: "not_found" }, { status: 404 });
}

export { handle as GET, handle as POST, handle as DELETE };
