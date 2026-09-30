// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title MockSmartAccount
/// @notice A minimal contract account for tests and demos: one EOA signer,
///  ERC-1271 signature validation, ERC-721 custody, and signer-only calls.
///  It stands in for the smart accounts email-onboarded holders usually own
///  tokens through (embedded signers behind ERC-4337 or EIP-7702 accounts).
/// @dev `isValidSignature(hash, signature)` recovers `hash` directly. Callers
///  that verify a signed message (viem `verifyMessage`, the ERC-8426 issuer's
///  `publicClientSignatureVerifier`) pass the EIP-191 personal_sign hash of
///  the message, so a signature the inner EOA makes with `signMessage` over
///  the same message validates. No replay protection across accounts or
///  chains is added (production accounts usually wrap the hash in EIP-712):
///  this is a test mock, not a wallet. NEVER hold real value in it.
contract MockSmartAccount is IERC1271, IERC721Receiver {
    /// @notice The EOA whose signatures this account accepts.
    address public immutable signer;

    error MockSmartAccountNotSigner(address caller);
    error MockSmartAccountCallFailed(bytes returnData);

    constructor(address signer_) {
        signer = signer_;
    }

    /// @inheritdoc IERC1271
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        return err == ECDSA.RecoverError.NoError && recovered == signer ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }

    /// @notice Make a call from the account. Signer only.
    function execute(address to, uint256 value, bytes calldata data) external payable returns (bytes memory result) {
        if (msg.sender != signer) revert MockSmartAccountNotSigner(msg.sender);
        bool ok;
        (ok, result) = to.call{value: value}(data);
        if (!ok) revert MockSmartAccountCallFailed(result);
    }

    /// @inheritdoc IERC721Receiver
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {}
}
