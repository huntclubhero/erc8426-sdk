// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {StoredValueCard} from "../src/examples/StoredValueCard.sol";
import {BoundedAction} from "../src/utils/BoundedAction.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

contract StoredValueCardTest is Test {
    event PassUpdate(uint256 indexed tokenId);
    event Charged(uint256 indexed tokenId, address indexed merchant, uint256 amount, uint32 punches);
    event RewardEarned(uint256 indexed tokenId, uint32 rewards);

    uint128 internal constant PER_TX = 25e6; // $25
    uint128 internal constant DAILY = 100e6; // $100
    uint32 internal constant CHARGES_PER_DAY = 20;
    uint32 internal constant PUNCHES = 10;

    MockERC20 internal usd;
    StoredValueCard internal cards;
    address internal issuer = makeAddr("issuer");
    address internal relayer = makeAddr("relayer");
    address internal holder = makeAddr("holder");
    address internal buyer = makeAddr("buyer");
    address internal cafe = makeAddr("cafe");
    address internal stranger = makeAddr("stranger");
    uint256 internal id;

    function setUp() public {
        vm.warp(1_700_000_000);
        usd = new MockERC20("Stable", "USDG", 6);
        cards = new StoredValueCard(
            "https://cards.example/", issuer, IERC20(address(usd)), PUNCHES, PER_TX, DAILY, CHARGES_PER_DAY
        );
        vm.startPrank(issuer);
        cards.setActionOperator(relayer, true);
        cards.setMerchant(cafe, true);
        id = cards.mint(holder);
        vm.stopPrank();
        _topUp(holder, 500e6);
    }

    function _topUp(address from, uint256 amount) internal {
        usd.mint(from, amount);
        vm.startPrank(from);
        usd.approve(address(cards), amount);
        cards.topUp(id, amount);
        vm.stopPrank();
    }

    function test_Setup() public view {
        assertEq(cards.balanceOfCard(id), 500e6);
        assertEq(usd.balanceOf(address(cards)), 500e6);
        assertTrue(cards.supportsInterface(0xef5f1e71));
        BoundedAction.ActionBound memory b = cards.actionBound(cards.CHARGE());
        assertEq(b.maxValuePerCall, PER_TX);
        assertEq(b.maxValuePerWindow, DAILY);
        assertEq(b.maxPerWindow, CHARGES_PER_DAY);
        assertEq(b.windowSeconds, 1 days);
    }

    function test_AnyoneCanTopUpAndItEmitsPassUpdate() public {
        usd.mint(stranger, 10e6);
        vm.startPrank(stranger);
        usd.approve(address(cards), 10e6);
        vm.expectEmit(true, false, false, true, address(cards));
        emit PassUpdate(id);
        cards.topUp(id, 10e6);
        vm.stopPrank();
        assertEq(cards.balanceOfCard(id), 510e6);
    }

    function test_TopUpRejectsZeroAndNonexistent() public {
        vm.expectRevert(StoredValueCard.CardZeroAmount.selector);
        cards.topUp(id, 0);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 99));
        cards.topUp(99, 1);
    }

    function test_ChargePaysMerchantAndPunches() public {
        vm.expectEmit(true, true, false, true, address(cards));
        emit Charged(id, cafe, 4.5e6, 1);
        vm.expectEmit(true, false, false, true, address(cards));
        emit PassUpdate(id);
        vm.prank(relayer);
        cards.charge(id, 4.5e6, cafe);

        assertEq(usd.balanceOf(cafe), 4.5e6);
        StoredValueCard.Card memory c = cards.card(id);
        assertEq(c.balance, 500e6 - 4.5e6);
        assertEq(c.punches, 1);
    }

    function test_TenthPunchEarnsRewardAndRedeem() public {
        vm.startPrank(relayer);
        for (uint256 i; i < PUNCHES - 1; ++i) cards.charge(id, 1e6, cafe);
        vm.expectEmit(true, false, false, true, address(cards));
        emit RewardEarned(id, 1);
        cards.charge(id, 1e6, cafe);
        StoredValueCard.Card memory c = cards.card(id);
        assertEq(c.punches, 0);
        assertEq(c.rewards, 1);

        uint256 before = cards.balanceOfCard(id);
        cards.redeemReward(id, cafe);
        assertEq(cards.card(id).rewards, 0);
        assertEq(cards.balanceOfCard(id), before); // a reward costs nothing
        vm.expectRevert(abi.encodeWithSelector(StoredValueCard.CardNoReward.selector, id));
        cards.redeemReward(id, cafe);
        vm.stopPrank();
    }

    function test_PerTxCapEnforced() public {
        vm.expectRevert(
            abi.encodeWithSelector(BoundedAction.BoundedActionValueTooHigh.selector, cards.CHARGE(), PER_TX + 1, PER_TX)
        );
        vm.prank(relayer);
        cards.charge(id, PER_TX + 1, cafe);
    }

    function test_DailyCapEnforcedAndRollsOver() public {
        vm.startPrank(relayer);
        for (uint256 i; i < 4; ++i) cards.charge(id, PER_TX, cafe);
        vm.expectRevert(
            abi.encodeWithSelector(BoundedAction.BoundedActionWindowCapExceeded.selector, id, cards.CHARGE(), 1, 0)
        );
        cards.charge(id, 1, cafe);
        vm.warp(block.timestamp + 1 days);
        cards.charge(id, PER_TX, cafe);
        vm.stopPrank();
        assertEq(usd.balanceOf(cafe), 5 * uint256(PER_TX));
    }

    function test_ChargeCountCap() public {
        vm.startPrank(relayer);
        for (uint256 i; i < CHARGES_PER_DAY; ++i) cards.charge(id, 1, cafe);
        vm.expectRevert(
            abi.encodeWithSelector(
                BoundedAction.BoundedActionRateLimited.selector, id, cards.CHARGE(), block.timestamp + 1 days
            )
        );
        cards.charge(id, 1, cafe);
        vm.stopPrank();
    }

    function test_ChargeOnlyToRegisteredMerchant() public {
        vm.expectRevert(abi.encodeWithSelector(StoredValueCard.CardUnknownMerchant.selector, relayer));
        vm.prank(relayer);
        cards.charge(id, 1e6, relayer);
    }

    function test_ChargeInsufficientBalance() public {
        vm.prank(issuer);
        uint256 empty = cards.mint(holder);
        vm.expectRevert(abi.encodeWithSelector(StoredValueCard.CardInsufficientBalance.selector, empty, 0, 1e6));
        vm.prank(relayer);
        cards.charge(empty, 1e6, cafe);
    }

    function test_NonOperatorsCannotCharge() public {
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionUnauthorizedOperator.selector, stranger));
        vm.prank(stranger);
        cards.charge(id, 1e6, cafe);
        // Not even the card's owner or the merchant.
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionUnauthorizedOperator.selector, holder));
        vm.prank(holder);
        cards.charge(id, 1e6, cafe);
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionUnauthorizedOperator.selector, cafe));
        vm.prank(cafe);
        cards.charge(id, 1e6, cafe);
    }

    function test_OwnerWithdraws() public {
        vm.expectEmit(true, false, false, true, address(cards));
        emit PassUpdate(id);
        vm.prank(holder);
        cards.withdraw(id, 100e6, holder);
        assertEq(usd.balanceOf(holder), 100e6);
        assertEq(cards.balanceOfCard(id), 400e6);
    }

    function test_OperatorCannotWithdrawOrMoveCard() public {
        vm.startPrank(relayer);
        vm.expectRevert(abi.encodeWithSelector(StoredValueCard.CardNotOwner.selector, id, relayer));
        cards.withdraw(id, 1, relayer);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, relayer, id));
        cards.transferFrom(holder, relayer, id);
        vm.stopPrank();
    }

    function test_ApprovedAccountCannotWithdraw() public {
        vm.prank(holder);
        cards.approve(stranger, id);
        vm.expectRevert(abi.encodeWithSelector(StoredValueCard.CardNotOwner.selector, id, stranger));
        vm.prank(stranger);
        cards.withdraw(id, 1, stranger);
    }

    function test_WithdrawChecks() public {
        vm.startPrank(holder);
        vm.expectRevert(StoredValueCard.CardZeroAmount.selector);
        cards.withdraw(id, 0, holder);
        vm.expectRevert(abi.encodeWithSelector(StoredValueCard.CardInsufficientBalance.selector, id, 500e6, 500e6 + 1));
        cards.withdraw(id, 500e6 + 1, holder);
        vm.stopPrank();
    }

    function test_OwnerRevokesCharging() public {
        vm.prank(holder);
        cards.setOperatorRevoked(id, relayer, true);
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionOperatorRevoked.selector, id, relayer));
        vm.prank(relayer);
        cards.charge(id, 1e6, cafe);
    }

    function test_BalanceTravelsWithCard() public {
        vm.prank(holder);
        cards.transferFrom(holder, buyer, id);
        vm.expectRevert(abi.encodeWithSelector(StoredValueCard.CardNotOwner.selector, id, holder));
        vm.prank(holder);
        cards.withdraw(id, 1, holder);
        vm.prank(buyer);
        cards.withdraw(id, 500e6, buyer);
        assertEq(usd.balanceOf(buyer), 500e6);
    }

    function test_IssuerAdminIsOwnerOnly() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        cards.setMerchant(stranger, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        cards.setActionOperator(stranger, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        cards.setChargeCaps(100, 1e18, 1e18);
        vm.stopPrank();
    }

    function test_FrozenCapsCanOnlyBeLowered() public {
        vm.startPrank(issuer);
        cards.freezeActionBound(cards.CHARGE());
        cards.setChargeCaps(CHARGES_PER_DAY, 10e6, 50e6);
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionBoundFrozen.selector, cards.CHARGE()));
        cards.setChargeCaps(CHARGES_PER_DAY, PER_TX, DAILY);
        vm.stopPrank();
    }

    function test_RejectsBadConfig() public {
        vm.expectRevert(StoredValueCard.CardInvalidConfig.selector);
        new StoredValueCard("", issuer, IERC20(address(0)), PUNCHES, PER_TX, DAILY, 1);
        vm.expectRevert(StoredValueCard.CardInvalidConfig.selector);
        new StoredValueCard("", issuer, IERC20(address(usd)), 0, PER_TX, DAILY, 1);
    }

    /// A leaked QR code (the operator path) can never move more than the
    /// daily cap per window, whatever amounts are attempted.
    function testFuzz_OperatorSpendBounded(uint256[12] memory amounts) public {
        _topUp(stranger, 10_000e6);
        uint256 before = cards.balanceOfCard(id);
        vm.startPrank(relayer);
        for (uint256 i; i < amounts.length; ++i) {
            uint256 amount = bound(amounts[i], 1, 2 * uint256(PER_TX));
            (bool ok,) = address(cards).call(abi.encodeCall(StoredValueCard.charge, (id, amount, cafe)));
            ok;
        }
        vm.stopPrank();
        uint256 spent = before - cards.balanceOfCard(id);
        assertLe(spent, DAILY);
        assertEq(usd.balanceOf(cafe), spent);
        // Accounting stays exact.
        assertEq(usd.balanceOf(address(cards)), cards.balanceOfCard(id));
    }
}
