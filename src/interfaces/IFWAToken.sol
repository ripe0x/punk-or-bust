// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @dev Derived from the Sourcify-verified source of mainnet 0xFe630e9EBF21f45Ff306CF2F9A33D9fa053573F2 (match 52153273).
/// @title IFWAToken
/// @notice The subset of the FWAToken the FWA V2 pool reports as `token()` that this repo calls.
/// @dev FWAToken locks transfers. A transfer succeeds only when the sender or the receiver is a
///      distributor, is the token owner, or is the Uniswap v4 PoolManager under a hook-granted transient
///      allowance. A contract that claims FWAToken and forwards it needs the distributor role on
///      itself or on the recipient.
interface IFWAToken {
    function balanceOf(address account) external view returns (uint256);

    function transfer(address to, uint256 amount) external returns (bool);

    function approve(address spender, uint256 amount) external returns (bool);

    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    /// @notice Whether `account` may move FWAToken while transfers are locked.
    function isDistributor(address account) external view returns (bool);
}
