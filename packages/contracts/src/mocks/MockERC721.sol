// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title MockERC721
/// @notice Test and local-demo collection with open minting, used as the
///  collection staked into `StakingPass`.
/// @dev NEVER deploy to a public network: anyone can mint.
contract MockERC721 is ERC721 {
    uint256 private _nextId;

    constructor(string memory name_, string memory symbol_) ERC721(name_, symbol_) {}

    /// @notice Mint the next id to `to`. Open to anyone, for tests only.
    function mint(address to) external returns (uint256 tokenId) {
        tokenId = ++_nextId;
        _mint(to, tokenId);
    }
}
