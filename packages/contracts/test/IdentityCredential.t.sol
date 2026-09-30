// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {IdentityCredential} from "../src/examples/IdentityCredential.sol";
import {IERC5192} from "../src/interfaces/IERC5192.sol";

contract IdentityCredentialTest is Test {
    event PassUpdate(uint256 indexed tokenId);
    event Locked(uint256 tokenId);
    event PassRotationRequested(uint256 indexed tokenId, address indexed holder);

    IdentityCredential internal ids;
    address internal attester = makeAddr("attester");
    address internal holder = makeAddr("holder");
    address internal other = makeAddr("other");
    bytes32 internal constant CLAIM = keccak256("over-18:v1:salt");
    uint256 internal id;
    uint64 internal expiresAt;

    function setUp() public {
        vm.warp(1_700_000_000);
        ids = new IdentityCredential("https://id.example/", attester);
        expiresAt = uint64(block.timestamp + 365 days);
        vm.prank(attester);
        id = ids.issue(holder, CLAIM, expiresAt);
    }

    function test_Interfaces() public view {
        assertEq(type(IERC5192).interfaceId, bytes4(0xb45a3c0e));
        assertTrue(ids.supportsInterface(0xb45a3c0e));
        assertTrue(ids.supportsInterface(0xef5f1e71));
        assertTrue(ids.supportsInterface(0x7965db0b));
    }

    function test_IssueEmitsLockedAndPassUpdate() public {
        vm.expectEmit(true, false, false, true, address(ids));
        emit PassUpdate(2);
        vm.expectEmit(false, false, false, true, address(ids));
        emit Locked(2);
        vm.prank(attester);
        ids.issue(other, CLAIM, expiresAt);
        assertTrue(ids.locked(2));
    }

    function test_CredentialData() public view {
        IdentityCredential.Credential memory c = ids.credential(id);
        assertEq(c.claimHash, CLAIM);
        assertEq(c.expiresAt, expiresAt);
        assertEq(c.attester, attester);
        assertFalse(c.revoked);
        assertTrue(ids.isValid(id));
    }

    function test_OnlyAttesterIssues() public {
        bytes32 role = ids.ATTESTER_ROLE();
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, holder, role));
        vm.prank(holder);
        ids.issue(holder, CLAIM, expiresAt);
    }

    function test_IssueRejectsPastExpiry() public {
        vm.expectRevert(IdentityCredential.CredentialInvalidExpiry.selector);
        vm.prank(attester);
        ids.issue(other, CLAIM, uint64(block.timestamp));
    }

    function test_TransfersRevert() public {
        vm.startPrank(holder);
        vm.expectRevert(abi.encodeWithSelector(IdentityCredential.CredentialSoulbound.selector, id));
        ids.transferFrom(holder, other, id);
        vm.expectRevert(abi.encodeWithSelector(IdentityCredential.CredentialSoulbound.selector, id));
        ids.safeTransferFrom(holder, other, id);
        vm.stopPrank();
    }

    function test_ApprovalsRevert() public {
        vm.startPrank(holder);
        vm.expectRevert(abi.encodeWithSelector(IdentityCredential.CredentialSoulbound.selector, id));
        ids.approve(other, id);
        vm.expectRevert(abi.encodeWithSelector(IdentityCredential.CredentialSoulbound.selector, 0));
        ids.setApprovalForAll(other, true);
        vm.stopPrank();
    }

    function test_RevokeFlagsAndEmits() public {
        vm.expectEmit(true, false, false, true, address(ids));
        emit PassUpdate(id);
        vm.prank(attester);
        ids.revoke(id);
        assertFalse(ids.isValid(id));
        assertEq(ids.ownerOf(id), holder); // record survives

        vm.expectRevert(abi.encodeWithSelector(IdentityCredential.CredentialAlreadyRevoked.selector, id));
        vm.prank(attester);
        ids.revoke(id);
        vm.expectRevert(abi.encodeWithSelector(IdentityCredential.CredentialAlreadyRevoked.selector, id));
        vm.prank(attester);
        ids.extend(id, expiresAt + 1);
    }

    function test_HolderCannotRevokeOrExtend() public {
        bytes32 role = ids.ATTESTER_ROLE();
        vm.startPrank(holder);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, holder, role));
        ids.revoke(id);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, holder, role));
        ids.extend(id, expiresAt + 1);
        vm.stopPrank();
    }

    function test_ExpiryAndExtend() public {
        vm.warp(expiresAt);
        assertFalse(ids.isValid(id));
        vm.expectRevert(IdentityCredential.CredentialInvalidExpiry.selector);
        vm.prank(attester);
        ids.extend(id, expiresAt);

        vm.expectEmit(true, false, false, true, address(ids));
        emit PassUpdate(id);
        vm.prank(attester);
        ids.extend(id, expiresAt + 30 days);
        assertTrue(ids.isValid(id));
    }

    function test_HolderRenounces() public {
        vm.expectRevert(abi.encodeWithSelector(IdentityCredential.CredentialNotHolder.selector, id, other));
        vm.prank(other);
        ids.renounce(id);

        vm.expectEmit(true, false, false, true, address(ids));
        emit PassUpdate(id);
        vm.prank(holder);
        ids.renounce(id);
        assertFalse(ids.isValid(id));
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, id));
        ids.locked(id);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, id));
        ids.passURI(id);
    }

    function test_RequestPassRotation() public {
        vm.expectEmit(true, true, false, true, address(ids));
        emit PassRotationRequested(id, holder);
        vm.expectEmit(true, false, false, true, address(ids));
        emit PassUpdate(id);
        vm.prank(holder);
        ids.requestPassRotation(id);

        vm.expectRevert(abi.encodeWithSelector(IdentityCredential.CredentialNotHolder.selector, id, other));
        vm.prank(other);
        ids.requestPassRotation(id);
    }

    function test_IsValidFalseForNonexistent() public view {
        assertFalse(ids.isValid(999));
    }
}
