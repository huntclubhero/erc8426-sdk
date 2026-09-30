# rental: the renter holds the pass, exclusively (ERC-4907)

```sh
pnpm --filter @erc8426-examples/use-cases demo:rental
```

A beach house key (`RentalPass.sol` from `@erc8426/contracts`, which is the SDK's `ERC721WalletPassRentable` plus a mint). The host rents it out with ERC-4907 `setUser`. During the rental the guest, and only the guest, holds the wallet pass and its Unlock link. At check out the key returns to the host with no transaction.

## What the pass shows

The guest's pass shows "Guest key", the check out time, and an Unlock link, and its `expiresAt` is set to check out, so it presents as expired afterwards. The host's pass shows "Owner key" and whether the house is rented out. A superseded pass is pushed voided ("No longer active").

## Entitlement policy (documented, as the spec requires)

`entitlement: rental4907()` (exclusive, the spec's RECOMMENDED precedence):

- While `userOf` is non-zero and not expired, the renter is the only entitled account for every covered action, `acquire` included. The owner is vetoed, so the host's manifest request gets 403 and the host's still-live Unlock link is refused by the fresh read, before any rotation.
- With no active rental, the owner alone is entitled. Expiry is passive, and the guest's link and manifest are refused once `userOf` reads zero.
- `userOf` and `ownerOf` are read fresh on every request. The contract exposes the same rule as `passHolderOf(tokenId)`.
- Each change of pass holder is a first claim that rotates every link. The guest's claim retires the host's links, and the host's claim after check out retires the guest's.

## Who can do what

| Action | Path | Why it is safe |
| - | - | - |
| Unlock the door | **Capability link** | It changes no on-chain state and moves no value. It works only for the currently entitled account (fresh read), and its link rotates at every change of holder. **Documented bound:** opens the lock and logs the entry, nothing else. |
| Rent out (`setUser`) | **Owner transaction** | It changes who is entitled, so it is never pass-reachable. The guest cannot extend their own stay (reverts). |
| Transfer | **Owner transaction** | The guest's `transferFrom` reverts. A transfer clears the rental (ERC-4907 reference behavior). |
