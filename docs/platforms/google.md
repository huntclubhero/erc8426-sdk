# Google Wallet

API reference: [`@erc8426/google` README](../../packages/google/README.md). This page is the credential setup and the lessons from running passes in production.

## Credentials, step by step

1. **Issuer account.** Sign in to the [Google Pay and Wallet Console](https://pay.google.com/business/console), open Google Wallet API, and create the issuer. Copy the **issuer id**: the long numeric one. The alphanumeric merchant id on the Pay side looks similar and 400s every Wallet API call; the client refuses non-numeric ids at construction.
2. **Cloud project.** In Google Cloud, create or pick a project and enable the **Google Wallet API**.
3. **Service account.** IAM, Service Accounts, create one (no project roles needed), then Keys, Add key, JSON. The JSON holds `client_email` and `private_key`; that pair is all the client uses. Store it in a secret manager.
4. **Grant it access.** Back in the Wallet console, Users, invite the service account email with Developer access. Until this is done every call answers 403.
5. **Publishing access.** Generic passes work for everyone at once. Event ticket, loyalty and offer classes save only to test accounts until Google approves the issuer for publishing; request it in the console once your pass looks right.

## Wiring with the issuer

```ts
const google = googleFormatProvider({
  client: googleWalletClient({ serviceAccount, issuerId }),
  classSuffix: "pets_v1",
  origins: saveOrigins(["https://pets.example"]),
});
// createIssuer({ providers: [apple, google], ... })
```

Every manifest resolution upserts the object and mints a fresh, one-hour save link that references it by id.

## Production gotchas

- **Numeric issuer id, not merchant id.** This misconfiguration fails every call and, where a code path falls back quietly, can run unnoticed for weeks. The provider reports REST failures through `onError`; alert on it.
- **Generic needs no review.** Loyalty, event ticket and offer classes are `UNDER_REVIEW` until approved. Ship on generic first if real users must succeed on day one.
- **Images must be public https.** Google fetches them from its own servers: `localhost` and private addresses answer 400, unreachable ones are dropped and the card shows no art, and bytes cannot be uploaded. The mapping throws a `GoogleImageError` rather than letting that happen silently.
- **Google caches images by URL.** A constant URL freezes the art at save time. Add a version query (`hero.png?v=<hash of what the art shows>`) that changes when the render does.
- **Hero ratio is about 3:1** (1032x336 is Google's guidance; 2064x672 for sharpness). A square image in the hero slot is stretched and cropped.
- **Text is never tappable.** The links module is the only tappable surface; the mapping puts every `PassContent` link there.
- **At most ten text modules render.** The mapping keeps the first ten, in front-of-card order.
- **No relative dates.** There is no on-device countdown; a time left field must be patched, so make it coarse (hourly) to keep patches rare.
- **Thin save links.** A link embedding the whole object grows with content and fails on Android past roughly 1800 characters; an embedded class that drifts from the stored one is rejected. The provider upserts through the API and references by id, and only falls back to a fat link (reported through `onError`) when the API call failed.
- **Origins: apex and www.** The save is refused from an origin not in the JWT; `saveOrigins` adds the www variant of each URL.
- **A saved object is shared.** Everyone who saved it sees the same object, so patching it for a new owner would keep the old owner's card live. The provider expires the old object and issues a new random object id on transfer, and classes set `ONE_USER_ALL_DEVICES` so a leaked link cannot save the live card to a second account.
- **Quota.** Patch only when the rendered object changed; the provider hashes the last accepted body and skips identical patches.
- **Access tokens** are cached until a minute before expiry, one exchange is shared by concurrent callers, and a 401 drops the cached token so a rotated key costs one failed call.
- **Save and delete callbacks** (`callbackOptions` on the class, via `classOverrides`) are informational: this SDK does not verify Google's callback signature, so never gate anything on them.
- **Persistent store.** `MemoryGoogleObjectStore` is per process. Implement `GoogleObjectStore` (three methods) over your database so object ids survive restarts.
