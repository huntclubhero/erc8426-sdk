# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Setup

```sh
pnpm install
pnpm build
pnpm test
git clone --depth 1 --branch v1.16.2 https://github.com/foundry-rs/forge-std packages/contracts/lib/forge-std
pnpm test:contracts
```

You need Node 20 or newer, pnpm 10, and [Foundry](https://book.getfoundry.sh) for the contracts and the end-to-end suite.

## Ground rules

- The ERC text is normative. If code and spec disagree, the spec wins; if you think the spec is wrong, raise it on the [Ethereum Magicians thread](https://ethereum-magicians.org/t/erc-8426-wallet-pass-extension-for-nfts/29358).
- Every MUST in the spec has a test. Name tests after the requirement they prove.
- Security behavior never regresses silently: a change to the authorization floor, rotation, or capability links needs a test that fails without it.
- Never commit keys or certificates. Tests generate them at runtime.
- Packages depend only on `@erc8426/core`, `viem`, and what their README lists. Keep them small.
