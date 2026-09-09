// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @notice The minimal slice of ERC-20 the treasury needs to sweep itself.
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title TokenTreasury (demo victim, token edition)
/// @notice The token-holding twin of `Treasury`. Its only privileged action is `withdraw()`, gated on
///         the deployer key — the secret that is a plain CI variable in `ordinary-repo` and
///         Key-Ring-protected in `klaxon-repo`. `withdraw()` sweeps the whole token balance to the
///         owner: exactly what a stolen deployer key does, and what goes to zero on camera.
contract TokenTreasury {
    address public immutable owner;
    IERC20 public immutable token;

    event Withdrawn(address indexed to, uint256 amount);

    error NotOwner();
    error TransferFailed();

    constructor(address token_) {
        owner = msg.sender;
        token = IERC20(token_);
    }

    function balance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// @notice Sweep the entire token balance to the owner. This is what a stolen deployer key does.
    function withdraw() external {
        if (msg.sender != owner) revert NotOwner();
        uint256 amount = token.balanceOf(address(this));
        emit Withdrawn(msg.sender, amount);
        if (!token.transfer(msg.sender, amount)) revert TransferFailed();
    }
}
