// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {PetPass} from "../src/examples/PetPass.sol";
import {BoundedAction} from "../src/utils/BoundedAction.sol";

contract PetPassTest is Test {
    event PassUpdate(uint256 indexed tokenId);
    event Cared(uint256 indexed tokenId, bytes32 indexed action, address indexed caller);

    PetPass internal pets;
    address internal issuer = makeAddr("issuer");
    address internal relayer = makeAddr("relayer");
    address internal holder = makeAddr("holder");
    address internal buyer = makeAddr("buyer");
    address internal stranger = makeAddr("stranger");
    uint256 internal constant LAPSE = 3 days;
    uint256 internal id;

    function setUp() public {
        vm.warp(1_700_000_000);
        pets = new PetPass("https://pets.example/wallet-pass/eip155/31337/0xPets/", issuer, LAPSE);
        vm.startPrank(issuer);
        pets.setActionOperator(relayer, true);
        id = pets.mint(holder);
        vm.stopPrank();
    }

    function test_MintHatchesAlivePet() public view {
        assertEq(pets.ownerOf(id), holder);
        assertTrue(pets.isAlive(id));
        assertEq(pets.diesAt(id), block.timestamp + LAPSE);
        (uint256 h, uint256 t, uint256 b) = pets.needs(id);
        assertEq(h + t + b, 0);
        assertTrue(pets.supportsInterface(0xef5f1e71));
        assertEq(pets.passURI(id), "https://pets.example/wallet-pass/eip155/31337/0xPets/1");
    }

    function test_OnlyIssuerMints() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        pets.mint(stranger);
    }

    function test_OperatorCaresAndEmits() public {
        vm.warp(block.timestamp + 1 hours);
        vm.expectEmit(true, true, true, true, address(pets));
        emit Cared(id, pets.FEED(), relayer);
        vm.expectEmit(true, false, false, true, address(pets));
        emit PassUpdate(id);
        vm.prank(relayer);
        pets.feed(id);

        PetPass.Pet memory p = pets.pet(id);
        assertEq(p.lastFed, block.timestamp);
        assertEq(p.cares, 1);
    }

    function test_EachCareUpdatesItsNeed() public {
        vm.warp(block.timestamp + 1 days);
        vm.startPrank(relayer);
        pets.water(id);
        pets.play(id);
        vm.stopPrank();
        (uint256 hunger, uint256 thirst, uint256 boredom) = pets.needs(id);
        assertEq(hunger, 33);
        assertEq(thirst, 0);
        assertEq(boredom, 0);
    }

    function test_OperatorRateLimited() public {
        vm.startPrank(relayer);
        for (uint256 i; i < 4; ++i) pets.feed(id);
        vm.expectRevert(
            abi.encodeWithSelector(
                BoundedAction.BoundedActionRateLimited.selector, id, pets.FEED(), block.timestamp + 1 days
            )
        );
        pets.feed(id);
        // Other actions have their own budget.
        pets.water(id);
        vm.stopPrank();
    }

    function test_OwnerSignedPathIsNotRateLimited() public {
        vm.startPrank(holder);
        for (uint256 i; i < 10; ++i) pets.feed(id);
        vm.stopPrank();
        assertEq(pets.pet(id).cares, 10);
        (uint32 count,,) = pets.actionUsage(id, pets.FEED());
        assertEq(count, 0);
    }

    function test_StrangerCannotCare() public {
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionUnauthorizedOperator.selector, stranger));
        vm.prank(stranger);
        pets.feed(id);
    }

    function test_OperatorCannotTransferOrApprove() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, relayer, id));
        vm.prank(relayer);
        pets.transferFrom(holder, relayer, id);

        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidApprover.selector, relayer));
        vm.prank(relayer);
        pets.approve(relayer, id);
    }

    function test_OwnerRevokesOperator() public {
        vm.prank(holder);
        pets.setOperatorRevoked(id, relayer, true);
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionOperatorRevoked.selector, id, relayer));
        vm.prank(relayer);
        pets.feed(id);
    }

    function test_PetDiesAfterLapse() public {
        vm.warp(block.timestamp + LAPSE);
        assertTrue(pets.isAlive(id));
        vm.warp(block.timestamp + 1);
        assertFalse(pets.isAlive(id));
        (uint256 hunger,,) = pets.needs(id);
        assertEq(hunger, 100);

        vm.expectRevert(abi.encodeWithSelector(PetPass.PetIsDead.selector, id));
        vm.prank(relayer);
        pets.feed(id);
        vm.expectRevert(abi.encodeWithSelector(PetPass.PetIsDead.selector, id));
        vm.prank(holder);
        pets.feed(id);
    }

    function test_OneNeglectedNeedKills() public {
        // Feed and water daily, never play.
        for (uint256 d; d < 3; ++d) {
            vm.warp(block.timestamp + 1 days);
            vm.startPrank(relayer);
            pets.feed(id);
            pets.water(id);
            vm.stopPrank();
        }
        vm.warp(block.timestamp + 1);
        assertFalse(pets.isAlive(id));
    }

    function test_CareExtendsLife() public {
        vm.warp(block.timestamp + 2 days);
        vm.startPrank(relayer);
        pets.feed(id);
        pets.water(id);
        pets.play(id);
        vm.stopPrank();
        vm.warp(block.timestamp + 2 days);
        assertTrue(pets.isAlive(id));
    }

    function test_TransferEmitsPassUpdateAndNewOwnerFresh() public {
        vm.prank(holder);
        pets.setOperatorRevoked(id, relayer, true);
        vm.expectEmit(true, false, false, true, address(pets));
        emit PassUpdate(id);
        vm.prank(holder);
        pets.transferFrom(holder, buyer, id);
        vm.prank(relayer);
        pets.feed(id);
    }

    function test_ConfigureActionIssuerOnlyAndKnownActions() public {
        bytes32 feedId = pets.FEED();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        pets.configureAction(feedId, 10, 1 days);

        vm.expectRevert(abi.encodeWithSelector(PetPass.PetUnknownAction.selector, keccak256("X")));
        vm.prank(issuer);
        pets.configureAction(keccak256("X"), 1, 1);

        vm.startPrank(issuer);
        pets.configureAction(feedId, 1, 1 hours);
        pets.freezeActionBound(feedId);
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionBoundFrozen.selector, feedId));
        pets.configureAction(feedId, 2, 1 hours);
        vm.stopPrank();
    }

    function test_RejectsZeroLapse() public {
        vm.expectRevert(PetPass.PetInvalidLapse.selector);
        new PetPass("", issuer, 0);
    }

    function test_ViewsRevertForNonexistent() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 99));
        pets.isAlive(99);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 99));
        pets.passURI(99);
    }
}
