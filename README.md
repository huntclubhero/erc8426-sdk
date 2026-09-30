# ERC-8426 SDK

**Put any NFT in Apple Wallet and Google Wallet.** A complete, MIT licensed toolkit for [ERC-8426: Wallet Pass Extension for NFTs](https://github.com/ethereum/ERCs/pull/2036): Solidity contracts, a pass server, Apple and Google delivery, a client for wallets and marketplaces, React components, and a conformance suite that checks any implementation against the spec.

A wallet pass is a card that ships on nearly every phone. It shows live state, links into web experiences, and receives push updates, without the holder installing an app. ERC-8426 is the shared seam between a token and that card:

1. **Discovery.** A token contract exposes `passURI(tokenId)` (ERC-165 id `0xef5f1e71`), which resolves to a manifest of acquisition URLs per platform.
2. **Freshness.** `PassUpdate` and `BatchPassUpdate` events tell anyone distributing passes that a card is stale.
3. **Authorization.** A pass is a bearer artifact, so any action it can trigger is authorized by a signed challenge (or, under strict conditions, a bounded capability link) plus a fresh on-chain ownership read.

This SDK implements all three, end to end.

> **Status.** ERC-8426 is a Draft (ethereum/ERCs PR #2036, discussion on [Ethereum Magicians](https://ethereum-magicians.org/t/erc-8426-wallet-pass-extension-for-nfts/29358)). The SDK is `0.x` and tracks the current draft; breaking changes follow the spec until it is final. The example contracts are tested, not audited.

## Packages

| Package | For | What it does |
| --- | --- | --- |
| [`@erc8426/contracts`](packages/contracts) | NFT projects | `IERC721WalletPass`, an abstract `ERC721WalletPass` base, ERC-4907 rentals, `BoundedAction` (on-chain limits for pass-reachable actions), and six use-case contracts |
| [`@erc8426/issuer`](packages/issuer) | Anyone issuing passes | A Fetch API handler for the whole protocol surface: public and gated manifests, challenges, the two-check authorization floor, signed actions, capability links, rotation, pass file hosting, entitlement policies, KV stores, transfer and `PassUpdate` watchers. Runs on Next.js, Hono, Workers, Bun, Deno, Node and Express |
| [`@erc8426/apple`](packages/apple) | Issuers | Signed `.pkpass` bundles, the PassKit web service, APNs push |
| [`@erc8426/google`](packages/google) | Issuers | Google Wallet classes and objects, upserts, Save to Google Wallet links |
| [`@erc8426/client`](packages/client) | Wallets, marketplaces, apps | Detect support, resolve public and gated manifests, add to wallet, signed actions, watch pass updates |
| [`@erc8426/react`](packages/react) | Frontends | `useWalletPass`, `usePassUpdates`, and an SSR-safe `<AddToWalletButton>` that shows the issuing contract |
| [`@erc8426/conformance`](packages/conformance) | Everyone | Check any contract and pass server against every MUST, as a library or `npx erc8426-conformance` |
| [`@erc8426/core`](packages/core) | All of the above | Protocol constants, ABIs, CAIP-19, ERC-4361 challenge codec, manifest validation, one `PassContent` shape that renders on both wallets |

## Quickstart

### 1. Make your token pass-enabled

```solidity
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721WalletPass} from "@erc8426/contracts/src/ERC721WalletPass.sol";

contract MyPass is ERC721WalletPass {
    constructor(string memory passBase) ERC721("My Pass", "PASS") ERC721WalletPass(passBase) {}
}
```

`passURI(tokenId)` now returns `passBase + tokenId`, `supportsInterface(0xef5f1e71)` is true, and every transfer emits `PassUpdate`. See [packages/contracts](packages/contracts) for the exact constructor and the extensions.

### 2. Serve passes

```ts
// app/wallet-pass/[...path]/route.ts (Next.js)
import { createIssuer } from "@erc8426/issuer";
import { appleFormatProvider } from "@erc8426/apple";
import { googleFormatProvider, googleWalletClient } from "@erc8426/google";

const issuer = createIssuer({
  domain: "passes.example.com",
  baseUrl: "https://passes.example.com",
  chainId: 1,
  contract: "0xYourContract",
  mode: "gated",
  publicClient,
  providers: [appleFormatProvider({ /* certs */ }), googleFormatProvider({ /* service account */ })],
  render: ({ token, owner, serial, links }) => ({
    serial,
    organizationName: "My Project",
    description: `My Pass #${token.tokenId}`,
    title: "My Pass",
    primary: [{ key: "id", label: "Token", value: `#${token.tokenId}` }],
    links: Object.entries(links).map(([action, url]) => ({ key: action, label: action, url })),
  }),
});

export const GET = issuer.handler;
export const POST = issuer.handler;
export const HEAD = issuer.handler;
export const OPTIONS = issuer.handler;
```

Exact option names are in the [issuer README](packages/issuer).

### 3. Add to Wallet, from any app

```tsx
import { AddToWalletButton } from "@erc8426/react";

<AddToWalletButton contract="0xYourContract" tokenId={412n} signer={account} />
```

Or without React:

```ts
import { createWalletPassClient } from "@erc8426/client";

const client = createWalletPassClient({ publicClient });
if (await client.supportsWalletPass(contract)) {
  const { url } = await client.addToWallet({ contract, tokenId }, { signer });
  window.location.href = url;
}
```

### 4. Check conformance

```sh
npx erc8426-conformance --rpc https://rpc.example --contract 0xYourContract --token 1
```

Add `--owner-key-env MY_KEY_VAR` to exercise the gated path with the owner's key (read from that environment variable, never from a flag).

## Use cases

Every use case below ships as a Solidity contract in [`packages/contracts/src/examples`](packages/contracts/src/examples) and a runnable demo in [`examples/use-cases`](examples/use-cases) that deploys to a local chain, serves the pass, and walks the story end to end.

| Use case | What the pass does | Pass-reachable (bounded link) | Needs the owner's signature |
| --- | --- | --- | --- |
| **Pet game** | A living pet on the card; care for it from the pass | feed, water, play (cooldown bounded on chain) | anything that moves the pet |
| **Stablecoin spending card** | A self-custody stored-value card: tap to pay, punches, rewards | merchant charge within per-transaction and daily caps | withdraw |
| **NFT staking** | A receipt pass showing accrued rewards | claim (pays only the current owner; relayer rate limited on chain) | unstake |
| **Event ticket** | Check in at the door, becomes a keepsake after the show | none (door staff check in) | transfer, resale |
| **Membership** | Tiered access with expiry and renewal | none | renew, upgrade |
| **Digital identity** | A soulbound credential card a verifier can check | none | rotate links, present to a verifier |
| **Rental** | ERC-4907: the renter holds the pass during the rental | per policy | setting the user |
| **Partner app** | Pass links open a partner app that runs any signed action | deep links | every action the app performs |

The partner app pattern is where the programmability opens up: a static pass links into an app (universal link or app link), and the app uses `@erc8426/client` to run signed actions of any shape, so the card becomes a front door to everything the contract can do.

## Built with ERC-8426

These are production systems by the author of the standard. They are the reason the spec reads the way it does.

- **[WALLETCHI](https://www.playwalletchi.com)**: a pixel pet that lives in Apple Wallet and Google Wallet. Mint with an email, care for the pet from the pass, and every tap is an on-chain transaction. Its token contract implements `IERC721WalletPass` and its server runs the gated configuration with capability links for care actions, bounded on chain by a session key scoped to the one function pass links invoke. Live on Robinhood Chain testnet. Its deployment is described in the ERC's non-normative [implementation notes](https://github.com/ethereum/ERCs/pull/2036).
- **[Rare Friends Pass](https://rare-friends-pass.vercel.app)** ([source](https://github.com/Halldon-Inc/rare-friends-pass)): a wallet pass for every activated Rare Friend on Robinhood Chain, showing claimable and pending rewards live. Claim runs from the pass with no signature, because the underlying claim can only pay the Friend's own wallet; withdraw needs the owner's confirmation. The collection predates ERC-8426, so the site acts as a gated resolver for an existing collection.
- **PUNCHCARD** (July 2026, retired): the stablecoin spending card. Bought with an email and a debit card, it held real digital dollars in the card's own account and spent them at a counter within per-transaction and daily caps enforced on chain, punching the card on every purchase. It ran on Robinhood Chain testnet before WALLETCHI replaced it; its pattern lives on as the `StoredValueCard` example.

Building on ERC-8426? Open a pull request adding your project here.

## Example app

[`examples/next-app`](examples/next-app) is a full Next.js app: mint a pass on a local chain, preview the card front and back in the browser (no Apple or Google credentials needed), add it to a real wallet when credentials are configured, run a signed action, follow a capability link, transfer the token and watch the old owner's links die.

## Security model

The standard's authorization rests on two checks, and this SDK enforces both:

| Hole | Closed by | In the SDK |
| --- | --- | --- |
| A sold token keeps acting through old passes | Fresh on-chain ownership read at request time | `issuer` entitlement policies, never cached |
| A forwarded pass or link is used under an unchanged owner | Signed ERC-4361 challenge per action | `issuer` authorize floor, `client` signs only in-scope challenges |
| A captured proof is replayed | Single-use verifier nonce and expiry | `issuer` nonce stores (atomic on KV) |
| A proof for one issuer is used at another | Verifier identity (SIWE domain) | checked by `issuer`, enforced by `client` |
| A capability link leaks | Bounded, documented effect; rotation on owner request | `BoundedAction` on chain, `issuer` capability links |

Read [docs/security.md](docs/security.md) before going to production.

**Review status.** Before release, the contracts and the TypeScript packages each went through an independent adversarial review that had to prove every finding with a failing test. Every finding was fixed, and the proofs now run as regression tests (`packages/contracts/test/AuditRegressions.t.sol`, `tests/audit`). This is an internal review, not a third-party audit; treat the example contracts accordingly.

## Documentation

- [Getting started](docs/getting-started.md)
- [Concepts](docs/concepts.md)
- [Security](docs/security.md)
- [Apple Wallet setup](docs/platforms/apple.md) and [Google Wallet setup](docs/platforms/google.md)
- [Deploying](docs/deploy.md)
- [FAQ](docs/faq.md)

## Development

```sh
pnpm install
pnpm build                 # TypeScript packages
pnpm test                  # vitest: unit, integration and end-to-end suites
git clone --depth 1 --branch v1.16.2 https://github.com/foundry-rs/forge-std packages/contracts/lib/forge-std
pnpm test:contracts        # Foundry
```

The end-to-end suite needs [Foundry](https://book.getfoundry.sh) (`anvil`) on your PATH or at `~/.foundry/bin`.

## License

[MIT](LICENSE). The ERC text itself is CC0.
