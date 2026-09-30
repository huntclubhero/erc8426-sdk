// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC4906} from "@openzeppelin/contracts/interfaces/IERC4906.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {IERC721WalletPass} from "./IERC721WalletPass.sol";

/// @title ERC721WalletPass
/// @notice OpenZeppelin ERC-721 extension implementing ERC-8426, the Wallet
///  Pass Extension for NFTs. Inherit it, call the constructor with a pass base
///  URI, and emit pass updates with `_passUpdate` and `_batchPassUpdate`
///  whenever state rendered on the pass changes.
/// @dev The on-chain half of ERC-8426 is discovery (`passURI`) and freshness
///  signalling (`PassUpdate`, `BatchPassUpdate`). Pass generation, signing,
///  delivery and the authorization of pass-reachable actions live off chain.
///
///  Access control is deliberately left to the inheriting contract: this
///  base exposes only internal setters, so a collection can gate them with
///  `Ownable`, `AccessControl`, or anything else.
///
///  Defaults, each overridable:
///  - `passURI(tokenId)` is the pass base URI followed by the decimal token
///    id, and reverts with `ERC721NonexistentToken` for unminted ids.
///  - A `PassUpdate` is emitted on every mint, transfer and burn (see
///    `_passUpdateOnTransfer`).
///  - ERC-4906 events are NOT mirrored (see `_mirrorsMetadataUpdates`).
abstract contract ERC721WalletPass is ERC721, IERC4906, IERC721WalletPass {
    using Strings for uint256;

    /// @dev ERC-165 identifier of ERC-4906, fixed by that standard (it is
    ///  not the XOR of its function selectors, because it declares none).
    bytes4 internal constant ERC4906_INTERFACE_ID = 0x49064906;

    /// @dev Base the per-token pass endpoint lives under. A good base
    ///  encodes chain and contract so one server can serve many collections,
    ///  for example "https://passes.example/wallet-pass/eip155/8453/0xColl/".
    string private _passBaseURI;

    /// @notice Emitted when the pass base URI changes.
    /// @dev Not part of ERC-8426. Changing the base moves the manifest
    ///  endpoint; it does not by itself change pass content, so no
    ///  `BatchPassUpdate` is implied.
    event PassBaseURIUpdated(string newPassBaseURI);

    /// @notice Raised when a batch range is inverted. ERC-8426 defines the
    ///  `BatchPassUpdate` range as inclusive of both ends, so `from` must not
    ///  exceed `to`.
    error ERC721WalletPassInvalidRange(uint256 fromTokenId, uint256 toTokenId);

    /// @notice Raised by `passURI` while no pass base URI is set: an empty
    ///  string is not a URI that resolves to a manifest, so the view refuses
    ///  rather than returning one.
    error ERC721WalletPassNoPassBaseURI();

    /// @param passBaseURI_ Initial pass base URI. May be empty and set later
    ///  with `_setPassBaseURI`; until then `passURI` reverts.
    constructor(string memory passBaseURI_) {
        _passBaseURI = passBaseURI_;
    }

    /// @inheritdoc IERC721WalletPass
    /// @dev Reverts with `ERC721NonexistentToken` for an unminted or burned
    ///  token, as the specification requires ("Throws if `tokenId` is not a
    ///  valid token"), and with `ERC721WalletPassNoPassBaseURI` while no base
    ///  is set, because the returned URI MUST resolve to a pass manifest.
    function passURI(uint256 tokenId) public view virtual returns (string memory) {
        _requireOwned(tokenId);
        string memory base = _passBaseURI;
        if (bytes(base).length == 0) revert ERC721WalletPassNoPassBaseURI();
        return string.concat(base, tokenId.toString());
    }

    /// @notice The current pass base URI.
    function passBaseURI() public view virtual returns (string memory) {
        return _passBaseURI;
    }

    /// @inheritdoc ERC721
    /// @dev Reports `0xef5f1e71` (ERC-8426) always, and `0x49064906`
    ///  (ERC-4906) only when `_mirrorsMetadataUpdates` returns true.
    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC721, IERC165) returns (bool) {
        return interfaceId == type(IERC721WalletPass).interfaceId
            || (interfaceId == ERC4906_INTERFACE_ID && _mirrorsMetadataUpdates()) || super.supportsInterface(interfaceId);
    }

    /// @dev Replace the pass base URI. Gate the external setter in the
    ///  inheriting contract.
    function _setPassBaseURI(string memory newPassBaseURI) internal virtual {
        _passBaseURI = newPassBaseURI;
        emit PassBaseURIUpdated(newPassBaseURI);
    }

    /// @dev Signal that pass content for `tokenId` changed. Call it after
    ///  every change to state that the pass renders. Also emits ERC-4906
    ///  `MetadataUpdate` when `_mirrorsMetadataUpdates` is true.
    function _passUpdate(uint256 tokenId) internal virtual {
        emit PassUpdate(tokenId);
        if (_mirrorsMetadataUpdates()) emit MetadataUpdate(tokenId);
    }

    /// @dev Signal that pass content changed for the inclusive range
    ///  [`fromTokenId`, `toTokenId`], for example a collection-wide template
    ///  refresh or the end of a round. One event over a range that includes
    ///  unaffected ids is cheaper than one event per token, and a redundant
    ///  refresh is harmless. Reverts if the range is inverted.
    function _batchPassUpdate(uint256 fromTokenId, uint256 toTokenId) internal virtual {
        if (fromTokenId > toTokenId) revert ERC721WalletPassInvalidRange(fromTokenId, toTokenId);
        emit BatchPassUpdate(fromTokenId, toTokenId);
        if (_mirrorsMetadataUpdates()) emit BatchMetadataUpdate(fromTokenId, toTokenId);
    }

    /// @dev Whether a change of owner (mint, transfer, burn) emits
    ///  `PassUpdate`. Default true.
    ///
    ///  Why on by default: ERC-8426 asks issuers to update, invalidate, or
    ///  visibly mark as superseded the passes issued to a previous owner, and
    ///  to rotate acquisition URLs once a transfer is observed. Pass content
    ///  itself usually shows the holder or depends on who holds the token, so
    ///  an owner change is a pass content change. Emitting from the transfer
    ///  hook covers mint, transfer and burn without separate call sites, and
    ///  gives every pass distributor (not only the issuer's own indexer) a
    ///  signal to re-render. Override to return false if your passes do not
    ///  depend on the holder and you want to save the gas (about 1,200 per
    ///  transfer).
    function _passUpdateOnTransfer() internal view virtual returns (bool) {
        return true;
    }

    /// @dev Whether pass update helpers also emit the ERC-4906 events
    ///  `MetadataUpdate` and `BatchMetadataUpdate`. Default false.
    ///
    ///  ERC-8426 keeps `PassUpdate` separate from ERC-4906 because pass
    ///  content often changes when `tokenURI` content does not. An
    ///  implementation that mirrors the manifest into metadata (the OPTIONAL
    ///  `wallet_pass` property, allowed only in the public configuration)
    ///  changes its metadata whenever the pass changes, and can emit both.
    ///  Override to return true in that case; `supportsInterface` then also
    ///  reports ERC-4906. The value should be constant for the life of the
    ///  contract so that ERC-165 answers stay stable.
    function _mirrorsMetadataUpdates() internal view virtual returns (bool) {
        return false;
    }

    /// @dev Hooks every mint, transfer and burn to emit `PassUpdate` when
    ///  `_passUpdateOnTransfer` is true.
    function _update(address to, uint256 tokenId, address auth) internal virtual override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (from != to && _passUpdateOnTransfer()) _passUpdate(tokenId);
    }
}
