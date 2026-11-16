import { getAddress, isAddress } from "viem";

import { allowSpend } from "@/lib/limits";
import { getRentalRuntime, RENTAL_MAX_SECONDS, RENTAL_MIN_SECONDS, RENTAL_SECONDS, RentalRefused } from "@/lib/rental";
import { json } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const isTokenId = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,30}$/.test(v);

/// State of one key: who owns it, who rents it and until when, and who the
/// issuer last issued its pass to.
export async function GET(request: Request): Promise<Response> {
  const r = await getRentalRuntime().catch((e: Error) => e);
  if (r instanceof Error) return json({ error: "internal_error", message: r.message }, { status: 500 });
  if (!r) return json({ error: "not_found", message: "No rental is configured" }, { status: 404 });
  const url = new URL(request.url);
  const tokenId = url.searchParams.get("tokenId");
  const base = { contract: r.rental.contract, seconds: RENTAL_SECONDS, now: Math.floor(Date.now() / 1000) };
  if (!tokenId) return json({ ...base, key: null });
  if (!isTokenId(tokenId)) return json({ error: "invalid_request", message: "tokenId must be a token id" }, { status: 400 });
  try {
    return json({ ...base, key: await r.view(tokenId), passUri: r.issuer.passUri(tokenId) });
  } catch (e) {
    console.warn(`[rental] state: ${(e as Error).message.split("\n")[0]}`);
    return json({ error: "read_failed", message: "The chain could not be read. Try again in a moment." }, { status: 503, headers: { "retry-after": "5" } });
  }
}

/// What the house does, on a visitor's request. All three are the operator's
/// own transactions or its own signed request, so each is capped per visitor.
///  - { do: "rent", account, seconds? }: mint a key to the house, rent it to the account.
///  - { do: "rent-again", tokenId, account, seconds? }: rent the same key to the same account again.
///  - { do: "owner-claims", tokenId }: the owner claims its pass for the key.
export async function POST(request: Request): Promise<Response> {
  const r = await getRentalRuntime().catch((e: Error) => e);
  if (r instanceof Error) return json({ error: "internal_error", message: r.message }, { status: 500 });
  if (!r) return json({ error: "not_found", message: "No rental is configured" }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { do?: unknown; account?: unknown; tokenId?: unknown; seconds?: unknown } | null;
  const account = typeof body?.account === "string" && isAddress(body.account) ? getAddress(body.account) : null;
  const wanted = typeof body?.seconds === "number" && Number.isFinite(body.seconds) ? Math.floor(body.seconds) : RENTAL_SECONDS;
  const seconds = Math.min(RENTAL_MAX_SECONDS, Math.max(RENTAL_MIN_SECONDS, wanted));
  try {
    if (body?.do === "rent") {
      if (!account) return json({ error: "invalid_request", message: "account must be an address" }, { status: 400 });
      if (!(await allowSpend(r.rt, "rent", request, 12, 400))) return json({ error: "rate_limited", message: "This demo rents a few keys per visitor per day. Try again tomorrow." }, { status: 429 });
      const out = await r.rent(account, seconds);
      return json({ ...out, seconds, passUri: r.issuer.passUri(out.tokenId) });
    }
    if (body?.do === "rent-again") {
      if (!account || !isTokenId(body.tokenId)) return json({ error: "invalid_request", message: "account and tokenId are required" }, { status: 400 });
      if (!(await allowSpend(r.rt, "rent", request, 12, 400))) return json({ error: "rate_limited", message: "This demo rents a few keys per visitor per day. Try again tomorrow." }, { status: 429 });
      const out = await r.rentAgain(body.tokenId, account, seconds);
      return json({ tokenId: body.tokenId, ...out, seconds });
    }
    if (body?.do === "owner-claims") {
      if (!isTokenId(body.tokenId)) return json({ error: "invalid_request", message: "tokenId is required" }, { status: 400 });
      if (!(await r.renterOf(body.tokenId))) return json({ error: "unknown_key", message: "This key was not rented out by this demo." }, { status: 404 });
      if (!(await allowSpend(r.rt, "owner-claims", request, 40, 2000))) return json({ error: "rate_limited", message: "Too many requests. Try again later." }, { status: 429 });
      return json(await r.ownerClaims(body.tokenId));
    }
    return json({ error: "invalid_request", message: 'do must be "rent", "rent-again" or "owner-claims"' }, { status: 400 });
  } catch (e) {
    if (e instanceof RentalRefused) return json({ error: e.code, message: e.message }, { status: e.status });
    console.warn(`[rental] ${String(body?.do)}: ${(e as Error).message.split("\n")[0]}`);
    return json({ error: "action_failed", message: "The house could not do that just now. Try again in a moment." }, { status: 502 });
  }
}
