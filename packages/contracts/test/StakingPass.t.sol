// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {StakingPass} from "../src/examples/StakingPass.sol";
import {BoundedAction} from "../src/utils/BoundedAction.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockERC721} from "../src/mocks/MockERC721.sol";

contract StakingPassTest is Test {
    event PassUpdate(uint256 indexed tokenId);
    event Claimed(uint256 indexed receiptId, address indexed to, uint256 amount);

    uint256 internal constant RATE = uint256(1e18) / 1 days; // about one token per day

    MockERC721 internal nfts;
    MockERC20 internal reward;
    StakingPass internal staking;
    address internal issuer = makeAddr("issuer");
    address internal holder = makeAddr("holder");
    address internal buyer = makeAddr("buyer");
    address internal relayer = makeAddr("relayer");
    uint256 internal nftId;

    function setUp() public {
        vm.warp(1_700_000_000);
        nfts = new MockERC721("Friends", "FRND");
        reward = new MockERC20("Reward", "RWD", 18);
        staking = new StakingPass("https://stake.example/", issuer, IERC721(address(nfts)), IERC20(address(reward)), RATE);
        reward.mint(address(staking), 1_000e18);
        vm.prank(issuer);
        staking.setActionOperator(relayer, true);
        nftId = nfts.mint(holder);
    }

    function _stake() internal returns (uint256 receiptId) {
        vm.startPrank(holder);
        nfts.approve(address(staking), nftId);
        receiptId = staking.stake(nftId);
        vm.stopPrank();
    }

    function test_StakeMintsReceiptAndEmitsPassUpdate() public {
        vm.startPrank(holder);
        nfts.approve(address(staking), nftId);
        vm.expectEmit(true, false, false, true, address(staking));
        emit PassUpdate(1);
        uint256 receiptId = staking.stake(nftId);
        vm.stopPrank();

        assertEq(staking.ownerOf(receiptId), holder);
        assertEq(nfts.ownerOf(nftId), address(staking));
        assertEq(staking.position(receiptId).stakedTokenId, nftId);
        assertTrue(staking.supportsInterface(0xef5f1e71));
    }

    function test_CannotStakeSomeoneElsesNft() public {
        vm.expectRevert();
        vm.prank(relayer);
        staking.stake(nftId);
    }

    function test_RewardsAccrue() public {
        uint256 r = _stake();
        vm.warp(block.timestamp + 1 days);
        assertEq(staking.pendingRewards(r), RATE * 1 days);
    }

    function test_OperatorClaimPaysOnlyOwner() public {
        uint256 r = _stake();
        vm.warp(block.timestamp + 1 days);
        uint256 expected = RATE * 1 days;

        vm.expectEmit(true, true, false, true, address(staking));
        emit Claimed(r, holder, expected);
        vm.expectEmit(true, false, false, true, address(staking));
        emit PassUpdate(r);
        vm.prank(relayer); // the issuer's relayer, following a pass link
        staking.claim(r);

        assertEq(reward.balanceOf(holder), expected);
        assertEq(reward.balanceOf(relayer), 0);
        assertEq(staking.pendingRewards(r), 0);
    }

    function test_RepeatedClaimIsBoundedByAccrual() public {
        uint256 r = _stake();
        vm.warp(block.timestamp + 1 days);
        vm.prank(relayer);
        staking.claim(r);
        vm.expectRevert(StakingPass.StakingNothingToClaim.selector);
        vm.prank(relayer);
        staking.claim(r);
    }

    function testFuzz_ClaimsNeverExceedAccrual(uint32[6] memory gaps) public {
        uint256 r = _stake();
        uint256 start = block.timestamp;
        for (uint256 i; i < gaps.length; ++i) {
            vm.warp(block.timestamp + bound(gaps[i], 0, 30 days));
            // Some claims revert (nothing accrued yet); only the totals matter.
            vm.prank(holder);
            (bool ok,) = address(staking).call(abi.encodeCall(StakingPass.claim, (r)));
            ok;
        }
        assertLe(reward.balanceOf(holder), (block.timestamp - start) * RATE);
        assertEq(reward.balanceOf(holder) + staking.pendingRewards(r), (block.timestamp - start) * RATE);
    }

    function test_ClaimPaysCurrentOwnerAfterSale() public {
        uint256 r = _stake();
        vm.warp(block.timestamp + 1 days);
        vm.prank(holder);
        staking.transferFrom(holder, buyer, r);
        vm.prank(relayer);
        staking.claim(r);
        assertEq(reward.balanceOf(buyer), RATE * 1 days);
        assertEq(reward.balanceOf(holder), 0);
    }

    function test_ClaimRevertsWhenPoolShort() public {
        StakingPass dry = new StakingPass("", issuer, IERC721(address(nfts)), IERC20(address(reward)), RATE);
        vm.startPrank(holder);
        nfts.approve(address(dry), nftId);
        uint256 r = dry.stake(nftId);
        vm.stopPrank();
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(abi.encodeWithSelector(StakingPass.StakingInsufficientRewardPool.selector, RATE * 1 days, 0));
        vm.prank(holder);
        dry.claim(r);
    }

    function test_StrangerCannotClaim() public {
        uint256 r = _stake();
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionUnauthorizedOperator.selector, buyer));
        vm.prank(buyer);
        staking.claim(r);
    }

    function test_OwnerAndApprovedCanClaim() public {
        uint256 r = _stake();
        vm.warp(block.timestamp + 1 days);
        vm.prank(holder);
        staking.claim(r);
        vm.prank(holder);
        staking.approve(buyer, r);
        vm.warp(block.timestamp + 1 days);
        vm.prank(buyer); // approved: still pays the owner
        staking.claim(r);
        assertEq(reward.balanceOf(holder), 2 * RATE * 1 days);
        assertEq(reward.balanceOf(buyer), 0);
    }

    function test_OperatorClaimsAreRateLimited() public {
        uint256 r = _stake();
        vm.startPrank(relayer);
        for (uint256 i; i < 24; ++i) {
            vm.warp(block.timestamp + 60);
            staking.claim(r);
        }
        vm.warp(block.timestamp + 60);
        vm.expectRevert();
        staking.claim(r);
        vm.stopPrank();
    }

    function test_OwnerRevokesClaimOperator() public {
        uint256 r = _stake();
        vm.warp(block.timestamp + 1 days);
        vm.prank(holder);
        staking.setAllOperatorsRevoked(r, true);
        vm.expectRevert(abi.encodeWithSelector(BoundedAction.BoundedActionOperatorRevoked.selector, r, relayer));
        vm.prank(relayer);
        staking.claim(r);
    }

    function test_UnstakeReturnsNftAndPays() public {
        uint256 r = _stake();
        vm.warp(block.timestamp + 2 days);
        vm.expectEmit(true, false, false, true, address(staking));
        emit PassUpdate(r);
        vm.prank(holder);
        staking.unstake(r);

        assertEq(nfts.ownerOf(nftId), holder);
        assertEq(reward.balanceOf(holder), RATE * 2 days);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, r));
        staking.ownerOf(r);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, r));
        staking.passURI(r);
    }

    function test_OnlyOwnerCanUnstake() public {
        uint256 r = _stake();
        vm.expectRevert(abi.encodeWithSelector(StakingPass.StakingNotReceiptOwner.selector, r, relayer));
        vm.prank(relayer);
        staking.unstake(r);

        // Even an approved account cannot: unstake burns, which no link may do.
        vm.prank(holder);
        staking.approve(relayer, r);
        vm.expectRevert(abi.encodeWithSelector(StakingPass.StakingNotReceiptOwner.selector, r, relayer));
        vm.prank(relayer);
        staking.unstake(r);
    }

    function test_UnstakeNeverBlocksOnEmptyPool() public {
        StakingPass dry = new StakingPass("", issuer, IERC721(address(nfts)), IERC20(address(reward)), RATE);
        vm.startPrank(holder);
        nfts.approve(address(dry), nftId);
        uint256 r = dry.stake(nftId);
        vm.warp(block.timestamp + 1 days);
        dry.unstake(r);
        vm.stopPrank();

        assertEq(nfts.ownerOf(nftId), holder);
        uint256 owed = RATE * 1 days;
        assertEq(dry.owedRewards(holder), owed);
        assertEq(dry.totalOwed(), owed);

        vm.expectRevert(abi.encodeWithSelector(StakingPass.StakingInsufficientRewardPool.selector, owed, 0));
        vm.prank(holder);
        dry.claimOwed();

        reward.mint(address(dry), owed);
        assertEq(dry.rewardPool(), 0); // owed amounts are reserved
        vm.prank(holder);
        dry.claimOwed();
        assertEq(reward.balanceOf(holder), owed);
        assertEq(dry.totalOwed(), 0);

        vm.expectRevert(StakingPass.StakingNothingToClaim.selector);
        vm.prank(holder);
        dry.claimOwed();
    }

    function test_RestakeMintsNewReceipt() public {
        uint256 r = _stake();
        vm.prank(holder);
        staking.unstake(r);
        uint256 r2 = _stake();
        assertEq(r2, r + 1);
    }
}
