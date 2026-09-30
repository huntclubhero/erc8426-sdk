# identity-credential: a soulbound ID card on a pass

```sh
pnpm --filter @erc8426-examples/use-cases demo:identity-credential
```

`IdentityCredential.sol` holds a non-transferable (ERC-5192) credential issued by an attester, with an expiry, and revocable. The pass is the ID card. A verifier (a bar checking age, a building checking access) asks the holder to sign a one-time challenge.

## What the pass shows

What the credential attests ("Over 18"), its status (Valid, Expired, REVOKED), the expiry, and the issue date. Revocation pushes the pass as voided. The chain holds only a salted hash of the claim, never personal data.

## Who can do what

| Action | Path | Why it is safe |
| - | - | - |
| Verify | **Signed** `verify` challenge, posted by the verifier to `POST /wallet-pass/:id/actions/verify` | The issuer runs both checks (signature and a fresh `ownerOf`) and then reports `valid`, `expired` or `revoked`. An impostor with a copy of the card and their own key gets 403. A challenge for the holder signed by someone else gets 401. |
| Request pass rotation | **Holder transaction** (`requestPassRotation`) or signed `rotatePassLinks` | Every link and download URL changes. The lost phone's pass download returns 404. |
| Issue, revoke, extend | **Attester transaction** | Only the attester role can do these. |
| Transfer | Impossible | `transferFrom` reverts with `CredentialSoulbound`. |

## Why rotation on request matters here

ERC-8426 rotates acquisition URLs when a transfer is observed. A soulbound token never transfers, so transfer rotation never fires, and a leaked pass stays live for as long as the holder is unchanged. Rotation on the owner's request is the only remedy. This contract lets the holder request it on chain (an event the issuer's indexer acts on), and the demo shows that path.

## Spec conditions

- Gated configuration, with no capability links: an identity check cannot be delegated to whoever holds a URL.
- The pass is a bearer artifact and proves nothing on its own; verification always takes the holder's signature plus the fresh read.
