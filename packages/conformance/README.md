# @erc8426/conformance

Check a token contract and the pass server its `passURI` points at against every requirement of [ERC-8426](https://eips.ethereum.org/EIPS/eip-8426) that can be observed from outside. Use it in CI for your issuer, or to vet a collection before integrating it.

```sh
npx @erc8426/conformance --rpc https://rpc.example --contract 0x5F9B...c2e1 --token 412
```

With the owner's key, the suite also proves the owner path of a gated issuer (200 with `Cache-Control: no-store`, and a replayed proof refused). The key is only read from an environment variable, never from a flag, so it stays out of shell history, process listings and the report:

```sh
export ERC8426_OWNER_KEY=0x...    # or any name, with --owner-key-env NAME
npx @erc8426/conformance --rpc $RPC --contract $CONTRACT --token 412 --nonexistent-token 999999
```

Exit codes: `0` conforms to every MUST checked, `1` a MUST check failed, `2` usage error. SHOULD failures are reported as warnings and do not change the exit code. `--json` prints the full report.

## What is checked

Each check has a stable id, the spec section it enforces, and its level.

| id | level | section | check |
| - | - | - | - |
| `contract.erc165` | MUST | Contract interface | `supportsInterface(0x01ffc9a7)` is true |
| `contract.erc165-invalid` | MUST | Contract interface | `supportsInterface(0xffffffff)` is false |
| `contract.interface-id` | MUST | Contract interface | `supportsInterface(0xef5f1e71)` is true |
| `contract.passuri` | MUST | Contract interface | `passURI(tokenId)` returns a URI |
| `contract.passuri-nonexistent` | MUST | Contract interface | `passURI` reverts for a nonexistent token |
| `manifest.reachable` | MUST | Pass manifest | the endpoint answers 200 (public) or 401 (gated) |
| `manifest.valid` | MUST | Pass manifest | non-empty `formats`, `google` is a Save link, `updatedAt` integer seconds |
| `manifest.lint` | SHOULD | Pass manifest | https URLs, `updatedAt` not in milliseconds |
| `manifest.apple-media-type` | MUST | Pass manifest | the `apple` URL is served as `application/vnd.apple.pkpass` |
| `manifest.apple-reachable` | SHOULD | Pass manifest | reported only when the `apple` URL cannot be fetched |
| `mirror.valid` | MUST | Metadata mirror | a `wallet_pass` in `tokenURI` metadata is a valid manifest |
| `mirror.gated-no-urls` | MUST | Metadata mirror | a gated issuer mirrors no acquisition URLs |
| `gated.401-proof-required` | MUST | Gated acquisition | no proof: 401, `error: "proof_required"`, a `challenge` URI |
| `gated.401-no-urls` | MUST | Gated acquisition | the 401 body carries no acquisition URLs |
| `challenge.missing-address` | MUST | Gated acquisition | 400 without `address` |
| `challenge.invalid-address` | MUST | Gated acquisition | 400 for an invalid `address` |
| `challenge.issued` | MUST | Gated acquisition | a JSON body with a `message` for a valid address |
| `challenge.siwe` | SHOULD | Authorization | the challenge is an ERC-4361 message |
| `challenge.domain` | MUST | Authorization | the verifier identity is present |
| `challenge.domain-host` | SHOULD | Authorization | the domain is the serving host, so clients can check it |
| `challenge.address` | MUST | Authorization | the claimed account echoes the request |
| `challenge.chain-id` | MUST | Authorization | the chain id is the token's chain |
| `challenge.nonce` | MUST | Authorization | a nonce is present |
| `challenge.expiration` | MUST | Authorization | an Expiration Time in the future |
| `challenge.token-resource` | MUST | Authorization | the first resource is this token's CAIP-19 id |
| `challenge.action-resource` | MUST | Authorization | the action resource is `urn:wallet-pass:action:acquire` |
| `challenge.fresh-nonce` | MUST | Gated acquisition | two requests yield two nonces |
| `gated.garbage-proof` | MUST | Gated acquisition | a garbage proof is refused, and not with 403 |
| `gated.non-owner-403` | MUST | Gated acquisition | a valid proof from a fresh non-owner key gets exactly 403 |
| `gated.owner-200` | MUST | Gated acquisition | the owner's proof resolves the manifest (owner key required) |
| `gated.no-store` | MUST | Gated acquisition | the verified response has `Cache-Control: no-store` |
| `gated.manifest.*` | MUST | Pass manifest | the manifest checks, on the owner's gated manifest |
| `gated.replay-refused` | MUST | Gated acquisition | the same proof a second time is refused, and not with 403 |
| `gated.expired-proof`, `gated.wrong-domain-proof` | MUST | Authorization | always skipped: a valid expired or wrong-domain proof cannot be produced without the server, so the issuer's own tests must cover them |

Rotation on a new owner's first claim is not observable without a transfer and is not checked.

## Library

```ts
import { runConformance, formatReport } from "@erc8426/conformance";

const report = await runConformance({
  rpcUrl: process.env.RPC_URL,          // or publicClient
  contract: "0x5F9B...c2e1",
  tokenId: 412n,
  nonexistentTokenId: 999999n,          // default: max uint256
  ownerPrivateKey: process.env.OWNER_KEY as `0x${string}` | undefined,
});
console.log(formatReport(report));
if (!report.ok) process.exit(1);
```

`runConformance(options): Promise<ConformanceReport>` where the report has `chainId`, `contract`, `tokenId`, `configuration` (`"public" | "gated" | "unknown"`), `passUri`, `manifestUrl`, `ownerAddress`, `checks` (`{ id, title, section, level, status, detail? }`), `summary` (`{ pass, fail, warn, skip }`) and `ok`. Options also take `fetch`, `ipfsGateway`, `arweaveGateway` and `timeoutMs`. `runCli(argv, io)` and `parseArgs(argv)` are exported for embedding the CLI.

## License

MIT
