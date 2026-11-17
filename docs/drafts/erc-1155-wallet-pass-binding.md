# Wallet Pass Binding for ERC-1155 (proposed draft)

Status: a proposed draft for review on the Ethereum Magicians thread for ERC-8426. It is not an ERC pull request and is not yet formatted as one. It is a companion to ERC-8426 and would require ERC-165, ERC-1155 and ERC-8426.

Each requirement below says what stands behind it:

- (built) runs in tests in this repository, and where it says so, on a public testnet.
- (not built) is text only. It stays a proposal until it runs.
- (open) is a question for reviewers.

Running demos on Robinhood Chain testnet (chain id 46630). The first two contracts have verified source:

- A pass with one tap links, which is retired when its account stops holding: <https://erc8426-demo.vercel.app/edition>, contract `VoteEditionPass` at `0x4966fe595829e7c537d5309a234fff068e13f123`.
- A pass with no links, which goes dark and comes back: <https://erc8426-demo.vercel.app/member>, contract `EditionPass` at `0x42aaeaaa9be01f6cf9b5e3b03a15d53a06e175fe`.
- An ERC-721 rental that ends by the clock, which is where open question 1 comes from: <https://erc8426-demo.vercel.app/rental>, contract `RentalPass` at `0x0853985646c829ac885e7ce35e9eb52ee22fa3f1`.

## What this is

ERC-8426 binds a wallet pass to one ERC-721 token and its one owner. This document says only what changes when the token is an ERC-1155 id with many holders and balances. Everything it does not restate applies as written in ERC-8426: the manifest, the two configurations, the challenge, the capability conditions, the refusal codes, and the Pass Issuer and Client requirements.

## Design goal

ERC-8426 exists so that a person can use what they hold from the wallet that is already on their phone. They add a card to Apple Wallet or Google Wallet, they watch it change, and they tap it. There is no browser extension, no separate app, no seed phrase to look after, and nothing to learn about a chain before the first tap. Once the card is added, the everyday action is a tap on it. It has run this way in two implementations: a pet that lived on its pass and was cared for from the pass, through a season on a test network, and a collection on mainnet whose holders tend what they hold from the card today.

This binding keeps that for tokens with many holders, and it is the test for what belongs in this document:

- What the holder does stays a tap on a card. A rule that keeps that tap safe belongs here even when it is strict, because a tap that nobody can abuse is the only reason it can go without a signature.
- The work lands on the Pass Issuer and the contract. Nearly every MUST below is something the holder never sees.
- Anything that would give the holder one more step, one more signature, one more app or one more thing to understand needs a reason this document can state. Where there is none, it is left out or made optional.
- The signed path stays for what a link must never do: transfer or burn what is held, change who is entitled, or overrule a link. It is the exception and the card is the front door.

## Scope: holding only

This binding covers passes that show a holding: memberships, editions, badges, "show your card".

Out of scope, and named so nobody assumes otherwise:

- Redemption: an admission, a claim, anything that can be used up. See "A balance is not a unit".
- A door scanning a pass. That is a third party reading a bearer artifact, a different shape from a holder following a link, and ERC-8426 has no text for it.

## The binding

- A pass is bound to a pair: a token id and an account. Two accounts that hold the same id hold two passes, with two sets of URLs. (built)
- An account is entitled to the pass of an id when a fresh `balanceOf(account, id)` is at least the minimum holding for that id. The minimum defaults to 1. A Pass Issuer that uses another minimum MUST document it per id. (built with one minimum for the whole issuer; a minimum per id is not built)
- The fresh entitlement read of ERC-8426 is that `balanceOf` read, taken at request time at `latest`, for the account the challenge names or the capability URL was issued to. A read at a head the node has just named (ask for the newest block, then read at that block) counts as a read at `latest` here: that block was the node's newest a moment before, and it is never a `safe` or `finalized` one. The read that admits a claim is taken that way, so that it also dates the pass (see Losing entitlement). (built)
- The claimed account is always named in the challenge. The token resource is the CAIP-19 identifier under the `erc1155` namespace: `eip155:<chain>/erc1155:<contract>/<id>`. A proof that names the same contract and id under `erc721` MUST be refused as `binding_mismatch`. (built)
- One pass per pair. A balance above the minimum does not make more passes. The pass MAY show the balance. (built)

## Per unit passes: not in this version

This version has one mode, one pass per account, so there is nothing for a wallet or an indexer to discover. Several passes drawn on one account's balance (a family with four tickets wanting four cards) is left for a later version, and it is recorded here so that version starts from what the thread settled. (not built)

- The rule: the live passes drawn on an account's balance, its delegates' included, MUST never number more than that balance at the fresh read. Units have no identity, so an issuer that retires one pass when one unit leaves MUST say which one.
- Discovery ships with the mode, never after it. Nobody should have to read an issuer's documentation to learn which mode an id uses.
  - The manifest carries it, as a member a Client reads when it gets the pass. This is the required place.
  - A gated manifest cannot be read without a holder's proof, so an indexer cannot see that member. For those readers a contract MAY also answer a view, `passBindingMode(uint256 id)`, under an ERC-165 identifier of its own. It is a separate, optional interface so that `passURI(uint256)` stays the only function of the wallet pass interface and the identifier `0xef5f1e71` stays shared with ERC-721.
  - Where both exist they MUST agree, and a contract that changes the mode of an id emits an event of its own for it. It does not reuse `PassUpdate`, which tells issuers to render again and push to phones.

## Contract interface

`passURI(uint256 id)`, `PassUpdate(uint256 indexed id)` and `BatchPassUpdate(uint256 fromId, uint256 toId)` carry over unchanged. (built)

The ERC-165 identifier is reused: `0xef5f1e71`. An ERC-165 identifier is the XOR of the function selectors, and `passURI(uint256)` is the only function, so any interface with that function has that identifier whatever it is named. A separate identifier would need a different function. (built: a test asserts the two interface ids are equal)

Two lines of the ERC-8426 contract text read differently here:

- `passURI` MUST throw for an id the contract serves no pass for, and a contract that tracks supply SHOULD treat an id with no supply as one. The call is the discovery: a Client learns whether an id has a pass by calling it, so the rule behind the throw need not be the same in every contract, and a throw means "no pass now", since the same id can answer after a mint. (built in the reference base, which uses "total supply above zero")
- `PassUpdate(id)` concerns every pass issued for the id, one per holding account. A transfer SHOULD NOT emit it by default: `TransferSingle` and `TransferBatch` already name the two accounts whose balances changed. Where a contract does emit it on transfer, it SHOULD NOT do so for a transfer of zero units. (built)

## The Client

Nothing in the Client requirements reads ownership. The Client fetches the manifest, signs a challenge that names an account, and takes what comes back.

One exception, found by running it: before it signs, a Client checks that the challenge names the token it asked about, and under this binding the token is written under the `erc1155` namespace. A Client therefore has to know which namespace to expect. It can learn that with one ERC-165 read of the ERC-1155 identifier (`0xd9b67a26`), or be told by the application. (built: the reference client refused to sign until it did this)

## Configurations

- Gated configuration: the manifest is resolved per account by the `acquire` proof, as in ERC-8426. Acquisition URLs and action links are issued per pair and bound to that account. (built)
- Public configuration: one manifest per id, the same for every reader. Its passes are not personal and MUST NOT carry action links. (not built: the reference issuer refuses this combination at startup)

## A balance is not a unit

`ownerOf` answers for one token, and anything recorded against that token id follows it through a sale. Where an id has a supply above one, its units have no identity. A fresh `balanceOf` read proves that the account holds at least the minimum now. It never proves that a unit is unused: an account can hold one unit, use it, send it to a second account, and the read passes there again. (built: a test admits one unit twice)

- A Pass Issuer MUST NOT treat the fresh entitlement read as proof that a unit is unused.
- Redemption is out of scope. An implementation that adds it anyway needs one of:
  1. the redeemable thing has its own id with a supply of one, so the ERC-8426 rule for one token applies;
  2. the action changes the balance in the same transaction that records the use: the unit is burned, or exchanged for a different id that marks it used (built: the example contract `SwapOnRedeemTicket`);
  3. the id cannot be transferred for the period in which it can be used.
- A record of use kept against the account, on or off chain, does not close it.
- Option 2 burns the unit or changes entitlement, which the capability conditions of ERC-8426 forbid a link to do. It belongs on the signed path.

## Actions under this binding

- A bound on a capability action that is counted per account is not a bound. Units move, so one unit that visits N accounts gets N times the bound. Under this binding the documented bound of a capability action MUST hold however many accounts a unit passes through. In practice the bound is enforced against something a moving unit cannot multiply: a snapshot, the id as a whole, or the chain. (built, after our own first demo action, "5 stamps per account per day", turned out to have exactly this hole)
- The fresh read admits the request. It MUST NOT decide what the action weighs. The worked example is a vote, one unit one vote: weight is the account's balance at the proposal's snapshot, from checkpoints the contract writes on every transfer, so the votes of all accounts never exceed the supply at the snapshot. A unit that moves after the snapshot carries no vote. (built: `VoteEditionPass`, with a fuzz test of that invariant)
- Where an action can arrive by both paths, the signed path SHOULD be able to override the capability path, and never the reverse. In the example a vote arrives by the link on the pass, by a signature the Pass Issuer relays, or in the holder's own transaction, and replaces an earlier vote only if it arrived a stronger way. A link votes once and never changes a vote. (built)
- Overriding needs time. Where an action has a deadline, the capability path SHOULD close before the signed one, so that what a link did can still be overruled. In the example a link vote is not accepted in the last fifth of a voting period. (built: in our first version all three ways shared one deadline, so a link vote that landed at the close was final)
- Where a capability action concerns one of several things that open and close (a proposal, a round), its link SHOULD be bound to that thing and end with it: minted for the one that is open, acting on that one from the Pass Issuer's own record of the link and not from a parameter of the request, and resolving to nothing once it has closed. A link that ended is not a rotation. The pass keeps its serial and its other URLs and the link for the next thing is delivered to the same installed pass, so ERC-8426's rule against delivering new links to the passes that carried the old ones does not apply to it. It does nothing for a copied pass, which is pushed each new link like the original; rotation is the remedy there. (built: `subject` on an action. In the example the link was one URL with the proposal as a parameter, and a link seen during one proposal cast the account's first vote on the next; it now answers 404 once its proposal has closed)
- Where a Pass Issuer does not bind the link that way, the documented bound of the action is stated over the life of the link, not per use.
- An action that concerns one of several open things names which one. In the example the link carries the proposal, and the page shown before confirming says which proposal the tap is for. (built)

Whose button it is when an id has many holders, and actions that spend a fungible balance, belong to the Wallet Pass Actions document, which comes second.

## Losing entitlement

ERC-8426 makes a transfer the trigger in several places, among them the gated configuration, the capability conditions and the Pass Issuer requirements. The trigger is losing entitlement, which a transfer may or may not cause. A rental ending is not a transfer either, so that wording is to be corrected in ERC-8426 itself. For this binding, an account loses entitlement when its balance of the id falls below the minimum.

- A transfer that leaves the sender at or above the minimum MUST NOT retire the sender's URLs. Selling one of three at a minimum of 1 changes nothing but the count. (built)
- A transfer never touches the pass of an account that is not its sender or receiver. (built)
- The moment is the read. A Pass Issuer that takes a fresh read and finds the account below the minimum SHOULD apply what follows then, on that request, whichever request it is (a link, a download, or the account's own proof), and not wait for an event or a timer. Otherwise the link it just refused answers again when the balance returns. (built: our first version answered 403 and left the link alive)
- Acting on a loss costs the holder more than a refusal does: a retired card has to be added again, and a dark one tells their lock screen. A node that lags answers from the past, and it gives the same answer however often it is asked, so a second read at `latest` does not test for it. What a lagging node cannot do is answer for a block it has not reached. So a Pass Issuer SHOULD date a pass with the block at which the account was read as entitled, take the read that shows a loss at a named block, and act only when that block is at or after the one the pass is dated with: the account held then and does not hold later, so the loss happened. The read that dates a pass is the read that admits its claim: the head is named, the read is taken at it, and the one answer both admits the account and dates the pass. A second read taken only to date the pass can reach a node behind the first, say "not entitled" for an account that holds, and leave the pass with no block and so with no test. A read the node cannot answer at the head it named is tried again inside the request before it is given up, since the nonce is spent by then and a failed claim costs the holder a new signature. A loss read from an earlier block, or one the node cannot answer, changes nothing and is tried again; the refusal of any other request is not affected and stays at `latest`. This holds wherever a pass can be lost: a holdings check, a refused request, the `PassUpdate` fan-out and the refresh after an action. What it does not cover is a reorganization that drops the block the loss was read at. (built: a simulated node one block behind the issuance used to take a live pass dark through the holdings check and through the fan-out, and "a second read agrees", our first answer, did not stop it. 0.5.1 then dated the pass with a second read after admitting the claim at `latest`: an account that claimed right after it received its unit could be issued a pass with no block and lose it to one lagging read. The reference issuer also compares a "not entitled" at the named head with one read at `latest` before it refuses a claim, and answers 503 when the two disagree, so a head named by a node behind the mint is not reported as "not the holder")

What happens to the pass depends on which path its actions take:

- A pass that can carry a capability link, which is any pass of an issuer that has a capability action whether or not a link is printed on it at the moment, is retired and never taken dark: the Pass Issuer MUST retire the account's links and acquisition URLs. The account leaves the issued set. If it holds again, its next acquisition is a first claim with new URLs and never the retired ones, the rule ERC-8426 states since ethereum/ERCs #2173. Reason: the link stands in for the proof, the holder stopped guarding the card when the balance left, and a return would revive every copy with nobody having done anything. (built)
- A pass whose every action takes the signed path: the installed pass MAY go dark and come back. The link only reaches the flow and the proof carries the authority, so a copy in someone else's hands still cannot sign. This is an exception to Gated acquisition and has to be written as one. It is the default for such a pass; a Pass Issuer MAY retire instead. (built, and seen on a real phone in Apple Wallet: the card went dark with a notification and came back as the same card)
  - The acquisition URLs MUST still be retired, including when a balance left and came back. In the gated configuration they are possession proofs for the download. (built)
  - A dark pass SHOULD say that it is dark, for the reason a superseded pass says why. (built)
  - A dark pass keeps its serial, so what the wallet platform holds for that serial is all that makes the card dark. A Pass Issuer MUST NOT hand out, or leave with a platform, live content rendered from a read taken before the pass went dark. (built: in our first version a download in flight while the unit left put the live card back)
  - A platform that updates a pass by merging keeps what an update leaves out. A dark pass replaces what the live pass showed (a barcode, for one) and does not merely omit it. (built in the example, found by review; not yet seen on a Google device)
- Staking and escrow: use a documented entitlement that reads the staking or escrow contract's record fresh, so the holder never loses entitlement in the first place. (not built)

## How the issuer finds out

- The truth is a fresh read over the accounts the Pass Issuer issued passes to. It needs no index of the chain's holders or transfers, and it survives a missed event. (built with one read per issued account; `balanceOfBatch` in one call is not built)
- `TransferSingle` and `TransferBatch` are a hint that says which two accounts to read now. A transfer of zero units is free, can name anyone, and MUST NOT count as a signal. (built)
- What the read cannot see is a balance that left and came back between two reads. A Pass Issuer SHOULD learn of a balance that fell below the minimum between two of its reads, by whatever means it has. The transfer events are one: with the block of the transfer, the issuer reads the balance at that block as well. An account found that way is treated as having lost the pass: retired where the pass is retired on loss, and its acquisition URLs replaced where the pass goes dark. (built)
  - That read applies to the accounts of that transfer only, and never to a pass issued after that block. (built: our first version let a late log retire a pass claimed after the unit came back)
  - It is best effort, which is why it is a SHOULD. A node keeps old state for a limited time: on the public testnet node used here a read 18 minutes back was answered and one 35 minutes back was not. A log that arrives later cannot be read at its block, and the reference issuer then changes nothing and reports a failed read.
- The receiver needs no trigger: an account that newly reaches the minimum is served by its own first claim. (built)
- As in ERC-8426, the fresh read at the time of the request is the boundary. Everything above only closes the residual window.

## Who can retire what

There is no "the owner".

- An entitled account MAY request rotation of its own URLs, and in the capability configuration the Pass Issuer MUST honor it. (built)
- No holder can retire the URLs of another holder. (built)
- An account's request also retires the URLs of accounts whose entitlement derives from it, such as a delegate it authorized. (not built)
- Delegates: per account passes stay additive, as the ERC-8426 text has it. Per unit passes count delegated passes against the balance. (not built)

## Freshness

- `PassUpdate(id)` reaches every pass issued for that id. The Pass Issuer already keeps the set of accounts it issued to, so the push needs no holder index. Each account gets its own fresh read first, so live content is never pushed to an account that no longer holds. (built)
- One holder's action concerns that holder's pass. It MUST NOT cause a read or a push for every other holder of the id. (built: our first version fanned out on every action, which made any holder a way to make the issuer notify everyone)
- A transfer that leaves an account entitled MAY refresh that account's pass, since it can show the balance. (built)
- The issued set is the live passes: an account leaves it when its pass is retired. Behind more than one instance it needs atomic add and remove. (built)
- No requirement on pacing the fan-out is needed: ERC-8426 already says not to push unchanged content, and a Pass Issuer renders from current state, so several `PassUpdate` signals for an id can be served by one fan-out. The contract has a side in this too: a contract SHOULD NOT let an arbitrary account cause `PassUpdate(id)` at no cost, through any function. (in the example contracts only the owner or an operator can cause one)

## Left out on purpose

- Operator approvals (`setApprovalForAll`) as entitlement: an operator is not a holder.
- Everything listed under "Scope: holding only".

## What stands behind this draft

- A reference ERC-1155 base contract with `passURI` and the events, and three example contracts (`EditionPass`, `VoteEditionPass`, `SwapOnRedeemTicket`), with forge tests.
- The SDK taught the binding for the gated configuration, per account: core, issuer, client and the example app, with unit tests and an end to end run on a local chain with the SDK's Apple and Google provider packages (self-signed certificates, and a stand-in for the Google Wallet API).
- A scripted run of the whole gated flow against a public testnet, in `tests/testnet`, that anyone can repeat with five funded keys.
- The two hosted demos above, each with a scripted check against it (`examples/next-app/scripts/smoke-edition.mjs`, 38 steps, and `smoke-member.mjs`, 16 steps).
- A real phone: a vote cast from the card in Apple Wallet with no signature, recorded on chain as a link vote, after a lock screen notification of the proposal; and the member pass going dark and coming back on the same card.
- Two adversarial reviews of the build. Their findings are fixed, nearly all with a test, and several became lines of this text.

Not built: per unit passes, the public configuration, delegates, a staking policy, `balanceOfBatch` in one call, a conformance profile for this binding, and a reference server for the ERC assets.

## Open questions

1. ERC-8426 and this draft both name the `latest` tag for the fresh read. Should each say in so many words that a read at a head the node has just named counts as one?
2. Per unit passes are left out of this version, with their discovery sketched above (a manifest member, plus an optional contract view under its own identifier). Is anyone building something that needs per unit in the first version?
