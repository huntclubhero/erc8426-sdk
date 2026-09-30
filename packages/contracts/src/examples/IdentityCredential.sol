// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {ERC721WalletPass} from "../ERC721WalletPass.sol";
import {IERC5192} from "../interfaces/IERC5192.sol";

/// @title IdentityCredential (example)
/// @notice Use case: a non-transferable credential (a membership ID, a
///  license, an age or KYC attestation) issued by an attester, with an
///  expiry, revocable by the attester. The wallet pass is the ID card: it
///  shows the credential and its status, and a verifier can check it against
///  the chain with `isValid`.
/// @dev Soulbound per ERC-5192: `locked` is always true, `Locked` is emitted
///  at issue, and transfers and approvals revert. The holder may burn
///  (renounce) their own credential; the attester revokes by flagging. The
///  credential record survives both, so a revocation stays on chain for
///  audit even after the holder renounces.
///
///  Only the attester that issued a credential may revoke or extend it (and
///  only while it still holds ATTESTER_ROLE); DEFAULT_ADMIN_ROLE may override,
///  for example to act on a compromised attester's credentials.
///
///  Capability analysis (ERC-8426): nothing here is reachable through a
///  capability link. Issue, revoke and extend need the attester's
///  signature; renounce and `requestPassRotation` need the holder's.
///
///  Rotation: ERC-8426 rotates acquisition URLs when a transfer is observed.
///  A soulbound token never transfers, so transfer-driven rotation never
///  fires, and a leaked pass link or pass file stays live for as long as the
///  holder is unchanged. Rotation on the owner's request is therefore the
///  holder's only remedy. `requestPassRotation` lets the holder ask for it
///  on chain (an event any issuer indexer can act on), in addition to
///  whatever off-chain reset the issuer offers. This event is part of this
///  example, not of ERC-8426.
contract IdentityCredential is ERC721WalletPass, AccessControl, IERC5192 {
    bytes32 public constant ATTESTER_ROLE = keccak256("ATTESTER_ROLE");

    /// @dev ERC-165 identifier of ERC-5192.
    bytes4 private constant ERC5192_INTERFACE_ID = 0xb45a3c0e;

    struct Credential {
        bytes32 claimHash;
        uint64 issuedAt;
        uint64 expiresAt;
        bool revoked;
        address attester;
    }

    mapping(uint256 tokenId => Credential) private _credentials;
    uint256 private _nextTokenId;

    event CredentialIssued(uint256 indexed tokenId, address indexed holder, address indexed attester, bytes32 claimHash, uint64 expiresAt);
    event CredentialRevoked(uint256 indexed tokenId, address indexed attester);
    event CredentialExtended(uint256 indexed tokenId, uint64 expiresAt);
    event PassRotationRequested(uint256 indexed tokenId, address indexed holder);

    error CredentialSoulbound(uint256 tokenId);
    error CredentialNotHolder(uint256 tokenId, address caller);
    error CredentialAlreadyRevoked(uint256 tokenId);
    error CredentialInvalidExpiry();
    error CredentialNotAttester(uint256 tokenId, address caller);
    error CredentialUnknown(uint256 tokenId);

    constructor(string memory passBaseURI_, address admin)
        ERC721("Identity Credential", "IDC")
        ERC721WalletPass(passBaseURI_)
    {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ATTESTER_ROLE, admin);
    }

    // Attester

    /// @notice Issue a credential to `to`. `claimHash` commits to the
    ///  off-chain claim (never put personal data on chain).
    function issue(address to, bytes32 claimHash, uint64 expiresAt)
        external
        onlyRole(ATTESTER_ROLE)
        returns (uint256 tokenId)
    {
        if (expiresAt <= block.timestamp) revert CredentialInvalidExpiry();
        tokenId = ++_nextTokenId;
        _credentials[tokenId] = Credential(claimHash, uint64(block.timestamp), expiresAt, false, msg.sender);
        _mint(to, tokenId);
        emit Locked(tokenId);
        emit CredentialIssued(tokenId, to, msg.sender, claimHash, expiresAt);
    }

    function revoke(uint256 tokenId) external {
        _requireOwned(tokenId);
        Credential storage c = _credentials[tokenId];
        _checkAttesterOf(tokenId, c);
        if (c.revoked) revert CredentialAlreadyRevoked(tokenId);
        c.revoked = true;
        emit CredentialRevoked(tokenId, msg.sender);
        _passUpdate(tokenId);
    }

    function extend(uint256 tokenId, uint64 expiresAt) external {
        _requireOwned(tokenId);
        Credential storage c = _credentials[tokenId];
        _checkAttesterOf(tokenId, c);
        if (c.revoked) revert CredentialAlreadyRevoked(tokenId);
        if (expiresAt <= c.expiresAt) revert CredentialInvalidExpiry();
        c.expiresAt = expiresAt;
        emit CredentialExtended(tokenId, expiresAt);
        _passUpdate(tokenId);
    }

    function setPassBaseURI(string calldata newBase) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setPassBaseURI(newBase);
    }

    // Holder

    /// @notice Burn your own credential. The record (including any
    ///  revocation) is kept for audit; only the token is burned.
    function renounce(uint256 tokenId) external {
        if (_requireOwned(tokenId) != msg.sender) revert CredentialNotHolder(tokenId, msg.sender);
        _burn(tokenId);
    }

    /// @notice Ask the issuer to rotate this credential's pass links and
    ///  pass downloads (the remedy for a leaked link, since a soulbound
    ///  token never triggers transfer rotation). Emits `PassUpdate` so every
    ///  distributor re-renders.
    function requestPassRotation(uint256 tokenId) external {
        if (_requireOwned(tokenId) != msg.sender) revert CredentialNotHolder(tokenId, msg.sender);
        emit PassRotationRequested(tokenId, msg.sender);
        _passUpdate(tokenId);
    }

    // Views

    /// @inheritdoc IERC5192
    function locked(uint256 tokenId) external view returns (bool) {
        _requireOwned(tokenId);
        return true;
    }

    /// @notice The credential record, also for a renounced (burned) token.
    ///  Reverts only for an id that was never issued.
    function credential(uint256 tokenId) external view returns (Credential memory) {
        Credential memory c = _credentials[tokenId];
        if (c.issuedAt == 0) revert CredentialUnknown(tokenId);
        return c;
    }

    /// @notice Exists, not revoked, not expired.
    function isValid(uint256 tokenId) external view returns (bool) {
        if (_ownerOf(tokenId) == address(0)) return false;
        Credential memory c = _credentials[tokenId];
        return !c.revoked && block.timestamp < c.expiresAt;
    }

    /// @dev Approvals are meaningless for a token that cannot move; refuse
    ///  them so no wallet UI suggests otherwise.
    function approve(address, uint256 tokenId) public pure override(ERC721, IERC721) {
        revert CredentialSoulbound(tokenId);
    }

    function setApprovalForAll(address, bool) public pure override(ERC721, IERC721) {
        revert CredentialSoulbound(0);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721WalletPass, AccessControl)
        returns (bool)
    {
        return interfaceId == ERC5192_INTERFACE_ID || super.supportsInterface(interfaceId);
    }

    /// @dev The issuing attester (still holding ATTESTER_ROLE), or an admin.
    function _checkAttesterOf(uint256 tokenId, Credential storage c) private view {
        address caller = _msgSender();
        bool issuer = caller == c.attester && hasRole(ATTESTER_ROLE, caller);
        if (!issuer && !hasRole(DEFAULT_ADMIN_ROLE, caller)) revert CredentialNotAttester(tokenId, caller);
    }

    /// @dev Only mint (from zero) and burn (to zero) are allowed.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        address current = _ownerOf(tokenId);
        if (current != address(0) && to != address(0)) revert CredentialSoulbound(tokenId);
        from = super._update(to, tokenId, auth);
    }
}
