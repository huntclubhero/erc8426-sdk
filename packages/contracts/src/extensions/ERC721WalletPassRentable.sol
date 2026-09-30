// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import {ERC721WalletPass} from "../ERC721WalletPass.sol";
import {IERC4907} from "../interfaces/IERC4907.sol";

/// @title ERC721WalletPassRentable
/// @notice ERC-8426 wallet pass token with ERC-4907 rentals. Setting,
///  changing or clearing the rental user emits `PassUpdate`, because the pass
///  should re-render for (and be re-issued to) the account now entitled to it.
/// @dev Entitlement policy (ERC-8426, "Extended entitlement"). A documented
///  extended entitlement MUST define precedence between owner and rental
///  user, and a rental entitlement SHOULD be exclusive of the owner for the
///  actions it covers. This extension documents the following policy and
///  exposes it on chain as `passHolderOf`:
///
///  - While a rental is active (`userOf(tokenId)` is non-zero), the rental
///    user is the ONLY account entitled to pass-reachable actions. The owner
///    is not entitled to them for the rental's duration.
///  - When no rental is active, the owner is entitled, as in plain ERC-8426.
///  - Actions that change ownership, entitlement or approvals (transfer,
///    burn, approve, `setUser`) are never pass-reachable and stay with the
///    owner under ERC-721 and ERC-4907 rules.
///
///  An off-chain verifier MUST read `passHolderOf` (or `userOf` then
///  `ownerOf`) at request time, never from a value cached at pass issuance.
///
///  Rental expiry is passive: when `userExpires` passes, `userOf` returns
///  the zero address without a transaction, so no event fires. Issuers
///  should render the expiry as a relative date on the pass, and verifiers
///  get the correct answer from the fresh read regardless.
///
///  As in the ERC-4907 reference implementation, a transfer clears the
///  rental (emitting `UpdateUser` with the zero address).
abstract contract ERC721WalletPassRentable is ERC721WalletPass, IERC4907 {
    struct UserInfo {
        address user;
        uint64 expires;
    }

    mapping(uint256 tokenId => UserInfo) private _users;

    /// @inheritdoc IERC4907
    /// @dev Callable by the owner or an approved operator of the token.
    ///  Emits `UpdateUser` and `PassUpdate`.
    function setUser(uint256 tokenId, address user, uint64 expires) public virtual {
        address owner = _requireOwned(tokenId);
        _checkAuthorized(owner, _msgSender(), tokenId);
        _users[tokenId] = UserInfo(user, expires);
        emit UpdateUser(tokenId, user, expires);
        _passUpdate(tokenId);
    }

    /// @inheritdoc IERC4907
    function userOf(uint256 tokenId) public view virtual returns (address) {
        UserInfo memory info = _users[tokenId];
        return uint256(info.expires) >= block.timestamp ? info.user : address(0);
    }

    /// @inheritdoc IERC4907
    function userExpires(uint256 tokenId) public view virtual returns (uint256) {
        return _users[tokenId].expires;
    }

    /// @notice The single account entitled to this token's pass-reachable
    ///  actions right now: the active rental user if there is one, else the
    ///  owner. Reverts for a nonexistent token.
    /// @dev This is the documented precedence rule of this extension (rental
    ///  exclusive of owner). Verifiers compare the claimed account against it
    ///  with a fresh read on every state-changing request.
    function passHolderOf(uint256 tokenId) public view virtual returns (address) {
        address owner = _requireOwned(tokenId);
        address user = userOf(tokenId);
        return user != address(0) ? user : owner;
    }

    /// @inheritdoc ERC721WalletPass
    /// @dev Also reports ERC-4907 (`0xad092b5c`).
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return interfaceId == type(IERC4907).interfaceId || super.supportsInterface(interfaceId);
    }

    /// @dev Clears the rental on transfer and burn, per the ERC-4907
    ///  reference implementation. The pass update for the owner change is
    ///  emitted by the base hook.
    function _update(address to, uint256 tokenId, address auth) internal virtual override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (from != to && _users[tokenId].user != address(0)) {
            delete _users[tokenId];
            emit UpdateUser(tokenId, address(0), 0);
        }
    }
}
