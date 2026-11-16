# Wallet Pass Binding for ERC-1155 (proposed draft)

Status: a proposed draft for review on the Ethereum Magicians thread for ERC-8426. It is not an ERC pull request and is not yet formatted as one. It is a companion to ERC-8426 and would require ERC-165, ERC-1155 and ERC-8426.

Every line below is marked with what stands behind it:

- (built) runs in tests on this branch, and where it says so, on a public testnet.
- (not built) is text only. It stays a proposal until it runs.
- (open) is a question for reviewers.

Running demo: <https://erc8426-demo.vercel.app/edition>. Contract `VoteEditionPass` at `0x7de2842c27ea0652e0688e0def03715dd8a4d89e` on Robinhood Chain testnet (chain id 46630), source verified.

## What this is

ERC-8426 binds a wallet pass to one ERC-721 token and its one owner. This document says only what changes when the token is an ERC-1155 id with many holders and balances. Everything it does not restate applies as written in ERC-8426: the manifest, the two configurations, the challenge, the capability conditions, the refusal codes, and the Pass Issuer and Client requirements.

## Scope: holding only

This binding covers passes that show a holding: memberships, editions, badges, "show your card".

Out of scope, and named so nobody assumes otherwise:

- Redemption: an admission, a claim, anything that can be used up. See "A balance is not a unit".
- A door scanning a pass. That is a third party reading a bearer artifact, a different shape from a holder following a link, and ERC-8426 has no text for it.

## The binding

- A pass is bound to a pair: a token id and an account. Two accounts that hold the same id hold two passes, with two sets of URLs. (built)
- An account is entitled to the pass of an id when a fresh `balanceOf(account, id)` is at least the minimum holding for that id. The minimum defaults to 1. A Pass Issuer that uses another minimum MUST document it per id. (built)
- The fresh entitlement read of ERC-8426 is that `balanceOf` read, taken at request time at `latest`, for the account the challenge names or the capability URL was issued to. (built)
- The claimed account is always named in the challenge. The token resource is the CAIP-19 identifier under the `erc1155` namespace: `eip155:<chain>/erc1155:<contract>/<id>`. A proof that names the same contract and id under `erc721` MUST be refused as `binding_mismatch`. (built)
- Per account or per unit: the Pass Issuer picks per id and documents it.
  - Per account, the default: one pass per pair. A balance above the minimum does not make more passes. The pass MAY show the balance. (built)
  - Per unit: several passes drawn on one account's balance. One rule: the live passes drawn on an account's balance, its delegates' included, MUST never number more than that balance at the fresh read. Units have no identity, so an issuer that retires one pass when one unit leaves MUST say which one. (not built)
  - If a per unit mode is specified, a wallet should not have to read the issuer's documentation to learn it. An optional member of the manifest is the proposed place. The mode is the Pass Issuer's and not the token contract's: an issuer can serve a collection it did not deploy. (not built, open)

## Contract interface

`passURI(uint256 id)`, `PassUpdate(uint256 indexed id)` and `BatchPassUpdate(uint256 fromId, uint256 toId)` carry over unchanged. (built)

The ERC-165 identifier is reused: `0xef5f1e71`. An ERC-165 identifier is the XOR of the function selectors, and `passURI(uint256)` is the only function, so any interface with that function has that identifier whatever it is named. A separate identifier would need a different function. (built: a test asserts the two interface ids are equal)

Two lines of the ERC-8426 contract text read differently here:

- `passURI` throws for a token that is not valid. ERC-1155 has no test for that. The reference base uses "total supply above zero", and a contract without supply tracking needs its own rule. (built in the reference base; the normative wording is open)
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

- A bound on a capability action that is counted per account is not a bound. Units move, so one unit that visits N accounts gets N times the bound. Under this binding the documented bound of a capability action MUST hold however many accounts a unit passes through. In practice the bound is enforced against something a moving unit cannot multiply: a snapshot, the id as a whole, or the chain. (built, after our own first demo action, "5 stamps per account per day", was defeated exactly this way)
- The fresh read admits the request. It MUST NOT decide what the action weighs. The worked example is a vote, one unit one vote: weight is the account's balance at the proposal's snapshot, from checkpoints the contract writes on every transfer, so the votes of all accounts never exceed the supply at the snapshot. A unit that moves after the snapshot carries no vote. (built: `VoteEditionPass`, with a fuzz test of that invariant)
- Where an action can arrive by both paths, the signed path SHOULD be able to override the capability path, and never the reverse. In the example a vote arrives by the link on the pass, by a signature the Pass Issuer relays, or in the holder's own transaction, and replaces an earlier vote only if it arrived a stronger way. A link votes once and never changes a vote. (built)
- An action that concerns one of several open things names which one. In the example the link carries the proposal, and the page shown before confirming says which proposal the tap is for. (built)

Whose button it is when an id has many holders, and actions that spend a fungible balance, belong to the Wallet Pass Actions document, which comes second.

## Losing entitlement

ERC-8426 says "on transfer" in three places: the gated configuration, the capability conditions and the Pass Issuer requirements. The trigger is losing entitlement, which a transfer may or may not cause. A rental ending is not a transfer either, so that wording is to be corrected in ERC-8426 itself. For this binding, an account loses entitlement when its balance of the id falls below the minimum.

- A transfer that leaves the sender at or above the minimum MUST NOT retire the sender's URLs. Selling one of three at a minimum of 1 changes nothing but the count. (built)
- A transfer never touches the pass of an account that is not its sender or receiver. (built)
- A Pass Issuer that takes a fresh read and finds the account below the minimum SHOULD act on it then, on any request, and not wait for an event or a timer. Otherwise the link it just refused answers again when the balance returns. (built: our first version answered 403 and left the link alive)

What happens to the pass depends on which path its actions take:

- A pass that carries even one capability link: the Pass Issuer MUST retire the account's links and acquisition URLs when it finds the account below the minimum. The account leaves the issued set. If it holds again, its next acquisition is a first claim with new URLs and never the retired ones, the rule ERC-8426 states since ethereum/ERCs #2173. Reason: the link stands in for the proof, the holder stopped guarding the card when the balance left, and a return would revive every copy with nobody having done anything. (built)
- A pass whose every action takes the signed path: the installed pass MAY go dark and come back. The link only reaches the flow and the proof carries the authority, so a copy in someone else's hands still cannot sign. This is an exception to Gated acquisition and has to be written as one. (built in the issuer and unit tested; not yet seen on a real phone)
  - The acquisition URLs MUST still be retired, including when a balance left and came back. In the gated configuration they are possession proofs for the download. (built)
  - A dark pass SHOULD say that it is dark, for the reason a superseded pass says why. (built)
- Staking and escrow: use a documented entitlement that reads the staking or escrow contract's record fresh, so the holder never loses entitlement in the first place. (not built)

## How the issuer finds out

- The truth is a fresh read over the accounts the Pass Issuer issued passes to. It needs no index of the chain's holders or transfers, and it survives a missed event. (built with one read per issued account; `balanceOfBatch` in one call is not built)
- `TransferSingle` and `TransferBatch` are a hint that says which two accounts to read now. A transfer of zero units is free, can name anyone, and MUST NOT count as a signal. (built)
- What the read cannot see is a balance that left and came back between two reads. The events are still for that: with the block of the transfer, the issuer reads the balance at that block as well. This matters only for a pass that is retired on loss. (built)
  - That read applies to the accounts of that transfer only, and never to a pass issued after that block. (built: our first version let a late log retire a pass claimed after the unit came back)
  - It is best effort, a SHOULD and not a MUST. A node keeps old state for a limited time, a few hours on the public testnet node used here. A log that arrives later cannot be read at its block, and the reference issuer then changes nothing and reports a failed read.
- The receiver needs no trigger: an account that newly reaches the minimum is served by its own first claim. (built)
- As in ERC-8426, the fresh read at the time of the request is the boundary. Everything above only closes the residual window.

## Who can retire what

There is no "the owner".

- An entitled account MAY request rotation of its own URLs, and in the capability configuration the Pass Issuer MUST honor it. (built)
- No holder can retire the URLs of another holder. (built)
- An account's request also retires the URLs of accounts whose entitlement derives from it, such as a delegate it authorized. (not built)
- Delegates: per account passes stay additive, as the ERC-8426 text has it. Per unit passes count delegated passes against the balance. (not built)

## Freshness

- `PassUpdate(id)` reaches every pass issued for that id. The Pass Issuer already keeps the set of accounts it issued to, so the push needs no holder index. Each account gets its own fresh read first, so content is never pushed to an account that no longer holds. (built)
- One holder's action concerns that holder's pass. It MUST NOT cause a read or a push for every other holder of the id. (built: our first version fanned out on every action, which made any holder a way to make the issuer notify everyone)
- A transfer that leaves an account entitled MAY refresh that account's pass, since it can show the balance. (built)
- The issued set is the live passes: an account leaves it when its pass is retired. Behind more than one instance it needs atomic add and remove. (built)
- A SHOULD on bounding or pacing the fan-out of `PassUpdate`, or leave it to implementation notes? (open)

## Left out on purpose

- Operator approvals (`setApprovalForAll`) as entitlement: an operator is not a holder.
- Everything listed under "Scope: holding only".

## What stands behind this draft

- A reference ERC-1155 base contract with `passURI` and the events, and three example contracts (`EditionPass`, `VoteEditionPass`, `SwapOnRedeemTicket`), with forge tests.
- The SDK taught the binding for the gated configuration, per account: core, issuer, client and the example app, with unit tests and an end to end run on a local chain against the real Apple and Google providers.
- A scripted run of the whole gated flow against a public testnet, in `tests/testnet`, that anyone can repeat with five funded keys.
- The hosted demo above, with a scripted check of 38 steps against it (`examples/next-app/scripts/smoke-edition.mjs`).
- Two adversarial reviews of the build. Their findings are fixed with tests and several became lines of this text.

Not built: per unit passes, the public configuration, delegates, a staking policy, `balanceOfBatch` in one call, a conformance profile for this binding, and a reference server for the ERC assets. No real phone has shown the dark pass yet.

## Open questions

1. The normative wording for "`passURI` throws for a token that is not valid" where a contract tracks no supply.
2. Whether the fan-out of `PassUpdate` gets a SHOULD on pacing.
3. For a Pass Issuer whose every action takes the signed path: is dark the default on lost entitlement, or retire with dark as an opt in? The reference issuer defaults to dark there today.
4. The manifest member that would announce a per unit mode, if per unit is specified at all in a first version.
