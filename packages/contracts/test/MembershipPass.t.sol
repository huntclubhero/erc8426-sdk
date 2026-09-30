// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {MembershipPass} from "../src/examples/MembershipPass.sol";

contract MembershipPassTest is Test {
    event PassUpdate(uint256 indexed tokenId);
    event Renewed(uint256 indexed tokenId, address indexed payer, uint64 expiresAt);
    event TierChanged(uint256 indexed tokenId, uint8 tier);

    MembershipPass internal club;
    address internal issuer = makeAddr("issuer");
    address internal member = makeAddr("member");
    address internal friend = makeAddr("friend");
    address internal stranger = makeAddr("stranger");
    uint256 internal id;
    uint256 internal constant GOLD_PRICE = 0.01 ether;
    uint64 internal period;

    function setUp() public {
        vm.warp(1_700_000_000);
        club = new MembershipPass("https://club.example/", issuer);
        period = club.PERIOD();
        vm.startPrank(issuer);
        club.setTierPrice(1, GOLD_PRICE);
        id = club.grant(member, 1, period);
        vm.stopPrank();
        vm.deal(member, 1 ether);
        vm.deal(friend, 1 ether);
    }

    function test_GrantIsActive() public view {
        assertTrue(club.isActive(id));
        MembershipPass.Membership memory m = club.membership(id);
        assertEq(m.tier, 1);
        assertEq(m.expiresAt, block.timestamp + period);
        assertTrue(club.supportsInterface(0xef5f1e71));
    }

    function test_ExpiresPassively() public {
        vm.warp(block.timestamp + period);
        assertFalse(club.isActive(id));
    }

    function test_RenewExtendsFromExpiryAndEmits() public {
        uint64 expected = club.membership(id).expiresAt + 2 * period;
        vm.expectEmit(true, true, false, true, address(club));
        emit Renewed(id, member, expected);
        vm.expectEmit(true, false, false, true, address(club));
        emit PassUpdate(id);
        vm.prank(member);
        club.renew{value: 2 * GOLD_PRICE}(id, 2);
        assertEq(club.membership(id).expiresAt, expected);
    }

    function test_RenewAfterLapseExtendsFromNow() public {
        vm.warp(block.timestamp + 10 * uint256(period));
        vm.prank(member);
        club.renew{value: GOLD_PRICE}(id, 1);
        assertEq(club.membership(id).expiresAt, block.timestamp + period);
        assertTrue(club.isActive(id));
    }

    function test_AnyoneCanGiftRenewal() public {
        vm.prank(friend);
        club.renew{value: GOLD_PRICE}(id, 1);
        assertEq(address(club).balance, GOLD_PRICE);
    }

    function test_RenewPaymentChecks() public {
        vm.startPrank(member);
        vm.expectRevert(abi.encodeWithSelector(MembershipPass.MembershipWrongPayment.selector, GOLD_PRICE, 1));
        club.renew{value: 1}(id, 1);
        vm.expectRevert(MembershipPass.MembershipZeroPeriods.selector);
        club.renew{value: 0}(id, 0);
        vm.stopPrank();

        vm.prank(issuer);
        club.setTier(id, 7); // tier with no price
        vm.expectRevert(abi.encodeWithSelector(MembershipPass.MembershipTierNotForSale.selector, 7));
        vm.prank(member);
        club.renew{value: GOLD_PRICE}(id, 1);
    }

    function test_RenewNonexistent() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 99));
        club.renew{value: GOLD_PRICE}(99, 1);
    }

    function test_IssuerRenewAndSetTier() public {
        vm.startPrank(issuer);
        vm.expectEmit(true, false, false, true, address(club));
        emit PassUpdate(id);
        club.issuerRenew(id, 1 days);

        vm.expectEmit(true, false, false, true, address(club));
        emit TierChanged(id, 2);
        vm.expectEmit(true, false, false, true, address(club));
        emit PassUpdate(id);
        club.setTier(id, 2);
        vm.stopPrank();
        assertEq(club.membership(id).tier, 2);
    }

    function test_IssuerFunctionsAreOwnerOnly() public {
        vm.startPrank(member);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, member));
        club.issuerRenew(id, 365 days);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, member));
        club.setTier(id, 9);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, member));
        club.grant(member, 9, 365 days);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, member));
        club.withdrawProceeds(payable(member));
        vm.stopPrank();
    }

    function test_WithdrawProceeds() public {
        vm.prank(member);
        club.renew{value: 3 * GOLD_PRICE}(id, 3);
        vm.prank(issuer);
        club.withdrawProceeds(payable(stranger));
        assertEq(stranger.balance, 3 * GOLD_PRICE);
    }

    function testFuzz_RenewMath(uint8 periods) public {
        periods = uint8(bound(periods, 1, 50));
        uint64 before = club.membership(id).expiresAt;
        vm.deal(member, uint256(periods) * GOLD_PRICE);
        vm.prank(member);
        club.renew{value: uint256(periods) * GOLD_PRICE}(id, periods);
        assertEq(club.membership(id).expiresAt, before + uint64(periods) * period);
    }
}
