// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ERC1155WalletPass} from "../ERC1155WalletPass.sol";

/// @title EditionPass (working draft example)
/// @notice An open edition: anyone claims a few units of an open id, free,
///  and units move freely. DRAFT, for the ERC-1155 binding demo on a
///  testnet; not audited, and the open claim makes it unfit for anything of
///  value.
/// @dev The case the binding is scoped to: a pass that shows a holding. An
///  account is entitled to the pass of an id while its balance is at least
///  the issuer's minimum, and nothing here can be used up. Claiming several
///  units lets one account try "send one of three and keep the pass".
contract EditionPass is ERC1155WalletPass, Ownable {
    /// @notice The most units of one id an account can claim in total.
    uint256 public immutable claimLimit;

    /// @notice Whether an id can be claimed.
    mapping(uint256 id => bool) public open;

    /// @notice Units of `id` that `account` has claimed so far. Units it
    ///  received by transfer do not count.
    mapping(uint256 id => mapping(address account => uint256)) public claimed;

    /// @notice Emitted when an id is opened or closed for claiming.
    event EditionOpen(uint256 indexed id, bool open);

    /// @notice Raised when a closed id is claimed.
    error EditionPassClosed(uint256 id);

    /// @notice Raised when a claim would pass the limit, or claims nothing.
    error EditionPassClaimLimit(uint256 id, address account, uint256 claimed, uint256 requested);

    constructor(string memory metadataURI, string memory passBaseURI_, address owner_, uint256 claimLimit_)
        ERC1155(metadataURI)
        ERC1155WalletPass(passBaseURI_)
        Ownable(owner_)
    {
        claimLimit = claimLimit_;
    }

    /// @notice Open or close `id` for claiming. Closing does not touch units
    ///  already held.
    function setOpen(uint256 id, bool open_) external onlyOwner {
        open[id] = open_;
        emit EditionOpen(id, open_);
    }

    /// @notice Claim `amount` units of `id` to the caller.
    function claim(uint256 id, uint256 amount) external {
        if (!open[id]) revert EditionPassClosed(id);
        uint256 already = claimed[id][msg.sender];
        if (amount == 0 || already + amount > claimLimit) {
            revert EditionPassClaimLimit(id, msg.sender, already, amount);
        }
        claimed[id][msg.sender] = already + amount;
        _mint(msg.sender, id, amount, "");
    }

    /// @notice Signal that the pass content of `id` changed for every holder.
    function announce(uint256 id) external onlyOwner {
        _passUpdate(id);
    }

    function setPassBaseURI(string calldata newPassBaseURI) external onlyOwner {
        _setPassBaseURI(newPassBaseURI);
    }
}
