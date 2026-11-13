// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {ERC1155WalletPass} from "../ERC1155WalletPass.sol";

/// @title VoteEditionPass (working draft example)
/// @notice An open edition whose units vote: one unit, one vote, counted at
///  a snapshot. DRAFT, for the ERC-1155 binding demo on a testnet; not
///  audited, and the open claim makes it unfit for anything of value.
/// @dev Why the vote is counted this way.
///
///  A balance is not a unit. A fresh `balanceOf` read proves an account holds
///  a unit now; it cannot prove the unit has not voted. If a vote were
///  admitted on the fresh read and recorded against the account, one unit
///  would vote, move to a second account, and vote again. So voting power is
///  not the balance now: it is the balance at the proposal's snapshot, read
///  from checkpoints this contract writes on every transfer. Units that move
///  after the snapshot carry no vote with them, and the votes of all accounts
///  can never add up to more than the supply at the snapshot. Splitting units
///  across accounts gains nothing, since power follows units and not heads.
///
///  A vote can arrive three ways, and they are not equal:
///  - `castVote`, sent by the holder: the strongest proof there is.
///  - `castVoteFor(..., signed = true)`, relayed by an operator after the
///    holder signed a challenge for it (the signed path of ERC-8426).
///  - `castVoteFor(..., signed = false)`, relayed by an operator because a
///    link on a wallet pass was followed (the capability path). Whoever holds
///    the pass holds the link, so this is the weakest.
///  The rule that keeps the weak one safe to offer: a link can cast an
///  account's vote once and can never change a vote, and the holder can
///  replace a link vote with a signed one, once, while the proposal is open.
///  A forwarded or stolen link can therefore do at most one thing, and the
///  holder can undo it. A vote moves no tokens and changes no entitlement.
contract VoteEditionPass is ERC1155WalletPass, Ownable {
    using Checkpoints for Checkpoints.Trace208;

    enum Choice {
        None,
        Yes,
        No
    }

    struct Proposal {
        /// The edition id whose units vote.
        uint256 id;
        /// Voting power is the balance at this time (unix seconds).
        uint48 snapshot;
        /// Last second in which a vote is accepted.
        uint48 closes;
        uint256 yes;
        uint256 no;
        string title;
    }

    struct Ballot {
        Choice choice;
        /// False for a vote cast through a pass link. Such a vote can be
        ///  replaced once by a signed one.
        bool signed;
        uint208 weight;
    }

    /// @notice The most units of one id an account can claim in total.
    uint256 public immutable claimLimit;

    /// @notice Whether an id can be claimed.
    mapping(uint256 id => bool) public open;

    /// @notice Units of `id` that `account` has claimed so far.
    mapping(uint256 id => mapping(address account => uint256)) public claimed;

    /// @notice Accounts allowed to open proposals and relay votes.
    mapping(address operator => bool) public voteOperator;

    mapping(uint256 id => mapping(address account => Checkpoints.Trace208)) private _balanceCheckpoints;
    Proposal[] private _proposals;
    mapping(uint256 proposalId => mapping(address account => Ballot)) private _ballots;

    event EditionOpen(uint256 indexed id, bool open);
    event VoteOperatorSet(address indexed operator, bool allowed);
    event ProposalCreated(uint256 indexed proposalId, uint256 indexed id, uint48 snapshot, uint48 closes, string title);
    /// @param signed False when the vote came through a pass link.
    /// @param replaced True when this vote replaced the account's link vote.
    event VoteCast(uint256 indexed proposalId, address indexed account, bool support, uint256 weight, bool signed, bool replaced);

    error VoteEditionClosed(uint256 id);
    error VoteEditionClaimLimit(uint256 id, address account, uint256 claimed, uint256 requested);
    error VoteEditionNotOperator(address caller);
    error VoteEditionUnknownProposal(uint256 proposalId);
    error VoteEditionInvalidDuration();
    /// @notice The snapshot second has not ended yet, or the proposal closed.
    error VoteEditionNotVotable(uint256 proposalId);
    /// @notice The account held no unit at the snapshot.
    error VoteEditionNoVotingPower(uint256 proposalId, address account);
    /// @notice The account's vote is final: it was signed, or the new vote is
    ///  another link vote.
    error VoteEditionAlreadyVoted(uint256 proposalId, address account);
    error VoteEditionFutureLookup(uint48 timepoint, uint48 clock);

    constructor(string memory metadataURI, string memory passBaseURI_, address owner_, uint256 claimLimit_)
        ERC1155(metadataURI)
        ERC1155WalletPass(passBaseURI_)
        Ownable(owner_)
    {
        claimLimit = claimLimit_;
    }

    // ---- the edition -----------------------------------------------------

    function setOpen(uint256 id, bool open_) external onlyOwner {
        open[id] = open_;
        emit EditionOpen(id, open_);
    }

    /// @notice Claim `amount` units of `id` to the caller.
    function claim(uint256 id, uint256 amount) external {
        if (!open[id]) revert VoteEditionClosed(id);
        uint256 already = claimed[id][msg.sender];
        if (amount == 0 || already + amount > claimLimit) {
            revert VoteEditionClaimLimit(id, msg.sender, already, amount);
        }
        claimed[id][msg.sender] = already + amount;
        _mint(msg.sender, id, amount, "");
    }

    function setPassBaseURI(string calldata newPassBaseURI) external onlyOwner {
        _setPassBaseURI(newPassBaseURI);
    }

    function setVoteOperator(address operator, bool allowed) external onlyOwner {
        voteOperator[operator] = allowed;
        emit VoteOperatorSet(operator, allowed);
    }

    // ---- checkpoints -----------------------------------------------------

    /// @notice The clock the checkpoints and snapshots use: unix seconds.
    /// @dev Seconds and not block numbers, because on some rollups
    ///  `block.number` is the parent chain's and advances slowly.
    function clock() public view returns (uint48) {
        return uint48(block.timestamp);
    }

    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() external pure returns (string memory) {
        return "mode=timestamp";
    }

    /// @notice `account`'s balance of `id` at the end of second `timepoint`,
    ///  which must be in the past.
    function getPastBalance(address account, uint256 id, uint48 timepoint) public view returns (uint256) {
        uint48 nowClock = clock();
        if (timepoint >= nowClock) revert VoteEditionFutureLookup(timepoint, nowClock);
        return _balanceCheckpoints[id][account].upperLookupRecent(timepoint);
    }

    /// @dev Writes a checkpoint for both sides of every mint, transfer and
    ///  burn. Several changes in one second leave that second's last value,
    ///  which is what a snapshot of that second reads.
    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        virtual
        override
    {
        super._update(from, to, ids, values);
        uint48 nowClock = clock();
        for (uint256 i = 0; i < ids.length; ++i) {
            uint256 id = ids[i];
            if (from != address(0)) {
                _balanceCheckpoints[id][from].push(nowClock, SafeCast.toUint208(balanceOf(from, id)));
            }
            if (to != address(0)) {
                _balanceCheckpoints[id][to].push(nowClock, SafeCast.toUint208(balanceOf(to, id)));
            }
        }
    }

    // ---- proposals and votes ---------------------------------------------

    /// @notice Open a proposal for the holders of `id`. The snapshot is now:
    ///  whoever holds at the end of this second votes with what they hold.
    ///  Emits `PassUpdate(id)`, since every holder's pass now shows it.
    function propose(uint256 id, string calldata title, uint48 duration) external returns (uint256 proposalId) {
        if (msg.sender != owner() && !voteOperator[msg.sender]) revert VoteEditionNotOperator(msg.sender);
        if (duration == 0) revert VoteEditionInvalidDuration();
        uint48 snapshot = clock();
        _proposals.push(Proposal({id: id, snapshot: snapshot, closes: snapshot + duration, yes: 0, no: 0, title: title}));
        proposalId = _proposals.length;
        emit ProposalCreated(proposalId, id, snapshot, snapshot + duration, title);
        _passUpdate(id);
    }

    /// @notice Number of proposals. Ids run from 1 to this number.
    function proposalCount() external view returns (uint256) {
        return _proposals.length;
    }

    function proposal(uint256 proposalId) public view returns (Proposal memory) {
        if (proposalId == 0 || proposalId > _proposals.length) revert VoteEditionUnknownProposal(proposalId);
        return _proposals[proposalId - 1];
    }

    function ballotOf(uint256 proposalId, address account) external view returns (Ballot memory) {
        return _ballots[proposalId][account];
    }

    /// @notice Whether votes are accepted now: after the snapshot second and
    ///  not after the close.
    function votable(uint256 proposalId) public view returns (bool) {
        Proposal memory p = proposal(proposalId);
        uint48 nowClock = clock();
        return nowClock > p.snapshot && nowClock <= p.closes;
    }

    /// @notice `account`'s voting power on a proposal: its balance at the
    ///  snapshot. Zero until the snapshot second has ended.
    function votingPower(uint256 proposalId, address account) public view returns (uint256) {
        Proposal memory p = proposal(proposalId);
        if (clock() <= p.snapshot) return 0;
        return getPastBalance(account, p.id, p.snapshot);
    }

    /// @notice Vote with the caller's own units. Replaces a link vote; final.
    function castVote(uint256 proposalId, bool support) external {
        _cast(proposalId, msg.sender, support, true);
    }

    /// @notice Relay `account`'s vote. `signed` says whether the account
    ///  signed for it (true) or a pass link was followed (false). The
    ///  operator is trusted for that statement and for nothing else: it
    ///  cannot vote with more than the snapshot balance, vote twice, or
    ///  change a signed vote.
    function castVoteFor(address account, uint256 proposalId, bool support, bool signed) external {
        if (!voteOperator[msg.sender]) revert VoteEditionNotOperator(msg.sender);
        _cast(proposalId, account, support, signed);
    }

    function _cast(uint256 proposalId, address account, bool support, bool signed) internal {
        if (!votable(proposalId)) revert VoteEditionNotVotable(proposalId);
        Proposal storage p = _proposals[proposalId - 1];
        uint256 weight = getPastBalance(account, p.id, p.snapshot);
        if (weight == 0) revert VoteEditionNoVotingPower(proposalId, account);

        Ballot storage b = _ballots[proposalId][account];
        bool replaced = false;
        if (b.choice != Choice.None) {
            // A signed vote is final. A link vote can be replaced, by a
            // signed vote only.
            if (b.signed || !signed) revert VoteEditionAlreadyVoted(proposalId, account);
            if (b.choice == Choice.Yes) p.yes -= b.weight;
            else p.no -= b.weight;
            replaced = true;
        }
        b.choice = support ? Choice.Yes : Choice.No;
        b.signed = signed;
        b.weight = SafeCast.toUint208(weight);
        if (support) p.yes += weight;
        else p.no += weight;
        emit VoteCast(proposalId, account, support, weight, signed, replaced);
    }
}
