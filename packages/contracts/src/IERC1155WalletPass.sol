// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title ERC-1155 Wallet Pass binding (working draft)
/// @dev DRAFT. This interface belongs to a working draft of an ERC-1155
///  binding for ERC-8426 and can change before that draft is proposed.
///
///  It has the same members as `IERC721WalletPass`, so its ERC-165
///  identifier is the same value, 0xef5f1e71 (the selector of
///  `passURI(uint256)`). Whether the binding keeps that identifier, and lets
///  a Client tell the two bindings apart by `supportsInterface` for ERC-721
///  (0x80ac58cd) against ERC-1155 (0xd9b67a26), or defines an identifier of
///  its own, is an open question of the draft.
interface IERC1155WalletPass {
    /// @notice Emitted when the wallet pass content bound to an id has
    ///  changed. It concerns every pass issued for the id, one per holding
    ///  account.
    event PassUpdate(uint256 indexed id);

    /// @notice Emitted when the wallet pass content for a consecutive range
    ///  of ids has changed. The range is inclusive of both ends.
    event BatchPassUpdate(uint256 fromId, uint256 toId);

    /// @notice Get the pass endpoint URI for an id.
    /// @dev One URI per id, never per holder: which account receives which
    ///  pass is decided at the endpoint. Throws if `id` is not a valid id.
    /// @param id The id whose pass endpoint is requested.
    /// @return The pass endpoint URI.
    function passURI(uint256 id) external view returns (string memory);
}
