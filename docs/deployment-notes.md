# Deployment Notes (non-normative)

What running ERC-8426 passes for real holders taught, in two parts. Nothing here is normative. Much of it sits in the delivery pipeline the specification leaves out of scope, and is recorded because every implementer meets the same platform constraints.

**Part one, WALLETCHI.** How one deployment implemented the standard: its on-chain interface, its gated manifest endpoint, how it delivered NFT-bound passes on Apple Wallet and Google Wallet, and how it applied the authorization requirements. WALLETCHI was a testnet experiment by the author of the standard. It opened to the public on 2026-10-13, issued about 1,000 passes, and was closed on 2026-11-06 (lesson 27 says how). These sections were moved here on 2026-10-23 from the ERC-8426 assets, which now carry only product-neutral platform notes, and they are kept in the present tense in which they were written while it ran.

**Part two, lessons.** Lessons 1 to 14 are WALLETCHI's. Lessons 15 to 27 come from a mainnet ERC-721 deployment that launched in November 2026, and from WALLETCHI's last weeks. The mainnet deployment implements the standard's contract interface with its own server code, not this SDK, so nothing in those lessons is a statement about the SDK's behaviour unless it says so.

## Technology stack

| Layer | Standard or mechanism | Role |
| --- | --- | --- |
| Token | ERC-721 with this extension (`passURI`, `PassUpdate`, `BatchPassUpdate`, ERC-165 id `0xef5f1e71`) | The token advertises its pass endpoint and signals pass staleness on chain. |
| Token | ERC-6551 token-bound accounts | Each token owns an account that holds its balance; actions spend from the token's own account. |
| Token | ERC-2981 | Royalty information for secondary sales. |
| Token | ERC-721C creator-token transfer validator | A creator-definable transfer validation hook, discoverable by marketplaces. |
| Account | EIP-7702 delegation to Alchemy SemiModularAccount7702 | Email-onboarded embedded-signer EOAs become smart accounts at their existing address, so `ownerOf` never changes. |
| Account | ERC-4337 user operations with a paymaster policy and a server-side approval webhook | Holders pay no gas; the webhook approves only the calls the application expects. |
| Account | Scoped session keys (a permission grant through the account provider's hosted grant API) | One owner signature authorizes a key limited on chain to the single function pass links invoke, enabling one-tap actions. |
| Authorization | ERC-4361 challenge floor with a CAIP-19 token binding | Proof of control naming token, action, single-use nonce, expiration, verifier, and account. |
| Authorization | ERC-1271 | Signature verification for contract accounts. |
| Authorization | Fresh `ownerOf` read, fail closed | Entitlement checked at request time on every state-changing request; never a cached owner. |
| Apple delivery | Signed PKPass bundles (Pass Type ID certificate issued by Apple, WWDR G4 chain) | The pass artifact. |
| Apple delivery | PassKit web service protocol (device registration, serials since tag, latest pass, log) | Installed passes fetch updated content. |
| Apple delivery | APNs background push | Tells devices a pass changed. |
| Apple delivery | Relative date fields | Live countdowns rendered on device between pushes. |
| Google delivery | Google Wallet REST API (loyalty class and objects) | The pass class and one object per token, upserted by the server. |
| Google delivery | Thin Save to Google Wallet JWTs referencing upserted objects | Short, reliable save links. |
| Google delivery | Object PATCH, `addMessage`, `linksModuleData` | Content updates, notifications, and tappable action links. |
| Discovery and freshness | Gated manifest behind `passURI` | Acquisition URLs only for a proven owner. |
| Discovery and freshness | Capability URL rotation on transfer | Previous owners' links and downloads stop working. |
| Discovery and freshness | On-chain `PassUpdate` and `BatchPassUpdate` | Staleness signal for any pass distributor or indexer. |

## Deployment profile

- ERC-721 tokens on a public test network, live from July 2026 until the deployment was closed on 2026-11-06. Holders onboard with an email address; their accounts use an embedded signer, and state-changing transactions are gas-sponsored.
- Each token carries one Apple Wallet pass and one Google Wallet pass. Pass content (status, countdown, balances) reflects on-chain state and changes several times a day.
- Its token contract, deployed on chain id 46630 at `0x96100112afec4a034270d96a133c8952e8c63f45`, implements `IERC721WalletPass`: `supportsInterface(0xef5f1e71)` returns `true`, and `passURI` reverts for unminted ids. Its server resolves `passURI` to a manifest. Earlier releases delivered the same passes without the on-chain interface.
- Opened to the public on 2026-10-13. 158 tokens were minted before minting closed, when the embedded-signer provider's allowance of user accounts ran out; holders saved passes on both Apple Wallet and Google Wallet. Minting later reopened, and about 1,000 passes had been issued when the deployment was closed on 2026-11-06.
- Acquisition URLs are also delivered in the mint response, the post-transfer claim response, and a receipt email.
- It documents itself as operating the gated configuration. Pass action links run in the capability configuration, bounded as described under [Authorization](#authorization-as-deployed).

## On-chain interface

**`passURI`.** Reverts for a nonexistent token, otherwise returns an owner-settable base followed by the decimal token id. The base encodes the chain and contract, in the form `<origin>/wallet-pass/eip155/<chainId>/<contract>/`, so one server can serve several collections and networks without ambiguity. `supportsInterface` returns `true` for `0xef5f1e71`.

**`PassUpdate`.** Emitted from the token's transfer hook, so mint, transfer, and burn are all covered without separate call sites. Most pass-rendered state lives in a separate application contract. Because the specification places the events on the token contract, the application contract asks the token contract to emit them through an emit-only signal function, callable only by the application contract, the owner, and registered signalers. Each action taken from a pass, and each prize or residual payment to a single token, emits `PassUpdate` for that token.

**`BatchPassUpdate`.** Emitted for collection-wide changes (the start or end of a round) over the full minted range, and once per reward distribution over the inclusive range from the lowest to the highest paid token id. Unpaid ids inside that range receive a redundant refresh, which is cheaper than one event per token.

**Signals never block state changes.** Every signal call is wrapped so that a failure to emit cannot revert the action or settlement that caused it.

**Passive state has no event.** State that changes with time rather than by transaction (a deadline lapsing) emits nothing. The pass covers it with a relative date field that the device counts down on its own.

**Gas.** Signaling adds about 4,100 gas per state-changing action and about 1,200 per mint.

**Push remains server-driven.** The server still triggers APNs pushes and Google Wallet updates from the state changes it observes. The events serve other pass distributors and indexers, which have no access to that server.

## Manifest endpoint

**Gated resolution.** An unauthenticated request to the `passURI` address returns `401` with a JSON body whose `error` is `proof_required` and whose `challenge` is the URI of the challenge endpoint for that token, and no acquisition URL. A request that proves control of the owning account returns `200` with the manifest (`formats.apple` a capability `.pkpass` URL, `formats.google` a Save to Google Wallet link, and `updatedAt`), sent with `Cache-Control: no-store`.

**Proof of control.** Either of two proofs is accepted. The first is an ERC-4361 challenge fetched from a `challenge` endpoint beneath the `passURI` address, signed, and returned in request headers. It follows the recommended serialization: the first resource is the CAIP-19 identifier of the token, the second is `urn:wallet-pass:action:acquire`, and the statement names the acquire action, with a single-use nonce, an expiration, the domain line, and the claimed account in the address line. The second is a session token from the embedded signer used by email-onboarded holders.

**Rotation at first claim.** When a proven owner is not the owner of record, the server rotates the per-pass secret before minting any acquisition URL. This is the gated configuration's rotation upon the new owner's first claim.

**No metadata mirror.** The optional `wallet_pass` property in token metadata is deliberately not served. `tokenURI` is public, so mirroring a gated manifest there would publish its capability URLs.

## Apple Wallet

**Signing.** Passes are signed with a Pass Type ID certificate issued by Apple, chained to the Apple WWDR G4 intermediate. The certificate is issued to an enrolled developer organization; Apple does not review individual passes or pass designs.

**PassKit web service.** The deployment serves the standard pass web service endpoints: device registration and unregistration, the list of serials updated since a tag, the latest pass for a serial (honoring `If-Modified-Since` with `304`), and the device log endpoint. Each pass carries its own authentication token, compared in constant time.

**Push.** When rendered state changes, the server sends an empty-payload APNs push (`apns-push-type: background`, priority 5, topic set to the Pass Type ID) over HTTP/2, authenticating with the pass certificate as the client certificate. The device then fetches the new pass from the web service. Replacing the runtime's default CA store with the WWDR certificate breaks the APNs TLS connection; add WWDR to the pass signing chain only.

**Notifications.** As documented for Wallet, a field change raises a lock-screen message only when that field carries a `changeMessage` (its `%@` is replaced with the new value), and a device compares an updated pass with the copy it holds, not with what the server last sent. The deployment confirmed the following on iOS 27 on 2026-10-17, checking each step against a server log of exactly which fields each device received: changing the value of an existing plain-text field that carries `changeMessage` raised exactly one notification with that text, even though the iOS 27 poster dictionary repeats the field under the same key; adding a field without a `changeMessage` raised the generic "Pass changed"; removing a field, dropping a `changeMessage` while keeping the value, and changing a value without a `changeMessage` raised nothing; and a `changeMessage` on a field with `attributedValue` displayed the raw link markup, because the substituted value came from `attributedValue`. It therefore announces by changing the value of a field every pass already has, never by adding a field, keeps every other field stable across failed reads and restarts so no update adds one by accident, and tests any notifying change on one device before sending it to every holder. Since then, adding a field that carries a `changeMessage` in an update where other text also moved raised the generic "Pass changed" on some phones, so each reminder is sent as an update whose only visible change is the value of one existing field with `changeMessage` "%@".

**Live countdown without push.** Date fields with `isRelative` set are redrawn by the device as a live countdown, so a timer on the pass stays correct between pushes. `relevantDate` surfaces the pass on the lock screen at a chosen time.

**Back-of-pass action links.** Each state-changing action is a link on the back of the pass, and each link is a capability URL bound to the pass and the action. Field text can change between pushes, but the link set is stable for a given owner.

**`sharingProhibited`.** Setting it hides the share control in Wallet. It does not stop the `.pkpass` file from being forwarded by other means, so it does not change the bearer-artifact analysis.

**Superseded passes on transfer.** After a transfer is claimed, the previous owner's device stays registered, marked superseded: the web service still lists the pass for it and answers the old authentication token with a keepsake pass marked as transferred, carrying no action links, instead of the current pass. A superseded registration no longer holds one of the pass's registration slots, and it stops receiving pushes after a short window (24 hours as deployed), so a forwarded copy cannot keep the holder's own devices out and old copies fall quiet. The new owner receives a fresh pass under a rotated token. This is how the deployment meets the requirement that superseded passes not present themselves as current.

**Field limits.** Wallet renders at most four secondary and auxiliary fields combined and truncates long header labels. Layouts that exceed this lose fields without an error.

**Other surfaces.** On macOS, passes open and their links work, but push updates were not observed. A pass added on one device mirrors to the holder's other devices.

## Google Wallet

**Issuer and class approval.** The issuer account was approved, and the loyalty pass class was reviewed and approved by Google (`reviewStatus` of `approved` through the Wallet REST API). Until approval, saved passes carry a test-only marker.

**Issuer id.** The Wallet REST API requires the numeric issuer id. The alphanumeric merchant id shown elsewhere in the console is rejected, which surfaced as silently failing object writes.

**Thin save links.** A save link is a signed JWT (`typ: savetowallet`) with an `origins` list naming every origin that hosts the save button; a page origin outside that list is refused. Embedding the full class and object in the JWT produced links of about 2,400 characters, past the roughly 1,800-character practical limit, and adds failed intermittently with generic errors. The deployment instead upserts the object through the REST API and issues a thin JWT that references the object by id.

**Upsert and updates.** Objects are created with GET, then POST on 404, then PATCH when present. A `409` on POST means another request created the object concurrently; the correct response is to PATCH, not to skip, because the content being written may be the newer state. Later updates are PATCH writes guarded by a content hash. A change to structure alone (for example adding a module) must still force a write.

**Rotation moves to a new object.** Every account that saved a Google Wallet object shares it, so a PATCH reaches every copy, a forwarded one or a previous owner's included. When the per-pass secret rotates (a new owner's first claim, or the owner's reset), the fresh action links are therefore issued in a new object with a new random id, and the object that carried the old links is expired: its state is set to `EXPIRED`, its link list is replaced with only the public pet page (a PATCH merges fields, so the list must be sent rather than omitted), and it carries the same keepsake wording as the Apple pass. Patching the old object in place would deliver the fresh links to every copy of it. Pets that have never rotated keep their original object, so passes saved before this behavior shipped keep updating.

**Notifications.** A message added with `addMessage` always lands on the card, but it raises a phone notification only when its `messageType` is `TEXT_AND_NOTIFY`; a `TEXT` message is silent. The deployment sends its two deadline reminders as `TEXT_AND_NOTIFY` and everything else as silent PATCH writes. Google documents, for the Add Message API, a maximum of 3 messages that trigger a push notification in a 24 hour period.

**Tappable links.** Google Wallet does not linkify text fields. The only tappable surface is `linksModuleData`, so action links live there.

**Images.** Image URLs are cached aggressively; changing the image requires a new URL. Hero images are wide, and a square image placed there is stretched.

## Authorization as deployed

- **Fresh read.** Every state-changing request (action taps, session key installation and revocation, pass link issuance, claims, challenge verification, and manifest resolution) reads `ownerOf` at request time. On failure it retries once after 250 ms, then refuses with a retryable `503` (`Retry-After: 5`). It never falls back to a cached or last-known-good owner; only read-only views use the cache. Making this strict also closed a path where a claim could proceed on the owner of record when the chain read failed.
- **Pass action links.** Holders onboard by email and are never prompted per action, so no per-action signature exists at tap time: the capability configuration. Each link is a capability URL bound to the pass and the action. A tap resolves the link, performs the fresh read, and submits the action with a session key the owner authorized once with a signature. The session key's authority is scoped on chain to the single state-changing function the pass exposes. The forwarding residual the specification discloses therefore stays bounded: a forwarded link can repeat that action for the owner, and cannot transfer, burn, or approve the token, change who may act for it, or reach any other function. The repetition is bounded on chain as well. Each care spends the care cost from the token's own account through the issuer's appointed spender, the tap-to-pay path the links use, and the account caps that spender at a per-transaction amount and a daily allowance (20 cares per rolling 24 hour window, which starts at the first spend, at the shipped configuration; both are parameters set when the spender is appointed and fixed for that token's account). Later releases raised the daily allowance for tokens minted after them, first to 500 cares and then to 1,000,000, and hold an owner-approved carer to 10 per window. At that size the allowance no longer binds, so for those tokens a forwarded link is bounded by the token account's balance, and rotation is the remedy. The owner's own signed execution through the account is not capped, and no link reaches it. So the most a forwarded link can do before the owner rotates it is spend that allowance, or the account's balance if smaller, on care, the one thing the account exists to spend on. "Cannot touch the token" therefore holds for ownership and entitlement; what the token's account holds is exposed only up to that cap.
- **Fallback.** When no usable session key exists, the link redirects to a page where the owner signs the action directly.
- **Rotation on request.** The owner can reset the pass links at any time from the account page. It is the transfer rotation with the owner unchanged: the per-pass secret rotates, every action link and pass download URL derived from it stops verifying, the previous Apple registrations are superseded and refresh into a keepsake marked as reset (they no longer count toward the registration bound, so a reset always frees the slots), the Google object that carried the old links is expired and the rotated links are issued in a new object (see Rotation moves to a new object), and fresh acquisition URLs are returned. Limited to one reset per pet per ten minutes. This is the remedy for a leaked link under an unchanged owner, which no transfer-driven rotation can provide.
- **Transfer.** Holders can also give a pet away from the account page. The transfer is an ERC-721 `transferFrom` signed by the owner's own account, never by the care session key, whose authority is scoped to the care function and cannot move the token. The transfer is gas-sponsored only when it matches a gift the server prepared for that owner, token, and recipient, and only when a fresh read shows the signer is still the owner; the sponsorship webhook refuses every other transfer, approval, or operator call on the token contract. Landing the transfer revokes the giver's care session at once; the pass secret rotates when the recipient first claims. A new owner claims with a signature over a server-issued single-use nonce. The claim, like a proven manifest request from a new owner, rotates the per-pass secret, which invalidates every action link and pass download URL derived from it and triggers the keepsake behavior described above.

- **The token's account: withdraw and top-up.** Care is paid from the token's own account, so its balance is what keeps a pass action working. The owner can withdraw that balance to their own account and put it back. The sponsorship webhook funds a withdrawal only when the target is a genuine account of the collection (the issuer's derived account for the token it reports, not the token it merely claims) and the payout goes to the signer, who must be the current owner; it funds a top-up only when the transfer pays such an account for a token the signer owns. Withdrawing from a live token stops on a warning that the balance pays for every action, with a one-tap option that leaves a reserve inside, and a refused action on an empty account says so and offers the top-up.
- **Approvals from the token's account.** The deployed account implementation does not refuse approvals granted from the account, so an approval granted under one owner would survive a sale, as the specification's Security Considerations describe. No pass link can grant one. The next account implementation refuses approval-granting calls in its execution function while still allowing revocations; existing accounts are immutable proxies, so it applies to tokens minted after it ships.

## Session grants on a shared account

One account can own several tokens, and each token's pass links act through an authority granted from that one account. WALLETCHI granted one session key per token, through the account provider's hosted grant API. On 2026-10-25 a holder who had claimed two gifted tokens into one account had both sessions granted in the same second. One token's taps then failed for a day under a generic "could not act right now" page, while its pass still showed one-tap care as on.

**Reproduced** on the same test network on 2026-10-31, with fresh accounts, the same grant API and a temporary sponsorship policy:

| What was done | Result |
| --- | --- |
| One grant, used five times | 5 of 5 landed |
| Two grants one after the other, the first used before the second was requested | 3 of 3 pairs got different slots; all landed |
| Two grants one after the other, 20, 60 and 150 seconds apart, neither used in between | 3 of 3 pairs got different slots; all landed |
| Two grants requested at the same moment | 2 of 16 pairs were assigned the same slot |
| Six grants requested at the same moment | 2 of 2 bursts had grants sharing a slot |
| The losing session of a collision, retried | 8 of 8 retries failed |
| A new grant for the losing token, requested alone | 9 of 9 got the next free slot and landed |

What that establishes:

- **The trigger is concurrent requests.** Grants requested in sequence never collided, even when the earlier one had not been used or confirmed on chain. Two requests in flight together sometimes did. The rate seen here (about one simultaneous pair in eight) is one day's measurement against one provider, not a constant.
- **The first to act wins, and the other is dead for good.** The first colliding session to send an operation installs the slot with its own key. Every operation from the other session is then checked against that key and refused, on every try. The losing session leaves no trace on chain, and it never acts with the winner's authority.
- **A simulation does not catch it.** For two sessions of the same scope, which is the case when every token's session calls the same function, the provider's prepare step, a simulation, succeeded for the loser every time. Only the signed send failed, and it was reported as an invalid account signature, not as a revert. (For two sessions of different scopes the prepare step did fail, on the winner's allowlist.) Simulating an action after a grant is therefore not a check that the grant is usable.

What to do:

- **Serialize grant requests per account.** Wait for one grant request to return before sending the next for the same account. Waiting for the first grant to be used or confirmed on chain is not needed. A latch per token is not enough; the account is the unit.
- **Retire a key on a signature validation failure.** It is permanent, so retrying it only repeats the failure. Treat it as proof the stored authority is dead: retire it, and fall back to the signed path or request a new grant alone. Classify the provider's signature error as this case, not as a transient chain error, and log its detail.
- **The pass should not claim what the key cannot do.** Until a session has landed a real action, a pass that shows one-tap actions as on may be wrong.

What is not established. The provider-side cause is inferred: the results are consistent with slot ids being reserved for pending sessions without the reservation being atomic, and the provider's documentation does not describe how ids are chosen. That the holder's failure on 2026-10-25 was this mechanism is also inferred: every observable matches, but its error text was never captured.

## Lessons

1. **Pass download URLs must be capability URLs too.** An early build served the pass file at a path keyed only by the pass serial, and the serial was public through token metadata. Because the pass embeds already-signed action links, anyone could download any holder's pass and replay its links. This was found in internal review before real value was at stake, and there is no evidence it was exploited. The fix derives a download capability from the per-pass secret with an HMAC, verifies it in constant time, returns `404` on mismatch, rotates it with the secret on transfer, and makes serial-only routes fail closed.
2. **GET must be side-effect free.** Mail scanners, chat previews, and wallets prefetch links. An action link that acts on GET gets triggered by a crawler. The deployment answers GET with a page that submits the action by POST, and acts only on POST.
3. **Browser storage opened from a pass is ephemeral.** Links open in an in-app browser whose storage does not survive from one tap to the next, so a browser-local session key re-prompted on every action. Holding the scoped session key server-side fixed it.
4. **Numeric issuer id, not merchant id,** for the Google Wallet REST API.
5. **Respect field-count limits** on Apple passes, and put every Google link in `linksModuleData`.
6. **Treat a Google `409` as "exists, now PATCH".**
7. **Keep WWDR out of the runtime CA store** when connecting to APNs.
8. **Notification throttling must not swallow time-critical warnings.** Quiet-hour suppression is fine for routine updates and wrong for warnings whose deadline falls inside the quiet window.
9. **Report a refusal a retry cannot fix as a refusal.** A holder withdrew the whole balance of their token's account, and every action then failed under a generic "try again" message. The token came within the hour of its deadline before the cause was found, with ample balance sitting in the holder's own account. The deployment now checks the token account's balance before submitting an action, names the condition when it is short, and offers a one-tap top-up.
10. **A warning must name every action that is due.** The token has five needs with separate deadlines that often lapse together, and the warning named only the first. Of the tokens that died after their holders had returned at least once, most died from a need the holder had never acted on, often while acting on another need repeatedly. Warnings now name every need due within the next 12 hours, most urgent first, or all five when every need is due or the read fails, say how long the token has, and say where on the card to tap.
11. **Social apps' in-app browsers do not add passes.** At launch, holders who minted inside a social app's in-app browser did not add their pass there. The receipt email carries both wallet buttons and is the path that reaches them, as it is for holders who mint on a desktop.
12. **Surface the pass on the lock screen only when it matters.** `relevantDate` is used for the final hours before a deadline, never as a daily reminder, so that a holder who sees the pass on the lock screen knows it needs them now.
13. **A restart must not delay a deadline reminder.** The reminder engine ran on a fixed interval with no first run, so every deploy pushed the next check back by up to a full interval. On a night with five deploys, one final warning went out 13 minutes after its due time. The server now runs one check 90 seconds after every start. Reminders are also held for 30 minutes after a landed action (5 for the final warning), so a holder who just acted is not warned for what they just did.
14. **Bind a mint to a browser, not a person.** To hold one token per phone without fingerprinting, the mint sets a random first-party HttpOnly cookie that ties that browser to the inbox that minted; a second inbox from the same browser is refused.

### Lessons 15 to 27: a mainnet launch, and WALLETCHI's last weeks

Each lesson says what was seen and what to do, and marks its evidence. **Reproduced**: made to happen again on purpose. **Measured**: counted on the live system. **Observed**: seen, with the cause read in code but not reproduced.

15. **Serialize session grants per account.** Reproduced. Two grant requests for one account that are in flight together can be assigned the same validation slot; grants requested in sequence never were. The first to act wins and the other fails at send forever, while a simulation passes for it. Serialize grant requests per account and retire a key on a signature validation failure: see [Session grants on a shared account](#session-grants-on-a-shared-account).
16. **A sponsorship limit should count operations that landed, not approvals.** Observed, read in code. A gas sponsorship rule that allows one account setup operation per sender per day and counts the approval locks a holder out for 24 hours when a first attempt is approved and then does not land, and a retry button that cannot start a second attempt in the same tab leaves them with nothing to press. Count what landed, or allow a few approvals a day, and make a retry control really retry.
17. **A superseded pass push can be lost.** Observed on one run: after a sale, the previous owner's pass stayed in place instead of refreshing into its superseded state. The push for a supersede was sent once, a throttled or unanswered push was logged and dropped, and a queued push for the same content version could absorb it; which of these happened on that run was not established. The fix closes all three: a failed push is retried with backoff, the supersede push is never coalesced with another, and one follow-up push goes out about 90 seconds later. For this SDK see "A lost push" in the [Apple notes](platforms/apple.md).
18. **A reminder job can stop while every health check stays green.** Observed. A scheduled job that sends reminders can stop doing its work while the readiness endpoint stays green, because that endpoint reports something else: another job's success, or that the process is up. Give each scheduled job its own liveness signal (the time its last run completed, alarmed when stale), and run a canary from outside that checks the effect: a token past the threshold shows the reminder.
19. **A provider quota can starve chain reads on launch day.** Measured. Minutes before the mint opened, the RPC key behind the chain reads answered every call 429 with a monthly capacity message; each read then paid a failed call before falling over to the next endpoint, and some holders were shown a "could not verify" state. Configure and test a second provider before launch, and alert on the first one's budget and error rate. When the fresh entitlement read cannot be taken at all, the standard's answer is 503 `read_failed`, never a cached owner.
20. **One announcement per person, written to fit, with an expiry.** Measured on WALLETCHI: an announcement sent to every pass reached a holder of two passes twice, and grouping passes by holder and device turned 1,001 passes into 899 sends. Observed: a card line longer than about 38 characters was clipped on the smallest phones although the banner showed it whole, and on the mainnet deployment a banner line stayed on passes for hours because clearing it was a manual step. Send one per person, write the line to fit the card, and let every announcement quiet and clear itself after a set time.
21. **Do not bake a duration into pass text.** Observed. A status line naming a remaining time was written when the pass was built and not refreshed, so a holder who acted every day read the same duration every day, and a reminder line naming hours left stayed on the card after those hours had passed. Put the time in a date field the device renders relative to now, or word the line so it stays true until the next update.
22. **A link is never a login.** Observed, caught in code review. A feature reached from a pass link created a browser session from the link alone, so anyone holding the link held the session. A capability link may trigger its one bounded action; it must never create a session, identify a person or open private content, which need the holder's own sign-in or a signed challenge, checked on the server.
23. **Pushes without change get an issuer throttled.** Measured on WALLETCHI on 2026-10-21. iOS told holders that their passes were receiving too many updates and that automatic updates would be turned off: an hourly forced refresh had every pass downloaded about 24 times a day (a median of 27 per iPhone, 37 percent of them unchanged), and the device logs named a push with no change, a fetch answered 200 where 304 was due, and a push to a device with no registration. After pushing only on real change and answering 304 correctly, web service errors in the device log fell from about 50 an hour to 1. Pace a collection-wide re-issue and keep it silent.
24. **Records keyed to a wallet provider's user id are orphaned when that user is deleted or restored.** Observed. After duplicate embedded-wallet users were deleted at the provider and the originals restored, some holders signed in with the right email and were refused as "email in use": the application's account row was keyed to the provider's user id, and nothing re-keyed it when the provider's side changed. Plan for it, and log refused sign-ins so the people affected can be found.
25. **Send a body with every POST.** Observed on phones and reproduced with a bare request. A POST sent with no body and no `Content-Type` was answered 415 by the API gateway before the application ran; a desktop browser added a length header and hid it. Have every client write send a JSON body (`{}` when the route needs none), and test with a bare `curl -X POST`, not a laptop browser.
26. **Build the new owner's pass before they ask, and not where actions are served.** Observed. People who received a transferred token waited about five minutes for their pass: the Apple bundle was built only on demand by the API, which declines to build when busy, and the site stopped asking after 90 seconds and kept the "not ready" answer for five minutes. Building the bundles in the process that also sends transactions was not the answer: signing there would block that process's event loop, so a separate service builds them. Build on the transfer event, in a process that shares nothing with the action path, and keep asking until the pass is ready.
27. **How to sunset a collection.** Done on WALLETCHI on 2026-11-06 and checked live. Every user route answers 410, with a page for a person when a browser asks (pass links and old emails land there) and JSON otherwise, and the sponsorship webhook approves nothing. Every pass was given its final line by a silent update, with no change message. The Apple web service stays reachable, because an iPhone has to fetch a silently pushed pass; the first cut answered it 410 too, which would have updated only Android passes, which are patched directly. Every background job is stopped so nothing pushes, mails or writes to the chain again, and nothing was deleted, so it can be undone.
