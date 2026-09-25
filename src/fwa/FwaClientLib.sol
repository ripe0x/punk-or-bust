// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

import {IFWA} from "../interfaces/IFWA.sol";
import {IFWARewards} from "../interfaces/IFWARewards.sol";
import {IFWAToken} from "../interfaces/IFWAToken.sol";
import {IFWAV2} from "../interfaces/IFWAV2.sol";

/// @dev Derived from the Sourcify-verified source of mainnet 0xFe630e9EBF21f45Ff306CF2F9A33D9fa053573F2 (match 52153273).
/// @title FwaClientLib
/// @notice FWA V2 acquisition, settlement, delivery, recovery and reward calls for a contract that is
///         FWA's purchaser of record. Public functions run by `DELEGATECALL` in the caller's own
///         address, so every FWA call is made by that contract and `address(this)` is the purchaser
///         FWA keys settlement rights, refund credit and reward registration on.
/// @dev Stateless: the calling contract holds the ETH, the request ids, the listing ids and the record
///      of what it has already resolved.
///
///      The purchaser invariant is checked where the call depends on it: `acquire` asserts FWA
///      credited this address, `status` and `classifyForced` revert when the record names another
///      purchaser, and the epoch claim reads the rewards module under this address. The builder
///      allowance is not claimed here: it belongs to the `acquire` caller, never to the purchaser.
///
///      The calling contract must implement `onERC721Received`: `keepAndForward` and `recoverStuck`
///      move the NFT through it. `keepAndForward` leaves the token with the named recipient inside the same
///      call, and both prove the transfer landed by reading `ownerOf` under a gas bound.
///
///      This library holds no reentrancy guard. Every external function must be called from an
///      entrypoint the calling contract itself guards with `nonReentrant`. `keepAndForward` reenters
///      the calling contract through `onERC721Received` when FWA's `keepNFT` delivers the NFT by
///      `safeTransferFrom`, before `forwardOwned` runs.
library FwaClientLib {
    /// @notice How a listing FWA has already settled resolved for this address. `None`: the listing
    ///         is in another state. `StuckNft`: FWA holds the NFT and names this address as its
    ///         recipient, so `recoverStuck` pulls it. `ForcedNft`: this address owns the NFT.
    ///         `ForcedEth`: another address owns the NFT and FWA paid the backing here.
    ///         `ForcedUnknown`: the collection did not answer `ownerOf`.
    enum ForcedKind {
        None,
        StuckNft,
        ForcedNft,
        ForcedEth,
        ForcedUnknown
    }

    /// @notice The listing fields a caller prices and delivers from. Field order follows
    ///         `IFWA.listings`.
    struct ListingSnapshot {
        address collection;
        address depositor;
        address purchaser;
        uint256 tokenId;
        uint256 value;
        uint64 allocatedAt;
        uint8 status;
    }

    uint256 internal constant OWNER_OF_GAS = 35_000;
    uint256 internal constant RESTRICTION_PROBE_GAS = 30_000;

    /// @notice FWA's own token-pack collections. Both settle as ETH.
    address internal constant LOCKED_FWA_TOKEN_PACKS = 0x470879Abd61FdCA91436fE27ed87dB2c8650f3e7;
    address internal constant FWA_TOKEN_PACKS = 0x727C739F07A89f11E883FE0F34937c55e4c3d74A;

    /// @notice FWA recorded a purchaser for the request or listing other than this address.
    error WrongPurchaser();
    /// @notice `quoteAcquisitionPrice` returned legs that do not sum to its own total.
    error InvalidDependency();
    /// @notice The value passed to `acquire` is below the quoted total.
    error InsufficientPayment();
    /// @notice FWA returned a batch whose length is not the one request this call asked for.
    error UnexpectedBatchSize();
    /// @notice The NFT is not owned by the recipient after the transfer, or the collection did not
    ///         answer `ownerOf`.
    error OwnershipUnproven();
    /// @notice An ERC721 or FWAToken transfer failed, or returned a non-success word.
    error TokenTransferFailed();
    /// @notice The withdrawn refund differs from the credit FWA reported before the call.
    error RefundMismatch();
    /// @notice FWA names an address other than this one as the listing's stuck-NFT recipient.
    error NotStuckRecipient();
    /// @notice FWAToken transfers are locked and the distributor role sits on neither this address
    ///         nor the custodian, so a claimed amount has no route to the custodian.
    error FwatCustodyUnavailable();
    /// @notice A claim was passed an empty epoch list.
    error EmptyEpochList();
    /// @notice A claim was passed epochs that are not strictly increasing.
    error EpochsNotStrictlyIncreasing();
    /// @notice A recipient or custodian argument is the zero address.
    error ZeroAddress();

    /* ------------------------------------------------------------------ */
    /*                             ACQUISITION                             */
    /* ------------------------------------------------------------------ */

    /// @notice FWA's live acquisition price: the pool fee leg, the VRF service fee leg, and their
    ///         total. The VRF leg is derived from `tx.gasprice`, so an off-chain quote must use the
    ///         gas price it intends to send.
    function quote(address fwa) public view returns (uint256 fee, uint256 vrf, uint256 total) {
        (fee, vrf, total) = IFWA(fwa).quoteAcquisitionPrice();
        if (fee + vrf != total) revert InvalidDependency();
    }

    /// @notice Whether an acquisition can be opened now and what it costs. `unfulfilledVrf` is the
    ///         pacing signal: callbacks FWA's VRF service still covers. `priced` is also false during
    ///         the purchase blackout, when `acquire` reverts.
    function readiness(address fwa)
        public
        view
        returns (bool priced, uint256 totalRequired, uint256 unfulfilledVrf, uint256 activeListings)
    {
        (,, uint256 total) = IFWA(fwa).quoteAcquisitionPrice();
        priced = total != 0;
        if (IFWAV2(fwa).isPurchaseBlackout()) priced = false;
        totalRequired = total;
        unfulfilledVrf = IFWA(fwa).unfulfilledVrfCount();
        activeListings = IFWA(fwa).activeListingCount();
    }

    /// @notice Opens one acquisition funded with `value` from this address's balance, with this
    ///         address as both caller and purchaser, so it earns no builder reward. The quoted pool
    ///         fee becomes FWA's own fee cap, so a fee that moves between the quote and the
    ///         acquisition reverts the call. The pool's own `selectionSlippageBps` bounds downward
    ///         fee drift as well as upward.
    /// @param value ETH forwarded to FWA. FWA returns the amount above the price it charges inside
    ///        the call, so `spent` is the measured balance delta.
    /// @return requestId FWA's acquisition id.
    /// @return spent ETH this call cost, net of FWA's in-call return of overpayment.
    function acquire(address fwa, uint256 value) public returns (uint256 requestId, uint256 spent) {
        (uint256 feeCap,, uint256 total) = quote(fwa);
        if (value < total) revert InsufficientPayment();

        uint256 balanceBefore = address(this).balance;
        uint256[] memory requestIds =
            IFWAV2(fwa).acquire{value: value}(address(this), 1, feeCap, 0, IFWAV2(fwa).selectionSlippageBps());
        if (requestIds.length != 1) revert UnexpectedBatchSize();
        requestId = requestIds[0];
        spent = balanceBefore - address(this).balance;

        (address purchaser,,,,) = IFWA(fwa).acquisitions(requestId);
        if (purchaser != address(this)) revert WrongPurchaser();
    }

    /// @notice The request's escrowed price, allocated listing and lifecycle status.
    ///         `acquisitionStatus` is an `IFWA.AcquisitionStatus`; `Fulfilled`, `Expired` and
    ///         `Refunded` are terminal.
    function status(address fwa, uint256 requestId)
        public
        view
        returns (uint256 priceEscrowed, uint256 listingId, uint8 acquisitionStatus)
    {
        address purchaser;
        (purchaser,, priceEscrowed, listingId, acquisitionStatus) = IFWA(fwa).acquisitions(requestId);
        if (purchaser != address(this)) revert WrongPurchaser();
    }

    /// @notice The listing record FWA allocated to a request.
    function listing(address fwa, uint256 listingId) public view returns (ListingSnapshot memory snapshot) {
        (
            address collection,
            address depositor,
            address purchaser,
            uint256 tokenId,,
            uint256 value,,,,
            uint64 allocatedAt,
            uint8 listingStatus
        ) = IFWA(fwa).listings(listingId);
        snapshot = ListingSnapshot({
            collection: collection,
            depositor: depositor,
            purchaser: purchaser,
            tokenId: tokenId,
            value: value,
            allocatedAt: allocatedAt,
            status: listingStatus
        });
    }

    /// @notice Classifies a listing FWA settled. The caller records the result and acts on it:
    ///         `StuckNft` calls `recoverStuck`, `ForcedNft` calls `forwardOwned`, `ForcedEth` means
    ///         the backing arrived on this address as ETH, and `ForcedUnknown` means the collection
    ///         did not answer `ownerOf` and an operator decides.
    /// @dev Answers `None` while the listing is in any other state, so a caller can call this on an
    ///      allocated listing to check whether it still holds the settlement right.
    function classifyForced(address fwa, uint256 listingId) public view returns (ForcedKind kind) {
        (address collection,, address purchaser, uint256 tokenId,,,,,,, uint8 listingStatus) =
            IFWA(fwa).listings(listingId);
        if (purchaser != address(this)) revert WrongPurchaser();
        if (listingStatus != uint8(IFWA.ListingStatus.Settled)) return ForcedKind.None;
        if (IFWA(fwa).stuckNFTRecipient(listingId) == address(this)) return ForcedKind.StuckNft;

        (bool proven, address owner) = _tryOwnerOf(collection, tokenId);
        if (!proven) return ForcedKind.ForcedUnknown;
        return owner == address(this) ? ForcedKind.ForcedNft : ForcedKind.ForcedEth;
    }

    /* ------------------------------------------------------------------ */
    /*                             SETTLEMENT                              */
    /* ------------------------------------------------------------------ */

    /// @notice Takes FWA's depositor bid: this address receives `settlementDiscountBps` of the
    ///         listing's backing and the NFT returns to the depositor.
    /// @return proceeds The measured ETH this address gained.
    function settleForEth(address fwa, uint256 listingId) public returns (uint256 proceeds) {
        uint256 balanceBefore = address(this).balance;
        IFWA(fwa).acceptDepositorBid(listingId);
        proceeds = address(this).balance - balanceBefore;
    }

    /// @notice Takes the NFT from an allocated listing and sends it to `to` in the same call. The
    ///         backing returns to the depositor. The caller decides routing policy and must check
    ///         `forcesEthSettlement` before calling this for a collection that forces ETH
    ///         settlement; this function performs no such check.
    /// @dev `keepNFT` transfers to this address, so the calling contract receives the token and must
    ///      implement `onERC721Received`.
    function keepAndForward(address fwa, uint256 listingId, address to) public {
        if (to == address(0)) revert ZeroAddress();
        (address collection,,, uint256 tokenId,,,,,,,) = IFWA(fwa).listings(listingId);
        IFWA(fwa).keepNFT(listingId);
        forwardOwned(collection, tokenId, to);
    }

    /// @notice Sends an NFT this address owns to `to` and proves the transfer landed.
    /// @dev The transfer is a raw `transferFrom` call: a collection that answers with a word must
    ///      answer `true`, and one that answers with no data is accepted, which is what ERC721
    ///      implementations in the wild do. The `ownerOf` read after it is the proof, under a gas
    ///      bound so a collection cannot consume the whole call.
    function forwardOwned(address collection, uint256 tokenId, address to) public {
        if (to == address(0)) revert ZeroAddress();
        bytes memory callData =
            abi.encodeWithSignature("transferFrom(address,address,uint256)", address(this), to, tokenId);
        bool ok;
        uint256 returnSize;
        uint256 returnValue;
        assembly ("memory-safe") {
            ok := call(gas(), collection, 0, add(callData, 0x20), mload(callData), 0, 0)
            returnSize := returndatasize()
            if eq(returnSize, 0x20) {
                returndatacopy(0, 0, 0x20)
                returnValue := mload(0)
            }
        }
        if (!ok || (returnSize != 0 && (returnSize != 32 || returnValue != 1))) revert TokenTransferFailed();

        (bool proven, address owner) = _tryOwnerOf(collection, tokenId);
        if (!proven || owner != to) revert OwnershipUnproven();
    }

    /// @notice Pulls an NFT whose FWA delivery failed and which FWA records this address as the
    ///         recipient of. The token stays on this address; `forwardOwned` moves it on.
    /// @dev Reverting an unproven recovery restores FWA's own retry entitlement.
    function recoverStuck(address fwa, uint256 listingId) public {
        if (IFWA(fwa).stuckNFTRecipient(listingId) != address(this)) revert NotStuckRecipient();
        (address collection,,, uint256 tokenId,,,,,,,) = IFWA(fwa).listings(listingId);
        IFWA(fwa).recoverStuckNFT(listingId);
        (bool proven, address owner) = _tryOwnerOf(collection, tokenId);
        if (!proven || owner != address(this)) revert OwnershipUnproven();
    }

    /* ------------------------------------------------------------------ */
    /*                               REFUNDS                               */
    /* ------------------------------------------------------------------ */

    /// @notice Takes this address's whole acquisition refund credit. Escrowed fees returned by
    ///         expiry, an empty pool, or price drift arrive as credit, so one call covers every
    ///         refunded request at once.
    /// @return amount The measured ETH this address gained, which equals the credit FWA reported
    ///         before the call.
    function withdrawRefund(address fwa) public returns (uint256 amount) {
        uint256 credit = IFWA(fwa).acquisitionRefundCredit(address(this));
        if (credit == 0) return 0;
        uint256 balanceBefore = address(this).balance;
        IFWA(fwa).withdrawAcquisitionRefund();
        amount = address(this).balance - balanceBefore;
        if (amount != credit) revert RefundMismatch();
    }

    /// @notice Acquisition refund credit FWA owes this address.
    function refundCredit(address fwa) public view returns (uint256) {
        return IFWA(fwa).acquisitionRefundCredit(address(this));
    }

    /* ------------------------------------------------------------------ */
    /*                               REWARDS                               */
    /* ------------------------------------------------------------------ */

    /// @notice The request's registered epoch, in a single-element array, when it currently
    ///         qualifies for `claimEpochs`: closed, every acquisition registered in it terminal
    ///         protocol-wide, unclaimed by this address, unswept, and a nonzero share of a nonzero
    ///         denominator. Empty while any of those is untrue.
    /// @dev An acquisition is registered in one epoch, stamped when FWA takes the request, so this
    ///      returns at most one element. `amount` is this address's share of the epoch pot at the
    ///      current denominator.
    function claimableEpochs(address rewards, address token, address custodian, uint256 requestId)
        public
        view
        returns (uint64[] memory epochs, uint256 amount)
    {
        if (!_fwatTransferable(token, custodian)) return (epochs, 0);
        IFWARewards module = IFWARewards(rewards);
        (address purchaser, uint64 epoch,,,) = module.acquisitionRewards(requestId);
        if (purchaser != address(this)) return (epochs, 0);
        if (epoch >= module.currentEpoch()) return (epochs, 0);
        if (module.pendingAcquisitionsInEpoch(epoch) != 0) return (epochs, 0);
        if (module.purchaserEpochSwept(epoch) || module.purchaserClaimed(epoch, address(this))) return (epochs, 0);
        uint256 mine = module.userAcquisitionsInEpoch(epoch, address(this));
        uint256 all = module.acquisitionsInEpoch(epoch);
        if (mine == 0 || all == 0) return (epochs, 0);
        epochs = new uint64[](1);
        epochs[0] = epoch;
        amount = FixedPointMathLib.fullMulDiv(module.purchaserEpochAmount(epoch), mine, all);
    }

    /// @notice Claims this address's share of each listed epoch's purchaser pot and sends the
    ///         FWAToken to `custodian` in the same call.
    /// @param epochs Strictly increasing and nonempty. FWA's own record of a claimed epoch is the
    ///        double-claim guard, so a repeated epoch reverts inside FWA.
    /// @return amount The measured FWAToken claimed and forwarded.
    function claimEpochs(address rewards, address token, address custodian, uint256[] memory epochs)
        public
        returns (uint256 amount)
    {
        if (custodian == address(0)) revert ZeroAddress();
        if (epochs.length == 0) revert EmptyEpochList();
        for (uint256 i = 1; i < epochs.length; ++i) {
            if (epochs[i] <= epochs[i - 1]) revert EpochsNotStrictlyIncreasing();
        }
        if (!_fwatTransferable(token, custodian)) revert FwatCustodyUnavailable();

        uint256 balanceBefore = IFWAToken(token).balanceOf(address(this));
        IFWARewards(rewards).claimEpochTokens(epochs);
        amount = IFWAToken(token).balanceOf(address(this)) - balanceBefore;
        _sendTokens(token, custodian, amount);
    }

    /* ------------------------------------------------------------------ */
    /*                           DELIVERY RULE                             */
    /* ------------------------------------------------------------------ */

    /// @notice Whether a listing of `collection` settles as ETH rather than as a delivered NFT.
    ///         FWA's two token-pack collections settle as ETH, and a `transfersRestricted() == true`
    ///         probe does the same for every other collection.
    /// @dev A probe that reverts, answers with the wrong width, or answers with a non-boolean word
    ///      counts as unrestricted. The probe runs under a gas bound.
    function forcesEthSettlement(address collection) public view returns (bool) {
        if (collection == LOCKED_FWA_TOKEN_PACKS || collection == FWA_TOKEN_PACKS) return true;
        bytes4 selector = bytes4(keccak256("transfersRestricted()"));
        bool ok;
        uint256 size;
        uint256 raw;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, selector)
            ok := staticcall(RESTRICTION_PROBE_GAS, collection, ptr, 0x04, ptr, 0x20)
            size := returndatasize()
            if and(ok, eq(size, 0x20)) { raw := mload(ptr) }
        }
        if (!ok || size != 32 || raw > 1) return false;
        return raw == 1;
    }

    /* ------------------------------------------------------------------ */
    /*                              INTERNAL                               */
    /* ------------------------------------------------------------------ */

    /// @dev FWAToken allows a transfer while the lock is on when the sender or the receiver is a
    ///      distributor, so the role on either this address or the custodian moves a claim.
    function _fwatTransferable(address token, address custodian) private view returns (bool) {
        return IFWAToken(token).isDistributor(custodian) || IFWAToken(token).isDistributor(address(this));
    }

    function _sendTokens(address token, address custodian, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IFWAToken.transfer, (custodian, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenTransferFailed();
    }

    /// @dev `proven` is false when the collection reverts, exhausts the bounded gas, or answers with
    ///      other than one word.
    function _tryOwnerOf(address collection, uint256 tokenId) private view returns (bool proven, address owner) {
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, shl(224, 0x6352211e))
            mstore(add(ptr, 4), tokenId)
            proven := staticcall(OWNER_OF_GAS, collection, ptr, 36, ptr, 32)
            if and(proven, eq(returndatasize(), 32)) { owner := shr(96, shl(96, mload(ptr))) }
            if iszero(eq(returndatasize(), 32)) { proven := 0 }
        }
    }
}
