# @erc8426/google

Google Wallet delivery for [ERC-8426](https://eips.ethereum.org/EIPS/eip-8426) wallet passes: a small Wallet REST client, the mapping from `PassContent` (from `@erc8426/core`) to Google Wallet classes and objects, Save to Google Wallet links, and a format provider that serves the `google` entry of a pass manifest.

## Setup

1. **Issuer account.** Sign in to the [Google Pay and Wallet Console](https://pay.google.com/business/console) and open Google Wallet API. Note the **issuer id**: the long numeric id shown there. The alphanumeric merchant id from the Pay side looks similar and is rejected by every Wallet API call; this package refuses anything non-numeric up front.
2. **Service account.** In Google Cloud, enable the Google Wallet API on a project, create a service account, and download a JSON key. Keep the key in a secret manager; the client needs only `client_email` and `private_key`.
3. **Grant access.** In the Wallet console, under Users, add the service account email with Developer access.
4. **Classes and review.** Generic classes need no review and work immediately for everyone. Event ticket, loyalty and offer classes are created `UNDER_REVIEW` and save only to test accounts until Google approves the issuer for publishing, so start with `generic` if you want the first real user to succeed today. The provider creates the class on first use and never rewrites an existing one, since rewriting an approved class can send it back to review.

## Images must be public https

Google fetches every image itself. A URL must be https on a publicly reachable host: `localhost` and private addresses answer 400, an unreachable URL is dropped silently, and image bytes cannot be uploaded at all. The mapping throws a `GoogleImageError` for any of these, or omits the slot with `unhostedImages: "omit"`. Google caches images by URL, so put a version in the query string when the art changes.

## Wiring

```ts
import { googleFormatProvider, googleWalletClient, saveOrigins } from "@erc8426/google";

const serviceAccount = JSON.parse(process.env.GOOGLE_WALLET_SA_JSON!);

const client = googleWalletClient({
  serviceAccount: { client_email: serviceAccount.client_email, private_key: serviceAccount.private_key },
  issuerId: process.env.GOOGLE_WALLET_ISSUER_ID!,
});

export const google = googleFormatProvider({
  client,
  classSuffix: "example_collection_v1",
  origins: saveOrigins(["https://example.com"]), // adds https://www.example.com
  messageFor: () => ({ header: "Pass updated", body: "Your pass has new details." }),
  onError: (err, where) => console.warn(where, err.message),
});
```

When the issuer resolves a manifest it calls `google.acquisitionUrl({ token, owner, content })` and puts the result under `formats.google`. The object is upserted through the REST API and the returned link references it by id, so the link is short and constant in size, expires after an hour by default, and is minted fresh on every manifest resolution (the spec allows acquisition URLs to be short-lived). `google.notifyUpdate(...)` patches the object; Google pushes object changes to every device that saved it, and `messageFor` sets the card's one message (the list is replaced on every update and cleared when `messageFor` returns null, with a display end of `messageTtlSeconds`, default a day). A message is card-only text unless it sets `notify: true` (Google `TEXT_AND_NOTIFY`), which is what raises an Android notification; use it for anything the holder must act on, and expect Google's per-object daily cap on notifying messages (three at the time of writing).

## Transfers

A Google object is shared by every account that saved it, so a new owner gets a **new object**: on a different owner, the provider expires the previous object (state `EXPIRED`, links removed, a message saying it was replaced) and issues a fresh random object id. Generated classes set `multipleDevicesAndHoldersAllowedStatus: ONE_USER_ALL_DEVICES`, so a leaked save link cannot put the live card in a second account. `google.rotate(serial)` does the same on the owner's request. Voided content (what the issuer sends for a superseded serial, on transfer or on the owner's rotation) expires the object, clears its links and posts one message saying why ("Transferred", or "Links reset" with a pointer to the current pass, from `defaultSupersededMessage`). `supersededMessage` takes a fixed message, `null` for none, or a function of the reason. Because PATCH merges, the provider always sends the links and text modules, empty when the content has none, so removed links never linger on a saved card.

Pass content maps to `state` as well: `voided` becomes `INACTIVE` and a past `expiresAt` becomes `EXPIRED`, which moves the pass out of the holder's active list.

## Android view constraints

Google Wallet can narrow how a saved pass is shown or copied on the device. Set `view` on the provider (or `MappingOptions.view` and `ClassOptions.view` when mapping by hand) and the fields go on every generated object and on the class, superseded and expired objects included, so a rotated card keeps the same constraints as the live one:

```ts
googleFormatProvider({
  ...options,
  view: {
    screenshots: "refuse",          // passConstraints.screenshotEligibility: INELIGIBLE
    unlockToView: true,             // class viewUnlockRequirement: UNLOCK_REQUIRED_TO_VIEW
    nfcBlock: ["payment"],          // passConstraints.nfcConstraint: [BLOCK_PAYMENT]
  },
});
```

Left out, the fields are omitted and Google's defaults apply (screenshots allowed, no unlock required). `screenshots: "refuse"` is honoured by current Wallet versions; older ones may still allow a screenshot. `nfcBlock` also accepts `"closedLoopTransit"` (`BLOCK_CLOSED_LOOP_TRANSIT`). Apple Wallet has no equivalent to any of these (`sharingProhibited` on the Apple side is the nearest neighbour). These constraints narrow the on-screen exposure of the capability links a pass carries; they do not replace the documented bound and rotation on request, which the spec's Security Considerations name as what limits a leaked link.

## Save and delete callbacks

Set `callbackOptions: { url: "https://issuer.example/google/callback" }` on the class (through `classOverrides`) and Google POSTs a signed message to that URL every time a holder saves (`"save"`) or removes (`"del"`) an object of the class. `createCallbackVerifier` checks it the way Google's own library does: a root key fetched from `https://pay.google.com/gp/m/issuer/keys` (cached by its `Cache-Control` max-age, else `keyCacheSeconds`) signs an intermediate key, the intermediate key signs the message for sender `GooglePayPasses` and recipient = your issuer id, both ECDSA P-256 over SHA-256, and the message must not be expired. `callbackHandler` wraps it as a fetch handler (serve it on Node through `toNodeHandler` from `@erc8426/issuer`):

```ts
import { callbackHandler, createCallbackVerifier, memoryCallbackNonceStore } from "@erc8426/google";

const verifier = createCallbackVerifier({ issuerId, nonceStore: memoryCallbackNonceStore() }); // or your KeyValueStore
export const handleGoogleCallback = callbackHandler(verifier, async ({ objectId, eventType }) => {
  await markSaved(objectId, eventType === "save");
});
```

The handler answers 200 for a verified event, 400 for a message that will never verify, 413 for a body past 16 kB, 503 when Google's keys could not be fetched or your `onEvent` threw (Google retries; the nonce claim is released first, so the redelivery is handled rather than answered as a replay), and 200 for a redelivered nonce (`nonce_replayed`, the event was already handled). When no cached root key signs a message's intermediate key, the key set is refetched early (at most once a minute) before the message is refused, so a root key Google rotates in is picked up at once. `verify(bodyText, headers?)` is available on its own and returns `{ ok: true, event }` or `{ ok: false, reason }` with one of `invalid_body`, `unsupported_protocol`, `keys_unavailable`, `intermediate_key_unverified`, `intermediate_key_expired`, `signature_invalid`, `message_invalid`, `message_expired`, `nonce_replayed`. A `User-Agent` other than `Googlebot` or `Google-Valuables` is logged (`onWarning`), not refused.

What a verified event proves: Google says an object of yours was saved to, or removed from, some Google account. What it does not prove: who that account is (no account identity is included), that the pass is on a device right now (delivery is best effort; events can arrive late or out of order, so a `del` after a `save` may describe an older state), or anything about on-chain entitlement. Use it for display state (a "saved" badge, install counts, tidying stores), never for authorization: the fresh entitlement read stays the only boundary.

Google fetches the callback URL as Googlebot, so your `robots.txt` must allow Googlebot on the callback path (a `Disallow` there and the callbacks never arrive). The nonce store is structurally a subset of `@erc8426/issuer`'s `KeyValueStore` (`set` with `onlyIfAbsent` and a TTL), so Redis or Upstash serve both; the TTL is the time left on the message.

## Building blocks

- `googleWalletClient({ serviceAccount, issuerId, fetch?, timeoutMs? })`: JWT bearer token exchange, cached until a minute before expiry, one shared exchange for concurrent callers, dropped at once on a 401. `get` (null on 404), `insert`, `patch`, `upsert` (insert on 404, patch when present or on a 409 race), `setMessages` (replace the list, optional display end), `addMessage` (append; Google keeps ten, unordered), `saveUrl`.
- `toGoogleObject(content, { issuerId, classSuffix, objectSuffix? })`: `generic` to `genericObject` (card title, header, subheader, logo, hero, color), `eventTicket` to `eventTicketObject`, `storeCard` to `loyaltyObject` (points from the first two primary fields), `coupon` to `offerObject`. Remaining fields become text modules (Google shows at most ten) and links become the links module, the only tappable surface on a Google pass.
- `toGoogleClass(content, options)`: the matching class, with `overrides` for fields PassContent does not carry.
- `createSaveUrl({ serviceAccount, origins, objectIds | objects, classes?, ttlSeconds? })`: returns a link beginning `https://pay.google.com/gp/v/save/`. Prefer `objectIds`; embedded objects make long links that fail on Android past roughly 1800 characters.
