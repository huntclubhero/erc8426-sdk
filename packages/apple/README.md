# @erc8426/apple

Apple Wallet delivery for [ERC-8426](https://eips.ethereum.org/EIPS/eip-8426) wallet passes: signed `.pkpass` building, the PassKit web service that keeps installed passes current, APNs pushes, and a format provider that serves the `apple` entry of a pass manifest.

The standard leaves generation, signing and push out of scope. This package fills that gap with the patterns of two production deployments, so an issuer describes a pass once as a `PassContent` (from `@erc8426/core`) and gets a working Apple pass.

## What you need from Apple

1. **An Apple Developer Program membership** and your **Team ID** (Membership details page).
2. **A Pass Type ID**, for example `pass.com.example.collection`, under Certificates, Identifiers and Profiles.
3. **A Pass Type ID certificate.** Create it for that identifier, download the `.cer`, open it in Keychain Access and export certificate plus private key as a `.p12`. Convert it to PEM:

   ```sh
   # OpenSSL 3 needs -legacy for most Keychain exports.
   openssl pkcs12 -legacy -in pass.p12 -clcerts -nokeys -out signerCert.pem
   openssl pkcs12 -legacy -in pass.p12 -nocerts -out signerKey.pem
   ```

   The second command asks for a PEM pass phrase; pass the same value as `signerKeyPassphrase`. Add `-nodes` instead to write an unencrypted key and keep it in a secret manager.

4. **The Apple WWDR intermediate, G4.** Pass Type ID certificates issued today chain to G4, and a bundle signed against the wrong intermediate installs nowhere and reports nothing.

   ```sh
   curl -O https://www.apple.com/certificateauthority/AppleWWDRCAG4.cer
   openssl x509 -inform der -in AppleWWDRCAG4.cer -out wwdr.pem
   ```

5. **Push credentials (optional, for live updates).** The Pass Type ID certificate itself is the APNs client credential for pass updates, and certificate auth is the path both production deployments run. Token auth with an APNs `.p8` key (Keys page, "Apple Push Notifications service") is also supported; confirm it against your pass type topic before relying on it, because Apple has historically accepted only certificates for Wallet topics.

Never commit any of these. Load them from a secret store at startup.

## The web service URL

A pass updates only if it carries a `webServiceURL`, and Apple only calls one that is **https on a public host** with a certificate that chains to a public root. On an `http` origin (local development) the provider omits the web service, so passes still install but never update. Pass pushes always travel through the production APNs gateway, development passes included.

## Two modes

**With `@erc8426/issuer` (recommended).** The provider implements core's `PassFileProvider`. The issuer calls `apple.passFile(ctx)`, receives the signed `.pkpass` (`contentType: application/vnd.apple.pkpass`, `filename: pass.pkpass`), and serves it at its own rotating 256-bit capability URL, so download hosting and rotation live in one place. Omit `linkSecret`, and mount only `apple.webService` at `basePath` so devices can register and fetch updates. `notifyUpdate` pushes through APNs as usual. A new owner seen by `passFile` still rotates the pass's device token and pushes the previous holder their superseded pass.

**Standalone.** Without the issuer, pass a `linkSecret` and mount `apple.handle`, which serves both the web service and the download route. `apple.acquisitionUrl(ctx)` then returns a capability URL on your origin.

## Wiring (standalone)

The handlers are Fetch API functions, `(Request) => Promise<Response>`, so they mount in Next.js route handlers, Hono, Bun, or Node's `http` behind a small adapter.

```ts
import { appleFormatProvider, createApnsClient, MemoryApplePassStore } from "@erc8426/apple";

const store = new MemoryApplePassStore(); // replace with a persistent ApplePassStore

const certificates = {
  signerCert: process.env.PASS_SIGNER_CERT_PEM!,
  signerKey: process.env.PASS_SIGNER_KEY_PEM!,
  signerKeyPassphrase: process.env.PASS_SIGNER_KEY_PASSPHRASE,
  wwdr: process.env.APPLE_WWDR_G4_PEM!,
};

const apns = createApnsClient({
  certificate: { cert: certificates.signerCert, key: certificates.signerKey, passphrase: certificates.signerKeyPassphrase },
  passTypeIdentifier: "pass.com.example.collection",
  store,
});

export const apple = appleFormatProvider({
  passTypeIdentifier: "pass.com.example.collection",
  teamIdentifier: "ABCDE12345",
  certificates,
  origin: "https://passes.example.com",
  basePath: "/apple",
  linkSecret: process.env.PASS_LINK_SECRET!, // 32+ random bytes, never stored with the passes
  store,
  apns,
  images: { icon: { url: "https://passes.example.com/icon.png" }, logo: { url: "https://passes.example.com/logo.png" } },
});

// Next.js: app/apple/[...path]/route.ts
export const GET = (req: Request) => apple.handle(req);
export const POST = GET;
export const DELETE = GET;
```

When the issuer resolves a manifest it calls `apple.acquisitionUrl({ token, owner, content })` and puts the result under `formats.apple`. When content changes (a `PassUpdate` event, a balance move) it calls `apple.notifyUpdate(...)`, which stores the new content, bumps `Last-Modified`, and pushes every registered device. For an owner's request to reset their links without the issuer, call `apple.rotate(serial, freshContent)`: every existing copy, a leaked one included, refreshes into the superseded card and can no longer register devices, and the owner's new download URL carries the fresh content. (With the issuer, rotation mints a new serial and voids the old one; voided content retires the old serial's token the same way.)

## Security properties

- **Per-pass authentication tokens.** Every serial gets its own random 256-bit token, compared in constant time. A leaked token exposes one pass, not the collection.
- **Capability download URLs.** The acquisition URL is `<origin><basePath>/passes/<serial>/<capability>.pkpass`, where the capability is an HMAC of the pass's current token under `linkSecret`. It is not derivable from the serial, token id or any public data, it needs no table of its own, and a read-only dump of the store alone does not yield working URLs. Unknown serials and wrong capabilities both answer 404.
- **Rotation on transfer.** When a different owner acquires the pass, its token rotates: the previous holder's download URL stops resolving, and their installed pass, on its next refresh, receives a superseded rendering (voided, no links, no barcode, no live values). A retired token may refresh and unregister its own device but can never register a new one, and the refresh embeds the retired token, never the new owner's.
- **Bounded pre-auth input.** `/v1/log` is unauthenticated by Apple's design: its body is capped at 16 KiB while streaming (413 past it), and entries are capped in count and length and stripped of control characters before `onLog` sees them. Registration bodies are capped at 1 KiB.

A pass is a projection of the token, not the token. Nothing in this package treats holding a pass, or its download URL, as proof of ownership; state-changing actions reached from pass links need the spec's authorization checks, including the fresh entitlement read.

## Building blocks

- `buildPkpass(content, options)` signs a bundle; `toPassJson` is the pure mapping. Styles map to `generic`, `eventTicket`, `storeCard`, `coupon`. Links become back fields with `attributedValue` anchors. Field keys must be unique across the whole pass; a duplicate throws, because Apple would drop it silently. Images must be PNG; URL sources are fetched at build time with a timeout and size cap, over https only, to public addresses only (every resolved address and every redirect hop is checked, so a URL from token metadata cannot reach your internal network or cloud metadata). `imageFetch.allowPrivateNetwork` relaxes this for local development. An icon is required.
- `applePassKitWebService({ store, passTypeIdentifier, buildPass, authenticate?, basePath?, onLog? })` implements register, unregister, updated serials, latest pass (with `If-Modified-Since` and 304) and log.
- `createApnsClient(...)` keeps one HTTP/2 session open and multiplexes, retires it on error, GOAWAY, a stalled stream or a quiet spell, retries tokens that never got a stream once, and removes tokens APNs answers 410 for.
- `MemoryApplePassStore` implements `ApplePassStore` (pass records plus device registrations) for tests and demos. A production store needs the same eight methods over a database.
