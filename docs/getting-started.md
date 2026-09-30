# Getting started

ERC-8426 lets an ERC-721 token advertise a native mobile wallet pass (Apple Wallet, Google Wallet). The token contract answers `passURI(tokenId)`, that URI resolves to a small JSON manifest of acquisition URLs, and any pass-reachable action is authorized by two checks, never by the pass itself. See [concepts](./concepts.md) for the model and [security](./security.md) for what each piece defends.

Pick your path:

- [A. An NFT project adding passes to a collection](#a-an-nft-project-adding-passes-to-a-collection)
- [B. A marketplace or wallet adding "Add to Wallet" for any compliant token](#b-a-marketplace-or-wallet-adding-add-to-wallet)
- [C. An issuer running the pass server](#c-an-issuer-running-the-pass-server)

## A. An NFT project adding passes to a collection

Discovery lives in the token contract. Clients call `passURI` and `supportsInterface(0xef5f1e71)` **on the token contract itself**, so the answer to "can my collection have passes" depends on whether that contract can gain two functions.

### New collection

Inherit `ERC721WalletPass` from [`@erc8426/contracts`](../packages/contracts/README.md):

```solidity
import {ERC721WalletPass} from "@erc8426/contracts/src/ERC721WalletPass.sol";

contract Pets is ERC721WalletPass, Ownable {
    constructor(address owner_)
        ERC721("Pets", "PET")
        ERC721WalletPass("https://pets.example/wallet-pass/")
        Ownable(owner_)
    {}

    function setPassBaseURI(string calldata base) external onlyOwner {
        _setPassBaseURI(base); // keep this: it is how you move servers later
    }
}
```

You get `passURI` (reverting for nonexistent ids, as the spec requires), the ERC-165 answer, and `PassUpdate` on every mint, transfer and burn. Call `_passUpdate(tokenId)` wherever state that the pass renders changes.

### Existing upgradeable collection

If the collection sits behind a proxy you control, ship an implementation that adds `passURI(uint256)`, returns `true` for `0xef5f1e71` in `supportsInterface`, and emits `PassUpdate` where rendered state changes. Storage layout rules for your proxy pattern apply as usual; `ERC721WalletPass` is a regular (non-upgradeable) OpenZeppelin extension, so port its few lines into your upgradeable base rather than inheriting it.

### Existing immutable collection

Be clear about this: **an immutable contract cannot become compliant.** A registry that maps someone else's `(contract, tokenId)` to a pass URI is not discoverable, because clients ask the token contract, and the standard deliberately has no registry. The honest options:

1. **A pass-enabled wrapper or receipt.** Holders deposit the original NFT and receive a 1:1 token from a new, compliant contract. That token carries `passURI`, and the issuer's fresh ownership read targets the wrapper. [`StakingPass`](../packages/contracts/src/examples/StakingPass.sol) is the worked pattern: stake an NFT from another collection, receive a pass-enabled receipt, burn it to get the original back. Unwrapping (burning the receipt) is an owner-signed action, never a pass link.
2. **Passes without discovery.** You can run the issuer for your own site and read ownership from the original contract, but wallets and marketplaces will not find the passes through the standard. That is a product, not ERC-8426 compliance.

### Then

1. Run the server (path C) and point the base URI at it.
2. Emit `PassUpdate` when rendered state changes, so distributors refresh.
3. Check it with [`@erc8426/conformance`](../packages/conformance/README.md):

   ```sh
   npx @erc8426/conformance --rpc $RPC --contract $CONTRACT --token 1
   ```

## B. A marketplace or wallet adding "Add to Wallet"

You need no relationship with the issuer. For React, [`@erc8426/react`](../packages/react/README.md):

```tsx
<WalletPassProvider options={{ publicClient }}>
  <AddToWalletButton contract={contract} tokenId={tokenId} signer={walletClient ? fromWalletClient(walletClient) : null} />
</WalletPassProvider>
```

Without React, [`@erc8426/client`](../packages/client/README.md):

```ts
const passes = createWalletPassClient({ publicClient });
if (await passes.supportsWalletPass(contract)) {
  const { url } = await passes.addToWallet({ contract, tokenId }, { signer }); // on click
  window.location.assign(url);
}
```

What the client does for you, because the spec asks it of you:

- Fetches the manifest at click time and never caches acquisition URLs.
- Handles both configurations. A gated issuer answers 401 with a challenge; the client checks the challenge is scoped to this token, this action, this signer and the serving host before asking the wallet to sign, then retries with the proof headers.
- Shows the issuing contract next to the button (the button does this by default). Pass fields can carry arbitrary links under an issuer's branding, so the contract address is the user's anchor.

A `403` means the connected wallet is not entitled; a `503` is retryable and carries `retryAfterSeconds`.

## C. An issuer running the pass server

Install [`@erc8426/issuer`](../packages/issuer/README.md) plus the platform packages you need: [`@erc8426/apple`](../packages/apple/README.md) and [`@erc8426/google`](../packages/google/README.md). Platform credentials take the longest; start them first ([Apple](./platforms/apple.md), [Google](./platforms/google.md)).

```ts
import { createIssuer, kvStores } from "@erc8426/issuer";
import { appleFormatProvider, createApnsClient } from "@erc8426/apple";
import { googleFormatProvider, googleWalletClient, saveOrigins } from "@erc8426/google";

export const apple = appleFormatProvider({
  passTypeIdentifier: "pass.com.pets.example",
  teamIdentifier: "ABCDE12345",
  certificates,                       // PEMs from your secret store
  origin: "https://pets.example",
  basePath: "/apple",                 // outside the issuer's /wallet-pass
  store: applePassStore,              // persistent ApplePassStore
  apns: createApnsClient({ certificate: { cert: certificates.signerCert, key: certificates.signerKey }, passTypeIdentifier: "pass.com.pets.example", store: applePassStore }),
});

const google = googleFormatProvider({
  client: googleWalletClient({ serviceAccount, issuerId: process.env.GOOGLE_ISSUER_ID! }),
  classSuffix: "pets_v1",
  origins: saveOrigins(["https://pets.example"]),
});

export const issuer = createIssuer({
  domain: "pets.example",
  baseUrl: "https://pets.example",
  chainId: 8453,
  contract: "0xYourCollection",
  mode: "gated",
  publicClient,
  stores: kvStores(kv),               // shared store with atomic getDel for nonces
  providers: [apple, google],
  render: ({ token, serial, links }) => ({
    serial,
    organizationName: "Pets",
    description: `Pet #${token.tokenId}`,
    title: "PETS",
    images: { icon: { url: "https://pets.example/icon.png" }, logo: { url: "https://pets.example/logo.png" } },
    links: Object.entries(links).map(([key, url]) => ({ key, label: key, url })),
  }),
});
```

Mount two handlers: `issuer.handler` under `/wallet-pass/*`, and `apple.webService` under `/apple/*` (Apple devices register and fetch updates there). The issuer hosts the `.pkpass` itself at a rotating capability URL, so the Apple provider needs no `linkSecret` in this mode. Framework recipes are in [deploy](./deploy.md).

Then:

1. Set the contract's pass base URI to `https://pets.example/wallet-pass/` (what `issuer.passUri(tokenId)` returns, minus the id).
2. Feed chain events: `watchTransfers` and `watchPassUpdates` on a long-running process, or `issuer.onTransfer` and `issuer.onPassUpdate` from an indexer webhook.
3. Choose `public` or `gated` deliberately (see [concepts](./concepts.md)). If passes carry action links, you want `gated`.
4. Before enabling capability links, read [security](./security.md) and work through its checklist.
5. Run the conformance CLI with the owner key in an environment variable to prove the gated owner path.
