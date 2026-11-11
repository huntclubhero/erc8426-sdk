# Deploy

The issuer and the Apple web service are Fetch API handlers (`Request` in, `Response` out), so the same code mounts anywhere. What changes between hosts is state (stores), long-lived connections (chain watchers, APNs) and which Node APIs exist. Store and framework details for the issuer are in its [README](../packages/issuer/README.md).

## What needs to persist

| State | Package | Requirement |
| - | - | - |
| Nonces | issuer | Shared across instances with an **atomic read and delete** (`getDel`). Otherwise a nonce spent on one instance stays live on another. |
| Pass records and link bindings | issuer | Shared, durable. `kvStores(kv, { chainId, contract })` covers nonces, records and links, keyed per collection. |
| Apple pass records and device registrations | apple | Durable `ApplePassStore`. Records hold `PassContent`; serialize `Date` and `Uint8Array` values. |
| Google object records | google | Durable `GoogleObjectStore` (get, put, delete), so object ids survive restarts. |

The in-memory defaults are for tests and a single process only. `createIssuer` refuses them under `NODE_ENV=production` unless every store is named (`stores: kvStores(kv, { chainId, contract })`, or an explicit `stores: memoryStores()` for a deliberate single instance), and warns once outside production.

## Apple signing cost under a burst

Every pass file the Apple provider serves is built and signed at that moment: the images are fetched when they are given as URLs, the bundle's manifest is hashed, and the Pass Type ID key signs it. Nothing is cached between requests. That holds for a download and for every 200 answer of the web service's latest-pass route.

What bounds it is the conditional fetch. The web service sends `Last-Modified` and answers a request whose `If-Modified-Since` is not older with 304, without building anything. Apple's Wallet Developer Guide (archived) asks for exactly that ("Support the If-Modified-Since caching mechanism on this endpoint"); the current endpoint reference lists only the `Authorization` header. Neither mentions `If-None-Match`, and this SDK has no evidence that Wallet sends it, so the web service issues no `ETag`.

So the cost to plan for is one signature per registered device per real change, arriving as the devices answer the push. An update pushed to every pass of a collection at once asks the host for that many signatures at once.

- Push a collection-wide change in batches, at a rate the host signs comfortably. Measure one `buildPkpass` on the production host first; the time depends on the key, the images and the CPU.
- Give images as bytes, or serve their URLs from somewhere fast and close: a slow image origin is paid on every build.
- A superseded pass is rebuilt on every fetch (a retired token is never answered 304). That is one build per old device per push, and pushes to superseded registrations stop after `SUPERSEDED_PUSH_WINDOW_MS`.
- Do not push when nothing changed. `notifyUpdate` always pushes; call it for real changes only. ERC-8426 asks an issuer not to push unchanged content, because a platform can throttle updates for an issuer that does.

## Next.js on Vercel

```ts
// app/wallet-pass/[...path]/route.ts
import { issuer } from "@/lib/issuer";
export const runtime = "nodejs"; // Apple signing and APNs need Node APIs
export const GET = issuer.handler;
export const POST = issuer.handler;
export const HEAD = issuer.handler;
export const OPTIONS = issuer.handler;
```

```ts
// app/apple/[...path]/route.ts  (the PassKit web service, basePath "/apple")
import { apple } from "@/lib/issuer";
export const runtime = "nodejs";
export const GET = apple.webService;
export const POST = apple.webService;
export const DELETE = apple.webService;
```

- **Stores:** Upstash Redis (or Vercel KV, which is Upstash) through `kvStores`; the issuer README has the ten-line adapter. Use Postgres or Redis for the Apple and Google stores.
- **Events:** serverless functions cannot hold a `watchTransfers` subscription. Use an indexer webhook (below), or a Vercel Cron job that reads `Transfer`, `PassUpdate` and `BatchPassUpdate` logs since the last processed block and calls the same hooks.
- **Secrets:** Vercel environment variables, marked sensitive. Base64 PEM files to keep their newlines intact. `linkSecret` (the example reads `ISSUER_LINK_SECRET`) is one of them: 32+ bytes, the same on every instance, required in production; the links are derived from it, so a store dump yields none.
- **APNs:** the client reuses its HTTP/2 session within a warm instance; a cold start reconnects once. That is fine at pass-update volumes.
- **Preview deployments:** Apple only calls `https` web services on public hosts, so test device updates on a deployed preview, not localhost.

## Node and Express

```ts
import express from "express";
import { expressMiddleware, toNodeHandler, watchPassUpdates, watchTransfers } from "@erc8426/issuer";
import { apple, issuer, publicClient } from "./issuer";

const app = express();
app.use(expressMiddleware(issuer)); // /wallet-pass/*, next() for anything else
app.all("/apple/*", async (req, res) => {
  const response = await apple.webService(toRequest(req)); // any Express to Fetch adapter
  res.status(response.status);
  response.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(Buffer.from(await response.arrayBuffer()));
});
app.listen(3000);

watchTransfers({ client: publicClient, issuer });
watchPassUpdates({ client: publicClient, issuer });
```

A long-running process is the best home for this SDK: watchers hold their subscriptions, APNs keeps one session open, and in-memory caches (Google access tokens, parsed keys) stay warm. Run more than one instance only with shared stores. `http.createServer(toNodeHandler(issuer))` works without Express.

## Cloudflare Workers and Hono

```ts
import { Hono } from "hono";
const app = new Hono();
app.all("/wallet-pass/*", (c) => issuer.handler(c.req.raw));
export default app;
```

- **Nonces must not live in Workers KV.** KV is eventually consistent and has no atomic read and delete. Put nonces in a Durable Object or Upstash, and records and links wherever you like: `stores: { ...kvStores(workersKv, scope), nonces: kvStores(upstash, scope).nonces }` with `scope = { chainId, contract }`.
- **Apple needs Node.** `@erc8426/apple` uses `node:http2` for APNs, and pass signing uses `node-forge` over Node buffers. Workers do not provide `node:http2`. Run the Apple provider and web service on a Node host, or run the whole issuer there if you serve Apple passes.
- **Google on Workers** uses `jose` (Web Crypto) and `node:crypto` helpers; it should run under the `nodejs_compat` flag but has not been verified there.
- **Events:** a Cron Trigger that reads logs since the last block, or an indexer webhook into a Worker route.

## Indexer webhooks

Any indexer that delivers contract logs (Alchemy, QuickNode, Goldsky) can drive rotation and updates. Verify the provider's signature, decode the logs, and call the hooks in log order:

```ts
import { decodeEventLog } from "viem";
import { erc721Abi, walletPassAbi } from "@erc8426/core";

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyProviderSignature(req.headers, raw)) return new Response(null, { status: 401 });
  for (const log of logsFrom(JSON.parse(raw))) {           // provider-specific shape
    if (log.address.toLowerCase() !== COLLECTION.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: [...erc721Abi, ...walletPassAbi], data: log.data, topics: log.topics });
      if (ev.eventName === "Transfer") await issuer.onTransfer(ev.args.tokenId, ev.args.from, ev.args.to);
      if (ev.eventName === "PassUpdate") await issuer.onPassUpdate(ev.args.tokenId);
      if (ev.eventName === "BatchPassUpdate") await issuer.onPassUpdate(ev.args.fromTokenId, ev.args.toTokenId); // inclusive
    } catch {
      /* not one of ours */
    }
  }
  return new Response(null, { status: 200 });
}
```

- `onTransfer` is idempotent and does nothing for a token it never issued, so redelivery is safe.
- A missed or late webhook degrades hygiene, never authorization: the fresh ownership read refuses the previous owner's links until rotation catches up. Still, backfill after an outage (for example with `@erc8426/client`'s `getPassUpdates` and a `Transfer` log query from the last processed block).
- Answer quickly and let the provider retry on failure; pushes that fail are reported through the issuer's `onError`, not thrown.
