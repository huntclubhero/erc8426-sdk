// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ERC721WalletPass} from "../ERC721WalletPass.sol";
import {BoundedAction} from "../utils/BoundedAction.sol";

/// @title StoredValueCard (example)
/// @notice Use case: a stablecoin spending card with a loyalty punch card
///  built in (the PUNCHCARD design). Each token holds its own stablecoin
///  balance. At a counter, a merchant terminal scans the QR code on the pass
///  and the issuer's relayer charges the card, within a per-transaction cap
///  and a daily cap enforced on chain. Every charge punches the card; every
///  `punchesPerReward` punches earn a reward (a free coffee) that the
///  merchant can redeem later without charging.
/// @dev Capability analysis (ERC-8426, "The capability configuration"):
///
///  Pass-reachable through the issuer operator (the QR code on the pass is a
///  bearer artifact, like a capability link):
///  - `charge`: moves value out of the token, which the capability
///    configuration allows only if the repetition is bounded and documented.
///    It is: at most `maxValuePerCall` per charge and `maxValuePerWindow` per
///    day per card (see `BoundedAction` for the two-window factor), and the
///    money can go only to a merchant the issuer registered, never to the
///    operator or an arbitrary address. It cannot transfer, burn or approve
///    the token. The documented worst case of a leaked QR code is the daily
///    cap spent at registered merchants until the owner revokes the operator
///    or rotates the pass. The daily cap bounds the RATE of loss; the total
///    exposure over time is the card balance, which the owner controls by
///    what they top up and by revoking (`setAllOperatorsRevoked` switches
///    every relayer off, including ones the issuer appoints later).
///  - `redeemReward`: bounded by rewards actually earned, moves no value.
///
///  Anyone may call:
///  - `topUp`: adds value to a card; it can only help the holder.
///
///  Needs the owner's own signed transaction:
///  - `withdraw`: sends any amount to any address the owner names. That is
///    an unbounded value transfer to a chosen recipient, exactly what a
///    capability link must never reach; it is the owner's exit, not a pass
///    action.
///  - transfer, approve, burn, and the revocations (the remedy).
///
///  An ERC-721 approval exposes the balance. `withdraw` itself is owner
///  only, but an approved account (`approve` or `setApprovalForAll`, for
///  example a marketplace conduit) can transfer the card to itself and then
///  withdraw. Treat approving a card like handing over its balance.
///
///  The CHARGE bound is frozen at deployment: the issuer can lower the caps
///  with `setChargeCaps` but never raise them, so the published bound is a
///  commitment. Deploy a new card contract to offer higher limits.
///
///  Every function that moves tokens is `nonReentrant`, so a token with
///  transfer hooks cannot re-enter a top up, charge or withdrawal.
///
///  Mapping to an ERC-6551 design: in the production variant each card owns
///  a token-bound account holding the stablecoin. The account's owner-only
///  `execute` plays the role of `withdraw` here, and the issuer is appointed
///  a spender inside the account whose per-transaction and daily caps are
///  enforced by the account implementation, which plays the role of
///  `BoundedAction` here. This example keeps the balance as internal
///  accounting in one contract, which is simpler to audit and cheaper, at the
///  cost of the card not being a general-purpose account.
///
///  Transfer semantics: the balance and punches travel with the token, as
///  they would with a token-bound account. A seller can withdraw before a
///  sale settles, so buyers and marketplaces must not price the balance
///  without escrow.
contract StoredValueCard is ERC721WalletPass, BoundedAction, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant CHARGE = keccak256("CHARGE");
    bytes32 public constant REDEEM = keccak256("REDEEM");

    /// @notice The stablecoin cards hold.
    IERC20 public immutable stablecoin;

    /// @notice Punches needed for one reward.
    uint32 public immutable punchesPerReward;

    struct Card {
        uint256 balance;
        uint32 punches;
        uint32 rewards;
    }

    mapping(uint256 tokenId => Card) private _cards;
    mapping(address merchant => bool) public isMerchant;
    uint256 private _nextTokenId;

    event MerchantSet(address indexed merchant, bool allowed);
    event ToppedUp(uint256 indexed tokenId, address indexed from, uint256 amount);
    event Charged(uint256 indexed tokenId, address indexed merchant, uint256 amount, uint32 punches);
    event RewardEarned(uint256 indexed tokenId, uint32 rewards);
    event RewardRedeemed(uint256 indexed tokenId, address indexed merchant);
    event Withdrawn(uint256 indexed tokenId, address indexed to, uint256 amount);

    error CardUnknownMerchant(address merchant);
    error CardInsufficientBalance(uint256 tokenId, uint256 balance, uint256 amount);
    error CardNoReward(uint256 tokenId);
    error CardNotOwner(uint256 tokenId, address caller);
    error CardZeroAmount();
    error CardInvalidConfig();

    /// @param stablecoin_ The ERC-20 cards hold (for example a 6 decimal
    ///  stablecoin). Fee-on-transfer tokens are credited by amount received.
    /// @param perTxCap Maximum per charge, in stablecoin units.
    /// @param dailyCap Maximum charged per card per day, in stablecoin units.
    /// @param chargesPerDay Maximum charges per card per day.
    constructor(
        string memory passBaseURI_,
        address initialOwner,
        IERC20 stablecoin_,
        uint32 punchesPerReward_,
        uint128 perTxCap,
        uint128 dailyCap,
        uint32 chargesPerDay
    ) ERC721("Stored Value Card", "CARD") ERC721WalletPass(passBaseURI_) Ownable(initialOwner) {
        if (address(stablecoin_) == address(0) || punchesPerReward_ == 0) revert CardInvalidConfig();
        stablecoin = stablecoin_;
        punchesPerReward = punchesPerReward_;
        _configureAction(CHARGE, chargesPerDay, 1 days, perTxCap, dailyCap);
        _configureAction(REDEEM, chargesPerDay, 1 days, 0, 0);
        // The documented value bound is a commitment: tighten only.
        if (chargesPerDay != 0) _freezeActionBound(CHARGE);
    }

    // Issuer

    /// @notice Issue a new empty card to `to`.
    function mint(address to) external onlyOwner returns (uint256 tokenId) {
        tokenId = ++_nextTokenId;
        _mint(to, tokenId);
    }

    function setMerchant(address merchant, bool allowed) external onlyOwner {
        isMerchant[merchant] = allowed;
        emit MerchantSet(merchant, allowed);
    }

    function setPassBaseURI(string calldata newBase) external onlyOwner {
        _setPassBaseURI(newBase);
    }

    function setActionOperator(address operator, bool allowed) external onlyOwner {
        _setActionOperator(operator, allowed);
    }

    /// @notice Appoint an operator for one action only (for example a
    ///  terminal key that may CHARGE but not REDEEM).
    function setActionOperatorFor(address operator, bytes32 actionId, bool allowed) external onlyOwner {
        _setActionOperatorFor(operator, actionId, allowed);
    }

    /// @notice Lower the spending caps. The CHARGE bound is frozen at
    ///  deployment, so caps can only be tightened.
    function setChargeCaps(uint32 chargesPerDay, uint128 perTxCap, uint128 dailyCap) external onlyOwner {
        _configureAction(CHARGE, chargesPerDay, 1 days, perTxCap, dailyCap);
    }

    function freezeActionBound(bytes32 actionId) external onlyOwner {
        _freezeActionBound(actionId);
    }

    // Anyone

    /// @notice Add `amount` of stablecoin to card `tokenId`, pulled from the
    ///  caller (who must have approved this contract).
    function topUp(uint256 tokenId, uint256 amount) external nonReentrant {
        _requireOwned(tokenId);
        if (amount == 0) revert CardZeroAmount();
        uint256 before = stablecoin.balanceOf(address(this));
        stablecoin.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = stablecoin.balanceOf(address(this)) - before;
        _cards[tokenId].balance += received;
        emit ToppedUp(tokenId, msg.sender, received);
        _passUpdate(tokenId);
    }

    // Operator (pass-reachable, bounded)

    /// @notice Charge `amount` from card `tokenId` to a registered merchant
    ///  and punch the card. Operator only, within the CHARGE bound.
    function charge(uint256 tokenId, uint256 amount, address merchant)
        external
        nonReentrant
        onlyBoundedAction(CHARGE, tokenId, amount)
    {
        if (amount == 0) revert CardZeroAmount();
        if (!isMerchant[merchant]) revert CardUnknownMerchant(merchant);
        Card storage c = _cards[tokenId];
        if (c.balance < amount) revert CardInsufficientBalance(tokenId, c.balance, amount);

        c.balance -= amount;
        c.punches += 1;
        emit Charged(tokenId, merchant, amount, c.punches);
        if (c.punches >= punchesPerReward) {
            c.punches = 0;
            c.rewards += 1;
            emit RewardEarned(tokenId, c.rewards);
        }
        _passUpdate(tokenId);

        stablecoin.safeTransfer(merchant, amount);
    }

    /// @notice Redeem one earned reward at a registered merchant. No value
    ///  moves. Operator only, within the REDEEM bound.
    function redeemReward(uint256 tokenId, address merchant) external nonReentrant onlyBoundedAction(REDEEM, tokenId, 0) {
        if (!isMerchant[merchant]) revert CardUnknownMerchant(merchant);
        Card storage c = _cards[tokenId];
        if (c.rewards == 0) revert CardNoReward(tokenId);
        c.rewards -= 1;
        emit RewardRedeemed(tokenId, merchant);
        _passUpdate(tokenId);
    }

    // Owner only (signed path)

    /// @notice Withdraw `amount` from card `tokenId` to `to`. Only the token
    ///  owner may call it; operators never can. An ERC-721 approved account
    ///  cannot call it directly but can transfer the card to itself first, so
    ///  an approval exposes the balance.
    function withdraw(uint256 tokenId, uint256 amount, address to) external nonReentrant {
        if (ownerOf(tokenId) != msg.sender) revert CardNotOwner(tokenId, msg.sender);
        if (amount == 0) revert CardZeroAmount();
        Card storage c = _cards[tokenId];
        if (c.balance < amount) revert CardInsufficientBalance(tokenId, c.balance, amount);
        c.balance -= amount;
        emit Withdrawn(tokenId, to, amount);
        _passUpdate(tokenId);

        stablecoin.safeTransfer(to, amount);
    }

    // Views

    function card(uint256 tokenId) external view returns (Card memory) {
        _requireOwned(tokenId);
        return _cards[tokenId];
    }

    function balanceOfCard(uint256 tokenId) external view returns (uint256) {
        _requireOwned(tokenId);
        return _cards[tokenId].balance;
    }

    function _boundedActionOwner(uint256 tokenId) internal view override returns (address) {
        return _requireOwned(tokenId);
    }
}
