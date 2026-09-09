// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title DemoUSD (dUSD) — a throwaway stand-in for a stablecoin
/// @notice The treasury holds *tokens*, not ether, for one practical reason: a Sepolia faucet gives
///         fractions of an ETH a day, so "12.4 ETH drains to zero" cannot be staged honestly on a
///         real explorer. A token the demo mints to itself can read any denomination — "12,400 dUSD
///         → 0" on real Etherscan — while the only ETH anyone needs is a few cents of gas. Six
///         decimals so it prints like USDC. Nothing here is part of the protocol; it exists so the
///         cold open has a balance that goes to zero on a chain a judge can check.
contract DemoUSD {
    string public constant name = "Demo USD";
    string public constant symbol = "dUSD";
    uint8 public constant decimals = 6;

    address public immutable minter;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error NotMinter();
    error InsufficientBalance();
    error InsufficientAllowance();

    constructor() {
        minter = msg.sender;
    }

    /// @notice Only the deployer mints — the demo funds its own treasury and nobody else's.
    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < amount) revert InsufficientAllowance();
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        uint256 bal = balanceOf[from];
        if (bal < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = bal - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }
}
