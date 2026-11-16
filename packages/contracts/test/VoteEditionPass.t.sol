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
        _claim(bob, 1);
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
        _claim(alice, 1);
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
        _claim(carol, 1);
        skip(5);
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

    /// @dev The same invariant with room to move: up to 8 holders with up to
    ///  a million units each, up to 24 transfers after the snapshot between
    ///  16 accounts (zero unit transfers and transfers back included, with
    ///  time passing in between), then every account votes, by any of the
    ///  three ways. Units that moved after the snapshot carry no vote, so
    ///  the tally is exactly the supply at the snapshot, never more.
    function testFuzz_votesAreExactlyTheSnapshotSupply_manyHoldersManyMoves(uint256 seed) public {
        VoteEditionPass big = new VoteEditionPass("https://meta.example/{id}.json", "https://issuer.example/edition-pass/", owner, 1_000_000);
        vm.startPrank(owner);
        big.setOpen(ID, true);
        big.setVoteOperator(operator, true);
        vm.stopPrank();

        address[16] memory accounts;
        for (uint256 i = 0; i < 16; ++i) {
            accounts[i] = address(uint160(0xA11CE000 + i));
        }
        uint256 holders = bound(uint256(keccak256(abi.encode(seed, "holders"))), 2, 8);
        uint256 supplyAtSnapshot;
        for (uint256 i = 0; i < holders; ++i) {
            uint256 amount = bound(uint256(keccak256(abi.encode(seed, "amount", i))), 1, 1_000_000);
            vm.prank(accounts[i]);
            big.claim(ID, amount);
            supplyAtSnapshot += amount;
        }
        vm.prank(operator);
        uint256 pid = big.propose(ID, "Paint the clubhouse", 1 hours);
        skip(1);

        uint256 moves = bound(uint256(keccak256(abi.encode(seed, "moves"))), 0, 24);
        for (uint256 m = 0; m < moves; ++m) {
            address from = accounts[uint256(keccak256(abi.encode(seed, "from", m))) % 16];
            address to = accounts[uint256(keccak256(abi.encode(seed, "to", m))) % 16];
            uint256 amount = bound(uint256(keccak256(abi.encode(seed, "units", m))), 0, big.balanceOf(from, ID));
            vm.prank(from);
            big.safeTransferFrom(from, to, ID, amount, "");
            skip(uint256(keccak256(abi.encode(seed, "wait", m))) % 3);
        }
        // An account that claims after the snapshot has no vote either.
        vm.prank(accounts[15]);
        try big.claim(ID, 7) {} catch {}

        for (uint256 i = 0; i < 16; ++i) {
            uint256 way = uint256(keccak256(abi.encode(seed, "way", i))) % 3;
            bool support = uint256(keccak256(abi.encode(seed, "support", i))) % 2 == 0;
            if (way == 0) {
                vm.prank(accounts[i]);
                try big.castVote(pid, support) {} catch {}
            } else {
                vm.prank(operator);
                try big.castVoteFor(accounts[i], pid, support, way == 2) {} catch {}
            }
        }
        VoteEditionPass.Proposal memory p = big.proposal(pid);
        assertEq(p.yes + p.no, supplyAtSnapshot);
    }

    // ---- link votes and signed votes ------------------------------------------

    /// @dev A link vote that lands at the close leaves the holder no time to
    ///  overrule it, so links stop being accepted before the vote does.
    function test_aLinkVoteCannotLandSoLateThatTheHolderCannotOverruleIt() public {
        _claim(alice, 2);
        uint256 pid = _propose();
        VoteEditionPass.Proposal memory p = edition.proposal(pid);

        // The last moment of the vote: a link is refused, a signature is not.
        vm.warp(p.closes);
        uint48 last = edition.linkCloses(pid);
        assertFalse(edition.linkVotable(pid));
        assertTrue(edition.votable(pid));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(VoteEditionPass.VoteEditionLinkVotingClosed.selector, pid, last));
        edition.castVoteFor(alice, pid, false, false);
        vm.prank(alice);
        edition.castVote(pid, true);
        (uint256 yes, uint256 no) = _tally(pid);
        assertEq(yes, 2);
        assertEq(no, 0);
    }

    /// @dev The cutoff itself: the last fifth of the period. A link vote in
    ///  the last second it is accepted still leaves that fifth to overrule.
    function test_linksCloseAFifthOfThePeriodBeforeTheVote() public {
        _claim(alice, 1);
        _claim(bob, 1);
        uint256 pid = _propose();
        VoteEditionPass.Proposal memory p = edition.proposal(pid);
        uint48 last = edition.linkCloses(pid);
        assertEq(last, p.closes - (p.closes - p.snapshot) / 5);
        assertGt(p.closes, last);

        vm.warp(last);
        assertTrue(edition.linkVotable(pid));
        vm.prank(operator);
        edition.castVoteFor(alice, pid, false, false);

        vm.warp(uint256(last) + 1);
        assertFalse(edition.linkVotable(pid));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(VoteEditionPass.VoteEditionLinkVotingClosed.selector, pid, last));
        edition.castVoteFor(bob, pid, false, false);

        // Alice overrules the link vote in what is left, by signature or herself.
        vm.prank(operator);
        edition.castVoteFor(alice, pid, true, true);
        vm.warp(p.closes);
        vm.prank(alice);
        edition.castVote(pid, false);
        (uint256 yes, uint256 no) = _tally(pid);
        assertEq(yes, 0);
        assertEq(no, 1);
    }

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
        assertEq(uint8(b.source), uint8(VoteEditionPass.Source.Relayed));
        // Neither a link nor another relayed vote changes it now.
        vm.expectRevert(abi.encodeWithSelector(VoteEditionPass.VoteEditionAlreadyVoted.selector, pid, alice));
        vm.prank(operator);
        edition.castVoteFor(alice, pid, true, false);
        vm.expectRevert(abi.encodeWithSelector(VoteEditionPass.VoteEditionAlreadyVoted.selector, pid, alice));
        vm.prank(operator);
        edition.castVoteFor(alice, pid, true, true);
    }

    function test_theHolderOverrulesTheOperatorOnChainAndThatIsFinal() public {
        _claim(alice, 3);
        uint256 pid = _propose();
        // An operator claims a signature that was never given.
        vm.prank(operator);
        edition.castVoteFor(alice, pid, false, true);
        (uint256 yes, uint256 no) = _tally(pid);
        assertEq(no, 3);
        // The holder votes for herself and that replaces it.
        vm.prank(alice);
        edition.castVote(pid, true);
        (yes, no) = _tally(pid);
        assertEq(yes, 3);
        assertEq(no, 0);
        assertEq(uint8(edition.ballotOf(pid, alice).source), uint8(VoteEditionPass.Source.Direct));
        // Final: not the operator, not a link, not the holder again.
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(VoteEditionPass.VoteEditionAlreadyVoted.selector, pid, alice));
        edition.castVoteFor(alice, pid, false, true);
        vm.expectRevert(abi.encodeWithSelector(VoteEditionPass.VoteEditionAlreadyVoted.selector, pid, alice));
        edition.castVoteFor(alice, pid, false, false);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(VoteEditionPass.VoteEditionAlreadyVoted.selector, pid, alice));
        vm.prank(alice);
        edition.castVote(pid, false);
    }

    function test_proposalBounds() public {
        vm.startPrank(operator);
        // Nobody holds the id yet.
        vm.expectRevert(abi.encodeWithSelector(VoteEditionPass.VoteEditionNoSupply.selector, ID));
        edition.propose(ID, "x", 1 hours);
        vm.stopPrank();
        _claim(alice, 1);
        vm.startPrank(operator);
        vm.expectRevert(VoteEditionPass.VoteEditionInvalidDuration.selector);
        edition.propose(ID, "x", 0);
        vm.expectRevert(VoteEditionPass.VoteEditionInvalidDuration.selector);
        edition.propose(ID, "x", 30 days + 1);
        vm.expectRevert(VoteEditionPass.VoteEditionInvalidDuration.selector);
        edition.propose(ID, "x", type(uint48).max);
        vm.stopPrank();
        assertFalse(edition.votable(0));
        assertFalse(edition.votable(99));
    }

    function test_aTransferOfZeroUnitsWritesNoCheckpoint() public {
        _claim(alice, 2);
        uint256 pid = _propose();
        // A stranger sends zero units to alice and from itself after the
        // snapshot: her power on the proposal is what it was.
        vm.prank(bob);
        edition.safeTransferFrom(bob, alice, ID, 0, "");
        assertEq(edition.votingPower(pid, alice), 2);
        assertEq(edition.votingPower(pid, bob), 0);
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
        _claim(bob, 1);
        uint256 pid = _propose();
        vm.expectRevert(abi.encodeWithSelector(VoteEditionPass.VoteEditionNoVotingPower.selector, pid, alice));
        vm.prank(operator);
        edition.castVoteFor(alice, pid, true, true);
    }

    function test_unknownProposal() public {
        vm.expectRevert(abi.encodeWithSelector(VoteEditionPass.VoteEditionUnknownProposal.selector, 1));
        edition.proposal(1);
        vm.expectRevert(abi.encodeWithSelector(VoteEditionPass.VoteEditionUnknownProposal.selector, 7));
        vm.prank(alice);
        edition.castVote(7, true);
    }
}
