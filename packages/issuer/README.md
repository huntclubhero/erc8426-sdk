# @erc8426/issuer

The server side of [ERC-8426](https://eips.ethereum.org/EIPS/eip-8426), the Wallet Pass Extension for NFTs. It issues challenges, enforces the two-check authorization floor, serves public and gated pass manifests, runs capability links, and rotates every URL on transfer, on a new owner's first claim, and on the owner's request.

It is built on the WHATWG Fetch API (`Request` in, `Response` out), so one handler runs in Next.js route handlers, Hono, Bun, Deno, Cloudflare Workers and Node. Runtime dependencies: `@erc8426/core` and the `viem` peer. Nothing else.

```sh
npm install @erc8426/issuer @erc8426/core viem
```

## Quickstart

```ts
// issuer.ts
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { createIssuer } from "@erc8426/issuer";

export const issuer = createIssuer({
  domain: "pets.example",               // verifier identity (SIWE domain)
  baseUrl: "https://pets.example",      // every emitted URL is built on this
  chainId: 8453,
  contract: "0xYourCollection",
  mode: "gated",                        // or "public"
  publicClient: createPublicClient({ chain: base, transport: http(process.env.RPC_URL) }),
  providers: [applePasses, googlePasses], // from @erc8426/apple and @erc8426/google
  render: ({ token, serial, links }) => ({
    serial,
    organizationName: "Pets",
    description: `Pet #${token.tokenId}`,
    title: "Pet",
    links: Object.entries(links).map(([key, url]) => ({ key, label: key, url })),
  }),
  capability: { enabled: true },
  actions: {
    feed: {
      description: "Feed your pet",
      capability: true,
      bound: "Feeds at most once per hour. Moves no tokens and no value.",
      execute: async ({ token, account }) => relayer.feed(token.tokenId),
    },
  },
});
```

Point the contract's `passURI(tokenId)` at `issuer.passUri(tokenId)`, which is `${baseUrl}/wallet-pass/${tokenId}` by default.

### Next.js (App Router)

```ts
// app/wallet-pass/[...path]/route.ts
import { issuer } from "@/issuer";

export const GET = issuer.handler;
export const POST = issuer.handler;
export const HEAD = issuer.handler;
export const OPTIONS = issuer.handler;
```

### Hono (Bun, Deno, Workers, Node)

```ts
import { Hono } from "hono";
import { issuer } from "./issuer";

const app = new Hono();
app.all("/wallet-pass/*", (c) => issuer.handler(c.req.raw));
export default app;
```

### Express

```ts
import express from "express";
import { expressMiddleware } from "@erc8426/issuer";
import { issuer } from "./issuer";

const app = express();
app.use(expressMiddleware(issuer)); // serves /wallet-pass/*, calls next() for anything else
app.listen(3000);
```

Plain Node: `http.createServer(toNodeHandler(issuer))`.

## HTTP surface

All under `basePath` (default `/wallet-pass`). Every response carries `Cache-Control: no-store`.

| Route | Purpose |
| :- | :- |
| `GET /:tokenId` | The manifest. Public: served to anyone. Gated: 401 `{ error: "proof_required", challenge }` without a proof, the manifest with a valid `acquire` proof in `X-Wallet-Pass-Proof` / `X-Wallet-Pass-Signature`. |
| `GET /:tokenId/challenge?address=&action=` | A fresh ERC-4361 challenge. `action` defaults to `acquire`. 400 on a missing or invalid address or an unknown action. |
| `POST /:tokenId/actions/:action` | Signed action. Body `{ message, signature, params? }` (or the proof headers). |
| `POST /:tokenId/rotate` | Rotate every link on the owner's signed `rotate` proof. |
| `GET /links/:link` | Describe a capability link. No side effects: a confirm page for browsers, JSON otherwise. |
| `POST /links/:link` | Perform a capability link's action. |
| `GET /passes/:link` | Download a pass file from a file provider (Apple `.pkpass`). `HEAD` answers the same headers with no body. |

Status codes follow the spec: 400 malformed or mis-scoped, 401 failed possession or freshness check (always with a `challenge` member), 403 only for a verified proof from a non-entitled account, 404 unknown or rotated link, 503 `read_failed` with `Retry-After` when the chain read could not be taken.

## Security model

| Spec requirement | What closes it here |
| :- | :- |
| Transfer window (a sold token keeps acting) | Check (2): a fresh entitlement read on every action, manifest, link and download. Nothing is cached. |
| Forwarding (a leaked pass or URL, unchanged owner) | Check (1): a signature over a verifier-issued challenge on the signed path. On the capability path this is the disclosed residual, bounded by the documented `bound` and remedied by `POST /:tokenId/rotate`. |
| Replay | Single-use nonce, spent atomically before any other check (`getDel` on shared stores). |
| Stale proof | `Expiration Time` checked against the verifier's clock, capped at the expiry the verifier issued. `Not Before` honoured. |
| Cross-verifier reuse | SIWE `domain` must equal `config.domain`. |
| Proof for another action or token | Exact binding: chain id, CAIP-19 token and action URN compared with the verifier's own config and with what the nonce was issued for, never with request values. |
| Acquire proof used as an action, or vice versa | `acquire` and `rotate` are reserved; the action route refuses them and the manifest refuses anything but `acquire`. |
| Contract accounts | With `publicClient`, signatures verify through `verifyMessage` (ERC-1271 and ERC-6492). |
| Failed read reported as a refusal | Reads throw on failure; the issuer answers 503, and 403 means only "not entitled". |
| Previous owner's URLs after transfer | Rotation on an observed transfer (`onTransfer`, watcher) or on the new owner's first claim, whichever comes first. The previous pass is pushed as voided. |
| Leaked URL under an unchanged owner | Rotation on the owner's signed request (a MUST in the capability configuration). |
| Guessable links | 256-bit random link tokens, bound server-side to one token and one action or format. Serials are random. |
| Capability link reaching a dangerous action | Config validation refuses capability actions without a documented `bound`, flagged `transfersOrBurns`, or outside the gated configuration. |
| Prefetching crawlers triggering actions | `GET` on a link never executes or reads; only `POST` does. |

The capability configuration is weaker than a per-action signature by design. Read the spec's section on it before enabling `capability`.

## Entitlement

The default is `ownerOnly()`. Extensions, all read fresh on every request:

```ts
import { anyOf, delegateRegistry, rental4907 } from "@erc8426/issuer";

createIssuer({ ...config, entitlement: anyOf(rental4907(), delegateRegistry()) });
```

- `rental4907({ exclusive = true, actions? })`: an active ERC-4907 user is entitled, and by default exclusive of the owner (and everyone else) for covered actions. An expired rental falls back to the owner.
- `delegateRegistry({ registry?, rights? })`: delegate.xyz v2 delegates of the current owner are entitled in addition to the owner.
- `anyOf(...)` precedence: any veto (an exclusive rental) wins, otherwise the first allow, otherwise refused.

## Chain events

Rotate on transfer and push updates either from a live subscription:

```ts
import { watchPassUpdates, watchTransfers } from "@erc8426/issuer";

watchTransfers({ client: publicClient, issuer });
watchPassUpdates({ client: publicClient, issuer });
```

or from an indexer webhook (Alchemy, QuickNode, Goldsky):

```ts
await issuer.onTransfer(tokenId, from, to);
await issuer.onPassUpdate(fromTokenId, toTokenId); // inclusive range
```

A lagging watcher degrades hygiene, never authorization: the fresh read refuses the previous owner's links until rotation catches up.

Burns. A burn emits both `Transfer` to the zero address and `PassUpdate`, so either hook may see it first. `onTransfer(id, from, zeroAddress)` treats it as a burn, and `onPassUpdate` takes a fresh `ownerOf` read before rendering and treats a token with no owner the same way. Either way the holder's installed passes are pushed as voided and every link and download is retired, and `render` is never called for the dead token (it would read a token that no longer exists). Pass `renderBurned` to choose what the voided card says. `onPassUpdate` also rotates when the read finds the token held by someone the pass was not issued to (a transfer no watcher has seen), so it never pushes a new owner's state to the previous holder's pass. A read that cannot be taken is reported through `onError` and `onPassUpdate` throws `IssuerError` `read_failed` after processing the rest of the range; nothing is rendered for that token.

## Stores

The default in-memory stores are for one process only. With more than one instance, the nonce store must be shared or a nonce spent on one instance stays live on another. `kvStores(kv)` builds all three stores on this interface:

```ts
interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { ttlSeconds?: number; onlyIfAbsent?: boolean }): Promise<boolean>;
  getDel(key: string): Promise<string | null>; // MUST be atomic
  del(key: string): Promise<void>;
}
```

### ioredis

```ts
import Redis from "ioredis";
import { kvStores, type KeyValueStore } from "@erc8426/issuer";

const redis = new Redis(process.env.REDIS_URL!);
const kv: KeyValueStore = {
  get: (k) => redis.get(k),
  async set(k, v, o = {}) {
    const args: (string | number)[] = [];
    if (o.ttlSeconds) args.push("EX", o.ttlSeconds);
    if (o.onlyIfAbsent) args.push("NX");
    return (await (redis.set as any)(k, v, ...args)) === "OK";
  },
  getDel: (k) => redis.getdel(k), // Redis 6.2+
  del: async (k) => void (await redis.del(k)),
};
createIssuer({ ...config, stores: kvStores(kv) });
```

### @upstash/redis (and Vercel KV)

```ts
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const kv: KeyValueStore = {
  get: (k) => redis.get<string>(k),
  async set(k, v, o = {}) {
    const opts: Record<string, unknown> = {};
    if (o.ttlSeconds) opts.ex = o.ttlSeconds;
    if (o.onlyIfAbsent) opts.nx = true;
    return (await redis.set(k, v, opts)) === "OK";
  },
  getDel: (k) => redis.getdel<string>(k),
  del: async (k) => void (await redis.del(k)),
};
```

Cloudflare Workers KV is eventually consistent and has no atomic read and delete, so it must not back the nonce store. Use a Durable Object or Upstash for nonces (`stores: { ...kvStores(workersKv), nonces: kvStores(upstash).nonces }`).

## API

- `createIssuer(options)` returns `{ config, stores, chain, handler, route, passUri, challengeUri, issueChallenge, authorize, rotate, onTransfer, onPassUpdate, capabilityLinksFor }`.
- Providers: core's `PassDeliveryProvider`, either a `PassFormatProvider` (returns an acquisition URL) or a `PassFileProvider` (`passFile(ctx)` returns the file bytes and the issuer serves them at a rotating capability URL). `domain` must equal `baseUrl`'s host, because clients refuse to sign a challenge for any other domain.
- `ActionError(status, code, message?)`: throw from `execute` to refuse with a chosen status (never 403).
- `authorize`, `publicClientChainReader`, `publicClientSignatureVerifier`, `eoaSignatureVerifier`, `memoryStores`, `kvStores`, `memoryKv`, `toNodeHandler`, `expressMiddleware` are exported for custom wiring.

## License

MIT
