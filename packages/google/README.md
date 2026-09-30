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

When the issuer resolves a manifest it calls `google.acquisitionUrl({ token, owner, content })` and puts the result under `formats.google`. The object is upserted through the REST API and the returned link references it by id, so the link is short and constant in size, expires after an hour by default, and is minted fresh on every manifest resolution (the spec allows acquisition URLs to be short-lived). `google.notifyUpdate(...)` patches the object; Google pushes object changes to every device that saved it, and `messageFor` can attach a notification.

## Transfers

A Google object is shared by every account that saved it, so a new owner gets a **new object**: on a different owner, the provider expires the previous object (state `EXPIRED`, links removed, a message saying it was replaced) and issues a fresh random object id. Generated classes set `multipleDevicesAndHoldersAllowedStatus: ONE_USER_ALL_DEVICES`, so a leaked save link cannot put the live card in a second account. `google.rotate(serial)` does the same on the owner's request.

Pass content maps to `state` as well: `voided` becomes `INACTIVE` and a past `expiresAt` becomes `EXPIRED`, which moves the pass out of the holder's active list.

## Building blocks

- `googleWalletClient({ serviceAccount, issuerId, fetch?, timeoutMs? })`: JWT bearer token exchange, cached until a minute before expiry, one shared exchange for concurrent callers, dropped at once on a 401. `get` (null on 404), `insert`, `patch`, `upsert` (insert on 404, patch when present or on a 409 race), `addMessage`, `saveUrl`.
- `toGoogleObject(content, { issuerId, classSuffix, objectSuffix? })`: `generic` to `genericObject` (card title, header, subheader, logo, hero, color), `eventTicket` to `eventTicketObject`, `storeCard` to `loyaltyObject` (points from the first two primary fields), `coupon` to `offerObject`. Remaining fields become text modules (Google shows at most ten) and links become the links module, the only tappable surface on a Google pass.
- `toGoogleClass(content, options)`: the matching class, with `overrides` for fields PassContent does not carry.
- `createSaveUrl({ serviceAccount, origins, objectIds | objects, classes?, ttlSeconds? })`: returns a link beginning `https://pay.google.com/gp/v/save/`. Prefer `objectIds`; embedded objects make long links that fail on Android past roughly 1800 characters.
