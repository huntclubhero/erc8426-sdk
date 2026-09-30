// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import {ERC721WalletPass} from "../../src/ERC721WalletPass.sol";
import {ERC721WalletPassRentable} from "../../src/extensions/ERC721WalletPassRentable.sol";
import {BoundedAction} from "../../src/utils/BoundedAction.sol";

/// @dev Exposes the base's internals with no access control, for tests.
contract WalletPassHarness is ERC721WalletPass {
    constructor(string memory base) ERC721("Harness", "H") ERC721WalletPass(base) {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }

    function burn(uint256 id) external {
        _burn(id);
    }

    function passUpdate(uint256 id) external {
        _passUpdate(id);
    }

    function batchPassUpdate(uint256 from, uint256 to) external {
        _batchPassUpdate(from, to);
    }

    function setPassBaseURI(string calldata base) external {
        _setPassBaseURI(base);
    }
}

/// @dev Opts into ERC-4906 mirroring.
contract MirroringHarness is WalletPassHarness {
    constructor(string memory base) WalletPassHarness(base) {}

    function _mirrorsMetadataUpdates() internal pure override returns (bool) {
        return true;
    }
}

/// @dev Opts out of the transfer-time pass update.
contract QuietTransferHarness is WalletPassHarness {
    constructor(string memory base) WalletPassHarness(base) {}

    function _passUpdateOnTransfer() internal pure override returns (bool) {
        return false;
    }
}

contract RentableHarness is ERC721WalletPassRentable {
    constructor(string memory base) ERC721("Rentable", "R") ERC721WalletPass(base) {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }

    function burn(uint256 id) external {
        _burn(id);
    }
}

/// @dev BoundedAction on a wallet pass token, with open configuration.
contract BoundedHarness is ERC721WalletPass, BoundedAction {
    bytes32 public constant PING = keccak256("PING");
    bytes32 public constant SPEND = keccak256("SPEND");

    uint256 public pings;
    uint256 public spent;

    constructor() ERC721("Bounded", "B") ERC721WalletPass("https://p.example/") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }

    function setActionOperator(address operator, bool allowed) external {
        _setActionOperator(operator, allowed);
    }

    function setActionOperatorFor(address operator, bytes32 id, bool allowed) external {
        _setActionOperatorFor(operator, id, allowed);
    }

    function configureAction(bytes32 id, uint32 maxPerWindow, uint32 windowSeconds, uint128 perCall, uint128 perWindow)
        external
    {
        _configureAction(id, maxPerWindow, windowSeconds, perCall, perWindow);
    }

    function freeze(bytes32 id) external {
        _freezeActionBound(id);
    }

    function ping(uint256 tokenId) external onlyBoundedAction(PING, tokenId, 0) {
        pings += 1;
        _passUpdate(tokenId);
    }

    function spend(uint256 tokenId, uint256 amount) external onlyBoundedAction(SPEND, tokenId, amount) {
        spent += amount;
        _passUpdate(tokenId);
    }

    function _boundedActionOwner(uint256 tokenId) internal view override returns (address) {
        return _requireOwned(tokenId);
    }
}
