# FAQ

### Does this work with ERC-1155?

No. The spec puts ERC-1155 out of scope: fungible balances and many holders per id need a different binding between holder and pass. The future extension it describes would bind a specific account alongside the token id and test `balanceOf(account, id)` against a minimum holding (default 1) in the authorization check, keeping multi-holder semantics out of the pass itself. Nothing in this SDK implements that yet.

### Soulbound tokens?

They work, with one difference: a soulbound token never transfers, so transfer-driven rotation never fires. Rotation on the owner's request is then the only remedy for a leaked link, which is why the spec makes it mandatory in the capability configuration. The [`IdentityCredential`](../packages/contracts/src/examples/IdentityCredential.sol) example (ERC-5192) shows the pattern, including an on-chain `requestPassRotation` signal.

### My collection is immutable. Can it have passes?

Not through this standard directly: clients ask the token contract for `passURI`, and an immutable contract cannot add it. Use a pass-enabled wrapper or receipt token, like the [`StakingPass`](../packages/contracts/src/examples/StakingPass.sol) pattern. See [getting started](./getting-started.md#existing-immutable-collection).

### Mac and desktop?

Apple Wallet passes open in Safari on macOS, which previews the pass and adds it to the Wallet of the iPhone or Apple Watch on the same Apple Account. A Save to Google Wallet link works in any desktop browser and saves to the Google account, where it appears on that account's Android devices. The client treats macOS Safari as Apple and other desktop browsers as Google, and you can force a platform.

### Android without Google Wallet?

Google Wallet is not available on every device (no Google Play services) or in every country. There the save link cannot complete. Some third-party Android apps open `.pkpass` files; the SDK does not target them, and an issuer can offer the Apple file as a download regardless. The token and its web experience are unaffected.

### What does it cost?

- Apple: the Apple Developer Program membership (yearly). Pass signing and APNs pushes have no per-pass fee.
- Google: the Wallet API has no fee; a Google Cloud project is needed for the service account.
- Chain: `PassUpdate` events cost gas where you emit them. The interface adds one view function and two events; nothing is written on chain for acquisition.
- Hosting: the issuer server, a shared store for nonces, and a relayer if you run capability actions (it pays gas for them).

### What if the issuer server goes down?

Ownership is unaffected: the token lives on chain, and nothing in a pass or on the server can move it. While the server is down, manifests do not resolve, new passes cannot be added, installed passes stop updating, and pass links fail. Installed passes keep showing their last content. If the contract kept a pass base URI setter (the base contract's `_setPassBaseURI`), the collection owner can point `passURI` at a replacement server; holders then re-acquire through the new manifest.

### Is a pass proof of ownership?

No, never. A pass file, an acquisition URL and the ability to add a pass to a wallet all fail as ownership proofs, because passes are forwarded, backed up and installed anywhere. Anything state-changing needs the two checks in [concepts](./concepts.md#the-two-checks), and the fresh ownership read runs every time.

### Public or gated?

Public if the pass only displays the token and carries no action links: simplest, and marketplaces can show it without a signature. Gated as soon as the pass can trigger anything, or the acquisition URLs should reach only the owner. See [concepts](./concepts.md#configurations).

### Can I rent or delegate pass access?

Yes, with a documented entitlement policy read fresh on every request: `rental4907()` (an active renter is exclusive of the owner for covered actions) and `delegateRegistry()` (delegate.xyz v2, additive), composed with `anyOf`. See the [issuer README](../packages/issuer/README.md#entitlement).

### How do I check an implementation?

```sh
npx @erc8426/conformance --rpc $RPC --contract $CONTRACT --token 412
# gated issuers: also prove the owner path (the key is read from the environment only)
ERC8426_OWNER_KEY=0x... npx @erc8426/conformance --rpc $RPC --contract $CONTRACT --token 412
```

Exit code 0 means every MUST checked passed. See the [conformance README](../packages/conformance/README.md).
