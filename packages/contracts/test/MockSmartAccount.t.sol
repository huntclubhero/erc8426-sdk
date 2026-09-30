// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {MockSmartAccount} from "../src/mocks/MockSmartAccount.sol";
import {MockERC721} from "../src/mocks/MockERC721.sol";

contract MockSmartAccountTest is Test {
    bytes4 internal constant MAGIC = 0x1626ba7e;

    MockSmartAccount internal account;
    MockERC721 internal nfts;
    address internal signer;
    uint256 internal signerKey;
    address internal other;
    uint256 internal otherKey;

    function setUp() public {
        (signer, signerKey) = makeAddrAndKey("signer");
        (other, otherKey) = makeAddrAndKey("other");
        account = new MockSmartAccount(signer);
        nfts = new MockERC721("Pets", "PET");
    }

    function _sign(uint256 key, bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, hash);
        return abi.encodePacked(r, s, v);
    }

    /// The hash a verifier passes for a personal_sign message (EIP-191).
    function _messageHash(string memory message) internal pure returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(bytes(message));
    }

    function test_ValidSignatureFromSigner() public view {
        bytes32 hash = _messageHash("issuer.example wants you to sign in");
        assertEq(account.isValidSignature(hash, _sign(signerKey, hash)), MAGIC);
    }

    function test_RejectsOtherSigner() public view {
        bytes32 hash = _messageHash("issuer.example wants you to sign in");
        assertEq(account.isValidSignature(hash, _sign(otherKey, hash)), bytes4(0xffffffff));
    }

    function test_RejectsSignatureOverAnotherHash() public view {
        bytes32 hash = _messageHash("one");
        assertEq(account.isValidSignature(_messageHash("two"), _sign(signerKey, hash)), bytes4(0xffffffff));
    }

    function test_RejectsMalformedSignature() public view {
        assertEq(account.isValidSignature(_messageHash("x"), hex"deadbeef"), bytes4(0xffffffff));
        assertEq(account.isValidSignature(_messageHash("x"), ""), bytes4(0xffffffff));
    }

    function testFuzz_OnlySignerValidates(uint256 key, bytes32 hash) public view {
        key = bound(key, 1, 115792089237316195423570985008687907852837564279074904382605163141518161494336);
        bytes4 result = account.isValidSignature(hash, _sign(key, hash));
        assertEq(result, vm.addr(key) == signer ? MAGIC : bytes4(0xffffffff));
    }

    function test_ReceivesAndHoldsErc721() public {
        uint256 id = nfts.mint(other);
        vm.prank(other);
        nfts.safeTransferFrom(other, address(account), id);
        assertEq(nfts.ownerOf(id), address(account));
    }

    function test_SignerExecutes() public {
        uint256 id = nfts.mint(address(account));
        vm.prank(signer);
        account.execute(address(nfts), 0, abi.encodeCall(nfts.transferFrom, (address(account), other, id)));
        assertEq(nfts.ownerOf(id), other);
    }

    function test_OnlySignerExecutes() public {
        uint256 id = nfts.mint(address(account));
        vm.expectRevert(abi.encodeWithSelector(MockSmartAccount.MockSmartAccountNotSigner.selector, other));
        vm.prank(other);
        account.execute(address(nfts), 0, abi.encodeCall(nfts.transferFrom, (address(account), other, id)));
    }

    function test_ExecuteBubblesFailure() public {
        vm.prank(signer);
        vm.expectRevert();
        account.execute(address(nfts), 0, abi.encodeCall(nfts.transferFrom, (address(account), other, 999)));
    }

    function test_ExecuteForwardsValueAndReceivesEth() public {
        vm.deal(address(account), 1 ether);
        vm.prank(signer);
        account.execute(other, 0.4 ether, "");
        assertEq(other.balance, 0.4 ether);
        (bool ok,) = address(account).call{value: 1}("");
        assertTrue(ok);
    }
}
