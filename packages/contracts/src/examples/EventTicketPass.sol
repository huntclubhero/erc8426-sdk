// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";

import {ERC721WalletPass} from "../ERC721WalletPass.sol";

/// @title EventTicketPass (example)
/// @notice Use case: event tickets that live in Apple Wallet and Google
///  Wallet. Each show reserves a consecutive block of token ids. Door staff
///  scan the pass and check the ticket in, once. After the show ends every
///  ticket for it becomes a keepsake, announced to pass distributors with a
///  single `BatchPassUpdate` over the show's id range. Resales pay royalties
///  through ERC-2981.
/// @dev Capability analysis (ERC-8426):
///
///  - `checkIn` is called by an account holding DOOR_ROLE after scanning the
///    pass. The pass barcode is a bearer artifact, so the door account's own
///    signature is what authorizes the transaction; the scan only selects
///    the ticket. Repetition is bounded by construction (once per ticket),
///    and check-in cannot transfer, burn or approve the ticket. A door app
///    should still take the fresh `ownerOf` read and compare it against the
///    holder it expects, for example the account that presented a signed
///    challenge at the door.
///  - `endShow` is permissionless after the show's end time: it changes no
///    ticket state (the keepsake phase is already implied by time) and only
///    emits the freshness signal, once.
///  - Transfer, approve and burn stay with the ticket owner (standard
///    ERC-721). Nothing here is reachable through a capability link.
///
///  The keepsake transition is time based. `phase` reports it as soon as
///  the show ends, even before anyone calls `endShow`; the event only tells
///  distributors to re-render.
contract EventTicketPass is ERC721WalletPass, ERC2981, AccessControl {
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant DOOR_ROLE = keccak256("DOOR_ROLE");

    enum Phase {
        Upcoming,
        CheckedIn,
        Keepsake
    }

    struct Show {
        uint64 startsAt;
        uint64 endsAt;
        uint256 firstTokenId;
        uint256 capacity;
        uint256 minted;
        bool ended;
    }

    mapping(uint256 showId => Show) private _shows;
    mapping(uint256 tokenId => uint256 showId) public showOf;
    mapping(uint256 tokenId => uint64) public checkedInAt;
    uint256 public showCount;
    uint256 private _nextReservedId = 1;

    event ShowCreated(uint256 indexed showId, uint64 startsAt, uint64 endsAt, uint256 firstTokenId, uint256 capacity);
    event CheckedIn(uint256 indexed tokenId, uint256 indexed showId, address indexed door);
    event ShowEnded(uint256 indexed showId);

    error TicketInvalidShow(uint256 showId);
    error TicketInvalidSchedule();
    error TicketSoldOut(uint256 showId);
    error TicketAlreadyCheckedIn(uint256 tokenId);
    error TicketShowOver(uint256 showId);
    error TicketShowNotOver(uint256 showId);
    error TicketShowAlreadyEnded(uint256 showId);

    constructor(string memory passBaseURI_, address admin, address royaltyReceiver, uint96 royaltyBps)
        ERC721("Event Ticket Pass", "TIX")
        ERC721WalletPass(passBaseURI_)
    {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ISSUER_ROLE, admin);
        _setDefaultRoyalty(royaltyReceiver, royaltyBps);
    }

    // Issuer

    /// @notice Create a show and reserve `capacity` consecutive token ids.
    function createShow(uint64 startsAt, uint64 endsAt, uint256 capacity)
        external
        onlyRole(ISSUER_ROLE)
        returns (uint256 showId)
    {
        if (endsAt <= startsAt || endsAt <= block.timestamp || capacity == 0) revert TicketInvalidSchedule();
        showId = ++showCount;
        uint256 first = _nextReservedId;
        _nextReservedId = first + capacity;
        _shows[showId] = Show(startsAt, endsAt, first, capacity, 0, false);
        emit ShowCreated(showId, startsAt, endsAt, first, capacity);
    }

    /// @notice Mint the next ticket of `showId` to `to`.
    function mintTicket(uint256 showId, address to) external onlyRole(ISSUER_ROLE) returns (uint256 tokenId) {
        Show storage s = _requireShow(showId);
        if (block.timestamp >= s.endsAt) revert TicketShowOver(showId);
        if (s.minted == s.capacity) revert TicketSoldOut(showId);
        tokenId = s.firstTokenId + s.minted;
        s.minted += 1;
        showOf[tokenId] = showId;
        _mint(to, tokenId);
    }

    function setPassBaseURI(string calldata newBase) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setPassBaseURI(newBase);
    }

    function setDefaultRoyalty(address receiver, uint96 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setDefaultRoyalty(receiver, bps);
    }

    // Door

    /// @notice Check ticket `tokenId` in. Once per ticket, before the show ends.
    function checkIn(uint256 tokenId) external onlyRole(DOOR_ROLE) {
        _requireOwned(tokenId);
        uint256 showId = showOf[tokenId];
        Show storage s = _shows[showId];
        if (block.timestamp >= s.endsAt) revert TicketShowOver(showId);
        if (checkedInAt[tokenId] != 0) revert TicketAlreadyCheckedIn(tokenId);
        checkedInAt[tokenId] = uint64(block.timestamp);
        emit CheckedIn(tokenId, showId, msg.sender);
        _passUpdate(tokenId);
    }

    // Anyone

    /// @notice After a show ends, signal once that every ticket for it is
    ///  now a keepsake, with one `BatchPassUpdate` over the minted range.
    function endShow(uint256 showId) external {
        Show storage s = _requireShow(showId);
        if (block.timestamp < s.endsAt) revert TicketShowNotOver(showId);
        if (s.ended) revert TicketShowAlreadyEnded(showId);
        s.ended = true;
        emit ShowEnded(showId);
        if (s.minted != 0) _batchPassUpdate(s.firstTokenId, s.firstTokenId + s.minted - 1);
    }

    // Views

    function show(uint256 showId) external view returns (Show memory) {
        return _requireShow(showId);
    }

    /// @notice The ticket's lifecycle phase, as the pass should render it.
    function phase(uint256 tokenId) external view returns (Phase) {
        _requireOwned(tokenId);
        Show storage s = _shows[showOf[tokenId]];
        if (block.timestamp >= s.endsAt || s.ended) return Phase.Keepsake;
        return checkedInAt[tokenId] != 0 ? Phase.CheckedIn : Phase.Upcoming;
    }

    /// @inheritdoc ERC721WalletPass
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721WalletPass, ERC2981, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    function _requireShow(uint256 showId) private view returns (Show storage s) {
        s = _shows[showId];
        if (s.capacity == 0) revert TicketInvalidShow(showId);
    }
}
