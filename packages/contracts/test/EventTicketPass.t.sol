// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {EventTicketPass} from "../src/examples/EventTicketPass.sol";

contract EventTicketPassTest is Test {
    event PassUpdate(uint256 indexed tokenId);
    event BatchPassUpdate(uint256 fromTokenId, uint256 toTokenId);
    event CheckedIn(uint256 indexed tokenId, uint256 indexed showId, address indexed door);

    EventTicketPass internal tix;
    address internal admin = makeAddr("admin");
    address internal door = makeAddr("door");
    address internal fan = makeAddr("fan");
    address internal fan2 = makeAddr("fan2");
    address internal royalties = makeAddr("royalties");
    address internal stranger = makeAddr("stranger");

    uint64 internal startsAt;
    uint64 internal endsAt;
    uint256 internal showId;

    function setUp() public {
        vm.warp(1_700_000_000);
        tix = new EventTicketPass("https://tix.example/", admin, royalties, 500);
        startsAt = uint64(block.timestamp + 7 days);
        endsAt = startsAt + 4 hours;
        vm.startPrank(admin);
        tix.grantRole(tix.DOOR_ROLE(), door);
        showId = tix.createShow(startsAt, endsAt, 100);
        vm.stopPrank();
    }

    function _mint(address to) internal returns (uint256) {
        vm.prank(admin);
        return tix.mintTicket(showId, to);
    }

    function test_Interfaces() public view {
        assertTrue(tix.supportsInterface(0xef5f1e71)); // ERC-8426
        assertTrue(tix.supportsInterface(0x2a55205a)); // ERC-2981
        assertTrue(tix.supportsInterface(0x7965db0b)); // AccessControl
        assertTrue(tix.supportsInterface(0x80ac58cd)); // ERC-721
    }

    function test_RoyaltyInfo() public view {
        (address receiver, uint256 amount) = tix.royaltyInfo(1, 1 ether);
        assertEq(receiver, royalties);
        assertEq(amount, 0.05 ether);
    }

    function test_ShowReservesConsecutiveIds() public {
        vm.prank(admin);
        uint256 show2 = tix.createShow(startsAt, endsAt, 10);
        assertEq(tix.show(showId).firstTokenId, 1);
        assertEq(tix.show(show2).firstTokenId, 101);
        vm.prank(admin);
        uint256 t = tix.mintTicket(show2, fan);
        assertEq(t, 101);
        assertEq(tix.showOf(t), show2);
    }

    function test_CreateShowValidation() public {
        vm.startPrank(admin);
        vm.expectRevert(EventTicketPass.TicketInvalidSchedule.selector);
        tix.createShow(endsAt, startsAt, 1);
        vm.expectRevert(EventTicketPass.TicketInvalidSchedule.selector);
        tix.createShow(startsAt, endsAt, 0);
        vm.expectRevert(EventTicketPass.TicketInvalidSchedule.selector);
        tix.createShow(0, uint64(block.timestamp), 1);
        vm.stopPrank();
    }

    function test_OnlyIssuerCreatesAndMints() public {
        bytes32 role = tix.ISSUER_ROLE();
        vm.startPrank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        tix.createShow(startsAt, endsAt, 1);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        tix.mintTicket(showId, stranger);
        vm.stopPrank();
    }

    function test_SoldOut() public {
        vm.prank(admin);
        uint256 small = tix.createShow(startsAt, endsAt, 1);
        vm.startPrank(admin);
        tix.mintTicket(small, fan);
        vm.expectRevert(abi.encodeWithSelector(EventTicketPass.TicketSoldOut.selector, small));
        tix.mintTicket(small, fan);
        vm.stopPrank();
    }

    function test_CheckInOnceAndPhases() public {
        uint256 t = _mint(fan);
        assertEq(uint8(tix.phase(t)), uint8(EventTicketPass.Phase.Upcoming));

        vm.warp(startsAt);
        vm.expectEmit(true, true, true, true, address(tix));
        emit CheckedIn(t, showId, door);
        vm.expectEmit(true, false, false, true, address(tix));
        emit PassUpdate(t);
        vm.prank(door);
        tix.checkIn(t);
        assertEq(uint8(tix.phase(t)), uint8(EventTicketPass.Phase.CheckedIn));

        vm.expectRevert(abi.encodeWithSelector(EventTicketPass.TicketAlreadyCheckedIn.selector, t));
        vm.prank(door);
        tix.checkIn(t);

        vm.warp(endsAt);
        assertEq(uint8(tix.phase(t)), uint8(EventTicketPass.Phase.Keepsake));
    }

    function test_OnlyDoorChecksIn() public {
        uint256 t = _mint(fan);
        bytes32 role = tix.DOOR_ROLE();
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, fan, role));
        vm.prank(fan);
        tix.checkIn(t);
    }

    function test_NoCheckInAfterShow() public {
        uint256 t = _mint(fan);
        vm.warp(endsAt);
        vm.expectRevert(abi.encodeWithSelector(EventTicketPass.TicketShowOver.selector, showId));
        vm.prank(door);
        tix.checkIn(t);
        vm.expectRevert(abi.encodeWithSelector(EventTicketPass.TicketShowOver.selector, showId));
        vm.prank(admin);
        tix.mintTicket(showId, fan);
    }

    function test_CheckInNonexistent() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 5));
        vm.prank(door);
        tix.checkIn(5);
    }

    function test_UncheckedTicketBecomesKeepsake() public {
        uint256 t = _mint(fan);
        vm.warp(endsAt + 1);
        assertEq(uint8(tix.phase(t)), uint8(EventTicketPass.Phase.Keepsake));
    }

    function test_EndShowEmitsBatchOverMintedRange() public {
        _mint(fan);
        _mint(fan2);
        _mint(fan);
        vm.expectRevert(abi.encodeWithSelector(EventTicketPass.TicketShowNotOver.selector, showId));
        tix.endShow(showId);

        vm.warp(endsAt);
        vm.expectEmit(false, false, false, true, address(tix));
        emit BatchPassUpdate(1, 3);
        vm.prank(stranger); // permissionless
        tix.endShow(showId);

        vm.expectRevert(abi.encodeWithSelector(EventTicketPass.TicketShowAlreadyEnded.selector, showId));
        tix.endShow(showId);
    }

    function test_EndShowWithNoTicketsEmitsNoBatch() public {
        vm.warp(endsAt);
        vm.recordLogs();
        tix.endShow(showId);
        assertEq(vm.getRecordedLogs().length, 1); // ShowEnded only
    }

    function test_EndUnknownShow() public {
        vm.expectRevert(abi.encodeWithSelector(EventTicketPass.TicketInvalidShow.selector, 9));
        tix.endShow(9);
    }

    function test_DoorCannotMoveTickets() public {
        uint256 t = _mint(fan);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, door, t));
        vm.prank(door);
        tix.transferFrom(fan, door, t);
    }

    function test_ResaleEmitsPassUpdate() public {
        uint256 t = _mint(fan);
        vm.expectEmit(true, false, false, true, address(tix));
        emit PassUpdate(t);
        vm.prank(fan);
        tix.transferFrom(fan, fan2, t);
    }
}
