// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IERC1155WalletPass} from "../src/IERC1155WalletPass.sol";
import {ERC1155WalletPass} from "../src/ERC1155WalletPass.sol";
import {EditionPass} from "../src/examples/EditionPass.sol";

contract EditionPassTest is Test {
    EditionPass internal edition;
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant ID = 1;

    function setUp() public {
        edition = new EditionPass("https://meta.example/{id}.json", "https://issuer.example/wallet-pass/", owner, 3);
        vm.prank(owner);
        edition.setOpen(ID, true);
    }

    function test_supportsTheWalletPassInterfaceAndERC1155() public view {
        assertTrue(edition.supportsInterface(type(IERC1155WalletPass).interfaceId));
        assertTrue(edition.supportsInterface(0xef5f1e71));
        assertTrue(edition.supportsInterface(0xd9b67a26));
        assertFalse(edition.supportsInterface(0x80ac58cd));
    }

    function test_anyoneClaimsUpToTheLimit() public {
        vm.prank(alice);
        edition.claim(ID, 2);
        vm.prank(alice);
        edition.claim(ID, 1);
        assertEq(edition.balanceOf(alice, ID), 3);
        assertEq(edition.claimed(ID, alice), 3);

        vm.expectRevert(abi.encodeWithSelector(EditionPass.EditionPassClaimLimit.selector, ID, alice, 3, 1));
        vm.prank(alice);
        edition.claim(ID, 1);
    }

    function test_claimingNothingReverts() public {
        vm.expectRevert(abi.encodeWithSelector(EditionPass.EditionPassClaimLimit.selector, ID, alice, 0, 0));
        vm.prank(alice);
        edition.claim(ID, 0);
    }

    function test_theLimitCountsClaimsNotUnitsHeld() public {
        vm.prank(alice);
        edition.claim(ID, 3);
        vm.prank(alice);
        edition.safeTransferFrom(alice, bob, ID, 3, "");
        // Sending the units away does not buy more claims.
        vm.expectRevert(abi.encodeWithSelector(EditionPass.EditionPassClaimLimit.selector, ID, alice, 3, 1));
        vm.prank(alice);
        edition.claim(ID, 1);
        // Receiving units does not use the receiver's claims.
        vm.prank(bob);
        edition.claim(ID, 3);
        assertEq(edition.balanceOf(bob, ID), 6);
    }

    function test_aClosedIdCannotBeClaimed() public {
        vm.expectRevert(abi.encodeWithSelector(EditionPass.EditionPassClosed.selector, 2));
        vm.prank(alice);
        edition.claim(2, 1);

        vm.prank(alice);
        edition.claim(ID, 1);
        vm.prank(owner);
        edition.setOpen(ID, false);
        vm.expectRevert(abi.encodeWithSelector(EditionPass.EditionPassClosed.selector, ID));
        vm.prank(bob);
        edition.claim(ID, 1);
        // Closing leaves what is held alone.
        assertEq(edition.balanceOf(alice, ID), 1);
    }

    function test_passURIFollowsSupply() public {
        vm.expectRevert(abi.encodeWithSelector(ERC1155WalletPass.ERC1155WalletPassNonexistentId.selector, ID));
        edition.passURI(ID);
        vm.prank(alice);
        edition.claim(ID, 1);
        assertEq(edition.passURI(ID), "https://issuer.example/wallet-pass/1");
    }

    function test_onlyTheOwnerOpensAnnouncesAndSetsTheBase() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        edition.setOpen(2, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        edition.announce(ID);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        edition.setPassBaseURI("https://evil.example/");
        vm.stopPrank();

        vm.expectEmit(true, false, false, false);
        emit IERC1155WalletPass.PassUpdate(ID);
        vm.prank(owner);
        edition.announce(ID);
    }

    function test_aTransferDoesNotAnnounceToEveryHolder() public {
        vm.prank(alice);
        edition.claim(ID, 2);
        vm.recordLogs();
        vm.prank(alice);
        edition.safeTransferFrom(alice, bob, ID, 1, "");
        // TransferSingle only.
        assertEq(vm.getRecordedLogs().length, 1);
    }
}
