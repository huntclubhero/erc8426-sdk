// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {IERC4907} from "../src/interfaces/IERC4907.sol";
import {RentableHarness} from "./harness/Harnesses.sol";

contract ERC721WalletPassRentableTest is Test {
    event PassUpdate(uint256 indexed tokenId);
    event UpdateUser(uint256 indexed tokenId, address indexed user, uint64 expires);

    RentableHarness internal pass;
    address internal owner = makeAddr("owner");
    address internal renter = makeAddr("renter");
    address internal operator = makeAddr("operator");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        pass = new RentableHarness("https://p.example/");
        pass.mint(owner, 1);
    }

    function test_InterfaceIds() public view {
        assertEq(type(IERC4907).interfaceId, bytes4(0xad092b5c));
        assertTrue(pass.supportsInterface(0xad092b5c));
        assertTrue(pass.supportsInterface(0xef5f1e71));
    }

    function test_SetUserEmitsUpdateUserAndPassUpdate() public {
        uint64 expires = uint64(block.timestamp + 1 days);
        vm.expectEmit(true, true, false, true, address(pass));
        emit UpdateUser(1, renter, expires);
        vm.expectEmit(true, false, false, true, address(pass));
        emit PassUpdate(1);
        vm.prank(owner);
        pass.setUser(1, renter, expires);

        assertEq(pass.userOf(1), renter);
        assertEq(pass.userExpires(1), expires);
    }

    function test_ApprovedOperatorCanSetUser() public {
        vm.prank(owner);
        pass.setApprovalForAll(operator, true);
        vm.prank(operator);
        pass.setUser(1, renter, uint64(block.timestamp + 1));
        assertEq(pass.userOf(1), renter);
    }

    function test_StrangerCannotSetUser() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, stranger, 1));
        vm.prank(stranger);
        pass.setUser(1, stranger, uint64(block.timestamp + 1));
    }

    function test_SetUserRevertsForNonexistent() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 99));
        pass.setUser(99, renter, 1);
    }

    function test_RentalIsExclusiveOfOwnerWhileActive() public {
        assertEq(pass.passHolderOf(1), owner);
        vm.prank(owner);
        pass.setUser(1, renter, uint64(block.timestamp + 1 hours));
        assertEq(pass.passHolderOf(1), renter);

        // Expiry is passive: no transaction, entitlement returns to owner.
        vm.warp(block.timestamp + 1 hours + 1);
        assertEq(pass.userOf(1), address(0));
        assertEq(pass.passHolderOf(1), owner);
    }

    function test_UserValidThroughExpirySecond() public {
        uint64 expires = uint64(block.timestamp + 100);
        vm.prank(owner);
        pass.setUser(1, renter, expires);
        vm.warp(expires);
        assertEq(pass.userOf(1), renter);
    }

    function test_ClearingUserEmitsPassUpdate() public {
        vm.prank(owner);
        pass.setUser(1, renter, uint64(block.timestamp + 1 days));
        vm.expectEmit(true, false, false, true, address(pass));
        emit PassUpdate(1);
        vm.prank(owner);
        pass.setUser(1, address(0), 0);
        assertEq(pass.passHolderOf(1), owner);
    }

    function test_TransferClearsRental() public {
        vm.prank(owner);
        pass.setUser(1, renter, uint64(block.timestamp + 1 days));

        vm.expectEmit(true, true, false, true, address(pass));
        emit UpdateUser(1, address(0), 0);
        vm.prank(owner);
        pass.transferFrom(owner, stranger, 1);

        assertEq(pass.userOf(1), address(0));
        assertEq(pass.userExpires(1), 0);
        assertEq(pass.passHolderOf(1), stranger);
    }

    function test_BurnClearsRental() public {
        vm.prank(owner);
        pass.setUser(1, renter, uint64(block.timestamp + 1 days));
        pass.burn(1);
        assertEq(pass.userOf(1), address(0));
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 1));
        pass.passHolderOf(1);
    }

    function test_RenterCannotTransfer() public {
        vm.prank(owner);
        pass.setUser(1, renter, uint64(block.timestamp + 1 days));
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, renter, 1));
        vm.prank(renter);
        pass.transferFrom(owner, renter, 1);
    }

    function test_RenterCannotChangeUser() public {
        vm.prank(owner);
        pass.setUser(1, renter, uint64(block.timestamp + 1 days));
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, renter, 1));
        vm.prank(renter);
        pass.setUser(1, renter, type(uint64).max);
    }
}
