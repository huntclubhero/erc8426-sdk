// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import {ERC721WalletPass} from "../ERC721WalletPass.sol";
import {ERC721WalletPassRentable} from "../extensions/ERC721WalletPassRentable.sol";

/// @title RentalPass (example)
/// @notice Use case: a rentable access pass (a beach house, a parking bay, a
///  studio). The owner rents it out with ERC-4907 `setUser`; during the
///  rental the renter, and only the renter, holds the wallet pass.
/// @dev Capability analysis (ERC-8426, "Extended entitlement"):
///
///  - The entitlement policy is the one `ERC721WalletPassRentable` documents
///    and exposes as `passHolderOf`: an active rental user is exclusive of
///    the owner; otherwise the owner. An issuer reads it fresh on every
///    request (the SDK issuer's `rental4907()` policy implements the same rule).
///  - `setUser` changes who is entitled, so it is owner (or approved) only
///    and never pass-reachable. The renter cannot extend their own rental.
///  - Transfer, approve and burn stay with the owner; a transfer clears the
///    rental, as in the ERC-4907 reference implementation.
///  - Rental expiry is passive: `userOf` returns zero once `userExpires`
///    passes, with no transaction and no event.
contract RentalPass is ERC721WalletPassRentable, Ownable {
    uint256 private _nextTokenId;

    constructor(string memory passBaseURI_, address initialOwner)
        ERC721("Rental Pass", "RENT")
        ERC721WalletPass(passBaseURI_)
        Ownable(initialOwner)
    {}

    /// @notice Mint the next pass to `to`.
    function mint(address to) external onlyOwner returns (uint256 tokenId) {
        tokenId = ++_nextTokenId;
        _mint(to, tokenId);
    }

    function setPassBaseURI(string calldata newBase) external onlyOwner {
        _setPassBaseURI(newBase);
    }
}
