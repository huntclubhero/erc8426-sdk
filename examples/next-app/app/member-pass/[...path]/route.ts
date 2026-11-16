import { after } from "next/server";

import { getMemberRuntime } from "@/lib/member";
import { json } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/// The ERC-8426 HTTP surface of the member pass (the "go dark and come back"
/// case of the ERC-1155 binding draft): the same routes as /wallet-pass,
/// served by an issuer whose passes carry no capability link.
async function handle(request: Request): Promise<Response> {
  let member;
  try {
    member = await getMemberRuntime();
  } catch (e) {
    return json({ error: "internal_error", message: (e as Error).message }, { status: 500 });
  }
  if (!member) return json({ error: "not_found", message: "No member pass is configured" }, { status: 404 });
  const m = member;
  // On serverless hosts (no watchers), catch up after the response is sent.
  if (!m.rt.config.watchers) after(() => m.sync().then(() => undefined, (e: Error) => console.warn(`[member sync] ${e.message}`)));
  return m.issuer.handler(request);
}

export { handle as GET, handle as POST, handle as HEAD, handle as OPTIONS };
