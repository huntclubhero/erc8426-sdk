# Changelog

## 0.2.0 (unreleased: not published until an iOS 27 device has shown a poster built by this code)

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
