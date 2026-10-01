# @erc8426/core

The shared, dependency-free building blocks of the [ERC-8426](https://ethereum-magicians.org/t/erc-8426-wallet-pass-extension-for-nfts/29358) SDK: the interface id and ABIs, CAIP-19 token ids, the manifest format, the SIWE challenge and proof headers, the error codes, and the delivery types the issuer and the Apple and Google packages share. The other `@erc8426/*` packages build on it; most apps install those and get this one with them.

```sh
npm install @erc8426/core viem
```

## What is in it

| Module | Exports |
| - | - |
| Constants | `WALLET_PASS_INTERFACE_ID` (`0xef5f1e71`), `ACQUIRE_ACTION`, `ROTATE_ACTION`, `PROOF_HEADER`, `SIGNATURE_HEADER`, `PKPASS_MEDIA_TYPE`, `FORMAT_APPLE`, `FORMAT_GOOGLE` |
| ABIs | `walletPassAbi` (`passURI`, `PassUpdate`, `BatchPassUpdate`), `erc165Abi`, `erc721Abi`, `erc4907Abi`, `erc4906Abi` |
| Token ids | `assetId`, `parseAssetId`, `tokenRef`, `sameToken`, `actionUrn`, `parseActionUrn` |
| Manifest | `createManifest`, `parseManifest` (shape checks with typed issues), `manifestPlatforms`, `readMetadataMirror` |
| Challenge and proof | `buildChallenge`, `parseChallenge`, `generateNonce`, `proofHeaders`, `readProofHeaders` |
| Errors | `WalletPassError`, `WALLET_PASS_ERROR_CODES`, `statusForError`, `isProofRequiredBody` |
| Delivery types | `PassContent`, `PassContext`, `PassFormatProvider`, `PassFileProvider`, `isPassFileProvider` |

```ts
import { assetId, parseManifest, WALLET_PASS_INTERFACE_ID } from "@erc8426/core";

assetId(1, "0x...", 7); // "eip155:1/erc721:0x.../7"
const result = parseManifest(json); // { ok, manifest, issues }
```

0.x tracks the draft standard and may change with it. MIT licensed.
