// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {KlaxonRegistry} from "../src/KlaxonRegistry.sol";

/// @title Deploy
/// @notice Deploys `KlaxonRegistry` from a throwaway funded EOA.
/// @dev `DEPLOY_KEY` is a burner private key funded from a faucet (Sepolia) or with ~$0.30 of ETH
///      (Base mainnet). **It is never the Ledger.** The device only ever calls
///      `register` / `commitPolicy` / `unrevoke` on the deployed address; keeping deployment on a
///      software key means the registry can be redeployed as many times as needed without a
///      single hardware approval.
///
///      The logged block number is the watcher's `DEPLOY_BLOCK` — the `getLogs` cursor starts
///      there, so record it alongside the address.
///
///      ```
///      forge script script/Deploy.s.sol:Deploy --rpc-url sepolia --broadcast --verify \
///        --private-key "$DEPLOY_KEY" --etherscan-api-key "$ETHERSCAN_API_KEY"
///      ```
contract Deploy is Script {
    function run() external returns (KlaxonRegistry registry) {
        uint256 deployKey = vm.envUint("DEPLOY_KEY");

        vm.startBroadcast(deployKey);
        registry = new KlaxonRegistry();
        vm.stopBroadcast();

        console2.log("KlaxonRegistry deployed");
        console2.log("  address:  %s", address(registry));
        console2.log("  chainId:  %s", block.chainid);
        console2.log("  block:    %s", block.number);
        console2.log("  deployer: %s", vm.addr(deployKey));
        console2.log("Record the block number as DEPLOY_BLOCK for the witness getLogs cursor.");
    }
}
