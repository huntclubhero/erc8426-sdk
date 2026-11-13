// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Supply} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {IERC1155WalletPass} from "./IERC1155WalletPass.sol";

/// @title ERC1155WalletPass (working draft)
/// @notice OpenZeppelin ERC-1155 extension carrying the on-chain half of a
///  wallet pass binding for ERC-1155: `passURI` per id and the two freshness
///  events. DRAFT: it follows a working draft of the binding, not a proposed
///  standard, and can change.
/// @dev As with `ERC721WalletPass`, the chain carries discovery and
///  freshness only. Who is entitled to a pass (a fresh
///  `balanceOf(account, id)` at or above a minimum holding) is read and
///  enforced by the Pass Issuer off chain, per holding account.
///
///  Access control is left to the inheriting contract: this base exposes
///  only internal setters.
///
///  Defaults, each overridable:
///  - `passURI(id)` is the pass base URI followed by the decimal id, and
///    reverts with `ERC1155WalletPassNonexistentId` while the id has no
///    supply. ERC-1155 has no notion of an id existing, so supply above
///    zero is the test this base uses.
///  - A transfer does NOT emit `PassUpdate` (see `_passUpdateOnTransfer`).
abstract contract ERC1155WalletPass is ERC1155Supply, IERC1155WalletPass {
    using Strings for uint256;

    /// @dev Base the per-id pass endpoint lives under.
    string private _passBaseURI;

    /// @notice Emitted when the pass base URI changes.
    event PassBaseURIUpdated(string newPassBaseURI);

    /// @notice Raised when a batch range is inverted.
    error ERC1155WalletPassInvalidRange(uint256 fromId, uint256 toId);

    /// @notice Raised by `passURI` while no pass base URI is set.
    error ERC1155WalletPassNoPassBaseURI();

    /// @notice Raised by `passURI` for an id with no supply.
    error ERC1155WalletPassNonexistentId(uint256 id);

    /// @param passBaseURI_ Initial pass base URI. May be empty and set later
    ///  with `_setPassBaseURI`; until then `passURI` reverts.
    constructor(string memory passBaseURI_) {
        _passBaseURI = passBaseURI_;
    }

    /// @inheritdoc IERC1155WalletPass
    function passURI(uint256 id) public view virtual returns (string memory) {
        if (!exists(id)) revert ERC1155WalletPassNonexistentId(id);
        string memory base = _passBaseURI;
        if (bytes(base).length == 0) revert ERC1155WalletPassNoPassBaseURI();
        return string.concat(base, id.toString());
    }

    /// @notice The current pass base URI.
    function passBaseURI() public view virtual returns (string memory) {
        return _passBaseURI;
    }

    /// @inheritdoc ERC1155
    /// @dev Reports the wallet pass identifier alongside ERC-1155's own.
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return interfaceId == type(IERC1155WalletPass).interfaceId || super.supportsInterface(interfaceId);
    }

    /// @dev Replace the pass base URI. Gate the external setter in the
    ///  inheriting contract.
    function _setPassBaseURI(string memory newPassBaseURI) internal virtual {
        _passBaseURI = newPassBaseURI;
        emit PassBaseURIUpdated(newPassBaseURI);
    }

    /// @dev Signal that pass content for `id` changed. The signal concerns
    ///  every pass issued for the id, so a Pass Issuer fans it out to each
    ///  account it issued a pass to. Emit it for changes to state the pass
    ///  renders for all holders, not for one holder's balance.
    function _passUpdate(uint256 id) internal virtual {
        emit PassUpdate(id);
    }

    /// @dev Signal that pass content changed for the inclusive range
    ///  [`fromId`, `toId`]. Reverts if the range is inverted.
    function _batchPassUpdate(uint256 fromId, uint256 toId) internal virtual {
        if (fromId > toId) revert ERC1155WalletPassInvalidRange(fromId, toId);
        emit BatchPassUpdate(fromId, toId);
    }

    /// @dev Whether a mint, transfer or burn emits `PassUpdate` for each id
    ///  it moves. Default false, the opposite of `ERC721WalletPass`.
    ///
    ///  Why off by default: a transfer changes the balances of two accounts,
    ///  and `TransferSingle` and `TransferBatch` already name both, so a
    ///  Pass Issuer can refresh those two passes from the transfer event
    ///  itself. `PassUpdate(id)` says the content changed for every holder
    ///  of the id, and emitting it per transfer would have an issuer push to
    ///  every pass of the id each time one unit moved. Override to return
    ///  true only if every holder's pass renders something a transfer
    ///  changes, such as the remaining supply. Know the cost before you do:
    ///  any holder can then make the issuer push to every pass of an id by
    ///  moving one unit back and forth, and a batch that lists an id twice
    ///  emits twice. Transfers of zero units are skipped.
    function _passUpdateOnTransfer() internal view virtual returns (bool) {
        return false;
    }

    /// @dev Hooks every mint, transfer and burn to emit `PassUpdate` per
    ///  moved id when `_passUpdateOnTransfer` is true.
    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        virtual
        override
    {
        super._update(from, to, ids, values);
        if (from != to && _passUpdateOnTransfer()) {
            for (uint256 i = 0; i < ids.length; ++i) {
                // A transfer of zero units changes nothing, and anyone can
                // send one for any id: it must not be a free way to make a
                // Pass Issuer push to every holder.
                if (values[i] != 0) _passUpdate(ids[i]);
            }
        }
    }
}
