import { getMemberRuntime } from "@/lib/member";
import { json } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/// The Apple PassKit web service of the member passes, apart from the other
/// two issuers' services so none answers for another.
async function handle(request: Request): Promise<Response> {
  let member;
  try {
    member = await getMemberRuntime();
  } catch (e) {
    return json({ error: "internal_error", message: (e as Error).message }, { status: 500 });
  }
  return member?.apple ? member.apple.webService(request) : json({ error: "unknown_capability", message: "Apple Wallet is not configured" }, { status: 404 });
}

export { handle as GET, handle as POST, handle as DELETE };
