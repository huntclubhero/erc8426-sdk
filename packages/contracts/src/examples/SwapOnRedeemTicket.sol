// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ERC1155WalletPass} from "../ERC1155WalletPass.sol";

/// @title SwapOnRedeemTicket (working draft example)
/// @notice A ticket with many units per id, where using a unit exchanges it
///  for a "used" id in the same transaction. DRAFT, for the ERC-1155 binding
///  demo; not audited.
/// @dev Why it exists: where an id has a supply above one, its units have no
///  identity. A fresh `balanceOf` read proves an account holds a unit now and
///  cannot prove the unit is unused: an account can be admitted, send the
///  unit on, and the read passes for the receiver. A record of use kept
///  against the account does not follow the unit. Here the use changes the
///  balance itself, so the unit that moves on afterwards is the used id and
///  the live id's balance read refuses it.
///
///  `redeem` burns and so changes entitlement. Under ERC-8426 a capability
///  link cannot reach such an action: the holder calls it, on the signed
///  path.
contract SwapOnRedeemTicket is ERC1155WalletPass, Ownable {
    /// @dev The used id of a live id sets the top bit. Live ids must leave
    ///  it clear.
    uint256 internal constant USED_FLAG = 1 << 255;

    /// @notice Emitted when `account` uses one unit of `id`.
    event Redeemed(address indexed account, uint256 indexed id);

    /// @notice Raised when a live id is expected and a used id is given.
    error SwapOnRedeemTicketNotLiveId(uint256 id);

    constructor(string memory metadataURI, string memory passBaseURI_, address owner_)
        ERC1155(metadataURI)
        ERC1155WalletPass(passBaseURI_)
        Ownable(owner_)
    {}

    /// @notice The id a unit of `id` becomes once used.
    function usedId(uint256 id) public pure returns (uint256) {
        if (id & USED_FLAG != 0) revert SwapOnRedeemTicketNotLiveId(id);
        return id | USED_FLAG;
    }

    /// @notice Mint `amount` live units of `id` to `to`.
    function mint(address to, uint256 id, uint256 amount) external onlyOwner {
        if (id & USED_FLAG != 0) revert SwapOnRedeemTicketNotLiveId(id);
        _mint(to, id, amount, "");
    }

    /// @notice Use one of the caller's units of `id`: the live unit is burned
    ///  and one unit of the used id is minted to the caller, atomically.
    function redeem(uint256 id) external {
        uint256 used = usedId(id);
        _burn(msg.sender, id, 1);
        _mint(msg.sender, used, 1, "");
        emit Redeemed(msg.sender, id);
    }

    function setPassBaseURI(string calldata newPassBaseURI) external onlyOwner {
        _setPassBaseURI(newPassBaseURI);
    }
}
