// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import {ERC721WalletPass} from "../ERC721WalletPass.sol";
import {BoundedAction} from "../utils/BoundedAction.sol";

/// @title PetPass (example)
/// @notice Use case: a WALLETCHI-style care game. Each token is a pet that
///  lives on a wallet pass. The pet has three needs (food, water, play); if
///  any need goes unmet for `lapseSeconds`, the pet dies. The back of the
///  pass carries Feed, Water and Play links.
/// @dev Capability analysis (ERC-8426, "The capability configuration"):
///
///  Pass-reachable through a capability link, via the issuer operator:
///  - `feed`, `water`, `play`. These are sound for the capability
///    configuration because they cannot transfer, burn or approve the token,
///    cannot change who is entitled to it, move no value (the action bounds
///    are configured with zero value caps), and their repetition is bounded
///    on chain by `BoundedAction` (by default 4 cares of each kind per token
///    per day). The worst a forwarded link can do is care for the pet, a
///    few times a day, until the owner rotates the link or calls
///    `setOperatorRevoked`.
///
///  Needs the owner's own signed transaction:
///  - transfer, approve, burn (standard ERC-721, never pass-reachable);
///  - `setAllOperatorsRevoked` / `setOperatorRevoked`, the owner's on-chain
///    remedy (the first also covers relayers the issuer appoints later).
///  The owner (or an approved account) may also call the care functions
///  directly; that signed path is not rate limited, because it carries the
///  owner's own authority rather than a bearer link's.
///
///  Death is passive: it happens when time passes, with no transaction and
///  so no event. Render the deadline as a relative date on the pass so the
///  device counts it down between pushes.
contract PetPass is ERC721WalletPass, BoundedAction, Ownable {
    bytes32 public constant FEED = keccak256("FEED");
    bytes32 public constant WATER = keccak256("WATER");
    bytes32 public constant PLAY = keccak256("PLAY");

    struct Pet {
        uint64 lastFed;
        uint64 lastWatered;
        uint64 lastPlayed;
        uint32 cares;
    }

    /// @notice Seconds a need may go unmet before the pet dies.
    uint256 public immutable lapseSeconds;

    mapping(uint256 tokenId => Pet) private _pets;
    uint256 private _nextTokenId;

    /// @notice Emitted on every care, alongside `PassUpdate`.
    event Cared(uint256 indexed tokenId, bytes32 indexed action, address indexed caller);

    error PetIsDead(uint256 tokenId);
    error PetUnknownAction(bytes32 action);
    error PetInvalidLapse();

    constructor(string memory passBaseURI_, address initialOwner, uint256 lapseSeconds_)
        ERC721("Pet Pass", "PET")
        ERC721WalletPass(passBaseURI_)
        Ownable(initialOwner)
    {
        if (lapseSeconds_ == 0) revert PetInvalidLapse();
        lapseSeconds = lapseSeconds_;
        // Default documented bound: 4 of each care per token per day, no value.
        _configureAction(FEED, 4, 1 days, 0, 0);
        _configureAction(WATER, 4, 1 days, 0, 0);
        _configureAction(PLAY, 4, 1 days, 0, 0);
    }

    // Issuer

    /// @notice Hatch a new pet for `to`. Every need starts satisfied.
    function mint(address to) external onlyOwner returns (uint256 tokenId) {
        tokenId = ++_nextTokenId;
        uint64 nowTs = uint64(block.timestamp);
        _pets[tokenId] = Pet(nowTs, nowTs, nowTs, 0);
        _mint(to, tokenId);
    }

    function setPassBaseURI(string calldata newBase) external onlyOwner {
        _setPassBaseURI(newBase);
    }

    function setActionOperator(address operator, bool allowed) external onlyOwner {
        _setActionOperator(operator, allowed);
    }

    /// @notice Appoint an operator for one care action only.
    function setActionOperatorFor(address operator, bytes32 actionId, bool allowed) external onlyOwner {
        _setActionOperatorFor(operator, actionId, allowed);
    }

    function configureAction(bytes32 actionId, uint32 maxPerWindow, uint32 windowSeconds) external onlyOwner {
        if (actionId != FEED && actionId != WATER && actionId != PLAY) revert PetUnknownAction(actionId);
        _configureAction(actionId, maxPerWindow, windowSeconds, 0, 0);
    }

    function freezeActionBound(bytes32 actionId) external onlyOwner {
        _freezeActionBound(actionId);
    }

    // Care (pass-reachable)

    function feed(uint256 tokenId) external {
        _care(tokenId, FEED);
    }

    function water(uint256 tokenId) external {
        _care(tokenId, WATER);
    }

    function play(uint256 tokenId) external {
        _care(tokenId, PLAY);
    }

    // Views

    function pet(uint256 tokenId) external view returns (Pet memory) {
        _requireOwned(tokenId);
        return _pets[tokenId];
    }

    /// @notice Whether every need was met within `lapseSeconds`.
    function isAlive(uint256 tokenId) public view returns (bool) {
        _requireOwned(tokenId);
        return block.timestamp <= diesAt(tokenId);
    }

    /// @notice The timestamp after which the pet is dead unless cared for.
    function diesAt(uint256 tokenId) public view returns (uint256) {
        Pet memory p = _pets[tokenId];
        uint256 oldest = p.lastFed;
        if (p.lastWatered < oldest) oldest = p.lastWatered;
        if (p.lastPlayed < oldest) oldest = p.lastPlayed;
        return oldest + lapseSeconds;
    }

    /// @notice Need levels from 0 (just met) to 100 (lapsed), for rendering.
    function needs(uint256 tokenId) external view returns (uint256 hunger, uint256 thirst, uint256 boredom) {
        _requireOwned(tokenId);
        Pet memory p = _pets[tokenId];
        return (_level(p.lastFed), _level(p.lastWatered), _level(p.lastPlayed));
    }

    // Internals

    function _care(uint256 tokenId, bytes32 action) internal {
        address holder = _requireOwned(tokenId);
        // Owner or approved account: the signed path, not rate limited.
        // Anyone else must be an operator within the action's bound.
        if (!_isAuthorized(holder, msg.sender, tokenId)) {
            _consumeBoundedAction(action, tokenId, msg.sender, 0);
        }
        if (block.timestamp > diesAt(tokenId)) revert PetIsDead(tokenId);

        Pet storage p = _pets[tokenId];
        uint64 nowTs = uint64(block.timestamp);
        if (action == FEED) p.lastFed = nowTs;
        else if (action == WATER) p.lastWatered = nowTs;
        else p.lastPlayed = nowTs;
        p.cares += 1;

        emit Cared(tokenId, action, msg.sender);
        _passUpdate(tokenId);
    }

    function _level(uint64 last) private view returns (uint256) {
        uint256 elapsed = block.timestamp - last;
        return elapsed >= lapseSeconds ? 100 : (elapsed * 100) / lapseSeconds;
    }

    function _boundedActionOwner(uint256 tokenId) internal view override returns (address) {
        return _requireOwned(tokenId);
    }
}
