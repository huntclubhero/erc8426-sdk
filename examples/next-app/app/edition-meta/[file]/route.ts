import { json } from "@/lib/server";

export const runtime = "nodejs";

/// ERC-1155 metadata for the edition, at the address the contract's `uri`
/// names: /edition-meta/{id}.json, where {id} is the id as 64 hex digits.
export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }): Promise<Response> {
  const { file } = await params;
  const m = /^([0-9a-f]{64})\.json$/.exec(file);
  if (!m) return json({ error: "not_found" }, { status: 404 });
  const id = BigInt(`0x${m[1]}`).toString();
  return json(
    {
      name: `ERC-8426 Edition ${id}`,
      description:
        "A testnet demo edition for the working draft of the ERC-1155 binding of ERC-8426 (Wallet Pass Extension for NFTs). Free to claim, no value. Holding at least one unit entitles the holding account to its own wallet pass.",
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
