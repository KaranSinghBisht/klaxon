// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {KlaxonRegistry} from "../src/KlaxonRegistry.sol";

contract KlaxonRegistryTest is Test {
    KlaxonRegistry internal registry;

    /// Stand-ins for the two Ledger addresses in the demo: the project operator and a stranger.
    address internal constant LEDGER = address(0x1ED6E9);
    address internal constant STRANGER = address(0xBEEF);

    bytes32 internal constant PID = keccak256("klaxon/demo-project");
    bytes32 internal constant POLICY = keccak256("klaxon.policy.json");

    event Registered(bytes32 indexed p, address owner);
    event PolicyCommitted(bytes32 indexed p, bytes32 hash);
    event Unrevoked(bytes32 indexed p, uint64 epoch);

    function setUp() public {
        registry = new KlaxonRegistry();
    }

    // --- register -----------------------------------------------------------------------------

    function test_register_setsOwnerAndEmits() public {
        vm.expectEmit(true, false, false, true);
        emit Registered(PID, LEDGER);

        vm.prank(LEDGER);
        registry.register(PID);

        assertEq(registry.owner(PID), LEDGER);
    }

    function test_register_secondCallReverts() public {
        vm.prank(LEDGER);
        registry.register(PID);

        vm.expectRevert(KlaxonRegistry.AlreadyRegistered.selector);
        vm.prank(LEDGER);
        registry.register(PID);
    }

    function test_register_secondCallRevertsForDifferentSender() public {
        vm.prank(LEDGER);
        registry.register(PID);

        vm.expectRevert(KlaxonRegistry.AlreadyRegistered.selector);
        vm.prank(STRANGER);
        registry.register(PID);

        assertEq(registry.owner(PID), LEDGER);
    }

    function test_register_distinctProjectsAreIndependent() public {
        bytes32 other = keccak256("klaxon/other-project");

        vm.prank(LEDGER);
        registry.register(PID);
        vm.prank(STRANGER);
        registry.register(other);

        assertEq(registry.owner(PID), LEDGER);
        assertEq(registry.owner(other), STRANGER);
    }

    // --- commitPolicy -------------------------------------------------------------------------

    function test_commitPolicy_storesAndEmits() public {
        vm.prank(LEDGER);
        registry.register(PID);

        vm.expectEmit(true, false, false, true);
        emit PolicyCommitted(PID, POLICY);

        vm.prank(LEDGER);
        registry.commitPolicy(PID, POLICY);

        assertEq(registry.policyHash(PID), POLICY);
    }

    function test_commitPolicy_nonOwnerReverts() public {
        vm.prank(LEDGER);
        registry.register(PID);

        vm.expectRevert(KlaxonRegistry.NotOwner.selector);
        vm.prank(STRANGER);
        registry.commitPolicy(PID, POLICY);

        assertEq(registry.policyHash(PID), bytes32(0));
    }

    function test_commitPolicy_unregisteredProjectReverts() public {
        vm.expectRevert(KlaxonRegistry.NotOwner.selector);
        vm.prank(LEDGER);
        registry.commitPolicy(PID, POLICY);
    }

    function test_commitPolicy_overwritesWithLatest() public {
        bytes32 second = keccak256("klaxon.policy.json@v2");

        vm.startPrank(LEDGER);
        registry.register(PID);
        registry.commitPolicy(PID, POLICY);
        registry.commitPolicy(PID, second);
        vm.stopPrank();

        assertEq(registry.policyHash(PID), second);
    }

    // --- unrevoke -----------------------------------------------------------------------------

    function test_unrevoke_advancesEpochAndEmits() public {
        vm.prank(LEDGER);
        registry.register(PID);

        vm.expectEmit(true, false, false, true);
        emit Unrevoked(PID, 1);

        vm.prank(LEDGER);
        registry.unrevoke(PID, 1);

        assertEq(registry.epoch(PID), 1);
    }

    function test_unrevoke_nonOwnerReverts() public {
        vm.prank(LEDGER);
        registry.register(PID);

        vm.expectRevert(KlaxonRegistry.NotOwner.selector);
        vm.prank(STRANGER);
        registry.unrevoke(PID, 1);

        assertEq(registry.epoch(PID), 0);
    }

    function test_unrevoke_equalEpochReverts() public {
        vm.startPrank(LEDGER);
        registry.register(PID);
        registry.unrevoke(PID, 7);

        vm.expectRevert(KlaxonRegistry.EpochNotIncreasing.selector);
        registry.unrevoke(PID, 7);
        vm.stopPrank();

        assertEq(registry.epoch(PID), 7);
    }

    function test_unrevoke_lowerEpochReverts() public {
        vm.startPrank(LEDGER);
        registry.register(PID);
        registry.unrevoke(PID, 7);

        vm.expectRevert(KlaxonRegistry.EpochNotIncreasing.selector);
        registry.unrevoke(PID, 6);
        vm.stopPrank();

        assertEq(registry.epoch(PID), 7);
    }

    function test_unrevoke_zeroFromZeroReverts() public {
        vm.startPrank(LEDGER);
        registry.register(PID);

        vm.expectRevert(KlaxonRegistry.EpochNotIncreasing.selector);
        registry.unrevoke(PID, 0);
        vm.stopPrank();
    }

    function test_unrevoke_maxEpochThenAnythingReverts() public {
        vm.startPrank(LEDGER);
        registry.register(PID);
        registry.unrevoke(PID, type(uint64).max);

        vm.expectRevert(KlaxonRegistry.EpochNotIncreasing.selector);
        registry.unrevoke(PID, type(uint64).max);
        vm.stopPrank();

        assertEq(registry.epoch(PID), type(uint64).max);
    }

    // --- fuzz ---------------------------------------------------------------------------------

    /// @dev Epoch monotonicity: a strictly greater epoch is accepted, anything else reverts and
    ///      leaves the stored epoch untouched.
    function testFuzz_unrevoke_epochMonotonicity(bytes32 p, uint64 first, uint64 second) public {
        vm.assume(first > 0);

        vm.startPrank(LEDGER);
        registry.register(p);
        registry.unrevoke(p, first);
        assertEq(registry.epoch(p), first);

        if (second > first) {
            registry.unrevoke(p, second);
            assertEq(registry.epoch(p), second);
        } else {
            vm.expectRevert(KlaxonRegistry.EpochNotIncreasing.selector);
            registry.unrevoke(p, second);
            assertEq(registry.epoch(p), first);
        }
        vm.stopPrank();
    }

    /// @dev A sequence of strictly increasing epochs always lands on the last one.
    function testFuzz_unrevoke_increasingSequenceAlwaysSucceeds(uint64[8] calldata deltas) public {
        vm.startPrank(LEDGER);
        registry.register(PID);

        uint64 current = 0;
        for (uint256 i = 0; i < deltas.length; i++) {
            uint64 delta = uint64(bound(deltas[i], 1, 1_000_000));
            current += delta;
            registry.unrevoke(PID, current);
            assertEq(registry.epoch(PID), current);
        }
        vm.stopPrank();
    }

    /// @dev Only the registering address can ever write to a project.
    function testFuzz_onlyOwnerCanWrite(address claimant, address caller, bytes32 p, bytes32 h)
        public
    {
        vm.assume(claimant != address(0));
        vm.assume(caller != claimant);

        vm.prank(claimant);
        registry.register(p);

        vm.expectRevert(KlaxonRegistry.NotOwner.selector);
        vm.prank(caller);
        registry.commitPolicy(p, h);

        vm.expectRevert(KlaxonRegistry.NotOwner.selector);
        vm.prank(caller);
        registry.unrevoke(p, 1);
    }
}
