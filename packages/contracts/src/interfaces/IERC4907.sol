// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title ERC-4907 Rental NFT, an extension of ERC-721
/// @dev The ERC-165 identifier for this interface is 0xad092b5c.
interface IERC4907 {
    /// @notice Emitted when the `user` of an NFT or the `expires` of the
    ///  `user` is changed. The zero address for `user` indicates that there
    ///  is no user address.
    event UpdateUser(uint256 indexed tokenId, address indexed user, uint64 expires);

    /// @notice Set the user and expires of an NFT.
    /// @dev The zero address indicates there is no user. Throws if `tokenId`
    ///  is not a valid NFT.
    /// @param user The new user of the NFT.
    /// @param expires UNIX timestamp until which the new user may use the NFT.
    function setUser(uint256 tokenId, address user, uint64 expires) external;

    /// @notice Get the user address of an NFT.
    /// @dev The zero address indicates that there is no user or the user has
    ///  expired.
    function userOf(uint256 tokenId) external view returns (address);

    /// @notice Get the user expires of an NFT.
    /// @dev The zero value indicates that there is no user.
    function userExpires(uint256 tokenId) external view returns (uint256);
}
