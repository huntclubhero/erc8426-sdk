// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {DeployExamples} from "../script/DeployExamples.s.sol";

/// @dev Smoke test: the deploy script runs end to end and wires roles.
contract DeployExamplesTest is Test {
    function test_DeploysAndWires() public {
        DeployExamples script = new DeployExamples();
        DeployExamples.Deployment memory d = script.run();
        address operator = 0x70997970C51812dC3A010c7D01b50e20d4DC79c8;

        assertTrue(d.petPass.isActionOperator(operator));
        assertTrue(d.storedValueCard.isActionOperator(operator));
        assertTrue(d.stakingPass.isActionOperator(operator));
        assertTrue(d.storedValueCard.isMerchant(operator));
        assertTrue(d.eventTicketPass.hasRole(d.eventTicketPass.DOOR_ROLE(), operator));
        assertEq(d.rewardToken.balanceOf(address(d.stakingPass)), 1_000_000e18);
        assertEq(
            d.petPass.passBaseURI(),
            string.concat(
                "http://localhost:3000/wallet-pass/eip155/", vm.toString(block.chainid), "/", vm.toString(address(d.petPass)), "/"
            )
        );
        assertTrue(d.identityCredential.supportsInterface(0xef5f1e71));
    }
}
