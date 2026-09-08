// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title Treasury (demo victim)
/// @notice The contract that drains on camera. Its only privileged action is `withdraw()`, gated on
///         the deployer key — the secret that sits in `ordinary-repo`'s CI as a plain variable and is
///         Key-Ring-protected in `klaxon-repo`. Nothing about this contract is part of the protocol;
///         it exists so the cold open has a balance that goes to zero.
contract Treasury {
    address public immutable owner;

    event Withdrawn(address indexed to, uint256 amount);

    error NotOwner();
    error TransferFailed();

    constructor() {
        owner = msg.sender;
    }

    receive() external payable {}

    /// @notice Sweep the entire balance to the owner. This is what a stolen deployer key does.
    function withdraw() external {
        if (msg.sender != owner) revert NotOwner();
        uint256 amount = address(this).balance;
        emit Withdrawn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
