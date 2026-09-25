// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @dev Derived from the Sourcify-verified source of mainnet 0xFe630e9EBF21f45Ff306CF2F9A33D9fa053573F2 (match 52153273).
/// @title IFWA
/// @notice The subset of the FWA V2 pool (mainnet 0x958C41181182e76F221331b2755b77D9e1426A98) this repo
///         calls. `IFWAV2` holds the acquisition entrypoint and the pool's other V2 reads.
/// @dev Every signature matches the verified pool source vendored under `refs/fwa-v2`. The pool sequences
///      acquisitions and settles them in request order through a permissionless `processAcquisitions`,
///      returns escrowed fees as pull credits, and keeps token rewards in a separate rewards module.
interface IFWA {
    /// @notice FWA listing lifecycle. Numeric values match the deployed enum.
    /// None 0, Active 1, Allocated 2, Withdrawn 3, Settled 4, Staged 5.
    enum ListingStatus {
        None,
        Active,
        Allocated,
        Withdrawn,
        Settled,
        Staged
    }

    /// @notice FWA acquisition lifecycle. Numeric values match the deployed enum.
    /// @dev Terminal for this integration: Fulfilled, Expired, Refunded. `Pending`, `Ready`, and `TimedOut`
    ///      all still need the request to reach the head of the sequence in `processAcquisitions`.
    enum AcquisitionStatus {
        None,
        Pending, // waiting for an on-time word
        Fulfilled, // a listing was allocated
        Expired, // skipped in sequence past its word deadline; escrowed fee became a pull credit
        Refunded, // empty pool or price drift; escrowed fee became a pull credit
        Ready, // an on-time word is cached and waiting for its turn in the sequence
        TimedOut // a word arrived after the deadline; skipped when it reaches the head
    }

    /* ------------------------------------------------------------------ */
    /*                               QUOTING                               */
    /* ------------------------------------------------------------------ */

    /// @notice Depositor pool fee plus VRF service fee for one acquisition.
    /// @dev The `vrf` leg is derived from `tx.gasprice`, so an off-chain quote must use the gas price it
    ///      intends to send. `acquire` also drains the staging queue before pricing, so the fee read by a
    ///      static call can differ from the fee charged inside the same transaction.
    function quoteAcquisitionPrice() external view returns (uint256 fee, uint256 vrf, uint256 total);

    /// @notice Current depositor pool fee, excluding the VRF service fee.
    function acquisitionFee() external view returns (uint256);

    /// @notice Issued VRF requests whose authenticated Chainlink callback has not arrived. Local expiry
    ///         does not reduce it, because Chainlink may still fulfill and bill the subscription later.
    ///         The external VRF service reserves callback coverage per request in `acquire`, so a
    ///         nonzero value is the signal to pace acquisitions to fulfillment.
    function unfulfilledVrfCount() external view returns (uint256);

    /// @notice Share of a position's backing paid out when the purchaser takes the bid, in bps.
    function settlementDiscountBps() external view returns (uint256);

    /// @notice Sum of backing across active listings, weighted by selection weight.
    function weightedBackingTotal() external view returns (uint256);

    /// @notice Sum of selection weight across active listings. Zero means no listing can be selected.
    function totalWeight() external view returns (uint256);

    /// @notice Listings currently in the selection tree. A caller buying several acquisitions at
    ///         once needs this rather than `totalWeight`: weight is inverse to backing, so a large
    ///         `totalWeight` can still be one listing, and every acquisition removes the listing it
    ///         takes.
    function activeListingCount() external view returns (uint256);

    /* ------------------------------------------------------------------ */
    /*                             ACQUISITION                             */
    /* ------------------------------------------------------------------ */

    /// @notice Permissionlessly move staged listings into the active pool before quoting.
    /// @dev The live `acquire` performs its own bounded staging drain before pricing. Calling this first,
    ///      then quoting again, gives exact-payment integrations a stable preparation path.
    function activateListings(uint256 maxCount) external;

    /// @notice Settle the ready or expired prefix of the acquisition sequence. Permissionless; the caller
    ///         only picks a gas bound. This is what moves a `Ready` or `TimedOut` request to a terminal
    ///         state, and what expires a `Pending` head once it passes its word deadline.
    function processAcquisitions(uint256 maxCount) external returns (uint256 processed);

    /// @notice Take the caller's accumulated acquisition refund credits. Escrowed fees returned by expiry,
    ///         an empty pool, or price drift arrive as credits, not as a transfer.
    function withdrawAcquisitionRefund() external returns (uint256 amount);

    /// @notice Acquisition refund credit owed to `purchaser`.
    function acquisitionRefundCredit(address purchaser) external view returns (uint256);

    /// @notice Blocks after a request before its word deadline lapses.
    function selectionTimeoutBlocks() external view returns (uint256);

    /// @notice Acquisition record. `priceEscrowed` stays populated after a refund, so it is the exact
    ///         amount credited back to the purchaser.
    function acquisitions(uint256 requestId)
        external
        view
        returns (address purchaser, uint256 requestBlock, uint256 priceEscrowed, uint256 listingId, uint8 status);

    /* ------------------------------------------------------------------ */
    /*                               LISTINGS                              */
    /* ------------------------------------------------------------------ */

    /// @notice Listing record. Field order matches the deployed struct.
    function listings(uint256 listingId)
        external
        view
        returns (
            address collection,
            address depositor,
            address purchaser,
            uint256 tokenId,
            uint256 weight,
            uint256 value,
            uint256 feeShare,
            uint256 feeDebt,
            uint256 slot,
            uint64 allocatedAt,
            uint8 status
        );

    /// @notice Address entitled to pull an NFT whose settlement delivery failed.
    function stuckNFTRecipient(uint256 listingId) external view returns (address);

    /// @notice Seconds the purchaser holds an exclusive settlement right after allocation.
    function settlementWindow() external view returns (uint256);

    /// @notice Seconds after allocation before anyone may finalize an unsettled listing.
    function finalizeWindow() external view returns (uint256);

    /// @notice The FWAToken address FWA settles in. Zero until the token is wired up.
    function token() external view returns (address);

    /// @notice The rewards module FWA registers acquisitions against. Zero until it is wired up.
    /// @dev Read rather than passed in so a deployment cannot be pointed at a rewards module the core
    ///      does not actually credit. `setRewards` is one-time on the live core, so this is fixed.
    function rewards() external view returns (address);

    /* ------------------------------------------------------------------ */
    /*                       PURCHASER SETTLEMENT                          */
    /* ------------------------------------------------------------------ */

    /// @notice Purchaser takes the NFT. Backing returns to the depositor. Strict: reverts if the ERC721
    ///         transfer to the purchaser fails.
    function keepNFT(uint256 listingId) external;

    /// @notice Purchaser accepts the depositor bid and receives it as FWAToken bought from the pool.
    /// @param minOut Slippage guard on the FWAToken received.
    function acceptBidAsTokens(uint256 listingId, uint256 minOut) external returns (uint256 tokenOut);

    /// @notice Purchaser sells the position back for ETH: receives `settlementDiscountBps` of the
    ///         backing, and the NFT returns to the depositor. `acceptBidAsTokens` spends a separately
    ///         configured `tokenSettlementDiscountBps` of the backing on FWAToken instead.
    /// @dev No enable flag. FWA's own comment: "Available the whole time the listing is allocated."
    ///      That is why this is the fallback: `acceptBidAsTokens` can be switched off by FWA's owner
    ///      (`acceptBidAsTokensEnabled`), and this cannot.
    function acceptDepositorBid(uint256 listingId) external;

    /// @notice Pull an NFT whose settlement delivery failed. Caller must be the recorded stuck recipient.
    function recoverStuckNFT(uint256 listingId) external;
}
