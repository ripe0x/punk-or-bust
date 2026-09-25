// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @dev Derived from the Sourcify-verified source of mainnet 0xFe630e9EBF21f45Ff306CF2F9A33D9fa053573F2 (match 52153273).
/// @title IFWAV2
/// @notice The FWA V2 pool's acquisition entrypoint and the sequencing, blackout and fee reads that sit
///         beside it. Every other pool call this repo makes goes through `IFWA` against the same
///         address. `ListingStatus` and `AcquisitionStatus` in `IFWA` match the deployed enums,
///         including `Staged`, `Ready`, and `TimedOut`.
interface IFWAV2 {
    /// @notice Opens `count` acquisitions and credits them to `purchaser`, which need not be the
    ///         caller. `purchaser` holds the settlement rights, the refund credit, and the reward
    ///         registration for every request in the batch; the caller funds the call and receives
    ///         the overpayment above `count * quoteAcquisitionPrice().total`. The rewards module
    ///         gives the caller a builder share of the protocol fee only when it is not the purchaser.
    /// @param maxAcquisitionFee Reverts if the live pool fee exceeds this. Zero disables the check.
    /// @param minWeightedValue Reverts if `weightedBackingTotal` is below this. Zero disables the check.
    /// @param maxNegativeSlippageBps Downward fee drift tolerated when the request reaches the head
    ///        of the sequence. Drift past it credits a refund instead of allocating a listing.
    ///        Upward drift is bounded by the pool's own `selectionSlippageBps`, snapshotted at this
    ///        call.
    function acquire(
        address purchaser,
        uint256 count,
        uint256 maxAcquisitionFee,
        uint256 minWeightedValue,
        uint256 maxNegativeSlippageBps
    ) external payable returns (uint256[] memory requestIds);

    /// @notice True while `acquire` reverts on a new request. Callbacks, ordered processing,
    ///         settlement, and exits stay open.
    function isPurchaseBlackout() external view returns (bool);

    /// @notice Per-request VRF service fee, the second leg of `quoteAcquisitionPrice`.
    function vrfServiceFee() external view returns (uint256);

    /// @notice Share of backing spent on FWAToken by `acceptBidAsTokens`. Set independently of
    ///         `settlementDiscountBps`, which rates the ETH payout.
    function tokenSettlementDiscountBps() external view returns (uint256);

    /// @notice Symmetric upward fee-drift tolerance the pool snapshots onto every new request.
    function selectionSlippageBps() external view returns (uint256);

    /// @notice Per-request sequencing record. `sequence` is the request's place in the pool's FIFO,
    ///         `wordDeadlineBlock` the block after which an arriving word is too late,
    ///         `rewardEpoch` the epoch the acquisition was registered in, the two bps fields the
    ///         drift tolerances snapshotted at request time, and `randomWord` the Chainlink word
    ///         once a callback has written it, zero before that.
    function acquisitionMeta(uint256 requestId)
        external
        view
        returns (
            uint64 sequence,
            uint64 wordDeadlineBlock,
            uint64 rewardEpoch,
            uint16 maxPositiveSlippageBps,
            uint16 maxNegativeSlippageBps,
            uint256 randomWord
        );

    /// @notice Recomputes the pool's outstanding-callback counter from its own records. Permissionless.
    function reconcileUnfulfilledVrfCount() external returns (uint256 reconciled);
}
