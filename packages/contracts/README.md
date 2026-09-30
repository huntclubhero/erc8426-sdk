# @erc8426/contracts

Solidity for [ERC-8426](https://github.com/ethereum/ERCs/pull/2036), the Wallet Pass Extension for NFTs: the interface, an OpenZeppelin base contract, an ERC-4907 rental extension, an on-chain bound for pass-reachable actions, and seven worked use cases with full Foundry tests.

ERC-8426 lets an ERC-721 token advertise a native mobile wallet pass (Apple Wallet, Google Wallet). On chain it adds only discovery (`passURI`) and a freshness signal (`PassUpdate`, `BatchPassUpdate`); pass generation, signing, delivery and the authorization of pass actions live off chain (see the other packages in this SDK).

| Path | What it is |
| - | - |
| `src/IERC721WalletPass.sol` | The interface, exactly as in the spec. ERC-165 id `0xef5f1e71`. |
| `src/ERC721WalletPass.sol` | Abstract OZ `ERC721` extension: `passURI`, settable base, `_passUpdate`, `_batchPassUpdate`, pass update on transfer, optional ERC-4906 mirror. |
| `src/extensions/ERC721WalletPassRentable.sol` | ERC-4907 rentals with a documented entitlement precedence (`passHolderOf`). |
| `src/utils/BoundedAction.sol` | The on-chain half of the spec's capability configuration: operator actions limited by action id, rate and value, inspectable, revocable per token by its owner. |
| `src/examples/*.sol` | `PetPass`, `StoredValueCard`, `StakingPass`, `EventTicketPass`, `MembershipPass`, `IdentityCredential`, `RentalPass`. |
| `src/mocks/*.sol` | `MockERC20` (6 decimal stablecoin stand-in) and `MockERC721`, open minting, for tests and local demos only. |
| `src/interfaces/` | `IERC4907`, `IERC5192`. |
| `abi/*.json` | ABI arrays for TypeScript (`import petPassAbi from "@erc8426/contracts/abi/PetPass.json"`). |
| `artifacts/*.json` | `{ contractName, abi, bytecode }` for each deployable contract (examples and mocks). |

## Install

### npm (Hardhat, Foundry with node_modules, or ABIs for TypeScript)

```sh
pnpm add @erc8426/contracts
```

OpenZeppelin Contracts 5.1 comes in as a dependency. Hardhat resolves `@erc8426/contracts/src/...` and `@openzeppelin/contracts/...` from `node_modules` on its own. In a Foundry project, add remappings:

```text
@erc8426/contracts/=node_modules/@erc8426/contracts/
@openzeppelin/contracts/=node_modules/@openzeppelin/contracts/
```

### Foundry only

Copy or vendor `src/` into your `lib/` (for example as `lib/erc8426/src`) and remap `@erc8426/contracts/=lib/erc8426/` alongside your existing OpenZeppelin 5.x remapping. The sources import OpenZeppelin as `@openzeppelin/contracts/...`.

Solidity `^0.8.24`; this package builds and tests with solc 0.8.26 (see `foundry.toml`).

## Usage

### A wallet pass collection

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC721WalletPass} from "@erc8426/contracts/src/ERC721WalletPass.sol";

contract LoyaltyCard is ERC721WalletPass, Ownable {
    mapping(uint256 => uint256) public points;

    constructor(address owner_)
        ERC721("Loyalty Card", "LOYAL")
        // Base encodes chain and contract so one server can serve many collections.
        ERC721WalletPass("https://passes.example/wallet-pass/eip155/8453/0xYourContract/")
        Ownable(owner_)
    {}

    function addPoints(uint256 tokenId, uint256 amount) external onlyOwner {
        points[tokenId] += amount;
        _passUpdate(tokenId); // the pass renders points, so signal staleness
    }

    function setPassBaseURI(string calldata base) external onlyOwner {
        _setPassBaseURI(base);
    }
}
```

What you get:

- `passURI(tokenId)` returns base + decimal id and reverts with `ERC721NonexistentToken` for unminted or burned ids, as the spec requires.
- `supportsInterface(0xef5f1e71)` returns true.
- `PassUpdate` fires on every mint, transfer and burn. The spec asks issuers to update or visibly supersede a previous owner's pass and to rotate acquisition URLs once a transfer is observed; emitting from the transfer hook gives every pass distributor that signal without extra call sites. Override `_passUpdateOnTransfer()` to return false if your pass does not depend on the holder.
- `_batchPassUpdate(from, to)` for collection-wide refreshes; the range is inclusive and reverts if inverted.
- Override `_mirrorsMetadataUpdates()` to return true if you serve the manifest in `tokenURI` metadata (public configuration only). Pass updates then also emit ERC-4906 `MetadataUpdate` / `BatchMetadataUpdate` and `supportsInterface(0x49064906)` returns true.

### Rentals (ERC-4907)

Inherit `ERC721WalletPassRentable` instead. `setUser` emits `UpdateUser` and `PassUpdate`, a transfer clears the rental, and `passHolderOf(tokenId)` returns the one account entitled to pass actions right now: the active renter if there is one, otherwise the owner. That is the precedence rule the spec asks for ("a rental entitlement SHOULD be exclusive of the owner"). Verifiers must read it fresh on every request. Rental expiry is passive (no event); render it as a relative date on the pass.

### Bounding a pass-reachable action

The spec's capability configuration lets a pass link trigger an action without a per-action signature only if, among other conditions, the action cannot transfer, burn or approve the token, its effect under unlimited repetition is bounded and documented, and the owner can rotate the link. `BoundedAction` puts the bound on chain:

```solidity
import {BoundedAction} from "@erc8426/contracts/src/utils/BoundedAction.sol";

contract CoffeeCard is ERC721WalletPass, BoundedAction, Ownable {
    bytes32 public constant STAMP = keccak256("STAMP");

    constructor(address owner_) ERC721("Coffee", "CUP") ERC721WalletPass("https://p.example/") Ownable(owner_) {
        // At most 3 stamps per card per day, moving no value.
        _configureAction(STAMP, 3, 1 days, 0, 0);
    }

    function setOperator(address relayer, bool allowed) external onlyOwner {
        _setActionOperator(relayer, allowed);
    }

    function stamp(uint256 tokenId) external onlyBoundedAction(STAMP, tokenId, 0) {
        // ... update state ...
        _passUpdate(tokenId);
    }

    function _boundedActionOwner(uint256 tokenId) internal view override returns (address) {
        return _requireOwned(tokenId);
    }
}
```

- Only appointed operators (your relayer or a scoped session key) pass the guard, and only for the action id the function names.
- `actionBound(actionId)` returns `(maxPerWindow, windowSeconds, maxValuePerCall, maxValuePerWindow, frozen)`: this is the bound you document. `actionUsage` and `remainingInWindow` show live usage.
- The token owner calls `setOperatorRevoked(tokenId, operator, true)` to stop an operator acting for their token at once. The revocation belongs to that owner and does not bind a buyer.
- `_freezeActionBound(actionId)` makes the bound tighten-only, turning it into a commitment.
- Windows are fixed, not sliding: over time the rate is at most `maxPerWindow` per `windowSeconds`, but two back-to-back windows allow up to twice the cap inside one span of `windowSeconds`. State the bound with that factor.
- It does not replace the fresh entitlement read (spec check 2). Your verifier still reads `ownerOf` at request time before submitting the operator transaction.

## Examples and their security model

Each example's header comment explains, per the spec's capability conditions, what a pass link may reach and what needs the owner's own signed transaction.

| Example | Use case | Pass-reachable (capability link or scan) | Owner or role signature only | Why |
| - | - | - | - | - |
| `PetPass` | WALLETCHI-style care game; a need unmet for `lapseSeconds` kills the pet | `feed`, `water`, `play` through the operator | transfer, approve, `setOperatorRevoked` | Care cannot move the token or value; `BoundedAction` caps it (default 4 of each per day). The owner may also care directly, unbounded, on the signed path. |
| `StoredValueCard` | Stablecoin spending card with punches (PUNCHCARD) | `charge` (per-tx and daily caps, registered merchants only), `redeemReward` | `withdraw` (any amount, any recipient), transfer, approve | A charge moves value, so it is value-bounded on chain; the documented worst case of a leaked QR is the daily cap spent at registered merchants. Withdraw is an unbounded transfer to a chosen address, which no link may reach. The header maps the design onto an ERC-6551 account with an issuer spender. |
| `StakingPass` | Stake an NFT, carry the position on a pass, accrue ERC-20 rewards | `claim`, permissionless | `unstake` (burns the receipt, returns the NFT), transfer | `claim` pays only the current receipt owner and never more than accrued, so repetition is bounded by construction and no operator key is needed. Unstake burns, which the spec forbids through a link. |
| `EventTicketPass` | Tickets that become keepsakes after the show; ERC-2981 royalties | none (door staff sign `checkIn`; `endShow` is permissionless after the end time and only signals) | `checkIn` (DOOR_ROLE, once per ticket), issuer minting | The scanned pass only selects the ticket; the door account's signature authorizes it. Show end emits one `BatchPassUpdate` over the show's reserved id range. |
| `MembershipPass` | Tiered, expiring membership | none (a renew page is signed by the payer) | `renew` (payer), `issuerRenew`, `setTier` (issuer) | Renewal is paid by whoever calls it and only extends; nothing moves the token. |
| `IdentityCredential` | Soulbound credential (ERC-5192), revocable, expiring | none | `issue`, `revoke`, `extend` (attester); `renounce`, `requestPassRotation` (holder) | A soulbound token never transfers, so transfer-driven link rotation never fires: rotation on the owner's request is the only remedy, and `requestPassRotation` signals it on chain. |
| `RentalPass` | Rentable access pass (ERC-4907); the renter holds the pass during a rental | whatever the issuer exposes, entitled by `passHolderOf` (renter exclusive of owner while a rental is active) | `setUser` (owner or approved), transfer, approve | `setUser` changes who is entitled, so it is never pass-reachable; the renter cannot extend their own rental; a transfer clears the rental. Expiry is passive. |

Passive changes (death by lapse, reward accrual, membership or rental expiry, a show ending) happen without a transaction and so without an event. Render them as relative dates or rates on the pass.

The examples are teaching code: they are tested, but not audited. Review them before deploying anything that holds value.

## Build, test, ABIs

```sh
cd packages/contracts
forge build
forge test
node scripts/export-abis.mjs   # or: pnpm run build (does both)
```

Foundry writes full artifacts (ABI, bytecode, metadata) to `out/<File>.sol/<Contract>.json`. `scripts/export-abis.mjs` copies the ABI arrays of the public contracts to `abi/<Contract>.json`, and for every deployable contract (examples and mocks) writes `{ contractName, abi, bytecode }` to `artifacts/<Contract>.json`. Both ship in the npm package, so TypeScript can deploy without Foundry:

```ts
import petPass from "@erc8426/contracts/artifacts/PetPass.json";
const hash = await wallet.deployContract({
  abi: petPass.abi,
  bytecode: petPass.bytecode as `0x${string}`,
  args: [passBaseURI, issuer, 3n * 86400n],
});
```

### Setup: forge-std

Tests and the deploy script use forge-std from `lib/forge-std`, which is gitignored. On a fresh clone, from the repository root, run:

```sh
git clone --depth 1 --branch v1.16.2 https://github.com/foundry-rs/forge-std packages/contracts/lib/forge-std
```

### Local deployment

```sh
anvil
pnpm run deploy:local
```

`script/DeployExamples.s.sol` deploys the mocks and every example, appoints the operator, registers it as a merchant and door account, funds the staking reward pool, sets base URIs of the form `<origin>/wallet-pass/eip155/<chainId>/<contract>/`, and logs the addresses. Optional env: `OPERATOR` (defaults to anvil's second dev account) and `PASS_BASE_URL` (defaults to `http://localhost:3000`). It signs through anvil's unlocked account, so no key is involved. The mocks mint to anyone: never deploy them to a public network.

## License

MIT. The ERC-8426 specification text itself is CC0.
