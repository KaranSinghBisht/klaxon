// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {DemoUSD} from "../src/demo/DemoUSD.sol";
import {TokenTreasury} from "../src/demo/TokenTreasury.sol";

/// Deploys DemoUSD + a TokenTreasury with the DEMO deployer key — the one the worm steals — and mints
/// the treasury its balance. Real Sepolia, real Etherscan, any denomination, cents of gas.
///   DEPLOYER_PRIVATE_KEY=0x… TREASURY_FUND_UNITS=12400000000 forge script script/DeployDemoToken.s.sol --rpc-url sepolia --broadcast
/// (12400000000 = 12,400 dUSD at 6 decimals.)
contract DeployDemoToken is Script {
    function run() external {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint256 fund = vm.envOr("TREASURY_FUND_UNITS", uint256(12_400_000_000));
        vm.startBroadcast(key);
        DemoUSD token = new DemoUSD();
        TokenTreasury t = new TokenTreasury(address(token));
        token.mint(address(t), fund);
        vm.stopBroadcast();
        console.log("DemoUSD:", address(token));
        console.log("TokenTreasury:", address(t));
        console.log("owner:", t.owner());
        console.log("treasury balance (dUSD units):", t.balance());
    }
}
