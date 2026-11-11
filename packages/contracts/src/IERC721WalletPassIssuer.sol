// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title ERC-721 Wallet Pass Extension, issuer identity commitment
/// @dev The ERC-165 identifier for this interface is 0x470be7e9.
///  This file reproduces the interface in ERC-8426 exactly. Only the license
///  header differs from the specification text (the specification itself is
///  CC0).
interface IERC721WalletPassIssuer {
    /// @notice The platform signer identity the pass manifests of this
    ///  contract carry, as the JSON `issuer` object defined under
    ///  Pass manifest.
    function passIssuer() external view returns (string memory);
}
