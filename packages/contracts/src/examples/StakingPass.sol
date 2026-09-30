// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ERC721WalletPass} from "../ERC721WalletPass.sol";
import {BoundedAction} from "../utils/BoundedAction.sol";

/// @title StakingPass (example)
/// @notice Use case: stake an NFT from another collection and carry the
///  position on a wallet pass. Staking mints a pass-enabled receipt token;
///  rewards accrue in an ERC-20 at `rewardPerSecond` per receipt; the pass
///  shows accrued rewards and carries a Claim link.
/// @dev Capability analysis (ERC-8426, "The capability configuration"):
///
///  Pass-reachable through a capability link, via the issuer operator:
///  - `claim`. The owner or an approved account may call it directly; an
///    appointed operator may call it within the CLAIM bound (by default 24
///    claims per receipt per day). It always pays the receipt's current
///    owner and nobody else, cannot transfer, burn or approve anything, and
///    its value under unlimited repetition is bounded by construction: the
///    total paid can never exceed the rewards accrued, so repeating it only
///    moves the owner's own rewards to the owner sooner.
///
///  Why claim is not permissionless: when the receipt sits in a contract
///  (a vault, a lending pool, a listing escrow), a stranger could push the
///  accrued rewards into that contract, where they may be stuck, and the
///  depositor would get the receipt back with nothing accrued. Limiting
///  callers to the owner, an approved account, or the bounded operator (the
///  issuer's relayer, which acts only after its fresh ownership read) keeps
///  that decision with the owner.
///
///  Needs the owner's own signed transaction:
///  - `unstake`: burns the receipt and returns the staked NFT. ERC-8426
///    forbids a capability link from burning or transferring the token or
///    changing who is entitled to it, so unstake is owner only.
///  - transfer and approve of the receipt (standard ERC-721).
///
///  Reward semantics: accrued rewards travel with the receipt, like fees on
///  a liquidity position NFT. A seller should claim before selling. When
///  the reward pool is short, `claim` reverts rather than paying partially,
///  and `unstake` never blocks on rewards: any unpaid amount is recorded as
///  owed to the unstaker and paid by `claimOwed` once the pool is refilled.
///
///  Accrual is passive: rewards grow each second with no transaction and no
///  event. Render the balance as a rate on the pass, or refresh it on a
///  schedule; `PassUpdate` fires on stake, claim and unstake.
contract StakingPass is ERC721WalletPass, BoundedAction, Ownable, ReentrancyGuard {
    bytes32 public constant CLAIM = keccak256("CLAIM");

    using SafeERC20 for IERC20;

    /// @notice The collection that can be staked.
    IERC721 public immutable stakedCollection;

    /// @notice The token rewards are paid in.
    IERC20 public immutable rewardToken;

    /// @notice Reward units accrued per receipt per second.
    uint256 public immutable rewardPerSecond;

    struct Position {
        uint256 stakedTokenId;
        uint64 stakedAt;
        uint64 lastClaimAt;
    }

    mapping(uint256 receiptId => Position) private _positions;
    mapping(address account => uint256) public owedRewards;
    uint256 private _nextReceiptId;

    /// @notice Reward tokens set aside for owed amounts; not available to
    ///  `claim`.
    uint256 public totalOwed;

    event Staked(uint256 indexed receiptId, address indexed staker, uint256 indexed stakedTokenId);
    event Claimed(uint256 indexed receiptId, address indexed to, uint256 amount);
    event Unstaked(uint256 indexed receiptId, address indexed to, uint256 indexed stakedTokenId, uint256 paid, uint256 owed);
    event OwedClaimed(address indexed account, uint256 amount);

    error StakingNotReceiptOwner(uint256 receiptId, address caller);
    error StakingInsufficientRewardPool(uint256 needed, uint256 available);
    error StakingNothingToClaim();

    constructor(
        string memory passBaseURI_,
        address initialOwner,
        IERC721 stakedCollection_,
        IERC20 rewardToken_,
        uint256 rewardPerSecond_
    ) ERC721("Staking Pass", "STAKE") ERC721WalletPass(passBaseURI_) Ownable(initialOwner) {
        stakedCollection = stakedCollection_;
        rewardToken = rewardToken_;
        rewardPerSecond = rewardPerSecond_;
        // Value moves only to the owner and is capped by accrual, so the
        // bound limits the rate of operator claims and moves no value.
        _configureAction(CLAIM, 24, 1 days, 0, 0);
    }

    function setActionOperator(address operator, bool allowed) external onlyOwner {
        _setActionOperator(operator, allowed);
    }

    function setActionOperatorFor(address operator, bytes32 actionId, bool allowed) external onlyOwner {
        _setActionOperatorFor(operator, actionId, allowed);
    }

    /// @notice Change how often an operator may claim per receipt.
    function configureClaimBound(uint32 maxPerWindow, uint32 windowSeconds) external onlyOwner {
        _configureAction(CLAIM, maxPerWindow, windowSeconds, 0, 0);
    }

    function setPassBaseURI(string calldata newBase) external onlyOwner {
        _setPassBaseURI(newBase);
    }

    /// @notice Stake `stakedTokenId` (approve this contract first) and
    ///  receive a receipt. The receipt mint emits `PassUpdate`.
    function stake(uint256 stakedTokenId) external nonReentrant returns (uint256 receiptId) {
        receiptId = ++_nextReceiptId;
        uint64 nowTs = uint64(block.timestamp);
        _positions[receiptId] = Position(stakedTokenId, nowTs, nowTs);
        _mint(msg.sender, receiptId);
        emit Staked(receiptId, msg.sender, stakedTokenId);
        stakedCollection.transferFrom(msg.sender, address(this), stakedTokenId);
    }

    /// @notice Pay accrued rewards for `receiptId` to its current owner.
    ///  Callable by the owner, an approved account, or an appointed operator
    ///  within the CLAIM bound (the pass-reachable path).
    function claim(uint256 receiptId) external nonReentrant returns (uint256 amount) {
        address holder = _requireOwned(receiptId);
        if (!_isAuthorized(holder, _msgSender(), receiptId)) {
            _consumeBoundedAction(CLAIM, receiptId, _msgSender(), 0);
        }
        amount = pendingRewards(receiptId);
        if (amount == 0) revert StakingNothingToClaim();
        uint256 available = rewardPool();
        if (amount > available) revert StakingInsufficientRewardPool(amount, available);

        _positions[receiptId].lastClaimAt = uint64(block.timestamp);
        emit Claimed(receiptId, holder, amount);
        _passUpdate(receiptId);
        rewardToken.safeTransfer(holder, amount);
    }

    /// @notice Burn `receiptId`, return the staked NFT and pay accrued
    ///  rewards to the receipt owner. Owner only. Never blocks on an empty
    ///  reward pool: the shortfall is recorded in `owedRewards`.
    function unstake(uint256 receiptId) external nonReentrant {
        address holder = _requireOwned(receiptId);
        if (holder != msg.sender) revert StakingNotReceiptOwner(receiptId, msg.sender);

        Position memory p = _positions[receiptId];
        uint256 pending = pendingRewards(receiptId);
        uint256 available = rewardPool();
        uint256 paid = pending <= available ? pending : available;
        uint256 owed = pending - paid;

        delete _positions[receiptId];
        if (owed != 0) {
            owedRewards[holder] += owed;
            totalOwed += owed;
        }
        _burn(receiptId);
        emit Unstaked(receiptId, holder, p.stakedTokenId, paid, owed);

        stakedCollection.transferFrom(address(this), holder, p.stakedTokenId);
        if (paid != 0) rewardToken.safeTransfer(holder, paid);
    }

    /// @notice Pay rewards owed to the caller from an earlier unstake.
    function claimOwed() external nonReentrant returns (uint256 amount) {
        amount = owedRewards[msg.sender];
        if (amount == 0) revert StakingNothingToClaim();
        uint256 balance = rewardToken.balanceOf(address(this));
        if (amount > balance) revert StakingInsufficientRewardPool(amount, balance);
        owedRewards[msg.sender] = 0;
        totalOwed -= amount;
        emit OwedClaimed(msg.sender, amount);
        rewardToken.safeTransfer(msg.sender, amount);
    }

    // Views

    function position(uint256 receiptId) external view returns (Position memory) {
        _requireOwned(receiptId);
        return _positions[receiptId];
    }

    /// @notice Rewards accrued by `receiptId` since its last claim.
    function pendingRewards(uint256 receiptId) public view returns (uint256) {
        _requireOwned(receiptId);
        return (block.timestamp - _positions[receiptId].lastClaimAt) * rewardPerSecond;
    }

    function _boundedActionOwner(uint256 tokenId) internal view override returns (address) {
        return _requireOwned(tokenId);
    }

    /// @notice Reward tokens available to `claim` (balance minus owed).
    function rewardPool() public view returns (uint256) {
        uint256 balance = rewardToken.balanceOf(address(this));
        return balance > totalOwed ? balance - totalOwed : 0;
    }
}
