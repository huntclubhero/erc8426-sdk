// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {IERC1155Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {ERC1155WalletPass} from "../src/ERC1155WalletPass.sol";
import {IERC1155WalletPass} from "../src/IERC1155WalletPass.sol";
import {IERC721WalletPass} from "../src/IERC721WalletPass.sol";
import {SwapOnRedeemTicket} from "../src/examples/SwapOnRedeemTicket.sol";

/// @dev Exposes the base's internals with no access control, for tests.
contract WalletPass1155Harness is ERC1155WalletPass {
    constructor(string memory base) ERC1155("https://meta.example/{id}.json") ERC1155WalletPass(base) {}

    function mint(address to, uint256 id, uint256 amount) external {
        _mint(to, id, amount, "");
    }

    function burn(address from, uint256 id, uint256 amount) external {
        _burn(from, id, amount);
    }

    function passUpdate(uint256 id) external {
        _passUpdate(id);
    }

    function batchPassUpdate(uint256 from, uint256 to) external {
        _batchPassUpdate(from, to);
    }

    function setPassBaseURI(string calldata base) external {
        _setPassBaseURI(base);
    }
}

/// @dev Opts into the transfer-time pass update.
contract LoudTransfer1155Harness is WalletPass1155Harness {
    constructor(string memory base) WalletPass1155Harness(base) {}

    function _passUpdateOnTransfer() internal pure override returns (bool) {
        return true;
    }
}

/// @dev The check a Pass Issuer must NOT rely on: entitlement by a fresh
///  balance read plus a record of use kept against the account.
contract RecordAgainstAccountDoor {
    ERC1155 internal immutable ticket;
    mapping(uint256 id => mapping(address account => bool)) public admitted;

    constructor(ERC1155 ticket_) {
        ticket = ticket_;
    }

    function admit(uint256 id) external returns (bool) {
        if (ticket.balanceOf(msg.sender, id) < 1) return false;
        if (admitted[id][msg.sender]) return false;
        admitted[id][msg.sender] = true;
        return true;
    }
}

contract ERC1155WalletPassTest is Test {
    event PassUpdate(uint256 indexed id);
    event BatchPassUpdate(uint256 fromId, uint256 toId);
    event PassBaseURIUpdated(string newPassBaseURI);

    bytes32 internal constant PASS_UPDATE_SIG = keccak256("PassUpdate(uint256)");

    string internal constant BASE = "https://passes.example/wallet-pass/eip155/31337/0xColl/";

    WalletPass1155Harness internal pass;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        pass = new WalletPass1155Harness(BASE);
    }

    function _passUpdateCount(Vm.Log[] memory logs) internal pure returns (uint256 n) {
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == PASS_UPDATE_SIG) ++n;
        }
    }

    // Interface ids

    /// The fact behind the draft's open question: the 1155 interface has the
    /// same members as the 721 one, so ERC-165 cannot tell them apart.
    function test_InterfaceIdEqualsThe721Value() public pure {
        assertEq(type(IERC1155WalletPass).interfaceId, bytes4(0xef5f1e71));
        assertEq(type(IERC1155WalletPass).interfaceId, type(IERC721WalletPass).interfaceId);
    }

    function test_SupportsInterfaces() public view {
        assertTrue(pass.supportsInterface(0xef5f1e71));
        assertTrue(pass.supportsInterface(0x01ffc9a7)); // ERC-165
        assertTrue(pass.supportsInterface(0xd9b67a26)); // ERC-1155
        assertTrue(pass.supportsInterface(0x0e89341c)); // ERC-1155 metadata URI
        assertFalse(pass.supportsInterface(0x80ac58cd)); // not ERC-721: how a Client tells the binding
        assertFalse(pass.supportsInterface(0xffffffff));
    }

    // passURI

    function test_PassURIIsBasePlusDecimalId() public {
        pass.mint(alice, 42, 3);
        assertEq(pass.passURI(42), string.concat(BASE, "42"));
    }

    function test_PassURIIsTheSameForEveryHolder() public {
        pass.mint(alice, 42, 1);
        pass.mint(bob, 42, 5);
        vm.prank(alice);
        string memory a = pass.passURI(42);
        vm.prank(bob);
        string memory b = pass.passURI(42);
        assertEq(a, b);
    }

    function test_PassURIRevertsForAnIdWithNoSupply() public {
        vm.expectRevert(abi.encodeWithSelector(ERC1155WalletPass.ERC1155WalletPassNonexistentId.selector, uint256(7)));
        pass.passURI(7);
    }

    function test_PassURIRevertsOnceTheLastUnitIsBurned() public {
        pass.mint(alice, 7, 2);
        pass.burn(alice, 7, 1);
        assertEq(pass.passURI(7), string.concat(BASE, "7"));
        pass.burn(alice, 7, 1);
        vm.expectRevert(abi.encodeWithSelector(ERC1155WalletPass.ERC1155WalletPassNonexistentId.selector, uint256(7)));
        pass.passURI(7);
    }

    function test_PassURIRevertsWithoutABase() public {
        WalletPass1155Harness empty = new WalletPass1155Harness("");
        empty.mint(alice, 1, 1);
        vm.expectRevert(ERC1155WalletPass.ERC1155WalletPassNoPassBaseURI.selector);
        empty.passURI(1);
        vm.expectEmit(false, false, false, true);
        emit PassBaseURIUpdated(BASE);
        empty.setPassBaseURI(BASE);
        assertEq(empty.passURI(1), string.concat(BASE, "1"));
        assertEq(empty.passBaseURI(), BASE);
    }

    // Events

    function test_PassUpdateEmits() public {
        vm.expectEmit(true, false, false, false);
        emit PassUpdate(9);
        pass.passUpdate(9);
    }

    function test_BatchPassUpdateEmitsAndRefusesAnInvertedRange() public {
        vm.expectEmit(false, false, false, true);
        emit BatchPassUpdate(3, 8);
        pass.batchPassUpdate(3, 8);
        vm.expectRevert(
            abi.encodeWithSelector(ERC1155WalletPass.ERC1155WalletPassInvalidRange.selector, uint256(8), uint256(3))
        );
        pass.batchPassUpdate(8, 3);
    }

    function test_TransfersAreQuietByDefault() public {
        vm.recordLogs();
        pass.mint(alice, 1, 3);
        vm.prank(alice);
        pass.safeTransferFrom(alice, bob, 1, 1, "");
        pass.burn(bob, 1, 1);
        assertEq(_passUpdateCount(vm.getRecordedLogs()), 0);
    }

    function test_OptInEmitsOnePassUpdatePerMovedId() public {
        LoudTransfer1155Harness loud = new LoudTransfer1155Harness(BASE);
        loud.mint(alice, 1, 3);
        loud.mint(alice, 2, 3);
        uint256[] memory ids = new uint256[](2);
        ids[0] = 1;
        ids[1] = 2;
        uint256[] memory values = new uint256[](2);
        values[0] = 1;
        values[1] = 2;
        vm.recordLogs();
        vm.prank(alice);
        loud.safeBatchTransferFrom(alice, bob, ids, values, "");
        assertEq(_passUpdateCount(vm.getRecordedLogs()), 2);
    }

    // Entitlement reads the binding relies on

    /// Selling one of three leaves an account at or above a minimum of 1:
    /// the read an issuer takes still passes for the seller.
    function test_SellingOneOfThreeKeepsTheSellerAtTheMinimum() public {
        pass.mint(alice, 5, 3);
        vm.prank(alice);
        pass.safeTransferFrom(alice, bob, 5, 1, "");
        assertGe(pass.balanceOf(alice, 5), 1);
        assertGe(pass.balanceOf(bob, 5), 1);
    }

    /// balanceOfBatch over the accounts an issuer issued passes to gives the
    /// crossing without indexing transfer events.
    function test_BalanceOfBatchOverIssuedAccountsShowsWhoFellBelowTheMinimum() public {
        pass.mint(alice, 5, 1);
        pass.mint(bob, 5, 2);
        vm.prank(alice);
        pass.safeTransferFrom(alice, makeAddr("carol"), 5, 1, "");
        address[] memory issued = new address[](2);
        issued[0] = alice;
        issued[1] = bob;
        uint256[] memory ids = new uint256[](2);
        ids[0] = 5;
        ids[1] = 5;
        uint256[] memory balances = pass.balanceOfBatch(issued, ids);
        assertEq(balances[0], 0);
        assertEq(balances[1], 2);
    }

    // A balance is not a unit

    /// The problem, executable: one unit admits two accounts when use is
    /// recorded against the account.
    function test_ARecordAgainstTheAccountAdmitsOneUnitTwice() public {
        RecordAgainstAccountDoor door = new RecordAgainstAccountDoor(pass);
        pass.mint(alice, 77, 1);

        vm.prank(alice);
        assertTrue(door.admit(77));
        vm.prank(alice);
        assertFalse(door.admit(77));

        vm.prank(alice);
        pass.safeTransferFrom(alice, bob, 77, 1, "");
        vm.prank(bob);
        assertTrue(door.admit(77));
        assertEq(pass.totalSupply(77), 1);
    }

    /// One close: the use exchanges the unit for a used id in the same
    /// transaction, so the unit that moves on fails the live id's read.
    function test_SwapOnRedeemRefusesTheUnitThatMovedOn() public {
        SwapOnRedeemTicket ticket = new SwapOnRedeemTicket("https://meta.example/{id}.json", BASE, address(this));
        ticket.mint(alice, 77, 1);

        vm.prank(alice);
        ticket.redeem(77);
        assertEq(ticket.balanceOf(alice, 77), 0);
        assertEq(ticket.balanceOf(alice, ticket.usedId(77)), 1);

        uint256 used = ticket.usedId(77);
        vm.prank(alice);
        ticket.safeTransferFrom(alice, bob, used, 1, "");
        assertEq(ticket.balanceOf(bob, 77), 0);

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC1155Errors.ERC1155InsufficientBalance.selector, bob, uint256(0), uint256(1), uint256(77)
            )
        );
        ticket.redeem(77);
    }

    function test_SwapOnRedeemUsesOneUnitOfSeveral() public {
        SwapOnRedeemTicket ticket = new SwapOnRedeemTicket("https://meta.example/{id}.json", BASE, address(this));
        ticket.mint(alice, 77, 3);
        vm.prank(alice);
        ticket.redeem(77);
        assertEq(ticket.balanceOf(alice, 77), 2);
        assertEq(ticket.balanceOf(alice, ticket.usedId(77)), 1);
        assertEq(ticket.totalSupply(77), 2);
    }

    function test_SwapOnRedeemRefusesAUsedIdAsLive() public {
        SwapOnRedeemTicket ticket = new SwapOnRedeemTicket("https://meta.example/{id}.json", BASE, address(this));
        uint256 used = ticket.usedId(77);
        vm.expectRevert(abi.encodeWithSelector(SwapOnRedeemTicket.SwapOnRedeemTicketNotLiveId.selector, used));
        ticket.mint(alice, used, 1);
        vm.expectRevert(abi.encodeWithSelector(SwapOnRedeemTicket.SwapOnRedeemTicketNotLiveId.selector, used));
        ticket.usedId(used);
    }

    function test_SwapOnRedeemAUsedIdHasNoPassEndpoint() public {
        SwapOnRedeemTicket ticket = new SwapOnRedeemTicket("https://meta.example/{id}.json", BASE, address(this));
        ticket.mint(alice, 77, 1);
        assertEq(ticket.passURI(77), string.concat(BASE, "77"));
        vm.prank(alice);
        ticket.redeem(77);
        // The used id has supply now, and still no pass.
        uint256 used = ticket.usedId(77);
        assertEq(ticket.totalSupply(used), 1);
        vm.expectRevert(abi.encodeWithSelector(SwapOnRedeemTicket.SwapOnRedeemTicketNotLiveId.selector, used));
        ticket.passURI(used);
    }

    function test_OptInIsNotTriggeredByATransferOfZeroUnits() public {
        LoudTransfer1155Harness loud = new LoudTransfer1155Harness(BASE);
        loud.mint(alice, 1, 3);
        vm.recordLogs();
        // Anyone, holding nothing, can send zero units of any id.
        vm.prank(bob);
        loud.safeTransferFrom(bob, alice, 1, 0, "");
        vm.prank(bob);
        loud.safeTransferFrom(bob, alice, 999, 0, "");
        assertEq(_passUpdateCount(vm.getRecordedLogs()), 0);
    }

    function test_SwapOnRedeemOnlyTheOwnerMints() public {
        SwapOnRedeemTicket ticket = new SwapOnRedeemTicket("https://meta.example/{id}.json", BASE, address(this));
        vm.prank(alice);
        vm.expectRevert();
        ticket.mint(alice, 1, 1);
    }
}
