// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @dev Derived from the Sourcify-verified source of mainnet 0xFe630e9EBF21f45Ff306CF2F9A33D9fa053573F2 (match 52153273).
/// @title IFWARewards
/// @notice The subset of the FWA V2 rewards module (mainnet 0xa54b44c7a894aa19c49734a753d01f9b8c5f6516)
///         this repo calls. The pool reports it as `rewards()`.
/// @dev Purchaser rewards are pooled per epoch, not paid per acquisition. A buyback funds each daily
///      epoch's pot, and the pot splits across every acquisition registered in that epoch that
///      allocated a listing. The module records the acquisition against the purchaser address when
///      the pool registers it, and the purchaser claims its share per epoch, once the epoch has closed.
///
///      `claimAccruedTokens` is a separate stream that belongs to the `acquire` caller, never to the
///      purchaser. When the caller is not the purchaser, the module reserves `builderRewardBps` of the
///      pool's acquisition protocol fee, and of the listing's final settlement protocol fee, as an ETH
///      allowance for that caller. The allowance is spent buying FWAToken. Its parameter is a
///      slippage bound on that buy, not an acquisition id.
interface IFWARewards {
    /// @notice Terminal status of one acquisition's reward record.
    enum AcquisitionRewardStatus {
        None,
        Pending,
        Settled,
        Refunded
    }

    /// @notice Claim this address's share of each listed epoch's purchaser pot. Reverts
    ///         `EpochNotClosed()` for an epoch still running, `EpochStillPending()` while any
    ///         acquisition registered in it is not yet terminal protocol-wide, and reverts on a second
    ///         claim of an epoch already claimed, which makes FWA's own record the double-claim guard.
    /// @return The FWAToken transferred to the caller.
    function claimEpochTokens(uint256[] calldata epochs) external returns (uint256);

    /// @notice One acquisition's reward record: the purchaser FWA credited, the epoch it was registered
    ///         in, its terminal status, the builder slice committed to it, and the `acquire` caller the
    ///         slice belongs to. The epoch is stamped at registration, so it is the epoch of the pull
    ///         rather than of the fulfilment.
    function acquisitionRewards(uint256 requestId)
        external
        view
        returns (address purchaser, uint64 epoch, uint8 status, uint256 tokenSlice, address caller);

    /// @notice The reward epoch in progress. Epochs are one day.
    function currentEpoch() external view returns (uint256);

    /// @notice Acquisitions `who` made in `epoch`: the numerator of their share of that epoch's pot.
    function userAcquisitionsInEpoch(uint256 epoch, address who) external view returns (uint256);

    /// @notice Acquisitions registered in `epoch` that settled with an allocated listing: the
    ///         denominator of `userAcquisitionsInEpoch`'s share. Refunded requests do not count.
    function acquisitionsInEpoch(uint256 epoch) external view returns (uint256);

    /// @notice Acquisitions registered in `epoch` but not yet terminal. `claimEpochTokens` reverts
    ///         `EpochStillPending()` while this is nonzero.
    function pendingAcquisitionsInEpoch(uint256 epoch) external view returns (uint256);

    /// @notice Whether `who` has already claimed `epoch`'s pot. `claimEpochTokens` reverts
    ///         `AlreadyClaimed()` if so.
    function purchaserClaimed(uint256 epoch, address who) external view returns (bool);

    /// @notice Whether `epoch`'s unclaimed pot has already been swept. `claimEpochTokens` reverts
    ///         `AlreadyClaimed()` if so.
    function purchaserEpochSwept(uint256 epoch) external view returns (bool);

    /// @notice The full purchaser pot `epoch` pays out, before dividing by `acquisitionsInEpoch`.
    function purchaserEpochAmount(uint256 epoch) external view returns (uint256);

    /// @notice Spend the caller's builder allowance buying FWAToken and send it to them. Reverts
    ///         `NoTokenReward()` when the allowance is zero.
    /// @param minOut Least FWAToken accepted from that buy.
    function claimAccruedTokens(uint256 minOut) external returns (uint256);

    /// @notice The caller's unspent builder allowance, in wei.
    function tokenBuyAllowance(address who) external view returns (uint256);

    /// @notice Every unspent builder allowance, in wei. This is the ETH the module is holding to spend
    ///         buying FWAToken on demand, so it is the ceiling on a buy anyone can route through
    ///         `claimAccruedTokens`.
    function tokenBuyAllowanceTotal() external view returns (uint256);
}
