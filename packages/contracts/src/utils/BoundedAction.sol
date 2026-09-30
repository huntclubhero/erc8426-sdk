// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Context} from "@openzeppelin/contracts/utils/Context.sol";

/// @title BoundedAction
/// @notice The on-chain half of ERC-8426's capability configuration. It lets
///  a token contract expose a pass-reachable function to an issuer operator
///  (a relayer or a scoped session key) while the chain, not the server,
///  enforces that "the effect of the action under unlimited repetition MUST
///  be bounded".
/// @dev How it maps to the capability configuration's conditions:
///
///  - Scoped authority ("SHOULD be limited on chain to the function the
///    link invokes"): an operator can call only functions guarded by
///    `onlyBoundedAction`, and only for the action id each function names.
///    An operator appointed with `_setActionOperatorFor` is further limited
///    to the action ids it was appointed for; one appointed with
///    `_setActionOperator` may run every bounded action.
///  - Bounded repetition: each (token, action) pair may run at most
///    `maxPerWindow` times per window of `windowSeconds`, and may move at
///    most `maxValuePerCall` per call and `maxValuePerWindow` per window.
///    An action configured with zero value caps can move no value at all.
///  - Documented bound: `actionBound(actionId)` returns the parameters, and
///    `actionUsage` / `remainingInWindow` return live usage, so the bound
///    can be read and published by anyone.
///  - The owner's remedy: the current owner of a token can switch off every
///    operator for that token with `setAllOperatorsRevoked`, which also
///    covers operators the issuer appoints later (a rotated relayer key), or
///    revoke one operator with `setOperatorRevoked`. Only the owner can
///    restore either. (Off chain, the owner's other remedy is capability URL
///    rotation on request.)
///  - Optional commitment: `_freezeActionBound` makes an action's bound
///    one-way, so the issuer can later tighten it but never loosen it.
///
///  Revocations are keyed to (token, owner): they last for that owner's
///  tenure, and a new owner starts with the issuer's defaults. Because the
///  key includes the owner, a revocation comes back if the same owner holds
///  the token again (A to B to A): an owner's choice follows the owner.
///
///  What this contract does NOT do: it does not perform ERC-8426 check (2),
///  the fresh entitlement read. That read is off chain, by the verifier,
///  before it submits the operator transaction. On chain the operator acts
///  for whoever owns the token at execution time.
///
///  Window semantics: windows are fixed, not sliding. A window opens at the
///  first use after the previous window has expired and lasts
///  `windowSeconds`. Over a long horizon the rate is at most `maxPerWindow`
///  per `windowSeconds`, but two back-to-back windows let up to
///  `2 * maxPerWindow` uses (and `2 * maxValuePerWindow` value) land inside
///  any single span of `windowSeconds`. Document the bound with that factor.
///
///  Callers are read with `_msgSender()`, so the contract works behind an
///  ERC-2771 trusted forwarder when the inheriting contract overrides it.
///
///  Integration: implement `_boundedActionOwner` (usually `_requireOwned`
///  on an ERC-721), gate your own `setActionOperator` / `configureAction`
///  wrappers with your access control, and guard each pass-reachable
///  function with `onlyBoundedAction` or `_consumeBoundedAction`.
abstract contract BoundedAction is Context {
    /// @notice Parameters bounding one action.
    /// @param maxPerWindow Maximum calls per token per window. Zero disables
    ///  the action for operators.
    /// @param windowSeconds Length of a window in seconds.
    /// @param maxValuePerCall Maximum value one call may move. Zero means the
    ///  action moves no value.
    /// @param maxValuePerWindow Maximum total value per token per window.
    /// @param frozen When true the bound can only be tightened.
    struct ActionBound {
        uint32 maxPerWindow;
        uint32 windowSeconds;
        uint128 maxValuePerCall;
        uint128 maxValuePerWindow;
        bool frozen;
    }

    /// @notice Usage of one action by one token in the current window.
    struct ActionUsage {
        uint64 windowStart;
        uint32 count;
        uint128 value;
    }

    mapping(bytes32 actionId => ActionBound) private _bounds;
    mapping(uint256 tokenId => mapping(bytes32 actionId => ActionUsage)) private _usage;
    mapping(address operator => bool) private _operators;
    mapping(address operator => mapping(bytes32 actionId => bool)) private _scopedOperators;
    mapping(uint256 tokenId => mapping(address owner => mapping(address operator => bool))) private _revoked;
    mapping(uint256 tokenId => mapping(address owner => bool)) private _revokedAll;

    /// @notice Emitted when an action's bound is set or changed.
    event ActionBoundConfigured(
        bytes32 indexed actionId,
        uint32 maxPerWindow,
        uint32 windowSeconds,
        uint128 maxValuePerCall,
        uint128 maxValuePerWindow
    );

    /// @notice Emitted when an action's bound becomes tighten-only.
    event ActionBoundFrozen(bytes32 indexed actionId);

    /// @notice Emitted when the issuer adds or removes an operator for every
    ///  bounded action.
    event ActionOperatorSet(address indexed operator, bool allowed);

    /// @notice Emitted when the issuer adds or removes an operator for one
    ///  action id.
    event ActionOperatorScopeSet(address indexed operator, bytes32 indexed actionId, bool allowed);

    /// @notice Emitted when a token owner revokes or restores one operator
    ///  for their token.
    event ActionOperatorRevoked(uint256 indexed tokenId, address indexed owner, address indexed operator, bool revoked);

    /// @notice Emitted when a token owner switches every operator off (or
    ///  back on) for their token, including operators appointed later.
    event AllActionOperatorsRevoked(uint256 indexed tokenId, address indexed owner, bool revoked);

    /// @notice Emitted each time an operator consumes a bounded action.
    event BoundedActionUsed(
        uint256 indexed tokenId, bytes32 indexed actionId, address indexed operator, uint256 value, uint32 countInWindow
    );

    error BoundedActionUnauthorizedOperator(address operator);
    error BoundedActionOperatorRevoked(uint256 tokenId, address operator);
    error BoundedActionDisabled(bytes32 actionId);
    error BoundedActionRateLimited(uint256 tokenId, bytes32 actionId, uint256 windowResetsAt);
    error BoundedActionValueTooHigh(bytes32 actionId, uint256 value, uint256 maxValuePerCall);
    error BoundedActionWindowCapExceeded(uint256 tokenId, bytes32 actionId, uint256 value, uint256 remaining);
    error BoundedActionInvalidBound(bytes32 actionId);
    error BoundedActionBoundFrozen(bytes32 actionId);
    error BoundedActionNotTokenOwner(uint256 tokenId, address account);

    /// @dev Guard a pass-reachable function: the caller must be an operator
    ///  for `actionId`, not revoked for `tokenId`, and the call is counted
    ///  against `actionId`'s bound with `value` moved.
    modifier onlyBoundedAction(bytes32 actionId, uint256 tokenId, uint256 value) {
        _consumeBoundedAction(actionId, tokenId, _msgSender(), value);
        _;
    }

    // Views

    /// @notice The bound configured for `actionId`. This is the documented
    ///  bound ERC-8426 asks capability-configuration issuers to publish.
    function actionBound(bytes32 actionId) public view virtual returns (ActionBound memory) {
        return _bounds[actionId];
    }

    /// @notice Usage of `actionId` by `tokenId` in the current window, with
    ///  an expired window reported as empty.
    /// @return count Calls made in the current window.
    /// @return value Value moved in the current window.
    /// @return windowResetsAt Timestamp at which the window expires, or zero
    ///  if no window is open.
    function actionUsage(uint256 tokenId, bytes32 actionId)
        public
        view
        virtual
        returns (uint32 count, uint128 value, uint256 windowResetsAt)
    {
        ActionUsage memory u = _usage[tokenId][actionId];
        uint256 resetsAt = uint256(u.windowStart) + _bounds[actionId].windowSeconds;
        if (u.windowStart == 0 || block.timestamp >= resetsAt) return (0, 0, 0);
        return (u.count, u.value, resetsAt);
    }

    /// @notice How many more calls, and how much more value, an operator can
    ///  spend on `actionId` for `tokenId` in the current window.
    function remainingInWindow(uint256 tokenId, bytes32 actionId)
        public
        view
        virtual
        returns (uint32 calls, uint128 value)
    {
        ActionBound memory b = _bounds[actionId];
        (uint32 count, uint128 used,) = actionUsage(tokenId, actionId);
        calls = count >= b.maxPerWindow ? 0 : b.maxPerWindow - count;
        value = used >= b.maxValuePerWindow ? 0 : b.maxValuePerWindow - used;
    }

    /// @notice Whether `operator` is appointed for every bounded action.
    function isActionOperator(address operator) public view virtual returns (bool) {
        return _operators[operator];
    }

    /// @notice Whether `operator` may run `actionId`: appointed for every
    ///  action, or scoped to this one.
    function isActionOperatorFor(address operator, bytes32 actionId) public view virtual returns (bool) {
        return _operators[operator] || _scopedOperators[operator][actionId];
    }

    /// @notice Whether the current owner of `tokenId` has revoked `operator`,
    ///  individually or by revoking every operator.
    function isOperatorRevoked(uint256 tokenId, address operator) public view virtual returns (bool) {
        address holder = _boundedActionOwner(tokenId);
        return _revokedAll[tokenId][holder] || _revoked[tokenId][holder][operator];
    }

    /// @notice Whether the current owner of `tokenId` has switched off every
    ///  operator for it.
    function areAllOperatorsRevoked(uint256 tokenId) public view virtual returns (bool) {
        return _revokedAll[tokenId][_boundedActionOwner(tokenId)];
    }

    /// @notice Whether `operator` may currently act on `tokenId` for at
    ///  least one action (appointed, globally or scoped, and not revoked).
    ///  Use `canOperateFor` for a specific action. Limits still apply.
    function canOperate(uint256 tokenId, address operator) public view virtual returns (bool) {
        return _operators[operator] && !isOperatorRevoked(tokenId, operator);
    }

    /// @notice Whether `operator` may currently run `actionId` on `tokenId`.
    ///  Rate and value limits still apply.
    function canOperateFor(uint256 tokenId, address operator, bytes32 actionId) public view virtual returns (bool) {
        return isActionOperatorFor(operator, actionId) && !isOperatorRevoked(tokenId, operator);
    }

    // Owner remedy

    /// @notice Revoke (or restore) one `operator` for `tokenId`. Only the
    ///  current owner of the token may call this.
    function setOperatorRevoked(uint256 tokenId, address operator, bool revoked) public virtual {
        address holder = _requireBoundedActionOwner(tokenId);
        _revoked[tokenId][holder][operator] = revoked;
        emit ActionOperatorRevoked(tokenId, holder, operator, revoked);
    }

    /// @notice Switch every operator off (or back on) for `tokenId`,
    ///  including operators the issuer appoints after this call. Only the
    ///  current owner of the token may call this, and only the owner can
    ///  restore it. This is the on-chain remedy for a leaked capability link
    ///  under an unchanged owner: it holds even if the issuer rotates or adds
    ///  relayer keys.
    function setAllOperatorsRevoked(uint256 tokenId, bool revoked) public virtual {
        address holder = _requireBoundedActionOwner(tokenId);
        _revokedAll[tokenId][holder] = revoked;
        emit AllActionOperatorsRevoked(tokenId, holder, revoked);
    }

    // Internal configuration (wrap these with your access control)

    /// @dev Appoint or remove an operator for every bounded action.
    function _setActionOperator(address operator, bool allowed) internal virtual {
        _operators[operator] = allowed;
        emit ActionOperatorSet(operator, allowed);
    }

    /// @dev Appoint or remove an operator for one action id only, so a key
    ///  can be limited to the one function its links invoke.
    function _setActionOperatorFor(address operator, bytes32 actionId, bool allowed) internal virtual {
        _scopedOperators[operator][actionId] = allowed;
        emit ActionOperatorScopeSet(operator, actionId, allowed);
    }

    /// @dev Set the bound for `actionId`. `maxPerWindow` of zero disables the
    ///  action; otherwise `windowSeconds` must be non-zero and
    ///  `maxValuePerCall` must not exceed `maxValuePerWindow`. A frozen bound
    ///  may only be tightened: fewer calls, a longer window, lower caps.
    function _configureAction(
        bytes32 actionId,
        uint32 maxPerWindow,
        uint32 windowSeconds,
        uint128 maxValuePerCall,
        uint128 maxValuePerWindow
    ) internal virtual {
        if (maxPerWindow != 0 && windowSeconds == 0) revert BoundedActionInvalidBound(actionId);
        if (maxValuePerCall > maxValuePerWindow) revert BoundedActionInvalidBound(actionId);
        ActionBound storage b = _bounds[actionId];
        if (b.frozen) {
            bool loosens = maxPerWindow > b.maxPerWindow || windowSeconds < b.windowSeconds
                || maxValuePerCall > b.maxValuePerCall || maxValuePerWindow > b.maxValuePerWindow;
            // Disabling (maxPerWindow zero) always tightens, whatever the window.
            if (loosens && maxPerWindow != 0) revert BoundedActionBoundFrozen(actionId);
        }
        b.maxPerWindow = maxPerWindow;
        b.windowSeconds = windowSeconds;
        b.maxValuePerCall = maxValuePerCall;
        b.maxValuePerWindow = maxValuePerWindow;
        emit ActionBoundConfigured(actionId, maxPerWindow, windowSeconds, maxValuePerCall, maxValuePerWindow);
    }

    /// @dev Make `actionId`'s bound tighten-only, permanently. Use it to
    ///  turn the published bound into a commitment holders can rely on.
    ///  Disabling a frozen action (setting `maxPerWindow` to zero) is allowed
    ///  and, because re-enabling would loosen it, final.
    function _freezeActionBound(bytes32 actionId) internal virtual {
        if (_bounds[actionId].maxPerWindow == 0) revert BoundedActionDisabled(actionId);
        _bounds[actionId].frozen = true;
        emit ActionBoundFrozen(actionId);
    }

    /// @dev Check that `operator` may run `actionId` on `tokenId` moving
    ///  `value`, and record the use. Reverts on any violation. Call it at the
    ///  top of a function when only some callers (for example the operator,
    ///  but not the owner) should be bounded.
    function _consumeBoundedAction(bytes32 actionId, uint256 tokenId, address operator, uint256 value)
        internal
        virtual
    {
        if (!isActionOperatorFor(operator, actionId)) revert BoundedActionUnauthorizedOperator(operator);
        address holder = _boundedActionOwner(tokenId);
        if (_revokedAll[tokenId][holder] || _revoked[tokenId][holder][operator]) {
            revert BoundedActionOperatorRevoked(tokenId, operator);
        }

        ActionBound memory b = _bounds[actionId];
        if (b.maxPerWindow == 0) revert BoundedActionDisabled(actionId);
        if (value > b.maxValuePerCall) revert BoundedActionValueTooHigh(actionId, value, b.maxValuePerCall);

        ActionUsage storage u = _usage[tokenId][actionId];
        if (u.windowStart == 0 || block.timestamp >= uint256(u.windowStart) + b.windowSeconds) {
            u.windowStart = uint64(block.timestamp);
            u.count = 0;
            u.value = 0;
        }
        if (u.count >= b.maxPerWindow) {
            revert BoundedActionRateLimited(tokenId, actionId, uint256(u.windowStart) + b.windowSeconds);
        }
        // value <= maxValuePerCall <= type(uint128).max, so the sum fits.
        uint256 newValue = uint256(u.value) + value;
        if (newValue > b.maxValuePerWindow) {
            // Saturating: a cap lowered below what this window already used
            // leaves nothing remaining, rather than underflowing.
            uint256 remaining = u.value >= b.maxValuePerWindow ? 0 : b.maxValuePerWindow - u.value;
            revert BoundedActionWindowCapExceeded(tokenId, actionId, value, remaining);
        }
        u.count += 1;
        // Safe: newValue <= maxValuePerWindow, a uint128.
        // forge-lint: disable-next-line(unsafe-typecast)
        u.value = uint128(newValue);
        emit BoundedActionUsed(tokenId, actionId, operator, value, u.count);
    }

    function _requireBoundedActionOwner(uint256 tokenId) private view returns (address holder) {
        holder = _boundedActionOwner(tokenId);
        if (_msgSender() != holder) revert BoundedActionNotTokenOwner(tokenId, _msgSender());
    }

    /// @dev The current owner of `tokenId`. Must revert for a nonexistent
    ///  token. For an OpenZeppelin ERC-721, return `_requireOwned(tokenId)`.
    function _boundedActionOwner(uint256 tokenId) internal view virtual returns (address);
}
