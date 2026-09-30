import { loadConfig } from "@/lib/config";
import { json } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/// A read-mostly JSON-RPC proxy for the browser, so a testnet RPC key never
/// ships to the page. Only the methods the app needs pass; the one write is
/// eth_sendRawTransaction, which carries a transaction the dev wallet signed
/// in the browser (the proxy never signs anything).
const ALLOWED = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_call",
  "eth_getLogs",
  "eth_newFilter",
  "eth_getFilterChanges",
  "eth_uninstallFilter",
  "eth_getBalance",
  "eth_getCode",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_getBlockByNumber",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_sendRawTransaction",
]);

interface RpcCall {
  jsonrpc: "2.0";
  id: unknown;
  method: string;
  params?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  const loaded = loadConfig();
  if (!loaded.ok) return json({ error: loaded.error }, { status: 500 });
  let body: RpcCall | RpcCall[];
  try {
    body = await request.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 });
  }
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length > 50) return json({ error: "batch too large" }, { status: 400 });
  const refused = calls.find((c) => typeof c?.method !== "string" || !ALLOWED.has(c.method));
  if (refused) {
    return json({ jsonrpc: "2.0", id: refused?.id ?? null, error: { code: -32601, message: `method not allowed: ${String(refused?.method)}` } });
  }
  const upstream = await fetch(loaded.config.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
