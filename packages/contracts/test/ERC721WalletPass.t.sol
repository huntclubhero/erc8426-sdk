// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {ERC721WalletPass} from "../src/ERC721WalletPass.sol";
import {IERC721WalletPass} from "../src/IERC721WalletPass.sol";
import {WalletPassHarness, MirroringHarness, QuietTransferHarness} from "./harness/Harnesses.sol";

contract ERC721WalletPassTest is Test {
    event PassUpdate(uint256 indexed tokenId);
    event BatchPassUpdate(uint256 fromTokenId, uint256 toTokenId);
    event MetadataUpdate(uint256 _tokenId);
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);
    event PassBaseURIUpdated(string newPassBaseURI);

    bytes32 internal constant PASS_UPDATE_SIG = keccak256("PassUpdate(uint256)");
    bytes32 internal constant METADATA_UPDATE_SIG = keccak256("MetadataUpdate(uint256)");

    string internal constant BASE = "https://passes.example/wallet-pass/eip155/31337/0xColl/";

    WalletPassHarness internal pass;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        pass = new WalletPassHarness(BASE);
    }

    // Interface ids

    function test_InterfaceIdIsSpecValue() public pure {
        assertEq(type(IERC721WalletPass).interfaceId, bytes4(0xef5f1e71));
    }

    function test_SupportsInterfaces() public view {
        assertTrue(pass.supportsInterface(0xef5f1e71));
        assertTrue(pass.supportsInterface(0x01ffc9a7)); // ERC-165
        assertTrue(pass.supportsInterface(0x80ac58cd)); // ERC-721
        assertTrue(pass.supportsInterface(0x5b5e139f)); // ERC-721 metadata
        assertFalse(pass.supportsInterface(0x49064906)); // ERC-4906 off by default
        assertFalse(pass.supportsInterface(0xffffffff));
    }

    function test_MirroringReportsErc4906() public {
        MirroringHarness m = new MirroringHarness(BASE);
        assertTrue(m.supportsInterface(0x49064906));
        assertTrue(m.supportsInterface(0xef5f1e71));
    }

    // passURI

    function test_PassURIIsBasePlusDecimalId() public {
        pass.mint(alice, 42);
        assertEq(pass.passURI(42), string.concat(BASE, "42"));
    }

    function test_PassURIRevertsForNonexistent() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, uint256(7)));
        pass.passURI(7);
    }

    function test_PassURIRevertsAfterBurn() public {
        pass.mint(alice, 1);
        pass.burn(1);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, uint256(1)));
        pass.passURI(1);
    }

    function test_PassURIEmptyBaseReturnsEmpty() public {
        WalletPassHarness empty = new WalletPassHarness("");
        empty.mint(alice, 1);
        assertEq(empty.passURI(1), "");
    }

    function test_SetPassBaseURIEmitsAndApplies() public {
        pass.mint(alice, 3);
        vm.expectEmit(address(pass));
        emit PassBaseURIUpdated("https://new.example/");
        pass.setPassBaseURI("https://new.example/");
        assertEq(pass.passURI(3), "https://new.example/3");
        assertEq(pass.passBaseURI(), "https://new.example/");
    }

    function testFuzz_PassURI(uint256 id) public {
        pass.mint(alice, id);
        assertEq(pass.passURI(id), string.concat(BASE, vm.toString(id)));
    }

    // Events

    function test_PassUpdateHelper() public {
        vm.expectEmit(true, false, false, true, address(pass));
        emit PassUpdate(5);
        pass.passUpdate(5);
    }

    function test_BatchPassUpdateHelper() public {
        vm.expectEmit(false, false, false, true, address(pass));
        emit BatchPassUpdate(1, 100);
        pass.batchPassUpdate(1, 100);
    }

    function test_BatchSingleTokenRange() public {
        vm.expectEmit(false, false, false, true, address(pass));
        emit BatchPassUpdate(9, 9);
        pass.batchPassUpdate(9, 9);
    }

    function test_BatchRevertsOnInvertedRange() public {
        vm.expectRevert(abi.encodeWithSelector(ERC721WalletPass.ERC721WalletPassInvalidRange.selector, 5, 4));
        pass.batchPassUpdate(5, 4);
    }

    function testFuzz_BatchRangeValidation(uint256 from, uint256 to) public {
        if (from > to) {
            vm.expectRevert(abi.encodeWithSelector(ERC721WalletPass.ERC721WalletPassInvalidRange.selector, from, to));
        } else {
            vm.expectEmit(false, false, false, true, address(pass));
            emit BatchPassUpdate(from, to);
        }
        pass.batchPassUpdate(from, to);
    }

    function test_MintTransferBurnEmitPassUpdate() public {
        vm.expectEmit(true, false, false, true, address(pass));
        emit PassUpdate(1);
        pass.mint(alice, 1);

        vm.expectEmit(true, false, false, true, address(pass));
        emit PassUpdate(1);
        vm.prank(alice);
        pass.transferFrom(alice, bob, 1);

        vm.expectEmit(true, false, false, true, address(pass));
        emit PassUpdate(1);
        pass.burn(1);
    }

    function test_DefaultDoesNotEmitMetadataUpdate() public {
        vm.recordLogs();
        pass.mint(alice, 1);
        pass.passUpdate(1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != METADATA_UPDATE_SIG);
        }
    }

    function test_MirroringEmitsBothEvents() public {
        MirroringHarness m = new MirroringHarness(BASE);
        vm.expectEmit(true, false, false, true, address(m));
        emit PassUpdate(1);
        vm.expectEmit(false, false, false, true, address(m));
        emit MetadataUpdate(1);
        m.passUpdate(1);

        vm.expectEmit(false, false, false, true, address(m));
        emit BatchPassUpdate(1, 10);
        vm.expectEmit(false, false, false, true, address(m));
        emit BatchMetadataUpdate(1, 10);
        m.batchPassUpdate(1, 10);
    }

    function test_QuietTransferOverride() public {
        QuietTransferHarness q = new QuietTransferHarness(BASE);
        vm.recordLogs();
        q.mint(alice, 1);
        vm.prank(alice);
        q.transferFrom(alice, bob, 1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != PASS_UPDATE_SIG);
        }
        // Explicit updates still work.
        vm.expectEmit(true, false, false, true, address(q));
        emit PassUpdate(1);
        q.passUpdate(1);
    }
}
