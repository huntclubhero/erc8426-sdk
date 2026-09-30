import { getRuntime, json } from "@/lib/server";
import { appleWebService } from "@/lib/appleProvider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/// The whole ERC-8426 HTTP surface: manifest, challenge, signed actions,
/// rotation, capability links and pass downloads, all from @erc8426/issuer.
/// The Apple PassKit web service (device registration and pass refresh) lives
/// under /wallet-pass/apple/v1 when Apple credentials are configured.
async function handle(request: Request): Promise<Response> {
  let runtime;
  try {
    runtime = await getRuntime();
  } catch (e) {
    return json({ error: "internal_error", message: (e as Error).message }, { status: 500 });
  }
  const path = new URL(request.url).pathname;
  if (path.startsWith("/wallet-pass/apple/")) {
    const apple = runtime.config.apple ? appleWebService() : undefined;
    return apple ? apple.webService(request) : json({ error: "not_found" }, { status: 404 });
  }
  return runtime.issuer.handler(request);
}

export { handle as GET, handle as POST, handle as HEAD, handle as OPTIONS, handle as DELETE };
