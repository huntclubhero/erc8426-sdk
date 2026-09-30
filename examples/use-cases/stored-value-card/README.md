# stored-value-card: a stablecoin card with punches (PUNCHCARD pattern)

```sh
pnpm --filter @erc8426-examples/use-cases demo:stored-value-card
```

Each card (`StoredValueCard.sol`) holds a stablecoin balance. A merchant terminal scans the QR code on the pass and charges the card. Every charge punches it, and 10 punches earn a free coffee. Anyone can top up a card. Only the owner can withdraw.

## What the pass shows

Balance, punches, free coffees, and the tap limits. The QR code is the charge capability. A "Redeem a free coffee" link appears when a reward is available. Every balance or punch change emits `PassUpdate`, and the pass is pushed with a lock-screen message ("Balance is now $...").

## Who can do what

| Action | Path | Why it is safe |
| - | - | - |
| Charge (QR scanned by the terminal) | **Capability link** with unsigned params `{ amount, merchant }` | It moves value, so the value bound is what makes it acceptable. That bound is **on chain**: at most $25 per charge and $100 and 20 charges per card per day, paid only to merchants the issuer registered. The params are not signed, and the bound holds for every possible value. |
| Redeem a free coffee | **Capability link** | It spends only rewards the card has earned, and moves no value. |
| Top up | **Anyone's transaction** | It can only add value. |
| Withdraw | **Owner transaction** only | It sends any amount to any address, which is an unbounded transfer and must never be pass-reachable. The relayer's `withdraw` reverts. |
| Switch off tap-to-pay | **Owner transaction** (`setOperatorRevoked`) | An on-chain remedy for a leaked QR. |
| Rotate the QR | **Signed** (`rotatePassLinks`) | The leaked QR stops resolving (404). |

## Spec conditions

- Gated configuration, and the capability configuration for charge and redeem only.
- The charge link is bound to one card and one action, and rotates on transfer and on request.
- Charges cannot transfer, burn or approve the card, and cannot move money anywhere except a registered merchant.
- **Documented bound:** at most $25 per charge and at most $100 and 20 charges per card per fixed 24 hour window (so at most twice that inside any 24 hour span), paid only to registered merchants. This is enforced by `BoundedAction` inside the card contract.
- The fresh `ownerOf` read runs on every scan.

## ERC-6551 mapping

In the production PUNCHCARD design, each card owns a token-bound account that holds the stablecoin. The account's owner-only `execute` plays the role of `withdraw`. The issuer is a spender inside the account whose per-transaction and daily caps the account enforces, which plays the role of `BoundedAction` here. The pass, the issuer config and the bound are the same either way.
