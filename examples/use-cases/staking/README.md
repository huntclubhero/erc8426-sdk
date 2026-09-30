# staking: a staking receipt on a pass

```sh
pnpm --filter @erc8426-examples/use-cases demo:staking
```

Stake an NFT from another collection into `StakingPass.sol` and receive a pass-enabled receipt. Rewards accrue in an ERC-20. Claim is one tap from the pass. Unstake burns the receipt and returns the NFT, so it stays with the owner. This mirrors the claim versus withdraw split in Rare Friends Pass.

## What the pass shows

Claimable rewards, the staked NFT, the earning rate per day, and the stake date. Accrual is passive (no event), so the claimable figure is as of the last render; the rate is shown alongside it. Stake, claim, sale and unstake all emit `PassUpdate` or `Transfer`. After unstake, the burned receipt's pass is pushed as voided.

## Who can do what

| Action | Path | Why it is safe |
| - | - | - |
| Claim | **Capability link** (the appointed relayer sends it) | `claim` pays **only the receipt's current owner** and can never pay more than has accrued. Repeating it, or tapping a forwarded link, only pays the owner sooner. On chain only the owner, an approved account, or the appointed operator (rate limited to 24 claims per receipt per day) may call it, so a stranger cannot push rewards into an escrow or vault that holds the receipt. |
| Unstake | **Owner transaction** only | It burns the receipt and moves the NFT. The spec forbids a capability link from burning or transferring the token, and the issuer refuses the config (`IssuerConfigError` for a `transfersOrBurns` capability action), as the demo shows. The pass's Unstake link is a plain page where the owner confirms in their own wallet. |
| Transfer the receipt | **Owner transaction** | Accrued rewards travel with the receipt, like fees on a liquidity position NFT. |

## Spec conditions

- Gated configuration, and the capability configuration for claim only.
- **Documented bound:** pays accrued rewards to the receipt's current owner and nobody else; the total paid can never exceed what accrued; cannot unstake, transfer, approve or burn. This is bounded by construction in the contract.
- Links rotate on sale and burn. The seller's old Claim link returns 404, and the burned receipt's link is dead.
- The fresh `ownerOf` read runs on every tap, so a burned receipt refuses immediately.
