# membership: tiers, expiry, renewals, and a venue access check

```sh
pnpm --filter @erc8426-examples/use-cases demo:membership
```

`MembershipPass.sol` holds tiered memberships with an expiry. Anyone can pay to renew one (a gift works). The club grants time and changes tiers. A venue checks access by asking the member to sign.

## What the pass shows

Tier (Silver or Gold, with colors to match), status, and the expiry date. The pass's own `expiresAt` makes a lapsed membership present as expired. The barcode identifies the membership as a CAIP-19 id. It is public data, not a credential. A "Renew or upgrade" link opens the club's web page.

## Who can do what

| Action | Path | Why it is safe |
| - | - | - |
| Enter a venue | **Signed** `enter` challenge, checked by `POST /venue/access` (which calls `issuer.authorize`) or by the standard `POST /wallet-pass/:id/actions/enter` | The member proves presence with their own key. The proof is single-use (a replay is refused with `nonce_invalid`). A copy of the pass signed with another key is refused with 403 `not_owner`. A forged signature is refused with 401. |
| Renew | **Payer's transaction** (`renew`, payable) | Anyone may pay, and it only extends. |
| Grant, extend, change tier | **Club transaction** (contract owner) | Members cannot change their own tier. |

There are no capability links: getting in the door must not work from a forwarded pass.

## Spec conditions

- Gated configuration, with no capability configuration.
- Check (1): each `enter` challenge names the token, the action, a single-use nonce, an expiry and the verifier's domain.
- Check (2): a fresh `ownerOf` read on every check.
- Expiry is passive. The venue reads `isActive` at request time, so a lapsed member with a valid signature is turned away (`expired`).
