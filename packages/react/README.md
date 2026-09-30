# @erc8426/react

React hooks and an accessible Add to Wallet button for [ERC-8426](https://eips.ethereum.org/EIPS/eip-8426) wallet passes. No styling framework, no bundled artwork, safe to render on the server.

```sh
npm install @erc8426/react @erc8426/client @erc8426/core viem react
```

## Button

```tsx
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { AddToWalletButton, WalletPassProvider } from "@erc8426/react";
import { fromWalletClient } from "@erc8426/client";

const publicClient = createPublicClient({ chain: mainnet, transport: http() });

export function TokenPage({ contract, tokenId, walletClient }) {
  return (
    <WalletPassProvider options={{ publicClient }}>
      <AddToWalletButton
        contract={contract}
        tokenId={tokenId}
        signer={walletClient ? fromWalletClient(walletClient) : null}
        onError={(e) => console.warn(e)}
      />
    </WalletPassProvider>
  );
}
```

What the button does:

- Fetches the manifest **when clicked**, never on render, and navigates to the chosen platform's acquisition URL. Nothing is cached (spec Client requirements).
- Labels itself "Add to Apple Wallet" or "Save to Google Wallet" once the platform is known (forced with `platform`, or detected from the user agent after mount), and "Add to Wallet" before that.
- Shows the issuing contract under the button, "Issued by contract 0x5F9B...c2e1", with the full address in `title` and linked through `aria-describedby`. The spec says clients SHOULD present the issuing contract alongside the action; turn it off with `showIssuer={false}` only if you show it elsewhere.
- Sets `aria-busy` and disables itself while working, and renders failures in a `role="alert"` element with a plain sentence (for example "The connected wallet does not own this token.").
- Renders a `<span data-wallet-pass="container">` holding `button[data-wallet-pass="button"][data-platform]`, `small[data-wallet-pass="issuer"]` and `span[data-wallet-pass="error"]`, so you can style it with any system. `className` goes on the button, `containerClassName` on the wrapper; other button attributes pass through.

### Official badges

Apple and Google publish official badge artwork with usage rules, and this package does not bundle either. Download them from:

- Apple: [Add to Apple Wallet guidelines](https://developer.apple.com/wallet/add-to-apple-wallet-guidelines/)
- Google: [Google Wallet brand guidelines](https://developers.google.com/wallet/generic/resources/brand-guidelines)

and pass them as children. A function child receives the resolved platform, so one button can switch badges. The accessible name stays the text label.

```tsx
<AddToWalletButton contract={contract} tokenId={tokenId} signer={signer}>
  {({ platform, busy }) =>
    platform === "google" ? <img src="/badges/google-wallet.svg" alt="" /> : <img src="/badges/apple-wallet.svg" alt="" />
  }
</AddToWalletButton>
```

## Hooks

All hooks read the client from `WalletPassProvider` (pass `client={...}` or `options={...}`).

```tsx
const { supported, status } = useSupportsWalletPass(contract);

const pass = useWalletPass({ contract, tokenId, signer, checkSupport: true });
// pass.status: "idle" | "adding" | "added" | "error"
// pass.supported, pass.platform, pass.error, pass.addToWallet(), pass.reset()

const { lastUpdate, count } = usePassUpdates(contract, { tokenId, onUpdate: refetchPreview });
```

`useWalletPass` also accepts `platform`, `navigate` (replace `window.location.assign`, for in-app browsers or tests), `onAdded` and `onError`. `useDetectedPlatform()` and `useWalletPassClient()` are exported for custom UIs, as are `labelForPlatform(platform)` and `describeError(error)`.

## Server rendering

Nothing reads `window`, `document` or `navigator` at import or during render. Platform detection and the ERC-165 check run in effects, so the server and the first client render agree.

## License

MIT
