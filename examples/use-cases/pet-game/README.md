# pet-game: care for a pet from the pass (WALLETCHI pattern)

```sh
pnpm --filter @erc8426-examples/use-cases demo:pet-game
```

Each token is a pet (`PetPass.sol`). A pet has three needs (food, water, play). If any need goes unmet for three days the pet dies. That happens passively, with no transaction and no event. The back of the pass carries Feed, Water and Play links that work with one tap and no signature.

## What the pass shows

Mood, hunger, thirst and boredom (0 to 100%), the number of cares, and the "needs care by" deadline. The deadline is a date on the pass, so the device counts it down between pushes. Every care emits `PassUpdate`, and the issuer pushes fresh content. When the pet is sold, the seller's pass is pushed as voided.

## Who can do what

| Action | Path | Why it is safe |
| - | - | - |
| Feed, Water, Play | **Capability link** (one tap, no signature) | Care cannot transfer, burn or approve the pet, and it cannot change who owns it. The relayer's authority is capped **on chain** by `BoundedAction`: 4 of each care per pet per day, moving no value. |
| Rotate the links | **Signed** (`rotatePassLinks`, owner signs a `rotate` challenge) | This is the owner's remedy for a leaked link, and a MUST in the capability configuration. |
| Switch every relayer off for this pet | **Owner transaction** (`setAllOperatorsRevoked`) | An on-chain remedy that does not depend on the issuer. It also covers relayer keys the issuer rotates in later, and only the owner can switch it back on. |
| Transfer, approve, burn | **Owner transaction** only | These are never reachable from the pass. The relayer's `transferFrom` reverts. |

## Spec conditions (The capability configuration)

- Gated configuration: the manifest needs an `acquire` proof (401 without one, 403 for a non-owner).
- Links are 256-bit capability URLs, each bound to one token and one action.
- Links rotate on transfer (the indexer calls `onTransfer`) and on the owner's request.
- The action cannot transfer, burn or approve the token, and cannot change entitlement.
- **Documented bound:** each care runs at most 4 times per pet per fixed on-chain window of 24 hours (so at most 8 inside any 24 hour span). It moves no tokens and no value. The contract enforces this, not the server.
- Authority is limited on chain to the care functions (`onlyBoundedAction`).
- The fresh `ownerOf` read runs on every tap.

## The disclosed residual

A forwarded link works for whoever holds it while the owner is unchanged. The demo shows this on purpose: a friend waters the pet through a forwarded link. The worst such a link can do is care for the pet a few times a day. The owner's remedies are rotating the links and switching the relayers off on chain, and both are shown.
