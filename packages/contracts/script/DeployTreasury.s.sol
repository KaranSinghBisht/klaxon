// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Treasury} from "../src/demo/Treasury.sol";

/// Deploys the demo Treasury with the DEMO deployer key — the one the worm steals — and funds it.
///   DEPLOYER_PRIVATE_KEY=0x… TREASURY_FUND_WEI=50000000000000000 forge script script/DeployTreasury.s.sol --rpc-url sepolia --broadcast
contract DeployTreasury is Script {
    function run() external {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint256 fund = vm.envOr("TREASURY_FUND_WEI", uint256(0));
        vm.startBroadcast(key);
        Treasury t = new Treasury();
        if (fund > 0) {
            (bool ok,) = address(t).call{value: fund}("");
            require(ok, "fund failed");
        }
        vm.stopBroadcast();
        console.log("Treasury:", address(t));
        console.log("owner:", t.owner());
        console.log("balance (wei):", address(t).balance);
    }
}
