import { getRentalRuntime } from "@/lib/rental";
import { json } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/// The ERC-8426 HTTP surface of the rental: the same routes as /wallet-pass,
/// served by an issuer whose entitlement is an ERC-4907 rental.
async function handle(request: Request): Promise<Response> {
  let rental;
  try {
    rental = await getRentalRuntime();
  } catch (e) {
    return json({ error: "internal_error", message: (e as Error).message }, { status: 500 });
  }
  if (!rental) return json({ error: "not_found", message: "No rental is configured" }, { status: 404 });
  return rental.issuer.handler(request);
}

export { handle as GET, handle as POST, handle as HEAD, handle as OPTIONS };
