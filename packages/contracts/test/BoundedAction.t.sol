// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {BoundedAction} from "../src/utils/BoundedAction.sol";
import {BoundedHarness} from "./harness/Harnesses.sol";

contract BoundedActionTest is Test {
    event ActionBoundConfigured(
        bytes32 indexed actionId, uint32 maxPerWindow, uint32 windowSeconds, uint128 maxValuePerCall, uint128 maxValuePerWindow
    );
    event ActionBoundFrozen(bytes32 indexed actionId);
    event ActionOperatorSet(address indexed operator, bool allowed);
    event ActionOperatorRevoked(uint256 indexed tokenId, address indexed owner, address indexed operator, bool revoked);
    event BoundedActionUsed(
        uint256 indexed tokenId, bytes32 indexed actionId, address indexed operator, uint256 value, uint32 countInWindow
    );
    event PassUpdate(uint256 indexed tokenId);

    BoundedHarness internal h;
    bytes32 internal PING;
    bytes32 internal SPEND;

    address internal holder = makeAddr("holder");
    address internal buyer = makeAddr("buyer");
    address internal relayer = makeAddr("relayer");
    address internal stranger = makeAddr("stranger");

    uint32 internal constant MAX = 3;
    uint32 internal constant WINDOW = 1 hours;

    function setUp() public {
        vm.warp(1_000_000);
        h = new BoundedHarness();
        PING = h.PING();
        SPEND = h.SPEND();
        h.mint(holder, 1);
        h.mint(holder, 2);
        h.setActionOperator(relayer, true);
        h.configureAction(PING, MAX, WINDOW, 0, 0);
        h.configureAction(SPEND, 10, 1 days, 25e6, 100e6);
    }

    // Configuration

    function test_ConfigureEmitsAndIsReadable() public {
        vm.expectEmit(true, false, false, true, address(h));
        emit ActionBoundConfigured(PING, 5, 60, 0, 0);
        h.configureAction(PING, 5, 60, 0, 0);
        BoundedAction.ActionBound memory b = h.actionBound(PING);
        assertEq(b.maxPerWindow, 5);
        assertEq(b.windowSeconds, 60);
        assertEq(b.maxValuePerCall, 0);
        assertEq(b.maxValuePerWindow, 0);
        assertFalse(b.frozen);
    }

    function test_ConfigureRejectsZeroWindow() public {
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionInvalidBound.selector, PING));
        h.configureAction(PING, 1, 0, 0, 0);
    }

    function test_ConfigureRejectsPerCallAbovePerWindow() public {
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionInvalidBound.selector, SPEND));
        h.configureAction(SPEND, 1, 60, 10, 9);
    }

    function test_OperatorSetEmits() public {
        vm.expectEmit(true, false, false, true, address(h));
        emit ActionOperatorSet(stranger, true);
        h.setActionOperator(stranger, true);
        assertTrue(h.isActionOperator(stranger));
        h.setActionOperator(stranger, false);
        assertFalse(h.isActionOperator(stranger));
    }

    // Happy path and events

    function test_OperatorCanAct() public {
        vm.expectEmit(true, true, true, true, address(h));
        emit BoundedActionUsed(1, PING, relayer, 0, 1);
        vm.expectEmit(true, false, false, true, address(h));
        emit PassUpdate(1);
        vm.prank(relayer);
        h.ping(1);
        assertEq(h.pings(), 1);
        (uint32 count, uint128 value, uint256 resetsAt) = h.actionUsage(1, PING);
        assertEq(count, 1);
        assertEq(value, 0);
        assertEq(resetsAt, block.timestamp + WINDOW);
    }

    // Unauthorized

    function test_NonOperatorRejected() public {
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionUnauthorizedOperator.selector, stranger));
        vm.prank(stranger);
        h.ping(1);
    }

    function test_TokenOwnerIsNotAnOperator() public {
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionUnauthorizedOperator.selector, holder));
        vm.prank(holder);
        h.ping(1);
    }

    function test_RemovedOperatorRejected() public {
        h.setActionOperator(relayer, false);
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionUnauthorizedOperator.selector, relayer));
        vm.prank(relayer);
        h.ping(1);
    }

    function test_NonexistentTokenRejected() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 99));
        vm.prank(relayer);
        h.ping(99);
    }

    function test_DisabledActionRejected() public {
        h.configureAction(PING, 0, 0, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionDisabled.selector, PING));
        vm.prank(relayer);
        h.ping(1);
    }

    function test_UnconfiguredActionRejected() public {
        BoundedHarness fresh = new BoundedHarness();
        fresh.mint(holder, 1);
        fresh.setActionOperator(relayer, true);
        bytes32 ping = fresh.PING();
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionDisabled.selector, ping));
        vm.prank(relayer);
        fresh.ping(1);
    }

    // Rate limit and window rollover

    function test_RateLimitHitsAtMax() public {
        vm.startPrank(relayer);
        for (uint256 i; i < MAX; ++i) h.ping(1);
        vm.expectRevert(
            abi.encodeWithSelector(BoundedAction.BoundedActionRateLimited.selector, 1, PING, block.timestamp + WINDOW)
        );
        h.ping(1);
        vm.stopPrank();
        (uint32 calls,) = h.remainingInWindow(1, PING);
        assertEq(calls, 0);
    }

    function test_LimitIsPerToken() public {
        vm.startPrank(relayer);
        for (uint256 i; i < MAX; ++i) h.ping(1);
        h.ping(2); // token 2 has its own budget
        vm.stopPrank();
        assertEq(h.pings(), MAX + 1);
    }

    function test_WindowRollover() public {
        vm.startPrank(relayer);
        for (uint256 i; i < MAX; ++i) h.ping(1);
        vm.warp(block.timestamp + WINDOW - 1);
        vm.expectRevert();
        h.ping(1);
        vm.warp(block.timestamp + 1);
        h.ping(1);
        vm.stopPrank();
        (uint32 count,, uint256 resetsAt) = h.actionUsage(1, PING);
        assertEq(count, 1);
        assertEq(resetsAt, block.timestamp + WINDOW);
    }

    function test_ExpiredWindowReportsEmpty() public {
        vm.prank(relayer);
        h.ping(1);
        vm.warp(block.timestamp + WINDOW);
        (uint32 count, uint128 value, uint256 resetsAt) = h.actionUsage(1, PING);
        assertEq(count, 0);
        assertEq(value, 0);
        assertEq(resetsAt, 0);
        (uint32 calls,) = h.remainingInWindow(1, PING);
        assertEq(calls, MAX);
    }

    /// The documented worst case: at most 2 * MAX inside any span of WINDOW.
    function test_TwoWindowWorstCase() public {
        vm.startPrank(relayer);
        for (uint256 i; i < MAX; ++i) h.ping(1);
        vm.warp(block.timestamp + WINDOW);
        for (uint256 i; i < MAX; ++i) h.ping(1);
        vm.expectRevert();
        h.ping(1);
        vm.stopPrank();
        assertEq(h.pings(), 2 * MAX);
    }

    // Value caps

    function test_ValueActionWithinCaps() public {
        vm.startPrank(relayer);
        h.spend(1, 25e6);
        h.spend(1, 25e6);
        vm.stopPrank();
        (, uint128 value) = h.remainingInWindow(1, SPEND);
        assertEq(value, 50e6);
    }

    function test_PerCallCap() public {
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionValueTooHigh.selector, SPEND, 25e6 + 1, 25e6));
        vm.prank(relayer);
        h.spend(1, 25e6 + 1);
    }

    function test_WindowValueCap() public {
        vm.startPrank(relayer);
        for (uint256 i; i < 4; ++i) h.spend(1, 25e6);
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionWindowCapExceeded.selector, 1, SPEND, 1, 0));
        h.spend(1, 1);
        vm.warp(block.timestamp + 1 days);
        h.spend(1, 25e6);
        vm.stopPrank();
    }

    function test_ZeroValueActionMovesNoValue() public {
        h.configureAction(PING, MAX, WINDOW, 0, 0);
        // PING always passes zero, but a value action configured with zero
        // caps refuses any value at all.
        h.configureAction(SPEND, 10, 1 days, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionValueTooHigh.selector, SPEND, 1, 0));
        vm.prank(relayer);
        h.spend(1, 1);
    }

    /// Under any sequence of calls inside one window, the total never exceeds
    /// the window cap and no single call exceeds the per-call cap.
    function testFuzz_ValueNeverExceedsCaps(uint128 perCall, uint128 perWindow, uint256[8] memory amounts) public {
        perWindow = uint128(bound(perWindow, 1, type(uint128).max));
        perCall = uint128(bound(perCall, 1, perWindow));
        h.configureAction(SPEND, 8, 1 days, perCall, perWindow);
        uint256 total;
        vm.startPrank(relayer);
        for (uint256 i; i < amounts.length; ++i) {
            uint256 amount = bound(amounts[i], 0, uint256(perWindow) + 1);
            (bool ok,) = address(h).call(abi.encodeCall(BoundedHarness.spend, (1, amount)));
            if (ok) {
                assertLe(amount, perCall);
                total += amount;
            }
            assertLe(total, perWindow);
        }
        vm.stopPrank();
        assertEq(h.spent(), total);
    }

    /// Calls in a window never exceed maxPerWindow, for any max and count.
    function testFuzz_CountNeverExceedsMax(uint8 maxPerWindow, uint8 attempts) public {
        maxPerWindow = uint8(bound(maxPerWindow, 1, 50));
        h.configureAction(PING, maxPerWindow, WINDOW, 0, 0);
        vm.startPrank(relayer);
        uint256 ok;
        for (uint256 i; i < attempts; ++i) {
            (bool success,) = address(h).call(abi.encodeCall(BoundedHarness.ping, (1)));
            if (success) ok++;
        }
        vm.stopPrank();
        assertEq(ok, attempts < maxPerWindow ? attempts : maxPerWindow);
    }

    // Owner revocation (the remedy)

    function test_OwnerRevokesOperatorForToken() public {
        vm.expectEmit(true, true, true, true, address(h));
        emit ActionOperatorRevoked(1, holder, relayer, true);
        vm.prank(holder);
        h.setOperatorRevoked(1, relayer, true);

        assertTrue(h.isOperatorRevoked(1, relayer));
        assertFalse(h.canOperate(1, relayer));
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionOperatorRevoked.selector, 1, relayer));
        vm.prank(relayer);
        h.ping(1);

        // Other tokens are unaffected.
        vm.prank(relayer);
        h.ping(2);
    }

    function test_OwnerCanRestoreOperator() public {
        vm.startPrank(holder);
        h.setOperatorRevoked(1, relayer, true);
        h.setOperatorRevoked(1, relayer, false);
        vm.stopPrank();
        vm.prank(relayer);
        h.ping(1);
    }

    function test_OnlyOwnerCanRevoke() public {
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionNotTokenOwner.selector, 1, stranger));
        vm.prank(stranger);
        h.setOperatorRevoked(1, relayer, true);

        // The operator cannot un-revoke itself either.
        vm.prank(holder);
        h.setOperatorRevoked(1, relayer, true);
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionNotTokenOwner.selector, 1, relayer));
        vm.prank(relayer);
        h.setOperatorRevoked(1, relayer, false);
    }

    function test_RevocationDoesNotBindNewOwner() public {
        vm.prank(holder);
        h.setOperatorRevoked(1, relayer, true);
        vm.prank(holder);
        h.transferFrom(holder, buyer, 1);

        assertFalse(h.isOperatorRevoked(1, relayer));
        vm.prank(relayer);
        h.ping(1);
    }

    function test_RevocationReturnsIfOwnerReacquires() public {
        vm.prank(holder);
        h.setOperatorRevoked(1, relayer, true);
        vm.prank(holder);
        h.transferFrom(holder, buyer, 1);
        vm.prank(buyer);
        h.transferFrom(buyer, holder, 1);
        assertTrue(h.isOperatorRevoked(1, relayer));
    }

    function test_RevokeAllCoversLaterOperators() public {
        vm.prank(holder);
        h.setAllOperatorsRevoked(1, true);
        assertTrue(h.areAllOperatorsRevoked(1));
        h.setActionOperator(stranger, true); // appointed after the revocation
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionOperatorRevoked.selector, 1, stranger));
        vm.prank(stranger);
        h.ping(1);
        vm.prank(relayer);
        h.ping(2); // other tokens unaffected
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionNotTokenOwner.selector, 1, relayer));
        vm.prank(relayer);
        h.setAllOperatorsRevoked(1, false);
        vm.prank(holder);
        h.setAllOperatorsRevoked(1, false);
        vm.prank(stranger);
        h.ping(1);
    }

    function test_RevokeAllDoesNotBindNewOwner() public {
        vm.prank(holder);
        h.setAllOperatorsRevoked(1, true);
        vm.prank(holder);
        h.transferFrom(holder, buyer, 1);
        assertFalse(h.areAllOperatorsRevoked(1));
        vm.prank(relayer);
        h.ping(1);
    }

    function test_ScopedOperator() public {
        h.setActionOperatorFor(stranger, PING, true);
        assertTrue(h.isActionOperatorFor(stranger, PING));
        assertFalse(h.isActionOperatorFor(stranger, SPEND));
        assertFalse(h.isActionOperator(stranger));
        vm.prank(stranger);
        h.ping(1);
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionUnauthorizedOperator.selector, stranger));
        vm.prank(stranger);
        h.spend(1, 1);
        h.setActionOperatorFor(stranger, PING, false);
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionUnauthorizedOperator.selector, stranger));
        vm.prank(stranger);
        h.ping(1);
    }

    function test_LoweredCapSaturates() public {
        vm.startPrank(relayer);
        h.spend(1, 25e6);
        h.spend(1, 25e6);
        vm.stopPrank();
        h.configureAction(SPEND, 10, 1 days, 10e6, 40e6);
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionWindowCapExceeded.selector, 1, SPEND, 1, 0));
        vm.prank(relayer);
        h.spend(1, 1);
    }

    // Freezing

    function test_FrozenBoundCanTighten() public {
        vm.expectEmit(true, false, false, true, address(h));
        emit ActionBoundFrozen(SPEND);
        h.freeze(SPEND);
        h.configureAction(SPEND, 5, 2 days, 10e6, 50e6);
        assertTrue(h.actionBound(SPEND).frozen);
        assertEq(h.actionBound(SPEND).maxValuePerWindow, 50e6);
    }

    function test_FrozenBoundCannotLoosen() public {
        h.freeze(SPEND);
        bytes memory err = abi.encodeWithSelector(BoundedAction.BoundedActionBoundFrozen.selector, SPEND);
        vm.expectRevert(err);
        h.configureAction(SPEND, 11, 1 days, 25e6, 100e6);
        vm.expectRevert(err);
        h.configureAction(SPEND, 10, 1 days - 1, 25e6, 100e6);
        vm.expectRevert(err);
        h.configureAction(SPEND, 10, 1 days, 25e6 + 1, 100e6);
        vm.expectRevert(err);
        h.configureAction(SPEND, 10, 1 days, 25e6, 100e6 + 1);
    }

    function test_FrozenBoundCanBeDisabledForGood() public {
        h.freeze(PING);
        h.configureAction(PING, 0, 0, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionBoundFrozen.selector, PING));
        h.configureAction(PING, 1, WINDOW, 0, 0);
    }

    function test_CannotFreezeDisabledAction() public {
        bytes32 other = keccak256("OTHER");
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionDisabled.selector, other));
        h.freeze(other);
    }
}
