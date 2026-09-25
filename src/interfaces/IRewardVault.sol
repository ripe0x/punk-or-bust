// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @dev Derived from the Sourcify-verified source of mainnet 0xEa20a110ad3Dfc483977d14f80203994E65D34FB (match 51606642).
/// @title IRewardVault
/// @notice The shared FWAT reward vault calls this repo makes. The factory is a "series" the vault
///         owner allowlists; each vault is a "round" with one locked share for its owner.
interface IRewardVault {
    function token() external view returns (address);
    function seriesAllowed(address series) external view returns (bool);
    function seriesOf(address round) external view returns (address);

    /// @notice Series only. Reverts unless the calling series is allowlisted, answers
    ///         `isRound(round)`, and `round.series()` names it.
    function registerRound(address round) external;

    /// @notice Registered round only, before its shares lock.
    function updateShare(address account, uint256 amount) external;

    /// @notice Registered round only. `total` must equal the round's share total.
    function lockShares(uint256 total) external;

    /// @notice Registered, locked round only. Calls back `collectRewards` on the round and credits the
    ///         measured FWAT it received.
    function harvest(uint256[] calldata epochs, bool accrued, uint256 minOut) external returns (uint256 amount);

    function claimable(address round, address account) external view returns (uint256);

    /// @notice Anyone may deliver an account's claim; it always pays that account.
    function claim(address round, address account) external;
}
