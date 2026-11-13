// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {IERC1155WalletPass} from "../src/IERC1155WalletPass.sol";
import {VoteEditionPass} from "../src/examples/VoteEditionPass.sol";

/// @dev A receiver that tries to claim again from inside the mint callback.
contract ReentrantClaimer {
    VoteEditionPass internal immutable edition;
    bool internal entered;

    constructor(VoteEditionPass edition_) {
        edition = edition_;
    }

    function go() external {
        edition.claim(1, 3);
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4) {
        if (!entered) {
            entered = true;
            // The limit is already spent, so this must revert the whole claim.
            edition.claim(1, 1);
        }
        return this.onERC1155Received.selector;
    }
}

contract VoteEditionPassTest is Test {
    VoteEditionPass internal edition;
    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint256 internal constant ID = 1;

    function setUp() public {
        vm.warp(1_800_000_000);
        edition = new VoteEditionPass("https://meta.example/{id}.json", "https://issuer.example/edition-pass/", owner, 3);
        vm.startPrank(owner);
        edition.setOpen(ID, true);
        edition.setVoteOperator(operator, true);
        vm.stopPrank();
    }

    function _claim(address who, uint256 amount) internal {
        vm.prank(who);
        edition.claim(ID, amount);
    }

    /// @dev Opens a proposal and moves past the snapshot second.
    function _propose() internal returns (uint256 pid) {
        vm.prank(operator);
        pid = edition.propose(ID, "Paint the clubhouse", 1 hours);
        skip(1);
    }

    function _tally(uint256 pid) internal view returns (uint256 yes, uint256 no) {
        VoteEditionPass.Proposal memory p = edition.proposal(pid);
        return (p.yes, p.no);
    }

    // ---- interface and edition ---------------------------------------------

    function test_interfaceIds() public view {
        assertTrue(edition.supportsInterface(type(IERC1155WalletPass).interfaceId));
        assertTrue(edition.supportsInterface(0xef5f1e71));
        assertTrue(edition.supportsInterface(0xd9b67a26));
        assertFalse(edition.supportsInterface(0x80ac58cd));
    }

    function test_claimLimitHoldsAgainstReentry() public {
        ReentrantClaimer claimer = new ReentrantClaimer(edition);
        vm.expectRevert();
        claimer.go();
        assertEq(edition.balanceOf(address(claimer), ID), 0);
    }

    function test_claimLimit() public {
        _claim(alice, 3);
        vm.expectRevert(abi.encodeWithSelector(VoteEditionPass.VoteEditionClaimLimit.selector, ID, alice, 3, 1));
        vm.prank(alice);
        edition.claim(ID, 1);
    }

    // ---- checkpoints -------------------------------------------------------

    function test_pastBalanceFollowsTransfers() public {
        _claim(alice, 3);
        uint48 t0 = edition.clock();
        skip(10);
        vm.prank(alice);
        edition.safeTransferFrom(alice, bob, ID, 2, "");
        uint48 t1 = edition.clock();
        skip(10);
        assertEq(edition.getPastBalance(alice, ID, t0), 3);
        assertEq(edition.getPastBalance(bob, ID, t0), 0);
        assertEq(edition.getPastBalance(alice, ID, t1), 1);
        assertEq(edition.getPastBalance(bob, ID, t1), 2);
    }

    function test_pastBalanceRefusesNowAndTheFuture() public {
        _claim(alice, 1);
        uint48 nowClock = edition.clock();
        vm.expectRevert(abi.encodeWithSelector(VoteEditionPass.VoteEditionFutureLookup.selector, nowClock, nowClock));
        edition.getPastBalance(alice, ID, nowClock);
    }

    // ---- who may propose and relay -------------------------------------------

    function test_onlyOwnerOrOperatorProposes() public {
        vm.expectRevert(abi.encodeWithSelector(VoteEditionPass.VoteEditionNotOperator.selector, alice));
        vm.prank(alice);
        edition.propose(ID, "x", 1 hours);
    }

    function test_onlyOperatorRelays() public {
        _claim(alice, 1);
        uint256 pid = _propose();
        vm.expectRevert(abi.encodeWithSelector(VoteEditionPass.VoteEditionNotOperator.selector, bob));
        vm.prank(bob);
        edition.castVoteFor(alice, pid, true, true);
    }

    function test_proposeAnnouncesToEveryHolder() public {
        vm.expectEmit(true, false, false, false);
        emit IERC1155WalletPass.PassUpdate(ID);
        vm.prank(operator);
        edition.propose(ID, "x", 1 hours);
    }

    // ---- one unit, one vote --------------------------------------------------

    function test_weightIsTheSnapshotBalance() public {
        _claim(alice, 3);
        _claim(bob, 1);
        uint256 pid = _propose();
        vm.prank(alice);
        edition.castVote(pid, true);
        vm.prank(bob);
        edition.castVote(pid, false);
        (uint256 yes, uint256 no) = _tally(pid);
        assertEq(yes, 3);
        assertEq(no, 1);
    }

    function test_aUnitThatMovesAfterTheSnapshotDoesNotVoteAgain() public {
        _claim(alice, 1);
        uint256 pid = _propose();
        vm.prank(alice);
        edition.castVote(pid, true);
        // The unit moves on. Its new holder held nothing at the snapshot.
        vm.prank(alice);
        edition.safeTransferFrom(alice, bob, ID, 1, "");
        assertEq(edition.balanceOf(bob, ID), 1);
        vm.expectRevert(abi.encodeWithSelector(VoteEditionPass.VoteEditionNoVotingPower.selector, pid, bob));
        vm.prank(bob);
        edition.castVote(pid, true);
        (uint256 yes,) = _tally(pid);
        assertEq(yes, 1);
    }

    function test_theSellerKeepsItsVoteAndTheBuyerVotesNextTime() public {
        _claim(alice, 1);
        uint256 pid = _propose();
        vm.prank(alice);
        edition.safeTransferFrom(alice, bob, ID, 1, "");
        // Alice held at the snapshot, so the vote is hers though the unit left.
        vm.prank(alice);
        edition.castVote(pid, false);
        skip(2 hours);
        uint256 next = _propose();
        vm.prank(bob);
        edition.castVote(next, true);
        vm.expectRevert(abi.encodeWithSelector(VoteEditionPass.VoteEditionNoVotingPower.selector, next, alice));
        vm.prank(alice);
        edition.castVote(next, true);
    }

    function test_claimingInTheSnapshotSecondCountsAndAfterItDoesNot() public {
        vm.prank(operator);
        uint256 pid = edition.propose(ID, "x", 1 hours);
        // Same second as the snapshot: counts.
        _claim(alice, 2);
        assertEq(edition.votingPower(pid, alice), 0); // not readable until the second ends
        skip(1);
        _claim(bob, 2);
        assertEq(edition.votingPower(pid, alice), 2);
        assertEq(edition.votingPower(pid, bob), 0);
    }

    function test_noVoteInTheSnapshotSecondOrAfterTheClose() public {
        _claim(alice, 1);
        vm.prank(operator);
        uint256 pid = edition.propose(ID, "x", 1 hours);
        vm.expectRevert(abi.encodeWithSelector(VoteEditionPass.VoteEditionNotVotable.selector, pid));
        vm.prank(alice);
        edition.castVote(pid, true);
        skip(1 hours + 1);
        vm.expectRevert(abi.encodeWithSelector(VoteEditionPass.VoteEditionNotVotable.selector, pid));
        vm.prank(alice);
        edition.castVote(pid, true);
    }

    function testFuzz_votesNeverExceedTheSupplyAtTheSnapshot(uint8 a, uint8 b, uint8 moved) public {
        uint256 ua = bound(a, 1, 3);
        uint256 ub = bound(b, 1, 3);
        _claim(alice, ua);
        _claim(bob, ub);
        uint256 pid = _propose();
        uint256 supplyAtSnapshot = ua + ub;
        // Units shuffle through a third account after the snapshot, and
        // everyone who can votes.
        uint256 m = bound(moved, 1, ua);
        vm.prank(alice);
        edition.safeTransferFrom(alice, carol, ID, m, "");
        address[3] memory voters = [alice, bob, carol];
        for (uint256 i = 0; i < voters.length; ++i) {
            vm.prank(voters[i]);
            try edition.castVote(pid, true) {} catch {}
        }
        (uint256 yes, uint256 no) = _tally(pid);
        assertEq(yes + no, supplyAtSnapshot);
    }

    // ---- link votes and signed votes ------------------------------------------

    function test_aLinkVotesOnceAndCannotChangeAVote() public {
        _claim(alice, 2);
        uint256 pid = _propose();
        vm.startPrank(operator);
        edition.castVoteFor(alice, pid, true, false);
        vm.expectRevert(abi.encodeWithSelector(VoteEditionPass.VoteEditionAlreadyVoted.selector, pid, alice));
        edition.castVoteFor(alice, pid, false, false);
        vm.expectRevert(abi.encodeWithSelector(VoteEditionPass.VoteEditionAlreadyVoted.selector, pid, alice));
        edition.castVoteFor(alice, pid, true, false);
        vm.stopPrank();
        (uint256 yes, uint256 no) = _tally(pid);
        assertEq(yes, 2);
        assertEq(no, 0);
    }

    function test_aSignedVoteReplacesALinkVoteOnceAndIsFinal() public {
        _claim(alice, 2);
        uint256 pid = _propose();
        vm.prank(operator);
        edition.castVoteFor(alice, pid, true, false);
        // The holder disagrees with what the link did.
        vm.prank(operator);
        edition.castVoteFor(alice, pid, false, true);
        (uint256 yes, uint256 no) = _tally(pid);
        assertEq(yes, 0);
        assertEq(no, 2);
        VoteEditionPass.Ballot memory b = edition.ballotOf(pid, alice);
        assertTrue(b.signed);
        // Final: neither a link, nor a relay, nor the holder changes it now.
        vm.expectRevert(abi.encodeWithSelector(VoteEditionPass.VoteEditionAlreadyVoted.selector, pid, alice));
        vm.prank(operator);
        edition.castVoteFor(alice, pid, true, false);
        vm.expectRevert(abi.encodeWithSelector(VoteEditionPass.VoteEditionAlreadyVoted.selector, pid, alice));
        vm.prank(operator);
        edition.castVoteFor(alice, pid, true, true);
        vm.expectRevert(abi.encodeWithSelector(VoteEditionPass.VoteEditionAlreadyVoted.selector, pid, alice));
        vm.prank(alice);
        edition.castVote(pid, true);
    }

    function test_aLinkCannotReplaceASignedVote() public {
        _claim(alice, 1);
        uint256 pid = _propose();
        vm.prank(alice);
        edition.castVote(pid, false);
        vm.expectRevert(abi.encodeWithSelector(VoteEditionPass.VoteEditionAlreadyVoted.selector, pid, alice));
        vm.prank(operator);
        edition.castVoteFor(alice, pid, true, false);
    }

    function test_theOperatorCannotVoteForAnAccountWithNoPower() public {
        uint256 pid = _propose();
        vm.expectRevert(abi.encodeWithSelector(VoteEditionPass.VoteEditionNoVotingPower.selector, pid, alice));
        vm.prank(operator);
        edition.castVoteFor(alice, pid, true, true);
    }

    function test_unknownProposal() public {
        vm.expectRevert(abi.encodeWithSelector(VoteEditionPass.VoteEditionUnknownProposal.selector, 1));
        edition.proposal(1);
        vm.expectRevert(abi.encodeWithSelector(VoteEditionPass.VoteEditionUnknownProposal.selector, 0));
        edition.votable(0);
    }
}
