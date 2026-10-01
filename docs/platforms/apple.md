# Apple Wallet

API reference: [`@erc8426/apple` README](../../packages/apple/README.md). This page is the credential setup and the lessons from running passes in production.

## Credentials, step by step

1. **Apple Developer Program** membership (paid, yearly). Note your **Team ID** from the Membership page.
2. **Pass Type ID.** Certificates, Identifiers and Profiles, Identifiers, add a Pass Type ID such as `pass.com.example.collection`. One per collection or product is typical.
3. **Pass Type ID certificate.** On that identifier, create a certificate. Generate the CSR with Keychain Access (Certificate Assistant, Request a Certificate From a Certificate Authority, saved to disk), upload it, download the `.cer`, double-click to add it to Keychain, then export certificate plus private key as `pass.p12`.
4. **Convert to PEM:**

   ```sh
   openssl pkcs12 -legacy -in pass.p12 -clcerts -nokeys -out signerCert.pem
   openssl pkcs12 -legacy -in pass.p12 -nocerts -out signerKey.pem
   ```

   `-legacy` is needed with OpenSSL 3 for most Keychain exports. The key stays encrypted with the pass phrase you choose; pass it as `signerKeyPassphrase`.
5. **WWDR G4 intermediate:**

   ```sh
   curl -O https://www.apple.com/certificateauthority/AppleWWDRCAG4.cer
   openssl x509 -inform der -in AppleWWDRCAG4.cer -out wwdr.pem
   ```

6. **Push.** The Pass Type ID certificate is also the APNs client credential for pass updates; use `createApnsClient({ certificate: { cert, key } })`. A `.p8` token key works for app pushes; for Wallet topics treat it as untested and verify before relying on it.
7. **Store all of it in a secret manager.** Base64 the PEMs if your platform mangles newlines in env vars.

## Wiring with the issuer

The issuer hosts the `.pkpass` at its own rotating capability URL through `passFile`, so omit `linkSecret` and mount only the web service:

```ts
const apple = appleFormatProvider({ passTypeIdentifier, teamIdentifier, certificates, origin: "https://pets.example", basePath: "/apple", store, apns });
// route /apple/* to apple.webService; pass apple to createIssuer({ providers: [apple, ...] })
```

Keep `basePath` outside the issuer's `/wallet-pass` so the two route trees never overlap. Standalone use (no issuer) is in the package README.

## Production gotchas

- **The web service must be public https.** Apple never calls `http` or a private host. On an `http` origin the provider omits `webServiceURL`: passes install but never update. Test updates on a deployed preview, not localhost.
- **Pushes always use the production gateway**, development passes included.
- **An icon is required.** Without `icon.png` the pass does not open, and nothing tells you why. The builder refuses to sign without one.
- **Field keys are unique across the whole pass**, links included. A duplicate is silently dropped at signing time; the builder throws instead.
- **Apple silently drops overflow fields.** A storeCard shows at most four secondary plus auxiliary fields. Plan the front of the card, do not rely on truncation.
- **Header labels crowd the logo.** Header fields are never dropped; Apple narrows the logo instead. Keep header labels short.
- **`changeMessage` fires on every change.** Put it only on fields whose change the holder wants a lock-screen banner for. A countdown or a balance that moves on every push becomes spam.
- **Countdowns: use relative dates.** A date field with `isRelative` redraws on the device between pushes. (Not in `PassContent` today; render the absolute time as text or extend the mapping.)
- **Links need anchors.** Apple only auto-detects bare URLs; labelled links go in `attributedValue` as `<a href>` with `&` escaped. The builder does this for `links`.
- **Images are PNG** and ship at @1x, @2x and @3x for sharpness. Strip art that worked in production: 375x144, 750x288, 1125x432. Icon: 29, 58, 87.
- **The certificate expires.** Pass Type ID certificates must be renewed; when one lapses, new passes fail to sign and pushes stop. Put the date on a calendar.
- **Superseded passes keep their old token.** A retired token may refresh (and receives the voided rendering) and unregister its own device, but can never register a new one. Never embed the current token in a pass served to a retired token.
- **Each retired token remembers why.** The record keeps a reason per retired token (`retiredReasons`, `transfer` or `reset`), so a seller's old pass reads "Transferred" and the same owner's pre-reset pass reads "Links reset" even on one serial. Records written before 0.1.1 have no reasons and render the generic wording. A custom `supersede(content, reason)` receives the reason.
- **Log route is unauthenticated** by Apple's design. The handler caps entries and strips control characters; do not widen it.
- **Persistent store.** `MemoryApplePassStore` is for tests. On serverless each instance has its own memory, so registrations vanish. Implement `ApplePassStore` over Postgres or Redis; records carry `PassContent`, whose `Date` and `Uint8Array` values need serializing.
