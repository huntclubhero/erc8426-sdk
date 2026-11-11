# @erc8426/core

The shared, dependency-free building blocks of the [ERC-8426](https://eips.ethereum.org/EIPS/eip-8426) SDK: the interface id and ABIs, CAIP-19 token ids, the manifest format, the SIWE challenge and proof headers, the error codes, and the delivery types the issuer and the Apple and Google packages share. The other `@erc8426/*` packages build on it; most apps install those and get this one with them.

```sh
npm install @erc8426/core viem
```

## What is in it

| Module | Exports |
| - | - |
| Constants | `WALLET_PASS_INTERFACE_ID` (`0xef5f1e71`), `WALLET_PASS_ISSUER_INTERFACE_ID` (`0x470be7e9`), `ACQUIRE_ACTION`, `ROTATE_ACTION`, `PROOF_HEADER`, `SIGNATURE_HEADER`, `PKPASS_MEDIA_TYPE`, `FORMAT_APPLE`, `FORMAT_GOOGLE` |
| ABIs | `walletPassAbi` (`passURI`, `PassUpdate`, `BatchPassUpdate`), `walletPassIssuerAbi` (`passIssuer`), `erc165Abi`, `erc721Abi`, `erc4907Abi`, `erc4906Abi` |
| Token ids | `assetId`, `parseAssetId`, `tokenRef`, `sameToken`, `actionUrn`, `parseActionUrn` |
| Manifest | `createManifest`, `parseManifest` (shape checks with typed issues), `manifestPlatforms`, `readMetadataMirror`; the OPTIONAL `issuer` member and the issuer identity commitment: `PassIssuerIdentity`, `parsePassIssuer`, `parsePassIssuerJson`, `diffPassIssuer` |
| Challenge and proof | `buildChallenge`, `parseChallenge`, `generateNonce`, `proofHeaders`, `readProofHeaders` |
| Errors | `WalletPassError`, `WALLET_PASS_ERROR_CODES`, `statusForError`, `isProofRequiredBody` |
| Delivery types | `PassContent`, `PassContext`, `PassFormatProvider`, `PassFileProvider`, `isPassFileProvider` |

```ts
import { assetId, parseManifest, WALLET_PASS_INTERFACE_ID } from "@erc8426/core";

assetId(1, "0x...", 7); // "eip155:1/erc721:0x.../7"
const result = parseManifest(json); // { ok, manifest, issues }
```

ERC-8426 is merged as a Draft; 0.x tracks its text and may change with it. MIT licensed.
