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
| `GET /:tokenId` | The manifest. Public: served to anyone. Gated: 401 `{ error: "proof_required", challenge }` without a proof, the manifest with a valid `acquire` proof in `Wallet-Pass-Proof` / `Wallet-Pass-Signature` (the pre-0.3.0 `X-` names are still read; the new name wins when both are sent). Served as `application/json` with `version: 1`. |
| `GET /:tokenId/challenge?address=&action=` | A fresh ERC-4361 challenge. `action` defaults to `acquire`. 400 on a missing or invalid address or an unknown action. |
| `POST /:tokenId/actions/:action` | Signed action. Body `{ message, signature, params? }` (or the proof headers). |
| `POST /:tokenId/rotate` | Rotate on a signed `rotate` proof from the holder of record (or an account entitled to acquire). Answers `{ ok, rotated }` only, never the manifest: the holder re-adds the new pass with an acquire proof. |
| `GET /links/:link` | Describe a capability link. No side effects: a confirm page for browsers, JSON otherwise. Every link page answer (and the result page of a form POST) carries `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer` and `Content-Security-Policy: frame-ancestors 'none'` (`LINK_PAGE_HEADERS`); a custom `confirmPage` gets them too, keeping its own CSP directives. |
| `POST /links/:link` | Perform a capability link's action. |
| `GET /passes/:link` | Download a pass file from a file provider (Apple `.pkpass`). `HEAD` answers the same headers with no body. |

Refusals carry the `error` codes of the spec's refusal table (Refusal responses), with the listed status. 401s always carry a `challenge` member; 429 and 503 carry `Retry-After`.

| `error` | Status | When | Retry |
| :- | :- | :- | :- |
| `invalid_request` | 400 | Malformed request: a bad token id or `address`, a proof header that cannot be decoded, a body that is not JSON | After correcting it |
| `invalid_message` | 400 | The presented message is not a parseable challenge, or exceeds the size bound | Fresh challenge |
| `domain_mismatch` | 400 | The challenge names another verifier | Fresh challenge |
| `binding_mismatch` | 400 | The proof or link does not bind this exact token and action | Fresh challenge |
| `unknown_action` | 400 | The action is not registered (SDK code, outside the table) | No |
| `proof_required` | 401 | No control proof was presented | Fresh challenge |
| `nonce_invalid` | 401 | Unknown or already spent nonce | Fresh challenge |
| `challenge_expired` | 401 | Expiration Time has passed | Fresh challenge |
| `not_yet_valid` | 401 | Not Before is in the future (being added to the table in PR #2036) | Fresh challenge |
| `signature_invalid` | 401 | The signature is not valid for the claimed account | Fresh challenge |
| `not_owner` | 403 | A verified proof from an account that is not entitled (fresh read). Reserved: nothing else answers 403 | No |
| `unknown_capability` | 404 | The capability URL, download link, token or route does not resolve, for example after rotation | No |
| `method_not_allowed` | 405 | Wrong method (SDK code) | No |
| `insufficient_balance` | 409 | An account the token controls holds less than the action spends (raise it from an action with `ActionError`) | After funding |
| `rate_limited` | 429 | Too many attempts for this client, token or action | After `Retry-After` |
| `action_failed`, `internal_error` | 500 | The action threw, or the issuer did (SDK codes) | Later |
| `read_failed` | 503 | The fresh entitlement read could not be taken | After `Retry-After` |

Until 0.4.0 the client and `isWalletPassErrorCode` also accept the 0.2.x names `malformed_proof`, `invalid_address`, `invalid_token` (now `invalid_request`) and `link_invalid`, `not_found` (now `unknown_capability`); the issuer no longer emits them.

## CORS

Off unless configured. With no `cors` the issuer sends no `Access-Control` headers, so a page on another origin cannot read the manifest, a challenge or a refusal, which is right when the only browser caller is your own site. A browser-based marketplace or wallet on another origin needs `cors: { origins: ["https://market.example"] }` (echoed per request, with `Vary: Origin`) or an explicit `cors: { origins: "*" }`. The preflight admits the two proof headers. Until 0.2.x a wildcard was the silent default.

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
| Leaked URL or pass under an unchanged owner | Rotation on the owner's signed request (a MUST in the capability configuration). It mints a new serial and pushes the old one as voided with no links, so a forwarded .pkpass or shared Google object refreshes into a dead card and never receives the new links. |
| Rotate used to take a pass | The rotate route never returns the manifest, never changes the holder of record, and requires the holder of record or an account entitled to acquire, so an owner excluded by an exclusive rental cannot disturb the renter's pass. |
| Unbounded pre-auth input | Bodies are read with a running byte count and cut at 64 KiB (`MAX_BODY_BYTES`), in the fetch handler and the Node adapter alike; oversized proof headers and token ids are refused before parsing. |
| A revert read as a burn | Only a nonexistent-token revert (`ERC721NonexistentToken`, or the OpenZeppelin 4 strings) or a zero owner means "no owner". Any other revert (a paused contract) is `read_failed`, never a burn. |
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
- `delegateRegistry({ registry?, rights? })`: delegate.xyz v2 delegates of the current owner are entitled in addition to the owner. Because delegation is additive, a delegate's claim does not void the owner's pass: while the holder of record is still entitled, another entitled account shares that pass (same serial, same links, acting on the holder's entitlement). The residual: revoking a delegation does not retire links the delegate already holds; the owner rotates on request to cut them off, then re-adds the pass.
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

Burns. A burn emits both `Transfer` to the zero address and `PassUpdate`, so either hook may see it first. `onTransfer(id, from, zeroAddress)` treats it as a burn, and `onPassUpdate` takes a fresh `ownerOf` read before rendering and treats a token with no owner the same way. Either way the holder's installed passes are pushed as voided and every link and download is retired, and `render` is never called for the dead token (it would read a token that no longer exists). Pass `renderBurned` to choose what the voided card says. `onPassUpdate` also rotates when the read finds the token held by someone the pass was not issued to (a transfer no watcher has seen), so it never pushes a new owner's state to the previous holder's pass. Only a nonexistent-token revert or a zero owner counts as burned; any other revert is a failed read. A read that cannot be taken is reported through `onError` and `onPassUpdate` throws `IssuerError` `read_failed` after processing the rest of the range; nothing is rendered for that token.

## Stores

The default in-memory stores are for one process only. With more than one instance, the nonce store must be shared or a nonce spent on one instance stays live on another. Since 0.3.0 `createIssuer` refuses the in-memory fallback in production (an `IssuerConfigError` naming the missing stores): pass `stores: kvStores(kv, { chainId, contract })`, or `stores: memoryStores()` to run one instance deliberately. Outside production a store left out falls back to memory with one warning (`onWarning`, default `console.warn`). Say which you are with `environment: "production"` or `"development"`: when set it decides, and `NODE_ENV` is only the fallback when it is left out. A real deployment ran for months with `NODE_ENV` unset, so a guard keyed on it alone protected nothing; when neither is set and `chainId` is a known mainnet (`MAINNET_CHAIN_IDS`: 1, 10, 137, 8453, 42161) the issuer warns once that production mode is undetermined and names the option.

Anyone can ask the challenge endpoint for a nonce. The in-memory store sweeps unconsumed nonces once their retention passes and caps itself at `maxNonces` (default 100000, dropping the oldest), and a KV store expires them by TTL. Neither is a defense against a flood on its own, since a flood past the cap evicts honest users' pending challenges; the built-in rate limiter (next section) is.

## Identical repeats

An identical repeat is not a replay. iOS in-app browsers send a GET, then a POST the phone aborts, then the same POST again, on every tap, and proxies retry a timed-out POST the same way. Following the spec revision, the issuer answers a repeat of an identical `POST /links/:link` (same link, same body bytes) or `POST /:tokenId/actions/:action` (same nonce, message, signature and body) that arrives while the first is in flight, or within `repeat.windowSeconds` (default 30) after it completed, with the first request's outcome: the action runs once and both callers get the same status and body (the repeat carries `X-Wallet-Pass-Repeat: true`). Only a presentation that differs is judged on its own: a different body on the same link is a new request, and a different request carrying a spent nonce is still `nonce_invalid`. Only a success is replayed: a refusal had no side effect, so a repeat of one is judged afresh (a 503 retries, a 404 before a claim becomes a 200 after it; on the nonce path it meets `nonce_invalid`, since the failed attempt spent the nonce). Outcomes live in `memoryRepeatStore()` (one process, bounded) by default; pass `repeat: { store: kvRepeatStore(kv) }` so instances share completed outcomes (in-flight sharing stays per process), or `repeat: false` to turn it off.

## Rate limiting

On by default. The challenge, manifest and capability endpoints each count attempts per client address and path token (`challenge:<client>:<tokenId>`, `manifest:<client>:<tokenId>`, `capability:<client>:<link>`) and answer `429 { "error": "rate_limited" }` with a `Retry-After` header (whole seconds) past the limit. The attempt is counted before any work, so a refused request costs nothing but the count. Defaults: `challenge` 30 per 60 s, `manifest` 60 per 60 s, `capability` (GET and POST `/links/:link`, GET and HEAD `/passes/:link`) 60 per 60 s.

```ts
import { createIssuer, kvRateLimiter, kvKeyNamespace } from "@erc8426/issuer";

createIssuer({
  ...config,
  rateLimit: {
    challenge: { limit: 10, windowSeconds: 60 },
    manifest: false,                                   // one family off
    limiter: kvRateLimiter(kv, { prefix: `${kvKeyNamespace(scope)}rl:` }), // one limit across instances
    clientKey: (request) => request.headers.get("x-real-ip"),          // what counts as one client
  },
});
createIssuer({ ...config, rateLimit: false });        // off entirely
```

- `memoryRateLimiter()` (default) keeps an exact sliding window per key in process memory, at most `maxKeys` keys (100000, least recently seen dropped). With several instances each enforces its own share.
- `kvRateLimiter(kv)` keeps a fixed-window counter per key in the `KeyValueStore`, shared by every instance. With a store that implements the optional `incr` (Redis `INCR` plus `EXPIRE`) the count is exact; without it the counter is read and written back and racing attempts may undercount.
- `clientKey` defaults to `defaultClientKey`: `CF-Connecting-IP`, `True-Client-IP`, `X-Real-IP`, `Fly-Client-IP`, the first `X-Forwarded-For` hop, then the socket address the Node adapter records (`toNodeHandler` and `expressMiddleware` set it from `req.socket.remoteAddress`, dropping any client-sent value). Behind no proxy `X-Forwarded-For` is client-supplied, so pass a `clientKey` that reads the socket address only.
- Any object with `hit(key, rule, nowMs)` is a `RateLimiter`.

Why the token is in every key: holders share addresses. A school's Wi-Fi, an office, a stadium, or a carrier's address translation puts many people behind one address, each presenting a different token (a class adding their student cards in the same minute, a venue's ticket holders at the door). A limit keyed by address alone refuses that crowd and does nothing against an attacker who spreads across addresses. Keyed by client and token together, thirty honest holders on one network are thirty keys, and the pattern the limit exists for, many requests for one token from one place, is still bounded. If you supply a `clientKey`, keep it per client; the issuer adds the token.

`kvStores(kv, { chainId, contract, prefix? })` builds all three stores on this interface. Every key is scoped by chain id and lowercased contract (`${prefix}${chainId}:${contract}:pass:${tokenId}`, and `:link:`, `:nonce:` alongside; `prefix` defaults to `erc8426:`), so two collections on one Redis never share a row even when they share token ids. Rows written by 0.2.x (`${prefix}pass:${tokenId}`) are not read; see the 0.3.0 changelog for the one-off rekey.

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
createIssuer({ ...config, stores: kvStores(kv, { chainId: config.chainId, contract: config.contract }) });
```

### @upstash/redis (and Vercel KV)

```ts
import { Redis } from "@upstash/redis";

// automaticDeserialization off: kvStores writes JSON strings and parses them
// itself. (kvStores also accepts parsed values since 0.1.1, so either works.)
const redis = Redis.fromEnv({ automaticDeserialization: false });
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

Cloudflare Workers KV is eventually consistent and has no atomic read and delete, so it must not back the nonce store. Use a Durable Object or Upstash for nonces (`stores: { ...kvStores(workersKv, scope), nonces: kvStores(upstash, scope).nonces }` with `scope = { chainId, contract }`).

## API

- `createIssuer(options)` returns `{ config, stores, chain, handler, route, passUri, challengeUri, issueChallenge, authorize, rotate, onTransfer, onPassUpdate, capabilityLinksFor }`.
- Providers: core's `PassDeliveryProvider`, either a `PassFormatProvider` (returns an acquisition URL) or a `PassFileProvider` (`passFile(ctx)` returns the file bytes and the issuer serves them at a rotating capability URL). `domain` must equal `baseUrl`'s host, because clients refuse to sign a challenge for any other domain.
- `ActionError(status, code, message?)`: throw from `execute` to refuse with a chosen status (never 403).
- `issuer.rotate(tokenId)` rotates programmatically with the same effect as the route (the caller authorizes). `authorize`, `publicClientChainReader`, `publicClientSignatureVerifier`, `eoaSignatureVerifier`, `memoryStores`, `kvStores`, `memoryKv`, `toNodeHandler`, `expressMiddleware` are exported for custom wiring.

## License

MIT
