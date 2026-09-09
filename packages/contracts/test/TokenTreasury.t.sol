// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DemoUSD} from "../src/demo/DemoUSD.sol";
import {TokenTreasury} from "../src/demo/TokenTreasury.sol";

contract TokenTreasuryTest is Test {
    DemoUSD token;
    TokenTreasury treasury;
    address attacker = address(0xBAD);

    // 12,400 dUSD at 6 decimals — the number that reads on camera.
    uint256 constant FUND = 12_400_000_000;

    function setUp() public {
        token = new DemoUSD();
        treasury = new TokenTreasury(address(token));
        token.mint(address(treasury), FUND);
    }

    function test_setUp_fundsTheTreasury() public view {
        assertEq(treasury.balance(), FUND);
        assertEq(treasury.owner(), address(this));
        assertEq(token.balanceOf(address(treasury)), FUND);
    }

    function test_withdraw_sweepsEverythingToOwner() public {
        uint256 before = token.balanceOf(address(this));
        treasury.withdraw();
        assertEq(treasury.balance(), 0);
        assertEq(token.balanceOf(address(this)), before + FUND);
    }

    function test_withdraw_emitsWithdrawn() public {
        vm.expectEmit(true, false, false, true, address(treasury));
        emit TokenTreasury.Withdrawn(address(this), FUND);
        treasury.withdraw();
    }

    function test_withdraw_nonOwnerReverts() public {
        vm.prank(attacker);
        vm.expectRevert(TokenTreasury.NotOwner.selector);
        treasury.withdraw();
        assertEq(treasury.balance(), FUND);
    }

    function test_mint_onlyMinter() public {
        vm.prank(attacker);
        vm.expectRevert(DemoUSD.NotMinter.selector);
        token.mint(attacker, 1);
    }

    function test_erc20_transferAndAllowance() public {
        token.mint(address(this), 100);
        assertTrue(token.transfer(attacker, 40));
        assertEq(token.balanceOf(attacker), 40);

        token.approve(attacker, 25);
        vm.prank(attacker);
        assertTrue(token.transferFrom(address(this), attacker, 25));
        assertEq(token.balanceOf(attacker), 65);
        assertEq(token.allowance(address(this), attacker), 0);
    }

    function test_erc20_insufficientBalanceReverts() public {
        vm.prank(attacker);
        vm.expectRevert(DemoUSD.InsufficientBalance.selector);
        token.transfer(address(this), 1);
    }
}
