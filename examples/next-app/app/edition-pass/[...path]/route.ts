import { editionSyncAfter, getEditionRuntime } from "@/lib/edition";
import { json } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/// The ERC-8426 HTTP surface of the ERC-1155 edition (working draft of the
/// ERC-1155 binding): the same routes as /wallet-pass, served by a second
/// issuer whose passes belong to an id and an account.
async function handle(request: Request): Promise<Response> {
  let edition;
  try {
    edition = await getEditionRuntime();
  } catch (e) {
    return json({ error: "internal_error", message: (e as Error).message }, { status: 500 });
  }
  if (!edition) return json({ error: "not_found", message: "No edition is configured" }, { status: 404 });
  editionSyncAfter(edition);
  return edition.issuer.handler(request);
}

export { handle as GET, handle as POST, handle as HEAD, handle as OPTIONS };
