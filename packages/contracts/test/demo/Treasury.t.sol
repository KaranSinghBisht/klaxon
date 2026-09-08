// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Treasury} from "../../src/demo/Treasury.sol";

contract TreasuryTest is Test {
    Treasury internal t;
    address internal deployer = makeAddr("deployer");
    address internal thief = makeAddr("thief");

    function setUp() public {
        vm.prank(deployer);
        t = new Treasury();
        vm.deal(address(t), 12.4 ether);
    }

    function test_ownerDrainsEverything() public {
        vm.prank(deployer);
        t.withdraw();
        assertEq(address(t).balance, 0);
        assertEq(deployer.balance, 12.4 ether);
    }

    function test_nonOwnerReverts() public {
        vm.prank(thief);
        vm.expectRevert(Treasury.NotOwner.selector);
        t.withdraw();
        assertEq(address(t).balance, 12.4 ether);
    }

    function test_receivesEth() public {
        vm.deal(thief, 1 ether);
        vm.prank(thief);
        (bool ok,) = address(t).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(t).balance, 13.4 ether);
    }
}
