# Changelog

## 0.3.0 (unreleased; every package to 0.3.0, contracts to 0.2.0)

Mainnet hardening and alignment with the current ERC-8426 draft (ethereum/ERCs PR #2036).

- `@erc8426/core`: the refusal codes follow the spec's refusal table. New codes `unknown_capability` (404), `insufficient_balance` (409) and `rate_limited` (429). `malformed_proof`, `invalid_address` and `invalid_token` collapse into `invalid_request` (400); `link_invalid` and `not_found` collapse into `unknown_capability` (404). `not_yet_valid` (401) stays and is being added to the table in PR #2036. The five retired names remain in `WalletPassErrorCode` as deprecated aliases for one minor version: `isWalletPassErrorCode` accepts them, `statusForError` maps them to the status of their replacement, and the new `canonicalErrorCode` resolves them. The issuer no longer emits them. `CANONICAL_WALLET_PASS_ERROR_CODES` lists what the SDK emits; `DEPRECATED_WALLET_PASS_ERROR_CODES` maps the aliases.
- `@erc8426/core`: `parseChallenge` reads the token and the action by position, as the spec's "Each floor field has a fixed place in the message" and the reference verifier do: the token is the first resource, the action the second. Before, it searched the resources list and refused a message with more than one of either as ambiguous. Now a message with the two swapped carries neither (the issuer refuses it as `binding_mismatch`), a message that lists the expected action anywhere but second is a proof for whatever sits second, and resources after the second are not read (the reference tolerates them; `@erc8426/client` still refuses to sign a challenge with more than two, a stricter policy on the signing side).
- `@erc8426/core`: `normalizeTokenId` (and so `tokenRef`, `assetId`, `parseAssetId` and every issuer and client entry point that takes a token id) refuses a value above 2^256 - 1 (`MAX_TOKEN_ID`), on top of the negative, fractional and non-digit input it already refused. An over-long string is refused before it is parsed.
- `@erc8426/issuer`: `createIssuer` refuses the in-memory store fallback under `NODE_ENV=production`. When `stores` leaves out `nonces`, `passes` or `links`, production throws an `IssuerConfigError` naming the missing stores (pass `kvStores(kv)`, or an explicit `memoryStores()` to run one instance deliberately); every other environment logs one warning naming the fallback, through the new `onWarning` option (default `console.warn`). `isProductionEnv()` is exported. The Apple and Google providers' own memory stores are unchanged.
- `@erc8426/issuer`: `kvStores` keys are scoped per collection. `kvStores(kv, { chainId, contract, prefix? })` now requires the chain id and contract address and writes every row under `${prefix}${chainId}:${contract}:` (contract lowercased; `prefix` still defaults to `erc8426:`): `erc8426:1:0x5f9b...c2e1:pass:412`, `...:link:<token>`, `...:nonce:<nonce>`. Two collections on one Redis, or one collection redeployed on another chain, can no longer read or overwrite each other's rows. `kvKeyNamespace(options)` returns the namespace. **Migration:** rows written by 0.2.x live under the old shape `${prefix}pass:<tokenId>`, `${prefix}link:<token>` and `${prefix}nonce:<nonce>` and are NOT read by 0.3.0. Either (a) let passes re-issue: deploy 0.3.0 and every holder's next acquire proof creates a fresh record with new links and a new serial, so installed passes keep working only after the holder re-adds them (their old capability links answer `unknown_capability` until then), or (b) rekey once before deploying: for every `${prefix}pass:*` and `${prefix}link:*` key, copy the value to the same key with `${chainId}:${contract.toLowerCase()}:` inserted after the prefix (`RENAME erc8426:pass:412 erc8426:1:0x5f9b...c2e1:pass:412`), then delete the old keys; nonces need no migration (they expire within `nonceTtlSeconds`, and a nonce issued by 0.2.x is refused as `nonce_invalid` by 0.3.0, which only costs that holder a fresh challenge). Option (b) keeps every installed pass and link live.
- `@erc8426/issuer`: every 400 for a malformed address, token id or proof header is `invalid_request`; every 404 (a rotated or unknown link, a download link, a nonexistent token in the public configuration, an unknown route) is `unknown_capability`.
- `@erc8426/client`: a code from a 0.2.x issuer is reported under the spec's name (`malformed_proof` arrives as `invalid_request`) with the string the issuer sent in `serverCode`. A reverted `passURI`, `tokenURI` or `ownerOf` read (a token that does not exist or was burned) is now `unknown_capability` with `source: "chain"`, where it was `not_found`; a 404 with no recognizable body is `unknown_capability` too. `@erc8426/react`'s `describeError` wording follows.

## 0.2.4 (google; every package republished at 0.2.4)

Android notifications, from the WALLETCHI deployment (2026-10-19): the provider sent every Google Wallet message as `TEXT`, which only shows inside the saved pass, so Android holders were never notified of a deadline reminder.

- `@erc8426/google`: `GoogleMessage` gains `notify?: boolean`. `addMessage` sends `messageType: TEXT_AND_NOTIFY` when it is set, which is the only kind that raises an Android notification; the default stays `TEXT`, so 0.2.3 behavior is unchanged and superseded messages stay silent. Google caps notifying messages per object per day (three at the time of writing).
- Docs: `docs/platforms/google.md` says which message kind notifies; `docs/platforms/apple.md` records the one-banner rule (a notifying update whose only visible change is the value of one existing field with `changeMessage`), that a value change to a repeated `posterGeneric` key raised one message on iOS 27, and that dropping a `changeMessage` is silent.

## 0.2.3 (apple, google; every package republished at 0.2.3)

Registration cap without eviction, from Nexory's review of the WALLETCHI PassKit web service (2026-10-15), which found that 0.2.2's eviction rule lets a forwarded pass push the holder's devices out.

- `@erc8426/apple`: at `MAX_REGISTRATIONS_PER_PASS` live devices a NEW device is refused (the web service answers 403); no registered device is ever evicted. Under 0.2.2 anyone holding a copy of the current pass (a forwarded file or mail) could register ten devices and silently cut the holder's own devices off updates. A device already registered still re-registers at the cap.
- `@erc8426/apple`: `DeviceRegistrationStore.register` may return `"full"` (the type widens to `Promise<boolean | "full">`; a store returning a boolean still compiles, but MUST stop evicting). New REQUIRED `supersede(passType, serial)`: the provider calls it whenever a pass's token rotates (transfer, voided supersede, `rotate()`). Superseded registrations still answer the device's list call and get pushes for `SUPERSEDED_PUSH_WINDOW_MS` (24 h), so the old pass refreshes into its superseded rendering, but they no longer count toward the cap, so an owner's rotation always frees the slots a forwarded copy filled. Custom stores must implement `supersede()`; without it the cap would lock owners out after a rotation (a forwarded copy that filled the ten slots would keep them forever, and the owner's new pass would answer 403 on every device). `MemoryApplePassStore` implements both; `pushPassUpdate` now sends to at most `MAX_PUSH_TOKENS_PER_PASS` (20: the live set plus as many superseded).
- `@erc8426/apple`: the provider calls `supersede()` BEFORE it persists the rotated record, on both the sync path (transfer, voided supersede) and `rotate()`. A supersede that throws now leaves the rotation unpersisted and retried on the next call; the other order would have persisted the rotation and left the old devices holding the slots with nothing to retry it. `supersede()` is idempotent, so a putPass failure after it is harmless.
- `@erc8426/apple`: the web service answers 403 at the cap, a status outside the 200/201/401 Apple documents for registration; the pass installs on that device but never updates (documented in `docs/platforms/apple.md`).
- `@erc8426/google`: expiring a superseded object retries once, and only on a transient failure (a 5xx, a 429, or no HTTP answer at all); a definite answer such as 404 is reported once and not retried. The provider forgets the old object id once the call returns, so an expire that never landed left every saved copy ACTIVE with nothing able to retry it.
- Example app: the Redis store keeps a live list (claimed atomically by a Lua script, so concurrent registrations never land past the cap and a device registering twice at once lands once) and a sorted set of superseded devices. Registrations written by 0.2.0 and 0.2.1 (the hosted demo), which have neither, keep receiving pushes through the per-serial token set and keep their slot when they next register. Covered by `examples/next-app/test/kv.test.ts` against an in-memory Upstash fake.

## 0.2.2 (apple; every package republished at 0.2.2)

Bounded Apple Wallet registrations, from a review of WALLETCHI's PassKit web service by Nexory (2026-10-14). No API changes.

- `@erc8426/apple`: a pass keeps at most `MAX_REGISTRATIONS_PER_PASS` (10) registered devices. `MemoryApplePassStore` evicts the least recently registered device; a device re-registering counts as fresh and evicts nobody. Every update sends one APNs request per token, so an unbounded set let anyone holding a pass make each push arbitrarily expensive. `DeviceRegistrationStore` now documents the cap as a MUST for custom stores, and `pushPassUpdate` sends to at most that many tokens even if a store does not enforce it.
- `@erc8426/apple`: the web service answers 400 for a device library identifier that is longer than 64 characters or not path-safe.
- Example app: the Redis store keeps a per-pass recency list and evicts past the cap.
- `@erc8426/contracts` (comment only, not republished): `StoredValueCard` notes that in a token-bound variant an approval granted from the card's own account survives a transfer, and that a production account should refuse approvals and allow only revocations.

## 0.2.1 (core, client, conformance; every package republished at 0.2.1)

Three fixes from an outside security review (Nexory, 2026-10-14). No API changes.

- `@erc8426/client`: redirects are followed by hand, at most three, and every hop must pass the same https (or loopback http) check as the first URL. Before, `fetch` followed them unchecked, so an allowed URL could bounce the client to `http://169.254.169.254/` or any plain-http host. In a browser, where a manual redirect comes back opaque, a GET is asked once more and the browser follows it itself: only the final URL is checked (https, or loopback http), and the body is dropped if it fails; any other method is refused. Regression tests in `audit-regressions.test.ts`.
- `@erc8426/conformance`: the owner key no longer signs whatever challenge the server under test returns. Before signing, the run applies the check `@erc8426/client` uses (`checkChallengeScope`): the challenge must come from the origin that serves the manifest and name that host, this token, the owner's account and the acquire action, with an Expiration Time inside the default lifetime limit. Otherwise nothing is signed and the owner checks are skipped with the reason. A server that issues challenges naming another host, or a lifetime above one hour, now gets its owner checks skipped instead of run.
- `@erc8426/core`: `parseChallenge` refuses a message longer than `MAX_CHALLENGE_MESSAGE_CHARS` (4096) before parsing it. The SIWE parser is quadratic on repeated `URI: ` without a newline (about 600 ms at 64 KiB), and an issuer parses before it knows the caller. A conforming challenge is under 2 KiB. Reported by Nexory (2026-10-14); the parser itself is being reported upstream to viem.

## 0.2.0 (published 2026-10-09)

Apple's iOS 27 Poster Generic face, and a signing-time check that the certificate matches the pass.

- `@erc8426/core`: `PassStyle` gains `"posterGeneric"`; `PassContent` gains `footer`, `posterFallback` and the `artwork` and `primaryLogo` image slots.
- `@erc8426/apple`: `posterGeneric` emits two dictionaries on one pass, the poster (one header field, up to four primary, one footer, the back) and a legacy fallback (`posterFallback`, default `generic`) with the full field set, so iOS 26 and earlier render the legacy layout. More fields than the poster face shows throws, as a duplicate key already did; a footer on another style throws. Images ship for both faces. Needs passkit-generator 3.6 or later at signing (the range already resolves 3.6.1); 3.5 strips the `posterGeneric` key silently.
- `@erc8426/apple`: `buildPkpass` refuses a signer certificate whose subject UID is not the `passTypeIdentifier` or whose OU is not the `teamIdentifier` (`validateSignerCertificate`). Such a pass signs fine and installs nowhere. Test certificates now carry Apple's UID and OU attributes.
- `@erc8426/google`: `posterGeneric` maps to the generic vertical; the portrait `artwork` is not used as the wide Google hero.

## 0.1.1 (client, react, conformance)

Found by installing every 0.1.1 package from npm into an empty project.

- `@erc8426/client`, `@erc8426/react`, `@erc8426/conformance`: depend on `@erc8426/core` (and `@erc8426/client`) by caret range. Their 0.1.0 releases pinned `@erc8426/core` to exactly 0.1.0, so installing them next to core 0.1.1 put two copies of core in the tree, and `instanceof WalletPassError` (imported from core) failed for errors the client threw. Every internal dependency now publishes as a caret range, guarded by `tests/audit/package-ranges.audit.test.ts`. No code changes.

## 0.1.1 (issuer, core, apple, google)

Superseded passes say why. ERC-8426 now asks that a pass presented as superseded state why and, where its holder may still be the owner, how to get the replacement (ethereum/ERCs PR #2036, de989060, raised on the Magicians thread).

- `@erc8426/core`: `SupersededReason` (`"transfer" | "reset"`) and `PassContent.supersededReason`.
- `@erc8426/issuer`: the old serial is pushed with `supersededReason` (`"reset"` for the owner's rotation, `"transfer"` for an observed transfer or a new account's claim), and `render` receives it.
- `@erc8426/apple`: the default superseded pass reads "Transferred" or "Links reset" and names the issuer to get the current pass from; each retired token remembers its own reason (`retiredReasons`, `retiredReasonFor`), and `supersede(content, reason)` receives it. Records from 0.1.0 load and render the generic wording.
- `@erc8426/google`: the superseded message follows the reason (`defaultSupersededMessage`); `supersededMessage` also accepts a function of the reason.
- Example renderers say "Links reset" on a reset instead of "Transferred".

Found by running the example app on Vercel from the published 0.1.0 packages:

- `@erc8426/issuer`: `kvStores` now accepts a key-value client that parses JSON on read. The `@upstash/redis` shim in the 0.1.0 README used the client's default automatic deserialization, which handed `kvStores` objects instead of strings, so every gated request failed. The README shim now turns that off, and `kvStores` works either way (regression test in `stores.test.ts`).
- `@erc8426/core`: ships its README (0.1.0 listed one in `files` that did not exist).
- Example app: hosted mode for serverless (shared Upstash stores for the issuer, Apple and Google; a cross-instance operator lock and nonce; log catch-up in place of watchers; rate-limited mint; an opt-in testnet burner wallet and gas drip), and the smoke test now fails, instead of skipping, when the conformance package is missing, and runs against a deployed instance.

## 0.1.0

First release, tracking the ERC-8426 draft as of ethereum/ERCs PR #2036.

- `@erc8426/core`, `@erc8426/contracts`, `@erc8426/issuer`, `@erc8426/apple`, `@erc8426/google`, `@erc8426/client`, `@erc8426/react`, `@erc8426/conformance`.
- Use-case contracts and runnable demos: pet game, stablecoin spending card, NFT staking, event ticket, membership, identity credential, rental, partner app.
- A full Next.js example app.
- End-to-end suites on a real chain, including smart-account owners (ERC-1271 and counterfactual ERC-6492).
- Fixes for every finding of two pre-release adversarial reviews (contracts and TypeScript), kept as regression tests.
