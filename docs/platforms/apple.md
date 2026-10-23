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
- **Notifications have their own rules.** See [Lock-screen notifications](#lock-screen-notifications) below before you put `changeMessage` on anything.
- **Countdowns: use relative dates.** A date field with `isRelative` redraws on the device between pushes. (Not in `PassContent` today; render the absolute time as text or extend the mapping.)
- **Links need anchors.** Apple only auto-detects bare URLs; labelled links go in `attributedValue` as `<a href>` with `&` escaped. The builder does this for `links`.
- **Images are PNG** and ship at @1x, @2x and @3x for sharpness. Strip art that worked in production: 375x144, 750x288, 1125x432. Icon: 29, 58, 87.
- **The certificate expires.** Pass Type ID certificates must be renewed; when one lapses, new passes fail to sign and pushes stop. Put the date on a calendar. `buildPkpass` refuses to sign with an expired or not yet valid certificate, with one that has no subject UID (not a Pass Type ID certificate), with one issued for another pass type or team, or with a key that is not the certificate's own, so the failure is an error at signing time rather than a pass that installs nowhere.
- **Superseded passes keep their old token.** A retired token may refresh (and receives the voided rendering) and unregister its own device, but can never register a new one. Never embed the current token in a pass served to a retired token.
- **Each retired token remembers why.** The record keeps a reason per retired token (`retiredReasons`, `transfer` or `reset`), so a seller's old pass reads "Transferred" and the same owner's pre-reset pass reads "Links reset" even on one serial. Records written before 0.1.1 have no reasons and render the generic wording. A custom `supersede(content, reason)` receives the reason.
- **Log route is unauthenticated** by Apple's design. The handler caps entries and strips control characters; do not widen it.
- **At the device cap, registration answers 403.** A pass keeps at most `MAX_REGISTRATIONS_PER_PASS` (10) live devices; the eleventh device's registration gets 403, a status outside the 200/201/401 Apple documents for this call. The pass still installs on that device, it just never updates (no push, no refresh) until a slot frees: a device unregisters, or the owner's token rotates (which supersedes the whole set). Nobody is ever evicted. A custom store MUST implement `supersede()`; without it a forwarded copy that filled the slots keeps them across every rotation and the owner is locked out.
- **Persistent store.** `MemoryApplePassStore` is for tests. On serverless each instance has its own memory, so registrations vanish. Implement `ApplePassStore` over Postgres or Redis; records carry `PassContent`, whose `Date` and `Uint8Array` values need serializing.

## Lock-screen notifications

**Documented** (the `changeMessage` field key, as described in the Passcreator, PassKit and Airship help documentation):

- A changed field raises a lock-screen message only if that field has a `changeMessage`. The message should contain `%@`, which Wallet replaces with the field's new value. A field without `changeMessage` changes silently.
- When several fields with a `changeMessage` change in one update, Wallet does not show each message: it shows one generic "Pass changed".

**Observed, not documented** (production passes of one issuer, 2026-10-17, iPhone on iOS 27; device behavior that may differ on other versions):

- Adding a back field **without** a `changeMessage` raised "Pass changed".
- Removing a back field raised nothing.
- A field with both `changeMessage` and `attributedValue` raised a message that showed the raw `<a href>` HTML: Wallet filled `%@` from `attributedValue`, not `value`.
- Adding a back field **with** a `changeMessage` reached some holders as "Pass changed" plus the message, when other text moved in the same update.
- Changing the value of an existing field that has a `changeMessage` raised exactly one message with that text, even on a `posterGeneric` pass that repeats the key. Dropping a `changeMessage` while keeping the value raised nothing.

**What to do:**

- **One banner = one field.** Send a notifying update whose only visible change is the value of one existing field that carries `changeMessage` "%@". Move every other change (new fields, removed fields, moving text) to a separate silent update.
- Put `changeMessage` only on fields whose change the holder wants to hear about. A countdown, a balance that moves on every push, or flavor text becomes spam, and holders mute the pass.
- **Never put `changeMessage` on a field that has `attributedValue`.** The builder never adds one to `links`; keep it that way if you post-process `pass.json`.
- Prefer changing the value of a field that already exists over adding a new field. On iOS 27 an added field raised "Pass changed" even without a `changeMessage`.
- **`posterGeneric` repeats keys.** The poster dictionary and the fallback dictionary share the same field objects, so header, primary and back fields appear in both. On iOS 27 a value change to one repeated key still raised one message, but changing two different fields that both carry `changeMessage` in one update collapses to "Pass changed".
- Before any update that reaches every holder, test the exact change on more than one device and more than one iOS version, starting from a pass that matches what holders have installed.
