// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Regressions for the external audit of packages/contracts. Each `test_F*`
// started as a proof of concept that passed while the finding was present;
// each now asserts the fixed (or documented) behavior. Each `test_OK*` is a
// property the audit checked and found to hold.

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {StoredValueCard} from "../src/examples/StoredValueCard.sol";
import {StakingPass} from "../src/examples/StakingPass.sol";
import {IdentityCredential} from "../src/examples/IdentityCredential.sol";
import {PetPass} from "../src/examples/PetPass.sol";
import {RentalPass} from "../src/examples/RentalPass.sol";
import {EventTicketPass} from "../src/examples/EventTicketPass.sol";
import {MembershipPass} from "../src/examples/MembershipPass.sol";
import {BoundedAction} from "../src/utils/BoundedAction.sol";
import {IERC721WalletPass} from "../src/IERC721WalletPass.sol";
import {IERC4907} from "../src/interfaces/IERC4907.sol";
import {IERC5192} from "../src/interfaces/IERC5192.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockERC721} from "../src/mocks/MockERC721.sol";

/// ERC-20 with an ERC-777 style sender hook (tokensToSend), called on the
/// `from` account before balances move.
interface ISendHook {
    function beforeSend() external;
}

contract HookToken is ERC20 {
    constructor() ERC20("Hook USD", "HUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (from.code.length != 0) ISendHook(from).beforeSend();
        return super.transferFrom(from, to, value);
    }
}

contract TopUpReenterer is ISendHook {
    StoredValueCard internal immutable cards;
    HookToken internal immutable token;
    uint256 internal tokenId;
    uint256 internal amount;
    bool internal entered;

    constructor(StoredValueCard cards_, HookToken token_) {
        cards = cards_;
        token = token_;
    }

    function attack(uint256 tokenId_, uint256 amount_) external {
        tokenId = tokenId_;
        amount = amount_;
        token.approve(address(cards), type(uint256).max);
        cards.topUp(tokenId, amount);
    }

    function beforeSend() external {
        if (entered) return;
        entered = true;
        cards.topUp(tokenId, amount);
    }

    function withdrawAll(uint256 id, address to) external {
        cards.withdraw(id, cards.balanceOfCard(id), to);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

/// An escrow that holds ERC-721s (a vault, lending pool, or listing escrow)
/// and has no way to move arbitrary ERC-20s out.
contract NftOnlyEscrow {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function release(IERC721 nft, uint256 id, address to) external {
        nft.transferFrom(address(this), to, id);
    }
}

contract AuditRegressions is Test {
    address internal issuer = makeAddr("issuer");
    address internal relayer = makeAddr("relayer");
    address internal relayer2 = makeAddr("relayer2");
    address internal holder = makeAddr("holder");
    address internal buyer = makeAddr("buyer");
    address internal cafe = makeAddr("cafe");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        vm.warp(1_700_000_000);
    }

    function _card(IERC20 coin) internal returns (StoredValueCard cards, uint256 id) {
        cards = new StoredValueCard("https://c/", issuer, coin, 10, 25e6, 100e6, 20);
        vm.startPrank(issuer);
        cards.setActionOperator(relayer, true);
        cards.setMerchant(cafe, true);
        id = cards.mint(holder);
        vm.stopPrank();
    }

    function _fund(StoredValueCard cards, MockERC20 usd, uint256 id, uint256 amount) internal {
        usd.mint(holder, amount);
        vm.startPrank(holder);
        usd.approve(address(cards), amount);
        cards.topUp(id, amount);
        vm.stopPrank();
    }

    // F1 (fixed): the owner-level switch covers every operator, including one
    // the issuer appoints after the revocation; only the owner can lift it.
    function test_F1_OwnerRevocationCoversRotatedOperator() public {
        MockERC20 usd = new MockERC20("USD", "USD", 6);
        (StoredValueCard cards, uint256 id) = _card(IERC20(address(usd)));
        _fund(cards, usd, id, 500e6);

        vm.prank(holder);
        cards.setAllOperatorsRevoked(id, true);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionOperatorRevoked.selector, id, relayer));
        cards.charge(id, 25e6, cafe);

        // Issuer rotates its relayer key. No action by the holder.
        vm.prank(issuer);
        cards.setActionOperator(relayer2, true);

        assertFalse(cards.canOperate(id, relayer2));
        vm.prank(relayer2);
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionOperatorRevoked.selector, id, relayer2));
        cards.charge(id, 25e6, cafe);
        assertEq(usd.balanceOf(cafe), 0);

        // Neither the issuer nor an operator can lift it; the owner can.
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionNotTokenOwner.selector, id, issuer));
        cards.setAllOperatorsRevoked(id, false);
        vm.prank(relayer2);
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionNotTokenOwner.selector, id, relayer2));
        cards.setAllOperatorsRevoked(id, false);
        vm.prank(holder);
        cards.setAllOperatorsRevoked(id, false);
        vm.prank(relayer2);
        cards.charge(id, 25e6, cafe);
        assertEq(usd.balanceOf(cafe), 25e6);
    }

    // F1 companion: a single-operator revocation is scoped to that operator
    // by design; the owner-level switch is the remedy that survives rotation.
    function test_F1_SingleOperatorRevocationIsScoped() public {
        MockERC20 usd = new MockERC20("USD", "USD", 6);
        (StoredValueCard cards, uint256 id) = _card(IERC20(address(usd)));
        vm.prank(holder);
        cards.setOperatorRevoked(id, relayer, true);
        vm.prank(issuer);
        cards.setActionOperator(relayer2, true);
        assertFalse(cards.canOperate(id, relayer));
        assertTrue(cards.canOperate(id, relayer2));
    }

    // Info (b): an operator scoped to one action cannot run another.
    function test_ScopedOperatorLimitedToItsAction() public {
        MockERC20 usd = new MockERC20("USD", "USD", 6);
        (StoredValueCard cards, uint256 id) = _card(IERC20(address(usd)));
        _fund(cards, usd, id, 100e6);
        bytes32 redeem = cards.REDEEM();
        vm.prank(issuer);
        cards.setActionOperatorFor(relayer2, redeem, true);
        assertTrue(cards.canOperateFor(id, relayer2, redeem));
        assertFalse(cards.canOperateFor(id, relayer2, cards.CHARGE()));
        vm.prank(relayer2);
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionUnauthorizedOperator.selector, relayer2));
        cards.charge(id, 1e6, cafe);
        vm.prank(relayer2);
        vm.expectRevert(abi.encodeWithSelector(StoredValueCard.CardNoReward.selector, id));
        cards.redeemReward(id, cafe); // passes the scope check, refused on state
    }

    // Info (a): the CHARGE bound is frozen at deployment.
    function test_ChargeBoundFrozenAtDeployment() public {
        MockERC20 usd = new MockERC20("USD", "USD", 6);
        (StoredValueCard cards,) = _card(IERC20(address(usd)));
        assertTrue(cards.actionBound(cards.CHARGE()).frozen);
        bytes32 charge = cards.CHARGE();
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionBoundFrozen.selector, charge));
        cards.setChargeCaps(20, 26e6, 100e6);
    }

    // Info (d): no check-in before the doors open.
    function test_NoCheckInBeforeDoorsOpen() public {
        EventTicketPass t = new EventTicketPass("https://t/", issuer, issuer, 500);
        address door = makeAddr("door");
        vm.startPrank(issuer);
        t.grantRole(t.DOOR_ROLE(), door);
        uint64 startsAt = uint64(block.timestamp + 7 days);
        uint256 s = t.createShow(startsAt, startsAt + 4 hours, 1);
        uint256 id = t.mintTicket(s, holder);
        vm.stopPrank();
        vm.prank(door);
        vm.expectRevert(abi.encodeWithSelector(EventTicketPass.TicketDoorsNotOpen.selector, s, uint256(startsAt - 2 hours)));
        t.checkIn(id);
        vm.warp(startsAt - 2 hours);
        vm.prank(door);
        t.checkIn(id);
    }

    // Info (e): passURI reverts while no base is set.
    function test_PassURIRevertsWithoutBase() public {
        PetPass pp = new PetPass("", issuer, 3 days);
        vm.prank(issuer);
        uint256 id = pp.mint(holder);
        vm.expectRevert();
        pp.passURI(id);
    }

    // F2 (fixed): topUp is nonReentrant, so a sender hook cannot re-enter it
    // to double count a deposit; the whole attack reverts.
    function test_F2_TopUpReentrancyReverts() public {
        HookToken coin = new HookToken();
        (StoredValueCard cards, uint256 victimId) = _card(IERC20(address(coin)));

        // Honest victim deposits 1,000.
        coin.mint(holder, 1_000e6);
        vm.startPrank(holder);
        coin.approve(address(cards), type(uint256).max);
        cards.topUp(victimId, 1_000e6);
        vm.stopPrank();

        TopUpReenterer attacker = new TopUpReenterer(cards, coin);
        vm.prank(issuer);
        uint256 attackerId = cards.mint(address(attacker));
        coin.mint(address(attacker), 200e6);

        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        attacker.attack(attackerId, 100e6);
        assertEq(cards.balanceOfCard(attackerId), 0);
        assertEq(coin.balanceOf(address(cards)), 1_000e6);
        assertEq(cards.balanceOfCard(victimId), 1_000e6);
    }

    // F3 (fixed): after a cap is lowered below what the window already used,
    // the next call raises BoundedActionWindowCapExceeded with zero remaining
    // (saturating), not an arithmetic panic.
    function test_F3_LoweredCapRaisesCleanError() public {
        MockERC20 usd = new MockERC20("USD", "USD", 6);
        (StoredValueCard cards, uint256 id) = _card(IERC20(address(usd)));
        _fund(cards, usd, id, 500e6);

        vm.startPrank(relayer);
        cards.charge(id, 25e6, cafe);
        cards.charge(id, 25e6, cafe);
        vm.stopPrank();

        vm.prank(issuer);
        cards.setChargeCaps(20, 10e6, 40e6); // used 50 > new window cap 40

        (, uint128 remaining) = cards.remainingInWindow(id, cards.CHARGE());
        assertEq(remaining, 0); // the view handles it
        bytes32 charge = cards.CHARGE();
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionWindowCapExceeded.selector, id, charge, 1e6, 0));
        cards.charge(id, 1e6, cafe);
    }

    // F4 (documented): withdraw is owner only, and the NatSpec and README now
    // state that an ERC-721 approval exposes the balance, because an approved
    // account can transfer the card to itself and then withdraw. This test
    // pins the documented behavior.
    function test_F4_ApprovalExposesBalanceAsDocumented() public {
        MockERC20 usd = new MockERC20("USD", "USD", 6);
        (StoredValueCard cards, uint256 id) = _card(IERC20(address(usd)));
        _fund(cards, usd, id, 500e6);

        vm.prank(holder);
        cards.setApprovalForAll(stranger, true); // e.g. a marketplace conduit

        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(StoredValueCard.CardNotOwner.selector, id, stranger));
        cards.withdraw(id, 500e6, stranger);
        cards.transferFrom(holder, stranger, id);
        cards.withdraw(id, 500e6, stranger);
        vm.stopPrank();
        assertEq(usd.balanceOf(stranger), 500e6);
    }

    // F5 (fixed): renounce burns the token but keeps the record, so a
    // revocation survives for audit.
    function test_F5_RenounceKeepsRevokedRecord() public {
        IdentityCredential idc = new IdentityCredential("https://i/", issuer);
        vm.prank(issuer);
        uint256 id = idc.issue(holder, keccak256("kyc"), uint64(block.timestamp + 365 days));
        vm.prank(issuer);
        idc.revoke(id);
        assertTrue(idc.credential(id).revoked);

        vm.prank(holder);
        idc.renounce(id);
        assertFalse(idc.isValid(id));
        IdentityCredential.Credential memory c = idc.credential(id);
        assertTrue(c.revoked);
        assertEq(c.attester, issuer);
        assertEq(c.claimHash, keccak256("kyc"));
        vm.expectRevert(abi.encodeWithSelector(IdentityCredential.CredentialUnknown.selector, 99));
        idc.credential(99);
    }

    // F6 (fixed): only the issuing attester (or DEFAULT_ADMIN_ROLE) can
    // revoke or extend a credential.
    function test_F6_OnlyIssuingAttesterOrAdmin() public {
        IdentityCredential idc = new IdentityCredential("https://i/", issuer);
        address other = makeAddr("otherAttester");
        address third = makeAddr("thirdAttester");
        bytes32 role = idc.ATTESTER_ROLE();
        vm.startPrank(issuer);
        idc.grantRole(role, other);
        idc.grantRole(role, third);
        vm.stopPrank();
        vm.prank(other);
        uint256 id = idc.issue(holder, keccak256("license"), uint64(block.timestamp + 30 days));

        vm.startPrank(third);
        vm.expectRevert(abi.encodeWithSelector(IdentityCredential.CredentialNotAttester.selector, id, third));
        idc.extend(id, uint64(block.timestamp + 3650 days));
        vm.expectRevert(abi.encodeWithSelector(IdentityCredential.CredentialNotAttester.selector, id, third));
        idc.revoke(id);
        vm.stopPrank();

        vm.prank(other); // the issuing attester
        idc.extend(id, uint64(block.timestamp + 60 days));
        vm.prank(issuer); // DEFAULT_ADMIN_ROLE override
        idc.revoke(id);
        assertEq(idc.credential(id).attester, other);
        assertTrue(idc.credential(id).revoked);
    }

    // F7 (fixed): claim is limited to the owner, an approved account, or the
    // bounded operator, so a stranger cannot push rewards into an escrow that
    // holds the receipt; the depositor keeps them.
    function test_F7_StrangerCannotStrandRewardsInEscrow() public {
        MockERC721 apes = new MockERC721("Apes", "APE");
        MockERC20 rwd = new MockERC20("R", "R", 18);
        StakingPass sp = new StakingPass("https://s/", issuer, IERC721(address(apes)), IERC20(address(rwd)), 1e18);
        rwd.mint(address(sp), 10_000_000e18);

        uint256 ape = apes.mint(holder);
        vm.startPrank(holder);
        apes.approve(address(sp), ape);
        uint256 r = sp.stake(ape);
        NftOnlyEscrow escrow = new NftOnlyEscrow();
        sp.safeTransferFrom(holder, address(escrow), r);
        vm.stopPrank();

        vm.warp(block.timestamp + 30 days);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionUnauthorizedOperator.selector, stranger));
        sp.claim(r);
        assertEq(rwd.balanceOf(address(escrow)), 0);

        escrow.release(IERC721(address(sp)), r, holder);
        uint256 accrued = sp.pendingRewards(r);
        assertEq(accrued, 30 days * 1e18);
        vm.prank(holder);
        sp.claim(r);
        assertEq(rwd.balanceOf(holder), accrued);
    }

    // F8 (documented): revocation is keyed to (token, owner), so when the
    // token goes from A to B and back to A, A's revocation applies again.
    // BoundedAction's NatSpec states this; the test pins it.
    function test_F8_RevocationFollowsTheOwnerAsDocumented() public {
        MockERC20 usd = new MockERC20("USD", "USD", 6);
        (StoredValueCard cards, uint256 id) = _card(IERC20(address(usd)));
        vm.prank(holder);
        cards.setOperatorRevoked(id, relayer, true);
        vm.prank(holder);
        cards.transferFrom(holder, buyer, id);
        assertTrue(cards.canOperate(id, relayer), "buyer starts with defaults");
        vm.prank(buyer);
        cards.transferFrom(buyer, holder, id);
        assertFalse(cards.canOperate(id, relayer), "old revocation is back");
    }

    // Held up checks

    function test_OK_InterfaceIds() public {
        assertEq(type(IERC721WalletPass).interfaceId, bytes4(0xef5f1e71));
        assertEq(type(IERC4907).interfaceId, bytes4(0xad092b5c));
        assertEq(type(IERC5192).interfaceId, bytes4(0xb45a3c0e));
        RentalPass rp = new RentalPass("https://r/", issuer);
        assertTrue(rp.supportsInterface(0xad092b5c));
        assertTrue(rp.supportsInterface(0xef5f1e71));
        assertTrue(rp.supportsInterface(0x80ac58cd));
        assertFalse(rp.supportsInterface(0x49064906));
        EventTicketPass t = new EventTicketPass("https://t/", issuer, issuer, 500);
        assertTrue(t.supportsInterface(0x2a55205a)); // ERC-2981
        assertTrue(t.supportsInterface(0x7965db0b)); // AccessControl
        assertTrue(t.supportsInterface(0xef5f1e71));
        assertTrue(t.supportsInterface(0x80ac58cd));
        IdentityCredential idc = new IdentityCredential("https://i/", issuer);
        assertTrue(idc.supportsInterface(0xb45a3c0e));
        assertTrue(idc.supportsInterface(0xef5f1e71));
        assertFalse(idc.supportsInterface(0xffffffff));
    }

    function test_OK_RentalUserClearedOnTransferAndBurnless() public {
        RentalPass rp = new RentalPass("https://r/", issuer);
        vm.prank(issuer);
        uint256 id = rp.mint(holder);
        vm.prank(holder);
        rp.setUser(id, stranger, uint64(block.timestamp + 1 days));
        assertEq(rp.passHolderOf(id), stranger);
        vm.prank(stranger);
        vm.expectRevert();
        rp.setUser(id, stranger, type(uint64).max); // renter cannot extend
        vm.prank(holder);
        rp.transferFrom(holder, buyer, id);
        assertEq(rp.userOf(id), address(0));
        assertEq(rp.userExpires(id), 0);
        assertEq(rp.passHolderOf(id), buyer);
    }

    function test_OK_SoulboundHolds() public {
        IdentityCredential idc = new IdentityCredential("https://i/", issuer);
        vm.prank(issuer);
        uint256 id = idc.issue(holder, keccak256("x"), uint64(block.timestamp + 1 days));
        vm.startPrank(holder);
        vm.expectRevert();
        idc.transferFrom(holder, buyer, id);
        vm.expectRevert();
        idc.safeTransferFrom(holder, buyer, id, "");
        vm.expectRevert();
        idc.approve(buyer, id);
        vm.expectRevert();
        idc.setApprovalForAll(buyer, true);
        vm.stopPrank();
        vm.prank(issuer);
        vm.expectRevert();
        idc.transferFrom(holder, issuer, id);
    }

    /// Fuzz: in any span of `windowSeconds` seconds the operator never gets
    /// more than 2 * maxPerWindow uses, and never moves more than 2 * cap.
    function testFuzz_OK_WindowNeverExceedsTwoX(uint32[40] memory gaps) public {
        MockERC20 usd = new MockERC20("USD", "USD", 6);
        StoredValueCard cards = new StoredValueCard("https://c/", issuer, IERC20(address(usd)), 10, 25e6, 50e6, 3);
        vm.startPrank(issuer);
        cards.setActionOperator(relayer, true);
        cards.setMerchant(cafe, true);
        uint256 id = cards.mint(holder);
        vm.stopPrank();
        _fund(cards, usd, id, 1_000_000e6);

        uint256[] memory times = new uint256[](40);
        uint256 n;
        for (uint256 i; i < 40; ++i) {
            vm.warp(block.timestamp + (gaps[i] % 30_000));
            vm.prank(relayer);
            try cards.charge(id, 25e6, cafe) {
                times[n++] = block.timestamp;
            } catch {}
        }
        for (uint256 i; i < n; ++i) {
            uint256 inSpan;
            for (uint256 j = i; j < n && times[j] <= times[i] + 1 days; ++j) {
                ++inSpan;
            }
            // Value per window 50 at 25 per call means at most 2 per window.
            assertLe(inSpan, 4);
        }
    }

    function test_OK_FrozenBoundCannotBeReenabledAfterDisable() public {
        PetPass pp = new PetPass("https://p/", issuer, 3 days);
        bytes32 feed = pp.FEED();
        vm.startPrank(issuer);
        pp.freezeActionBound(feed);
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionBoundFrozen.selector, feed));
        pp.configureAction(feed, 5, 1 days);
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionBoundFrozen.selector, feed));
        pp.configureAction(feed, 4, 1 days - 1);
        pp.configureAction(feed, 0, 0); // disable
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionBoundFrozen.selector, feed));
        pp.configureAction(feed, 1, type(uint32).max);
        vm.stopPrank();
    }

    function test_OK_StakingNoDoubleClaimOrClaimAfterBurn() public {
        MockERC721 apes = new MockERC721("Apes", "APE");
        MockERC20 rwd = new MockERC20("R", "R", 18);
        StakingPass sp = new StakingPass("https://s/", issuer, IERC721(address(apes)), IERC20(address(rwd)), 1e18);
        rwd.mint(address(sp), 100e18);
        uint256 ape = apes.mint(holder);
        vm.startPrank(holder);
        apes.approve(address(sp), ape);
        uint256 r = sp.stake(ape);
        vm.warp(block.timestamp + 150); // 150 owed, pool 100
        sp.unstake(r);
        vm.stopPrank();
        assertEq(rwd.balanceOf(holder), 100e18);
        assertEq(sp.owedRewards(holder), 50e18);
        vm.expectRevert();
        sp.claim(r);
        // Stranger cannot stake someone else's approved NFT.
        uint256 ape2 = apes.mint(holder);
        vm.prank(holder);
        apes.setApprovalForAll(address(sp), true);
        vm.prank(stranger);
        vm.expectRevert();
        sp.stake(ape2);
        // Refill covers only the owed reserve, not new claims.
        rwd.mint(address(sp), 50e18);
        assertEq(sp.rewardPool(), 0);
        vm.prank(holder);
        sp.claimOwed();
        assertEq(sp.totalOwed(), 0);
    }

    function test_OK_MembershipExactPaymentAndNoStrayEth() public {
        MembershipPass mp = new MembershipPass("https://m/", issuer);
        vm.startPrank(issuer);
        mp.setTierPrice(1, 1 ether);
        uint256 id = mp.grant(holder, 1, 1 days);
        vm.stopPrank();
        vm.deal(stranger, 10 ether);
        vm.startPrank(stranger);
        vm.expectRevert();
        mp.renew{value: 1.5 ether}(id, 1);
        (bool ok,) = address(mp).call{value: 1 ether}("");
        assertFalse(ok);
        mp.renew{value: 2 ether}(id, 2);
        vm.stopPrank();
        assertEq(mp.membership(id).expiresAt, uint64(block.timestamp + 1 days + 60 days));
    }

    function test_OK_CheckInOnceAndNotAfterEnd() public {
        EventTicketPass t = new EventTicketPass("https://t/", issuer, issuer, 500);
        address door = makeAddr("door");
        vm.startPrank(issuer);
        t.grantRole(t.DOOR_ROLE(), door);
        uint256 s = t.createShow(uint64(block.timestamp + 1 hours), uint64(block.timestamp + 5 hours), 2);
        uint256 id = t.mintTicket(s, holder);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert();
        t.checkIn(id);
        vm.startPrank(door);
        t.checkIn(id);
        vm.expectRevert(abi.encodeWithSelector(EventTicketPass.TicketAlreadyCheckedIn.selector, id));
        t.checkIn(id);
        vm.stopPrank();
        (address rcv, uint256 amt) = t.royaltyInfo(id, 10_000);
        assertEq(rcv, issuer);
        assertEq(amt, 500);
    }

    function test_OK_PetOperatorBoundedOwnerNot() public {
        PetPass pp = new PetPass("https://p/", issuer, 3 days);
        vm.startPrank(issuer);
        pp.setActionOperator(relayer, true);
        uint256 id = pp.mint(holder);
        vm.stopPrank();
        vm.startPrank(relayer);
        for (uint256 i; i < 4; ++i) {
            pp.feed(id);
        }
        vm.expectRevert();
        pp.feed(id);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionUnauthorizedOperator.selector, stranger));
        pp.feed(id);
        for (uint256 i; i < 10; ++i) {
            vm.prank(holder);
            pp.feed(id);
        }
    }
}
