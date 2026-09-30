# ERC-8426 use cases, end to end

Eight runnable stories that show what a wallet pass can safely do for a token. Each demo:

1. spawns a fresh `anvil` chain on a random port;
2. deploys the contract from `@erc8426/contracts` with runtime-generated keys;
3. starts an `@erc8426/issuer` on a local HTTP port (`toNodeHandler`);
4. walks the story with `@erc8426/client`, printing the manifest, the pass as a device would show it, each action's result, the on-chain state, and every request that is refused and why.

```sh
pnpm --filter @erc8426-examples/use-cases demo:all        # every demo, with a summary
pnpm --filter @erc8426-examples/use-cases demo:pet-game   # one demo
```

Requirements: Foundry's `anvil` (`~/.foundry/bin/anvil`, or set `ANVIL_PATH`), and the workspace packages built (`pnpm build`).

| Demo | Story | Pass-reachable (capability link) | Signed challenge | Owner or role transaction only | Documented bound |
| - | - | - | - | - | - |
| [pet-game](pet-game) | WALLETCHI: care for a pet from the pass; it dies if neglected | feed, water, play | rotate | transfer, revoke relayer | 4 of each care per pet per day, on chain, no value |
| [stored-value-card](stored-value-card) | PUNCHCARD: stablecoin card charged by merchants, punches, free coffee | charge (QR), redeem | rotate | withdraw, switch off tap-to-pay | $25 per charge, $100 and 20 charges per day, registered merchants only, on chain |
| [staking](staking) | Stake an NFT; the receipt pass claims rewards | claim | rotate | unstake (burns), transfer | pays only the current owner, never more than accrued |
| [event-ticket](event-ticket) | Scan to check in, keepsake after the show, BatchPassUpdate | check-in (barcode) | rotate | resale, show admin | once per ticket, only before the show ends |
| [membership](membership) | Tiers, expiry, gifts, a venue access check | none | enter (venue), rotate | renew (payer), tier changes (club) | n/a |
| [identity-credential](identity-credential) | Soulbound ID card, verifier by signed challenge, revocation | none | verify, rotate | issue, revoke (attester), request rotation (holder) | n/a |
| [rental](rental) | ERC-4907: the renter holds the pass exclusively | unlock | rotate | setUser, transfer | opens the lock only, for the currently entitled account |
| [partner-app](partner-app) | Pass links open a partner app that signs every action | none | care (batched, params) | owner transactions from the app | on-chain bound still applies to the relayer |

## Layout

- `lib/anvil.ts`: spawn anvil on a free port and wait for it.
- `lib/chain.ts`: viem clients, runtime actors funded with `anvil_setBalance`, deploy from `@erc8426/contracts/artifacts`, send and read. It also forwards `Transfer`, `PassUpdate` and `BatchPassUpdate` from receipts to the issuer (`onTransfer`, `onPassUpdate`), standing in for an indexer webhook or `watchTransfers` / `watchPassUpdates`.
- `lib/server.ts`: listen first, then build the issuer, because its `domain` and `baseUrl` must be the exact origin that serves it (clients refuse to sign a challenge for any other domain).
- `lib/preview.ts`: a stand-in wallet platform. Apple and Google passes need issuer certificates and platform accounts, so the demos plug in a `PassFileProvider` under the manifest key `preview`. It serves the rendered `PassContent` as JSON from the issuer's rotating download URL and prints every push. Swap in `@erc8426/apple` and `@erc8426/google` for production; the issuer config does not change.
- `lib/demo.ts`: installing a pass, tapping a link (GET describes the link, POST acts), and mapping contract reverts to `ActionError`.
- `lib/narrate.ts`: output formatting and expectations. A demo exits non-zero if any expectation fails.

## Reading the output

- `ok` is an expected success; `refused` is an expected refusal with the status and reason; `FAILED` is a broken expectation.
- `push` lines show what an installed pass would receive. `(VOIDED)` marks a superseded or revoked pass.
- `indexer:` lines show chain events reaching the issuer.
