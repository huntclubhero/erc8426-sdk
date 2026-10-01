# Changelog

## 0.1.1 (issuer, core)

Found by running the example app on Vercel from the published 0.1.0 packages.

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
