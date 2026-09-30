# Security

A wallet pass is a projection of the token, not the token. Every artifact the standard describes (the pass file, the acquisition URL, the manifest) is a bearer artifact, and authorization never lives in it. This page maps each hole to what closes it in the SDK and the test that proves it. Test files are under `packages/<name>/test/`.

## Threat model

| Hole | Closed by | SDK component | Proven by |
| - | - | - | - |
| Transfer window: a sold token's passes keep acting | Check 2, fresh entitlement read on every action, manifest, link and download | `@erc8426/issuer` authorize, chain reader | issuer `authorize.test.ts` "the fresh read closes the transfer window"; `capability.test.ts` "a live link behind a sold token is refused by the fresh read before any rotation"; `manifest.test.ts` "refuses a pass download when the holder it was issued to is no longer entitled" |
| Forwarding: a leaked pass or URL, owner unchanged | Check 1, signature over a verifier challenge (signed path) | issuer challenge and authorize; client `signedAction` | `authorize.test.ts` "runs the action end to end for the owner", "refuses a signature from the wrong account" |
| Replay of a captured proof | Single-use nonce, spent atomically before other checks | issuer nonce store, `kvStores` `getDel` | `authorize.test.ts` "the single-use nonce makes a captured proof worthless a second time", "spends the nonce even when a later check fails"; `stores.test.ts` "of concurrent presentations of one nonce, exactly one succeeds" |
| Stale leaked proof | Expiration Time against the verifier's clock; Not Before honoured | issuer authorize | `authorize.test.ts` "the expiration makes a leaked proof go stale", "refuses a challenge whose Not Before is in the future" |
| Proof lifted to another verifier | SIWE `domain` must equal the verifier's own | issuer config (`domain` must be `baseUrl`'s host), client scope check | `authorize.test.ts` "the verifier identity keeps a challenge signed for one issuer from being presented to another"; `config.test.ts` "refuses a domain that is not baseUrl's host" |
| Proof for another action, token, chain or contract | Exact binding against the verifier's config and what the nonce was issued for | issuer authorize | `authorize.test.ts` "a proof obtained for one action cannot be presented for another", "a proof for token X cannot be presented for token Y", chain and contract scope tests |
| Acquire proof used to act, or vice versa | `acquire` and `rotate` reserved per route | issuer routes and config | `authorize.test.ts` "an acquire proof MUST NOT authorize any other action"; `manifest.test.ts` "a proof for any other action MUST NOT resolve the manifest" |
| Failed chain read reported as "not owner" | Reads throw; 503 `read_failed` with `Retry-After`; 403 reserved | issuer chain reader and errors | `authorize.test.ts` "answers a read that cannot be taken 503"; `chain.test.ts` "throws when the read could not be taken" |
| Gated manifest leaking URLs | 401 body carries only the challenge URI | issuer manifest | `manifest.test.ts` "answers a request with no proof 401 proof_required with the challenge URI and no acquisition URLs"; conformance `gated.401-no-urls` |
| Previous owner's URLs after a transfer | Rotation on observed transfer or first claim | issuer `onTransfer`, watchers, manifest | `manifest.test.ts` "rotates acquisition URLs on a new owner's first claim, not on a repeat claim"; `capability.test.ts` "a link rotated on an observed transfer is refused"; `watcher.test.ts` "rotates on an observed transfer" |
| Previous owner's installed pass still looks current | Superseded push: voided, links removed | issuer notify; apple provider; google provider | `manifest.test.ts` "gives the new holder a new random serial and pushes the previous holder's pass as superseded"; apple `apple.test.ts` "rotates on transfer"; google `google.test.ts` "on transfer expires the previous owner's object" |
| Leaked link, owner unchanged (capability path) | Rotation on the owner's signed request | issuer `POST /:tokenId/rotate`, client `rotatePassLinks` | `capability.test.ts` "the owner's rotate proof retires every link and download URL" |
| Guessable or derivable URLs | 256-bit random link tokens bound server side; random serials | issuer capability links; apple HMAC download capability | `capability.test.ts` "the URL is an unguessable 256-bit capability not derivable from the token id"; apple `apple.test.ts` "serves the acquisition URL as a signed pkpass with the spec media type" (a guessed capability answers 404) |
| Capability link reaching a dangerous action | Config refuses capability actions without a `bound`, flagged `transfersOrBurns`, or outside gated | issuer config validation; `BoundedAction` on chain | `config.test.ts` "refuses a capability action with no documented bound", "refuses a capability action that transfers, burns or approves", "refuses the capability configuration outside the gated configuration"; contracts `BoundedAction.t.sol` (`test_NonOperatorRejected` and the window and value cap tests) |
| Crawlers or link previews triggering actions | GET on a link never reads or acts; only POST does | issuer capability links | `capability.test.ts` "a GET on a link is side-effect free" |
| Client signing a challenge it did not ask for | Scope check before the signer sees it | `@erc8426/client` `checkChallengeScope` | client `client.test.ts` "refuses to sign an off-scope challenge" (wrong domain, wrong token, expired) and the "challenge scope" suite |
| Stolen Apple device token reaching other passes | Per-pass random token, constant-time compare; retired tokens cannot register devices | apple web service | `apple.test.ts` "refuses a missing or wrong token with 401", "serves a retired token the superseded rendering, lets it unregister, never register" |
| Google save link replayed into a second account | New object per owner; `ONE_USER_ALL_DEVICES` class | google provider and class mapping | `google.test.ts` "on transfer expires the previous owner's object and issues a new one", "builds a class per vertical" |

Contract accounts sign through ERC-1271 and ERC-6492 when the issuer has a `publicClient` (`authorize.test.ts` "checks contract account signatures through the client's verifyMessage").

## What the capability configuration gives up

With no per-action signature, **forwarding is not closed**. Anyone holding a capability link can trigger its bound action while ownership is unchanged. Entropy does not help once it has leaked, rotation does not fire without a transfer, and the fresh read refuses a sold token, not a forwarded link. The SDK accepts this residual exactly as the spec does and bounds it:

- the action cannot transfer, burn or approve the token or change entitlement (enforced by config validation);
- its total effect under unlimited repetition is bounded and documented (`bound` is required, and `BoundedAction` enforces it on chain);
- the owner can always rotate every link.

`capability.test.ts` "lets a forwarded link act under an unchanged owner" asserts this residual on purpose. If an action's repeated effect cannot be bounded, it does not belong on a link: keep it on the signed path.

## Deployment checklist

- **Operator key custody.** The relayer or session key that executes capability actions should be limited on chain to the one function each link invokes (a `BoundedAction` operator, or a session key scoped to that function), never an unrestricted key. Keep it in a KMS or HSM, not a plaintext env file. The token owner can revoke it per token with `setOperatorRevoked`.
- **BoundedAction parameters.** Set `maxPerWindow`, `windowSeconds` and value caps to the smallest that serves the product, and state the bound with the factor of two that back-to-back fixed windows allow. Put the same sentence in the action's `bound`. Freeze the bound once it is a promise.
- **Rotation endpoint exposed.** `POST /wallet-pass/:tokenId/rotate` must be reachable, and the owner needs a way to call it (a "reset my pass links" button using `rotatePassLinks`). Required in the capability configuration.
- **Fresh read at the safe head.** Point `publicClient` at a node you trust, and set `blockTag` to the safest head your chain offers that still meets your latency needs. A lagging node or a reorg widens the transfer window; that residual is accepted risk, so keep it small.
- **Shared nonce store.** More than one instance means a shared store with an atomic read and delete (Redis `GETDEL`, Upstash, a Durable Object). Never Workers KV for nonces.
- **Events feed rotation.** Run `watchTransfers` and `watchPassUpdates`, or indexer webhooks into `onTransfer` and `onPassUpdate`. A lagging feed degrades hygiene, not authorization.
- **CORS.** The default wildcard is safe because proofs travel in headers and no cookies are involved. Restrict `cors.origins` if you want only your own frontends; either way the preflight must allow `X-Wallet-Pass-Proof` and `X-Wallet-Pass-Signature`.
- **No PII in serials or fields.** Serials and Google object ids are random. Never derive them from an email or account id, and keep emails off pass-visible fields: passes are forwarded and backed up.
- **Origin.** Serve pass endpoints from the collection's published origin, so users can match the pass to the project.
- **Platform secrets.** Apple certificates and the APNs key, the Google service account key, and the Apple `linkSecret` (standalone mode) live in a secret manager, never in the repository or the store.
- **Conformance in CI.** `npx @erc8426/conformance` with `ERC8426_OWNER_KEY` in the environment proves the gated owner path and replay refusal against the deployed server.
