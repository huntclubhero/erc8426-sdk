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
- **Only `TEXT_AND_NOTIFY` notifies.** A `TEXT` message lands on the card silently; set `notify: true` on a `GoogleMessage` for anything the holder must act on (see Notifications below). Superseded messages stay silent.
- **No relative dates.** There is no on-device countdown; a time left field must be patched, so make it coarse (hourly) to keep patches rare.
- **Thin save links.** A link embedding the whole object grows with content and fails on Android past roughly 1800 characters; an embedded class that drifts from the stored one is rejected. The provider upserts through the API and references by id, and only falls back to a fat link (reported through `onError`) when the API call failed.
- **Origins: apex and www.** The save is refused from an origin not in the JWT; `saveOrigins` adds the www variant of each URL.
- **A saved object is shared.** Everyone who saved it sees the same object, so patching it for a new owner would keep the old owner's card live. The provider expires the old object and issues a new random object id on transfer, and classes set `ONE_USER_ALL_DEVICES` so a leaked link cannot save the live card to a second account.
- **Quota.** Patch only when the rendered object changed; the provider hashes the last accepted body and skips identical patches.
- **Access tokens** are cached until a minute before expiry, one exchange is shared by concurrent callers, and a 401 drops the cached token so a rotated key costs one failed call.
- **Save and delete callbacks** (`callbackOptions` on the class, via `classOverrides`) are signed by Google, and `createCallbackVerifier` and `callbackHandler` verify them (the ECv2SigningOnly envelope, Google's published keys, the message expiry, and the nonce when you give it a store). Handle only verified events. A callback says an account saved or deleted the pass; it says nothing about who owns the token, so it never stands in for the fresh ownership read.
- **Persistent store.** `MemoryGoogleObjectStore` is per process. Implement `GoogleObjectStore` (three methods) over your database so object ids survive restarts.

## Notifications

The provider keeps the card's message list to what matters now: `notifyUpdate` REPLACES the list (PATCH `messages`) with the one message `messageFor` returns, each given a display end of `messageTtlSeconds` (default a day), and clears it when `messageFor` returns null, so a reminder disappears the moment the action it asked for has landed. Appending (`addMessage`) is still on the client for integrators who want it, but Google keeps at most ten messages per object and shows them in no guaranteed order, so a reminder per update left holders scrolling stale ones. A superseded object carries only its notice.

A Google Wallet message is card-only text by default (`messageType: TEXT`): the holder sees it inside the saved pass and nothing else happens on the phone. Set `notify: true` on the message returned by `messageFor` to send `TEXT_AND_NOTIFY`, which raises an Android notification. Use it for anything the holder must act on and keep the rest silent. Google documents a maximum of three messages that trigger a push notification in a 24 hour period, says that a further attempt "will yield a QuotaExceededException response", and says it may throttle an issuer it considers to be spamming. When a notifying message is refused that way, `notifyUpdate` sends the same message once more as `TEXT`, so the words still reach the card, and, once that write has landed, reports `notify quota exceeded for <object id>: message sent as TEXT` through `onError`. Google does not document the status or body of that answer, so the provider matches the documented name, `QuotaExceededException`, exactly, in the error body (`isNotifyQuotaError`); this path is covered by tests against a stand-in API and has not been observed against the live one. If the notification matters, count your own notifying messages per object and stay under the limit.

Two more things the documentation leaves open. Google describes the notification for the Add Message API (`addMessage`); the provider writes its message with a PATCH of `messages` so that it replaces the list, and Google's page does not say whether a message written that way notifies. Check it on a device before you rely on it; `client.addMessage` with `notify: true` is the documented route. And holders receive nothing unless notifications are enabled for their passes. Apple has no equivalent switch: an Apple banner comes from a field whose value changed while it carries `changeMessage`, see the Apple notes.
