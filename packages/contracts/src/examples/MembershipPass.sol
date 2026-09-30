// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import {ERC721WalletPass} from "../ERC721WalletPass.sol";

/// @title MembershipPass (example)
/// @notice Use case: a tiered, expiring membership card (a gym, a club, a
///  subscription). The pass shows tier and expiry. Anyone can pay to renew a
///  membership (a gift works too); the issuer can grant time or change a
///  member's tier. Every renewal and tier change emits `PassUpdate`.
/// @dev Capability analysis (ERC-8426):
///
///  - `renew` needs no special authorization: the caller pays, and the only
///    effect is to extend someone else's membership. A pass link can open a
///    renew page, but the payer's wallet signs the payment, so this is the
///    signed path, and it cannot transfer, burn or approve the token.
///  - `issuerRenew` and `setTier` are issuer only (contract owner).
///  - Transfer, approve and burn stay with the member (standard ERC-721).
///  Nothing here is reachable through a capability link, so no operator or
///  `BoundedAction` is needed.
///
///  Expiry is passive: a membership lapses when time passes, with no
///  transaction and no event. Render the expiry as a relative date on the
///  pass; `isActive` gives verifiers the correct answer at request time.
contract MembershipPass is ERC721WalletPass, Ownable {
    /// @notice Length of one paid period.
    uint64 public constant PERIOD = 30 days;

    /// @notice Price per period, in wei, for each tier. Zero means the tier
    ///  cannot be bought or renewed by payment.
    mapping(uint8 tier => uint256) public tierPrice;

    struct Membership {
        uint8 tier;
        uint64 expiresAt;
    }

    mapping(uint256 tokenId => Membership) private _memberships;
    uint256 private _nextTokenId;

    event TierPriceSet(uint8 indexed tier, uint256 pricePerPeriod);
    event Renewed(uint256 indexed tokenId, address indexed payer, uint64 expiresAt);
    event TierChanged(uint256 indexed tokenId, uint8 tier);

    error MembershipTierNotForSale(uint8 tier);
    error MembershipWrongPayment(uint256 expected, uint256 received);
    error MembershipZeroPeriods();

    constructor(string memory passBaseURI_, address initialOwner)
        ERC721("Membership Pass", "MEMBER")
        ERC721WalletPass(passBaseURI_)
        Ownable(initialOwner)
    {}

    // Issuer

    function setTierPrice(uint8 tier, uint256 pricePerPeriod) external onlyOwner {
        tierPrice[tier] = pricePerPeriod;
        emit TierPriceSet(tier, pricePerPeriod);
    }

    /// @notice Grant a new membership of `tier` lasting `duration` seconds.
    function grant(address to, uint8 tier, uint64 duration) external onlyOwner returns (uint256 tokenId) {
        tokenId = ++_nextTokenId;
        _memberships[tokenId] = Membership(tier, uint64(block.timestamp) + duration);
        _mint(to, tokenId);
    }

    /// @notice Add `duration` seconds to a membership without payment.
    function issuerRenew(uint256 tokenId, uint64 duration) external onlyOwner {
        _requireOwned(tokenId);
        _extend(tokenId, duration);
    }

    function setTier(uint256 tokenId, uint8 tier) external onlyOwner {
        _requireOwned(tokenId);
        _memberships[tokenId].tier = tier;
        emit TierChanged(tokenId, tier);
        _passUpdate(tokenId);
    }

    function setPassBaseURI(string calldata newBase) external onlyOwner {
        _setPassBaseURI(newBase);
    }

    /// @notice Send collected payments to `to`.
    function withdrawProceeds(address payable to) external onlyOwner {
        Address.sendValue(to, address(this).balance);
    }

    // Anyone

    /// @notice Pay for `periods` more periods at the membership's tier price.
    ///  Extends from the current expiry, or from now if already lapsed.
    function renew(uint256 tokenId, uint64 periods) external payable {
        _requireOwned(tokenId);
        if (periods == 0) revert MembershipZeroPeriods();
        uint8 tier = _memberships[tokenId].tier;
        uint256 price = tierPrice[tier];
        if (price == 0) revert MembershipTierNotForSale(tier);
        uint256 expected = price * periods;
        if (msg.value != expected) revert MembershipWrongPayment(expected, msg.value);
        _extend(tokenId, PERIOD * periods);
    }

    // Views

    function membership(uint256 tokenId) external view returns (Membership memory) {
        _requireOwned(tokenId);
        return _memberships[tokenId];
    }

    function isActive(uint256 tokenId) external view returns (bool) {
        _requireOwned(tokenId);
        return block.timestamp < _memberships[tokenId].expiresAt;
    }

    function _extend(uint256 tokenId, uint64 duration) private {
        Membership storage m = _memberships[tokenId];
        uint64 from = m.expiresAt > block.timestamp ? m.expiresAt : uint64(block.timestamp);
        m.expiresAt = from + duration;
        emit Renewed(tokenId, msg.sender, m.expiresAt);
        _passUpdate(tokenId);
    }
}
