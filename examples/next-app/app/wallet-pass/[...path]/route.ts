import { getRuntime, json } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/// The whole ERC-8426 HTTP surface: manifest, challenge, signed actions,
/// rotation, capability links and pass downloads, all from @erc8426/issuer.
/// The Apple PassKit web service lives outside this tree, at /apple (see
/// app/apple/[...path]/route.ts), so this catch-all never swallows it.
async function handle(request: Request): Promise<Response> {
  let runtime;
  try {
    runtime = await getRuntime();
  } catch (e) {
    return json({ error: "internal_error", message: (e as Error).message }, { status: 500 });
  }
  return runtime.issuer.handler(request);
}

export { handle as GET, handle as POST, handle as HEAD, handle as OPTIONS };
