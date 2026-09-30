// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {RentalPass} from "../src/examples/RentalPass.sol";

contract RentalPassTest is Test {
    event PassUpdate(uint256 indexed tokenId);
    event UpdateUser(uint256 indexed tokenId, address indexed user, uint64 expires);

    RentalPass internal house;
    address internal host = makeAddr("host");
    address internal guest = makeAddr("guest");
    address internal buyer = makeAddr("buyer");
    address internal stranger = makeAddr("stranger");
    uint256 internal id;

    function setUp() public {
        vm.warp(1_700_000_000);
        house = new RentalPass("https://house.example/wallet-pass/", host);
        vm.prank(host);
        id = house.mint(host);
    }

    function test_Interfaces() public view {
        assertTrue(house.supportsInterface(0xef5f1e71));
        assertTrue(house.supportsInterface(0xad092b5c));
        assertEq(house.passURI(id), "https://house.example/wallet-pass/1");
    }

    function test_OnlyOwnerMintsAndSetsBase() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        house.mint(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        house.setPassBaseURI("x");
        vm.stopPrank();
    }

    function test_RentalLifecycle() public {
        uint64 checkout = uint64(block.timestamp + 3 days);
        vm.expectEmit(true, true, false, true, address(house));
        emit UpdateUser(id, guest, checkout);
        vm.expectEmit(true, false, false, true, address(house));
        emit PassUpdate(id);
        vm.prank(host);
        house.setUser(id, guest, checkout);
        assertEq(house.passHolderOf(id), guest);

        vm.warp(checkout + 1);
        assertEq(house.userOf(id), address(0));
        assertEq(house.passHolderOf(id), host);
    }

    function test_GuestCannotTransferOrExtend() public {
        vm.prank(host);
        house.setUser(id, guest, uint64(block.timestamp + 1 days));
        vm.startPrank(guest);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, guest, id));
        house.transferFrom(host, guest, id);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, guest, id));
        house.setUser(id, guest, type(uint64).max);
        vm.stopPrank();
    }

    function test_SaleClearsRental() public {
        vm.startPrank(host);
        house.setUser(id, guest, uint64(block.timestamp + 1 days));
        house.transferFrom(host, buyer, id);
        vm.stopPrank();
        assertEq(house.userOf(id), address(0));
        assertEq(house.passHolderOf(id), buyer);
    }
}
