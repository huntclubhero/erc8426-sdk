// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {IERC721WalletPass} from "../src/IERC721WalletPass.sol";
import {IERC721WalletPassIssuer} from "../src/IERC721WalletPassIssuer.sol";
import {IssuerCommitmentHarness, WalletPassHarness} from "./harness/Harnesses.sol";

/// The OPTIONAL issuer identity commitment of ERC-8426.
contract ERC721WalletPassIssuerTest is Test {
    event PassIssuerUpdated(string newPassIssuer);

    string internal constant IDENTITY =
        '{"apple":{"teamIdentifier":"A1B2C3D4E5","passTypeIdentifier":"pass.example.card"},"google":{"issuerId":"3388000000012345678"}}';

    IssuerCommitmentHarness internal pass;

    function setUp() public {
        pass = new IssuerCommitmentHarness("https://p.example/", IDENTITY);
    }

    /// The identifier the specification states, which is the selector of the
    ///  interface's only function, and distinct from the base interface's.
    function test_InterfaceIdEqualsSpecValue() public pure {
        assertEq(type(IERC721WalletPassIssuer).interfaceId, bytes4(0x470be7e9));
        assertEq(IERC721WalletPassIssuer.passIssuer.selector, bytes4(0x470be7e9));
        assertTrue(type(IERC721WalletPassIssuer).interfaceId != type(IERC721WalletPass).interfaceId);
    }

    function test_SupportsBothInterfaces() public view {
        assertTrue(pass.supportsInterface(0x470be7e9));
        assertTrue(pass.supportsInterface(0xef5f1e71));
        assertTrue(pass.supportsInterface(0x01ffc9a7));
        assertFalse(pass.supportsInterface(0xffffffff));
    }

    /// A contract that does not commit does not claim the interface.
    function test_BaseDoesNotClaimTheCommitment() public {
        WalletPassHarness plain = new WalletPassHarness("https://p.example/");
        assertFalse(plain.supportsInterface(0x470be7e9));
    }

    function test_PassIssuerReturnsTheCommittedJson() public view {
        assertEq(pass.passIssuer(), IDENTITY);
    }

    /// Changing the committed identity is a transaction, and it is logged.
    function test_SetPassIssuerReplacesAndEmits() public {
        string memory next = '{"google":{"issuerId":"3388000000099999999"}}';
        vm.expectEmit(false, false, false, true, address(pass));
        emit PassIssuerUpdated(next);
        pass.setPassIssuer(next);
        assertEq(pass.passIssuer(), next);
    }

    /// Without a committed identity the view refuses rather than returning a
    ///  string that is not the JSON object the specification requires.
    function test_PassIssuerRevertsWhileUnset() public {
        IssuerCommitmentHarness unset = new IssuerCommitmentHarness("https://p.example/", "");
        vm.expectRevert(abi.encodeWithSignature("ERC721WalletPassNoPassIssuer()"));
        unset.passIssuer();
        unset.setPassIssuer(IDENTITY);
        assertEq(unset.passIssuer(), IDENTITY);
    }
}
