// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {PetPass} from "../src/examples/PetPass.sol";
import {StoredValueCard} from "../src/examples/StoredValueCard.sol";
import {StakingPass} from "../src/examples/StakingPass.sol";
import {EventTicketPass} from "../src/examples/EventTicketPass.sol";
import {MembershipPass} from "../src/examples/MembershipPass.sol";
import {IdentityCredential} from "../src/examples/IdentityCredential.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockERC721} from "../src/mocks/MockERC721.sol";

/// @title DeployExamples
/// @notice Deploys every example and both mocks to a LOCAL chain (anvil) and
///  logs the addresses. The mocks allow open minting, so never point this at
///  a public network.
/// @dev Run against anvil, signing with anvil's first unlocked dev account:
///
///    anvil
///    pnpm run deploy:local   (from packages/contracts)
///
///  The deploy:local package script broadcasts through anvil's unlocked
///  account, so no private key is involved.
///
///  Environment (all optional):
///  - OPERATOR: the issuer operator (relayer or session key) appointed on
///    PetPass and StoredValueCard, and granted DOOR_ROLE on EventTicketPass.
///    Defaults to anvil's second dev account.
///  - PASS_BASE_URL: origin the pass base URIs are built on. Defaults to
///    http://localhost:3000.
contract DeployExamples is Script {
    /// @dev Public address of anvil's second default dev account. Only the
    ///  address is used here; no key is referenced.
    address internal constant DEFAULT_OPERATOR = 0x70997970C51812dC3A010c7D01b50e20d4DC79c8;

    struct Deployment {
        MockERC20 stablecoin;
        MockERC20 rewardToken;
        MockERC721 collection;
        PetPass petPass;
        StoredValueCard storedValueCard;
        StakingPass stakingPass;
        EventTicketPass eventTicketPass;
        MembershipPass membershipPass;
        IdentityCredential identityCredential;
    }

    function run() external returns (Deployment memory d) {
        address operator = vm.envOr("OPERATOR", DEFAULT_OPERATOR);
        string memory origin = vm.envOr("PASS_BASE_URL", string("http://localhost:3000"));

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        d = _deploy(deployer, operator, origin);
        vm.stopBroadcast();

        console2.log("chainId", block.chainid);
        console2.log("deployer", deployer);
        console2.log("operator", operator);
        console2.log("MockERC20 (stablecoin, 6 dp)", address(d.stablecoin));
        console2.log("MockERC20 (reward, 18 dp)", address(d.rewardToken));
        console2.log("MockERC721 (stakeable)", address(d.collection));
        console2.log("PetPass", address(d.petPass));
        console2.log("StoredValueCard", address(d.storedValueCard));
        console2.log("StakingPass", address(d.stakingPass));
        console2.log("EventTicketPass", address(d.eventTicketPass));
        console2.log("MembershipPass", address(d.membershipPass));
        console2.log("IdentityCredential", address(d.identityCredential));
    }

    function _deploy(address deployer, address operator, string memory origin) internal returns (Deployment memory d) {
        d.stablecoin = new MockERC20("Mock USD", "mUSD", 6);
        d.rewardToken = new MockERC20("Mock Reward", "mRWD", 18);
        d.collection = new MockERC721("Mock Friends", "mFRND");

        d.petPass = new PetPass(_base(origin), deployer, 3 days);
        d.petPass.setPassBaseURI(_base(origin, address(d.petPass)));
        d.petPass.setActionOperator(operator, true);

        // $25 per charge, $100 per day, 20 charges per day, 10 punches per reward.
        d.storedValueCard = new StoredValueCard(
            _base(origin), deployer, IERC20(address(d.stablecoin)), 10, 25e6, 100e6, 20
        );
        d.storedValueCard.setPassBaseURI(_base(origin, address(d.storedValueCard)));
        d.storedValueCard.setActionOperator(operator, true);
        d.storedValueCard.setMerchant(operator, true);

        d.stakingPass = new StakingPass(
            _base(origin), deployer, IERC721(address(d.collection)), IERC20(address(d.rewardToken)), 1e18 / uint256(1 days)
        );
        d.stakingPass.setPassBaseURI(_base(origin, address(d.stakingPass)));
        d.rewardToken.mint(address(d.stakingPass), 1_000_000e18);

        d.eventTicketPass = new EventTicketPass(_base(origin), deployer, deployer, 500);
        d.eventTicketPass.setPassBaseURI(_base(origin, address(d.eventTicketPass)));
        d.eventTicketPass.grantRole(d.eventTicketPass.DOOR_ROLE(), operator);

        d.membershipPass = new MembershipPass(_base(origin), deployer);
        d.membershipPass.setPassBaseURI(_base(origin, address(d.membershipPass)));
        d.membershipPass.setTierPrice(1, 0.01 ether);

        d.identityCredential = new IdentityCredential(_base(origin), deployer);
        d.identityCredential.setPassBaseURI(_base(origin, address(d.identityCredential)));
    }

    /// @dev Placeholder base used at construction, before the address is known.
    function _base(string memory origin) internal pure returns (string memory) {
        return string.concat(origin, "/wallet-pass/");
    }

    /// @dev The recommended base shape: origin/wallet-pass/eip155/<chainId>/<contract>/
    function _base(string memory origin, address collection) internal view returns (string memory) {
        return string.concat(
            origin, "/wallet-pass/eip155/", vm.toString(block.chainid), "/", vm.toString(collection), "/"
        );
    }
}
