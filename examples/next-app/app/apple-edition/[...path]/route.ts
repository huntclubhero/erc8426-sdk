import { getEditionRuntime } from "@/lib/edition";
import { json } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/// The Apple PassKit web service of the edition passes, apart from the pet
/// passes' service at /apple so the two never answer for each other.
async function handle(request: Request): Promise<Response> {
  let edition;
  try {
    edition = await getEditionRuntime();
  } catch (e) {
    return json({ error: "internal_error", message: (e as Error).message }, { status: 500 });
  }
  return edition?.apple ? edition.apple.webService(request) : json({ error: "unknown_capability", message: "Apple Wallet is not configured" }, { status: 404 });
}

export { handle as GET, handle as POST, handle as DELETE };
