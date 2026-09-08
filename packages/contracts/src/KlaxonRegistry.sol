// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title KlaxonRegistry
/// @author KLAXON
/// @notice On-chain anchor for KLAXON projects: who owns a project, which release policy is in
///         force, and which revocation epoch is current.
/// @dev **Every state change on this contract is signed by a Ledger hardware device.**
///
///      The owner of a project is the operator's Ledger address. `register` is permissionless
///      first-write-wins, so the operator claims a project id by being the first to call it from
///      the device. Afterwards `commitPolicy` and `unrevoke` are gated on `msg.sender == owner[p]`,
///      which means they can only be executed by a transaction the device physically approved.
///
///      The contract is never deployed by the Ledger. Deployment uses a throwaway funded EOA
///      (`script/Deploy.s.sol`), keeping the device out of the build loop entirely. The device is
///      only ever the *caller*, via:
///
///      ```
///      wallet-cli send -a <label> --to <registry> --amount "0 ETH" --data 0x... --output json
///      ```
///
///      where `--data` is the ABI-encoded call produced by `scripts/calldata.sh` (or viem's
///      `encodeFunctionData`). Until the ERC-7730 descriptor in `erc7730/` is merged into
///      LedgerHQ's clear-signing registry, the Ethereum app shows this as a blind signature, so
///      Blind signing must be enabled on the device.
///
///      Nothing here is upgradeable and nothing here holds value: the contract stores three
///      mappings and emits three events. A watcher (`packages/witness`) follows the events with
///      `getLogs` and a persisted cursor; `verify` reads the same events with a keyless RPC.
contract KlaxonRegistry {
    /// @notice Project id => the Ledger address that claimed it. Set once, by `register`.
    mapping(bytes32 => address) public owner;

    /// @notice Project id => `sha256` of the exact committed bytes of `klaxon.policy.json`.
    mapping(bytes32 => bytes32) public policyHash;

    /// @notice Project id => current revocation epoch. Monotonically increasing.
    mapping(bytes32 => uint64) public epoch;

    /// @notice A project id was claimed. `owner` is the device address that claimed it.
    event Registered(bytes32 indexed p, address owner);

    /// @notice A release policy was committed for a project. `hash` is `sha256(policy bytes)`.
    event PolicyCommitted(bytes32 indexed p, bytes32 hash);

    /// @notice A revocation was lifted by advancing the project's epoch.
    event Unrevoked(bytes32 indexed p, uint64 epoch);

    /// @notice `msg.sender` is not the registered owner of the project.
    error NotOwner();

    /// @notice The project id has already been claimed.
    error AlreadyRegistered();

    /// @notice The supplied epoch is not strictly greater than the current one.
    error EpochNotIncreasing();

    /// @notice Claim a project id. Permissionless, first-write-wins.
    /// @dev Called from the Ledger so that `owner[p]` becomes the device address. D19 recommends
    ///      running this in the same device session as the first `commitPolicy` — two approvals
    ///      back to back, one trip to the drawer.
    /// @param p The project id, `sha256(repository_id || 0x00 || rootId)`.
    function register(bytes32 p) external {
        if (owner[p] != address(0)) revert AlreadyRegistered();
        owner[p] = msg.sender;
        emit Registered(p, msg.sender);
    }

    /// @notice Commit the release policy hash for a project. Device-signed by the owner.
    /// @param p The project id.
    /// @param h `sha256` of the exact committed bytes of `klaxon.policy.json`.
    function commitPolicy(bytes32 p, bytes32 h) external {
        if (owner[p] != msg.sender) revert NotOwner();
        policyHash[p] = h;
        emit PolicyCommitted(p, h);
    }

    /// @notice Lift a revocation by advancing the project's epoch. Device-signed by the owner.
    /// @dev Strictly increasing: an equal or lower epoch reverts with `EpochNotIncreasing`, so a
    ///      replayed or reordered transaction can never walk the epoch backwards.
    /// @param p The project id.
    /// @param e The new epoch. Must be strictly greater than `epoch[p]`.
    function unrevoke(bytes32 p, uint64 e) external {
        if (owner[p] != msg.sender) revert NotOwner();
        if (e <= epoch[p]) revert EpochNotIncreasing();
        epoch[p] = e;
        emit Unrevoked(p, e);
    }
}
