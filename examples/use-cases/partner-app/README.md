# partner-app: pass links that open a partner app

```sh
pnpm --filter @erc8426-examples/use-cases demo:partner-app
```

The pass is a shortcut into a partner app, not a remote control. Its links are universal links (`https://app.petpals.example/pet/1?do=care`). On a phone with the app installed they open the app; without it, they open the partner's website. The app holds the user's signer (an embedded wallet) and runs every action on the **signed path** through `@erc8426/client`. That gives it full programmability beyond what a static pass can do. The demo simulates the app as a script and uses `PetPass.sol`.

## What the pass shows

The pet's state, the care count, and the deadline, plus "Open in PetPals" and "Care for your pet" links. No capability links exist: the capability configuration is off.

## Who can do what

| Action | Path | Why it is safe |
| - | - | - |
| Care (one or more kinds in one request) | **Signed** `care` challenge from the app, with params `{ kinds }` | Forwarding is closed: a friend who opens the forwarded link in their own app signs with their own wallet and gets 403. Params are not signed, so they only choose among care kinds, and every choice stays inside the contract's on-chain bound (the 5th feed in a window is refused even with a valid signature). |
| Activity feed | **Read** (`client.getPassUpdates`) | Reads public `PassUpdate` history. |
| Owner transactions (play directly, gift the pet) | **Owner transaction** from the app's embedded wallet | The app is a full wallet. After a gift, the old session's signed actions get 403 from the fresh read. |

## Why use this pattern

- Nothing on the pass carries authority, so there is no forwarding residual to disclose or bound. The spec's check (1) (a per-action signature) holds everywhere the product can carry a signature, and an app can.
- The app can batch actions, take choices as params, show live state and history, and ask for confirmation. None of that fits in a static pass.
- The issuer, manifest, rotation and freshness machinery are identical to the capability demos.
