// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721WalletPass} from "../ERC721WalletPass.sol";
import {IERC721WalletPassIssuer} from "../IERC721WalletPassIssuer.sol";

/// @title ERC721WalletPassIssuer
/// @notice ERC-8426 wallet pass token that commits on chain to the platform
///  signer its passes come from (ERC-8426, "Issuer identity commitment").
///  A client can then check the signer of a pass against something the
///  contract, not the endpoint, asserts.
/// @dev `passIssuer()` returns a JSON object with the shape of the manifest's
///  `issuer` member, for example
///  `{"apple":{"teamIdentifier":"A1B2C3D4E5","passTypeIdentifier":"pass.example.card"},"google":{"issuerId":"3388000000012345678"}}`.
///
///  The string is stored and returned as given: the contract does not parse
///  JSON, so the caller of `_setPassIssuer` is responsible for its shape.
///  Once a contract implements this interface, its Pass Issuer MUST include
///  `issuer` in every manifest it serves for the contract, equal member for
///  member to this object. Changing the committed identity (an issuer
///  migration) is therefore a transaction: update the contract and the
///  manifest together, because a client that sees them differ is asked not
///  to install the pass.
///
///  Access control is left to the inheriting contract, as in the base: gate
///  an external setter around `_setPassIssuer`.
abstract contract ERC721WalletPassIssuer is ERC721WalletPass, IERC721WalletPassIssuer {
    string private _passIssuer;

    /// @notice Emitted when the committed issuer identity changes.
    /// @dev Not part of ERC-8426.
    event PassIssuerUpdated(string newPassIssuer);

    /// @notice Raised by `passIssuer` while no identity is set: an empty
    ///  string is not the JSON object the specification requires, so the view
    ///  refuses rather than returning one.
    error ERC721WalletPassNoPassIssuer();

    /// @param passIssuer_ Initial issuer identity JSON. May be empty and set
    ///  later with `_setPassIssuer`; until then `passIssuer` reverts.
    constructor(string memory passIssuer_) {
        _passIssuer = passIssuer_;
    }

    /// @inheritdoc IERC721WalletPassIssuer
    function passIssuer() public view virtual returns (string memory) {
        string memory identity = _passIssuer;
        if (bytes(identity).length == 0) revert ERC721WalletPassNoPassIssuer();
        return identity;
    }

    /// @inheritdoc ERC721WalletPass
    /// @dev Also reports `0x470be7e9` (the issuer identity commitment).
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return interfaceId == type(IERC721WalletPassIssuer).interfaceId || super.supportsInterface(interfaceId);
    }

    /// @dev Replace the committed issuer identity. Gate the external setter
    ///  in the inheriting contract.
    function _setPassIssuer(string memory newPassIssuer) internal virtual {
        _passIssuer = newPassIssuer;
        emit PassIssuerUpdated(newPassIssuer);
    }
}
