# @erc8426/client

Discover, resolve and acquire [ERC-8426](https://eips.ethereum.org/EIPS/eip-8426) wallet passes from any compliant token. For marketplaces, wallet apps, indexers and anyone who wants an "Add to Apple Wallet" or "Save to Google Wallet" action on a token they did not issue.

```sh
npm install @erc8426/client @erc8426/core viem
```

## What it does for you

- **Discovery.** `supportsWalletPass` runs the full ERC-165 detection procedure for `0xef5f1e71` and answers `false` (never throws) for contracts without ERC-165.
- **Both configurations.** A manifest served without a proof is the public configuration. A `401 proof_required` is the gated configuration: the client fetches the acquire challenge, has your signer sign it, and retries with the `X-Wallet-Pass-Proof` and `X-Wallet-Pass-Signature` headers.
- **Protection for the signer.** Before a challenge reaches the signer, the client checks it is scoped to what the user asked for: the SIWE domain is the host that served the challenge, the address is the signer, the chain id and CAIP-19 token are the requested token, the action is the requested action, and the expiration is in the future and not too far away. Anything else is refused with `source: "client"` and nothing is signed.
- **No caching.** The spec says clients MUST NOT durably cache acquisition URLs and SHOULD fetch the manifest at the moment of the add-to-wallet action. Every call re-reads `passURI` and refetches the manifest.
- **Typed errors.** `403` is always `not_owner` (the spec reserves it for a verified proof from an account that is not entitled). `503` is `read_failed` with `retryable: true` and `retryAfterSeconds` from `Retry-After`. Other refusals keep the issuer's `error` code when it is a core code; an issuer code outside the core set (an integrator's cooldown, `invalid_params`) becomes `action_refused` for a 4xx or `server_error` for a 5xx, with the issuer's string in `serverCode`. `network` means only a fetch that failed or timed out.
- **Typed chain reads.** A `passURI` or `tokenURI` revert (a token that does not exist or was burned) is `not_found` with `source: "chain"`; an address with no contract is `unsupported`; an RPC that could not answer is `network` with `retryable: true`. No raw viem error escapes.
- **Freshness events.** `PassUpdate` and `BatchPassUpdate` (inclusive range) come through one callback shape.

## Quick start

```ts
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { createWalletPassClient } from "@erc8426/client";

const passes = createWalletPassClient({
  publicClient: createPublicClient({ chain: mainnet, transport: http() }),
});

const token = { contract: "0x5F9B5a1cdED9d6B3f5E8a2C47B0e13d6A8F4c2e1", tokenId: 412n };

if (await passes.supportsWalletPass(token.contract)) {
  const { manifest, configuration } = await passes.getManifest(token);
  console.log(configuration, Object.keys(manifest.formats));
}
```

## Marketplace "Add to Wallet" button

Fetch on click, not on page load, and show the issuing contract next to the button (Client requirements: clients SHOULD present the issuing contract address alongside the action).

```ts
import { fromWalletClient, originMatches, WalletPassClientError } from "@erc8426/client";

async function onAddToWalletClick() {
  try {
    const { url } = await passes.addToWallet(token, {
      // Only needed for gated passes. A viem LocalAccount works as is.
      signer: walletClient ? fromWalletClient(walletClient) : undefined,
    });
    window.location.assign(url); // .pkpass hands off to Wallet; a Google link opens the save flow
  } catch (e) {
    if (e instanceof WalletPassClientError) {
      if (e.code === "proof_required") return promptConnectWallet();
      if (e.code === "not_owner") return showMessage("This wallet does not own the token.");
      if (e.retryable) return showMessage(`Try again in ${e.retryAfterSeconds ?? 5}s.`);
    }
    throw e;
  }
}

const issuer = await passes.issuerDisplay(token);
// issuer.contractShort -> "0x5F9B...c2e1", issuer.origin -> "https://issuer.example"
```

`addToWallet` picks the platform from `navigator.userAgent` (iPhone, iPad and macOS Safari get Apple; Android gets Google; anything else gets Google, whose save link works in any browser, then Apple). Force one with `platform: "apple"`. For React, use [`@erc8426/react`](../react).

## Wallet app discovery

A wallet that shows a user's NFTs can surface passes for all of them, and keep them fresh:

```ts
for (const nft of ownedNfts) {
  if (!(await passes.supportsWalletPass(nft.contract))) continue;
  const display = await passes.issuerDisplay(nft);
  const trusted = originMatches(display.passUri, collectionWebsites[nft.contract] ?? []);
  showPassAction(nft, { issuer: display.contractShort, origin: display.origin, trusted });
}

// Regenerate or refresh when content changes. Omit the contract to watch every collection.
const unwatch = passes.watchPassUpdates(undefined, (u) => {
  if (Array.isArray(u.tokenIds)) refresh(u.contract, u.tokenIds);
  else refreshRange(u.contract, u.tokenIds.from, u.tokenIds.to); // inclusive
});

// Backfill after downtime.
const missed = await passes.getPassUpdates({ fromBlock: lastSeenBlock, toBlock: "latest" });
```

The `wallet_pass` metadata mirror is available through `readMetadataMirror(token)`. It is marked `authoritative: false`: when both exist the manifest behind `passURI` wins, and a gated issuer must not mirror URLs at all.

## Signed actions

For pass-reachable actions on the signed path (the user signs each action), `signedAction` requests a challenge for the action, checks its scope, signs it, and POSTs `{ message, signature, params, chainId, contract, tokenId, action }`:

```ts
const result = await passes.signedAction({
  token,
  action: "feed",
  signer: fromWalletClient(walletClient),
  params: { amount: 1 },
});
```

Route conventions (the spec standardizes the proof, not the routes, so both are overridable):

- Challenge: the URL named in the manifest's `401` body, with `?address=0x...&action=feed` added. If the manifest is public (no 401), `{passBase}/challenge`. Override with `challengeEndpoint`.
- Action: `{passBase}/actions/{action}`, where `passBase` is the resolved `passURI` without query or trailing slash. Override with `endpoint`.

These match the `@erc8426/issuer` routes. Query parameters are always added with `URLSearchParams`, so a challenge URL that already carries a query (for example `.../challenge?action=rotate`) keeps working.

### Rotating links

`rotatePassLinks(token, { signer })` asks the issuer to rotate every acquisition URL and capability link for the token, the owner's remedy for a leaked link (issuers MUST offer it in the capability configuration). It signs a `rotate` challenge, which cannot acquire or act, and POSTs it to `{passBase}/rotate`.

`requestChallenge(token, action, account)` is the lower-level step on its own, returning the scope-checked message and its parsed fields.

## Issuer notes (CORS)

The first manifest request is a plain GET, so it needs no preflight. The gated retry carries `X-Wallet-Pass-Proof` and `X-Wallet-Pass-Signature`, so a browser client needs the issuer to answer the preflight with `Access-Control-Allow-Headers: X-Wallet-Pass-Proof, X-Wallet-Pass-Signature`.

## API

`createWalletPassClient(options)`:

| option | |
| - | - |
| `publicClient` | viem client for the token's chain (required) |
| `fetch` | fetch implementation, default global `fetch` |
| `ipfsGateway`, `arweaveGateway` | gateways for `ipfs://` and `ar://`, default `https://ipfs.io` and `https://arweave.net` |
| `maxChallengeTtlSeconds` | longest challenge lifetime the client will sign, default 3600 |
| `trustedChallengeDomains` | extra SIWE domains to accept, for development only |

Returns:

| method | |
| - | - |
| `supportsWalletPass(contract)` | `Promise<boolean>` |
| `getPassURI(token)` | `Promise<string>` raw `passURI` |
| `resolvePassURI(uri)` | gateway-rewritten URL (http, https, data pass through) |
| `getManifest(token, { signer?, signal? })` | `Promise<{ manifest, configuration, passUri, url, issues }>` |
| `getAcquisitionUrl(token, platform, { signer? })` | `Promise<string>` |
| `addToWallet(token, { signer?, platform?, userAgent? })` | `Promise<{ url, platform, configuration, manifest }>` |
| `readMetadataMirror(token)` | `Promise<{ authoritative: false, tokenUri, result }>` |
| `requestChallenge(token, action, account, { endpoint? })` | `Promise<{ message, parsed, challengeUrl }>` |
| `signedAction({ token, action, signer, endpoint?, challengeEndpoint?, params? })` | `Promise<{ status, body }>` |
| `rotatePassLinks(token, { signer, endpoint?, challengeEndpoint? })` | `Promise<{ status, body }>` |
| `issuerDisplay(token)` | `Promise<{ chainId, contract, contractShort, tokenId, passUri, origin }>` |
| `watchPassUpdates(contract \| undefined, onUpdate, opts?)` | unwatch function |
| `getPassUpdates({ contract?, fromBlock?, toBlock? })` | `Promise<PassUpdateNotice[]>` |

Standalone helpers: `detectPlatform(ua)`, `choosePlatform(available, detected)`, `resolveUri(uri, gateways)`, `decodeDataUri(uri)`, `uriOrigin(uri)`, `originMatches(passUri, expectedOrigins)`, `passBase(url)`, `shortAddress(address)`, `fromWalletClient(walletClient, account?)`, `checkChallengeScope(message, expected)`, `domainsForUrl(url)`, `passUpdateCovers(update, tokenId)`, `normalizePassUpdateLog(log)`, `errorFromResponse(status, headers, body)`, `errorFromChainRead(error, what)`, `parseRetryAfter(value)`, and the `WalletPassClientError` class (a `WalletPassError` with `source` (`server`, `chain` or `client`), `retryable`, `retryAfterSeconds`, `challenge`, `serverCode`, `body`; an issuer code outside the core set becomes `action_refused` (4xx) or `server_error` (5xx) and is kept verbatim in `serverCode`; `network` means only a failed or timed out fetch).

## License

MIT
