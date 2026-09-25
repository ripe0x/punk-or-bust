// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuardTransient} from "solady/utils/ReentrancyGuardTransient.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

import {FwaClientLib} from "./fwa/FwaClientLib.sol";
import {IFWA} from "./interfaces/IFWA.sol";
import {IFWAV2} from "./interfaces/IFWAV2.sol";
import {IRewardVault} from "./interfaces/IRewardVault.sol";

interface IVaultRouter {
    function acquireBatch(uint256 count) external payable returns (uint256[] memory requestIds, uint256 spentPerPull);
}

interface IVaultFactory {
    function registerRound() external;
}

/// @title Vault
/// @notice One per owner, cloned by `VaultFactory`. FWA's purchaser of record: holds the owner's ETH,
///         requests pulls through the shared router, and routes every reveal to the owner's wallet
///         (keep list), a short miss auction, or back to FWA for ETH, which recycles into further
///         pulls until the run stops.
/// @dev ETH ledger: `idle` is the owner's spendable ETH. Every outflow debits it; every inflow is
///      credited by balance reconciliation (`_absorb`), never by events, so ETH FWA pushes without a
///      callback (depositor resolution, refunds) is counted the same as ETH from a settlement call.
///      Escrowed bids (`bidEscrow`) and credited bid refunds (`creditedRefunds`) belong to bidders
///      and are excluded from reconciliation, so they never reach `idle`.
contract Vault is ReentrancyGuardTransient {
    enum Status {
        Idle,
        Running,
        WindingDown
    }

    /// @dev Values are append-only.
    enum PullStatus {
        None,
        Pending,
        Kept,
        Sold,
        Forced,
        Refunded,
        Auctioning
    }

    struct RunParams {
        uint256 maxDrawdownBps;
        uint256 maxPullCostWei;
        uint256 stopAfterKeeps;
        uint256 deadline;
        uint256 maxPulls;
    }

    struct KeepToken {
        address collection;
        uint256 tokenId;
    }

    struct Pull {
        uint128 price;
        PullStatus status;
    }

    struct Auction {
        uint256 listingId;
        uint256 backstop;
        uint256 highBid;
        address highBidder;
        uint256 deadline;
        uint256 hardDeadline;
    }

    uint256 public constant BPS = 10_000;
    uint256 public constant PULL_FEE_PPM = 250;
    uint256 public constant PPM = 1_000_000;
    uint256 public constant MAX_BATCH = 5;
    uint256 public constant MAX_OUTSTANDING = 32;
    uint256 public constant PRIORITY_CAP = 2 gwei;
    uint256 public constant DEFAULT_GAS_CEILING = 1.2 gwei;
    uint256 public constant MAX_GAS_CEILING = 100 gwei;
    /// @notice Gas charged on top of the measured gas of a reimbursed call: intrinsic cost, calldata
    ///         and the reimbursement transfer itself.
    // SPEC: overhead and per-function caps are not in the spec; chosen above the measured cost of a
    // five-pull request and a full sync so an honest keeper is covered and a call cannot exceed them.
    uint256 public constant GAS_OVERHEAD = 40_000;
    uint256 public constant REQUEST_GAS_CAP = 1_500_000;
    uint256 public constant SYNC_GAS_CAP = 3_000_000;
    uint256 public constant FINALIZE_GAS_CAP = 1_000_000;

    uint256 public constant AUCTION_GAP_BPS = 900;
    uint256 public constant AUCTION_MIN_SURPLUS = 0.01 ether;
    uint256 public constant AUCTION_NO_ORACLE_BACKING = 1 ether;
    uint256 public constant AUCTION_MAX_DURATION = 60 minutes;
    uint256 public constant AUCTION_EXTENSION = 5 minutes;
    uint256 public constant BID_STEP_BPS = 10_500;
    // SPEC: an auction opens for 30 minutes, so late bids have room to extend it toward the 60 minute cap.
    uint256 public constant AUCTION_DURATION = 30 minutes;
    // SPEC: the settle buffer is 30 minutes; an auction never runs past allocation + window - buffer.
    uint256 public constant AUCTION_SETTLE_BUFFER = 30 minutes;
    // SPEC: at most 8 open auctions per vault; at the cap a miss sells back.
    uint256 public constant MAX_AUCTIONS = 8;

    uint8 internal constant ACQ_FULFILLED = uint8(IFWA.AcquisitionStatus.Fulfilled);
    uint8 internal constant ACQ_EXPIRED = uint8(IFWA.AcquisitionStatus.Expired);
    uint8 internal constant ACQ_REFUNDED = uint8(IFWA.AcquisitionStatus.Refunded);
    uint8 internal constant LISTING_ALLOCATED = uint8(IFWA.ListingStatus.Allocated);

    address public immutable FWA;
    address public immutable FACTORY;
    address public immutable ROUTER;
    address public immutable REWARD_VAULT;
    address public immutable FEE_RECIPIENT;
    address public immutable REWARDS;
    address public immutable TOKEN;

    /// @notice Set once by `initialize` and never changed.
    address public OWNER;
    Status public status;
    bool public autoReturn;
    bool public rewardsRegistered;
    uint256 public gasCeiling;

    /// @notice The owner's spendable ETH.
    uint256 public idle;
    /// @notice Pull fees earned by completed pulls and not yet paid to `FEE_RECIPIENT`.
    uint256 public feeOwed;

    RunParams public run;
    uint256 public runStartValue;
    /// @notice Backstop ETH given up for NFTs kept this run. Counts toward the drawdown value.
    uint256 public keptValue;
    uint256 public pullsRequested;
    uint256 public keeps;

    mapping(address keeper => bool) public isKeeper;
    mapping(address collection => bool) public keepCollection;
    mapping(address collection => mapping(uint256 tokenId => bool)) public keepToken;

    uint256[] internal _outstanding;
    mapping(uint256 requestId => Pull) public pulls;

    mapping(uint256 requestId => Auction) public auctions;
    uint256 public openAuctions;
    /// @notice ETH held for current high bids. Never part of `idle`.
    uint256 public bidEscrow;
    /// @notice Sum of `bidRefunds`. Never part of `idle`.
    uint256 public creditedRefunds;
    /// @notice Outbid or failed-delivery refunds whose push failed, claimable by the bidder.
    mapping(address bidder => uint256) public bidRefunds;

    error Unauthorized();
    error AlreadyInitialized();
    error BadStatus();
    error BadParams();
    error BadCount();
    error TooManyOutstanding();
    error PurchaseBlackout();
    error NotPriced();
    error GasPriceTooHigh();
    error FloorReached();
    error AccruedNotSupported();
    error BidTooLow();
    error AuctionEnded();
    error AuctionNotEnded();

    event RunStarted(uint256 runStartValue, RunParams params);
    event RunWindingDown();
    event RunEnded(uint256 returned);
    event Deposited(uint256 amount);
    event Withdrawn(uint256 amount);
    event PullsRequested(uint256[] requestIds, uint256 spentPerPull);
    event PullResolved(uint256 indexed requestId, uint256 indexed listingId, PullStatus outcome);
    event PullForced(uint256 indexed requestId, uint256 indexed listingId, FwaClientLib.ForcedKind kind);
    event FeePaid(uint256 amount);
    event KeeperReimbursed(address indexed keeper, uint256 gasUsed, uint256 gasPrice, uint256 amount);
    event KeepCollectionSet(address indexed collection, bool keep);
    event KeepTokenSet(address indexed collection, uint256 indexed tokenId, bool keep);
    event KeeperSet(address indexed keeper, bool approved);
    event AutoReturnSet(bool enabled);
    event GasCeilingSet(uint256 ceiling);
    event RewardsRegistered();
    event AuctionStarted(
        uint256 indexed requestId, uint256 indexed listingId, uint256 backstop, uint256 deadline, uint256 hardDeadline
    );
    event BidPlaced(uint256 indexed requestId, address indexed bidder, uint256 amount, uint256 deadline);
    event BidRefunded(address indexed bidder, uint256 amount, bool credited);
    event BidRefundClaimed(address indexed bidder, address to, uint256 amount);
    event AuctionFinalized(uint256 indexed requestId, address indexed winner, uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != OWNER) revert Unauthorized();
        _;
    }

    constructor(address fwa, address factory, address router, address rewardVault, address feeRecipient) {
        FWA = fwa;
        FACTORY = factory;
        ROUTER = router;
        REWARD_VAULT = rewardVault;
        FEE_RECIPIENT = feeRecipient;
        REWARDS = IFWA(fwa).rewards();
        TOKEN = IFWA(fwa).token();
    }

    receive() external payable {}

    /// @notice The router returns purchase overpayment here. Credited by balance reconciliation.
    function receivePurchaseRefund() external payable {}

    /* ------------------------------------------------------------------ */
    /*                              LIFECYCLE                              */
    /* ------------------------------------------------------------------ */

    /// @notice Factory only, once per clone, in the transaction that creates it.
    function initialize(
        address owner_,
        address[] calldata collections,
        KeepToken[] calldata tokens,
        address[] calldata keepers,
        RunParams calldata params
    ) external payable nonReentrant {
        if (msg.sender != FACTORY) revert Unauthorized();
        if (OWNER != address(0)) revert AlreadyInitialized();
        if (owner_ == address(0)) revert BadParams();
        OWNER = owner_;
        autoReturn = true;
        gasCeiling = DEFAULT_GAS_CEILING;
        _setKeepCollections(collections, true);
        _setKeepTokens(tokens, true);
        _setKeepers(keepers, true);
        _absorb();
        _startRun(params);
    }

    function startRun(RunParams calldata params) external payable onlyOwner nonReentrant {
        if (status != Status.Idle) revert BadStatus();
        _absorb();
        _startRun(params);
    }

    /// @notice Adds ETH. During a run it raises `runStartValue` by the deposit.
    function deposit() external payable onlyOwner nonReentrant {
        _absorb();
        if (status != Status.Idle) runStartValue += msg.value;
        emit Deposited(msg.value);
    }

    /// @notice No new pulls; in-flight pulls resolve through `sync`, then the vault is `Idle`.
    function stop() external onlyOwner nonReentrant {
        if (status != Status.Running) revert BadStatus();
        _windDown();
        _finishIfDone();
    }

    function withdraw() external onlyOwner nonReentrant {
        if (status != Status.Idle) revert BadStatus();
        _absorb();
        _payFees();
        emit Withdrawn(_sendIdle());
    }

    /// @notice Sends an NFT this vault holds (forced or recovered outcomes) to the owner.
    function sweepNft(address collection, uint256 tokenId) external onlyOwner nonReentrant {
        FwaClientLib.forwardOwned(collection, tokenId, OWNER);
    }

    /* ------------------------------------------------------------------ */
    /*                                PULLS                                */
    /* ------------------------------------------------------------------ */

    /// @notice Opens up to `count` pulls, fewer if a run limit or the drawdown floor allows fewer.
    ///         Ends the run instead when a stop condition holds.
    /// @return requested Pulls opened by this call.
    function requestPulls(uint256 count) external nonReentrant returns (uint256 requested) {
        uint256 gasStart = gasleft();
        bool byKeeper = msg.sender != OWNER;
        if (byKeeper && !isKeeper[msg.sender]) revert Unauthorized();
        // A keeper spends the owner's ETH only at or below the owner's gas ceiling; pull cost rises with gas.
        if (byKeeper && tx.gasprice > gasCeiling) revert GasPriceTooHigh();
        if (status != Status.Running) revert BadStatus();
        if (count == 0 || count > MAX_BATCH) revert BadCount();
        _absorb();

        RunParams memory p = run;
        uint256 inFlight = _outstanding.length + openAuctions;
        if (
            block.timestamp > p.deadline || pullsRequested >= p.maxPulls
                || (p.stopAfterKeeps != 0 && keeps >= p.stopAfterKeeps)
        ) {
            _windDown();
        } else {
            if (inFlight >= MAX_OUTSTANDING) revert TooManyOutstanding();
            if (IFWAV2(FWA).isPurchaseBlackout()) revert PurchaseBlackout();
            (uint256 fee,, uint256 total) = FwaClientLib.quote(FWA);
            if (total == 0) revert NotPriced();
            // SPEC: a quote above maxPullCostWei is "FWA config outside the run's bounds" and ends the run.
            if (total > p.maxPullCostWei) {
                _windDown();
            } else {
                requested = _min(_min(count, MAX_OUTSTANDING - inFlight), p.maxPulls - pullsRequested);
                // SPEC: the floor check prices each pull at its quote plus the pull fee it would owe.
                requested = _min(requested, _affordable(total, total + fee * PULL_FEE_PPM / PPM, byKeeper));
                if (requested == 0) {
                    // The run ends on the floor only when nothing is in flight.
                    if (inFlight != 0) revert FloorReached();
                    _windDown();
                } else {
                    _acquire(requested, total);
                }
            }
        }
        _finishIfDone();
        _reimburse(gasStart, REQUEST_GAS_CAP, false);
    }

    /// @notice Resolves up to `maxCount` outstanding pulls: routes every reveal (keep list to the
    ///         owner, a miss auction, or sell back), records forced outcomes, and takes refund credit.
    ///         Auctions are finalized separately by `finalizeAuction`.
    ///         Permissionless; approved keepers are reimbursed when it resolves something.
    function sync(uint256 maxCount) external nonReentrant returns (uint256 resolved) {
        uint256 gasStart = gasleft();
        _absorb();
        uint256 i;
        while (i < _outstanding.length && resolved < maxCount) {
            if (_resolve(_outstanding[i])) {
                _outstanding[i] = _outstanding[_outstanding.length - 1];
                _outstanding.pop();
                ++resolved;
            } else {
                ++i;
            }
        }
        if (FwaClientLib.refundCredit(FWA) != 0) FwaClientLib.withdrawRefund(FWA);
        _absorb();
        _payFees();
        if (status == Status.Running) {
            RunParams memory p = run;
            if (block.timestamp > p.deadline || (p.stopAfterKeeps != 0 && keeps >= p.stopAfterKeeps)) _windDown();
        }
        _finishIfDone();
        if (resolved != 0) _reimburse(gasStart, SYNC_GAS_CAP, true);
    }

    /// @notice Self-call boundary so a failed keep, delivery or sale reverts alone and routing can
    ///         fall back. `keepTo` zero sells back; otherwise the NFT goes to `keepTo`.
    function settleSelf(uint256 listingId, address keepTo) external {
        if (msg.sender != address(this)) revert Unauthorized();
        if (keepTo != address(0)) FwaClientLib.keepAndForward(FWA, listingId, keepTo);
        else FwaClientLib.settleForEth(FWA, listingId);
    }

    /* ------------------------------------------------------------------ */
    /*                             MISS AUCTION                            */
    /* ------------------------------------------------------------------ */

    /// @notice Bids on a miss auction. The first bid is at least the backstop plus 5%, each later bid
    ///         the high bid plus 5%. A bid in the last 5 minutes extends the auction by 5 minutes, up
    ///         to its hard deadline. The previous high bid is refunded, or credited if the push fails.
    function bid(uint256 requestId) external payable nonReentrant {
        if (pulls[requestId].status != PullStatus.Auctioning) revert BadStatus();
        Auction storage a = auctions[requestId];
        if (block.timestamp >= a.deadline) revert AuctionEnded();
        uint256 prev = a.highBid;
        if (msg.value < (prev == 0 ? a.backstop : prev) * BID_STEP_BPS / BPS) revert BidTooLow();
        address prevBidder = a.highBidder;
        a.highBid = msg.value;
        a.highBidder = msg.sender;
        bidEscrow += msg.value;
        if (a.deadline - block.timestamp < AUCTION_EXTENSION) {
            a.deadline = _min(block.timestamp + AUCTION_EXTENSION, a.hardDeadline);
        }
        emit BidPlaced(requestId, msg.sender, msg.value, a.deadline);
        if (prev != 0) _refundBid(prevBidder, prev);
    }

    /// @notice Ends a miss auction after its deadline. The high bidder gets the NFT and the bid joins
    ///         idle ETH; with no bid or a failed delivery the bid is refunded and the vault sells back.
    ///         A listing already settled by other means is recorded as forced. Permissionless;
    ///         approved keepers are reimbursed.
    function finalizeAuction(uint256 requestId) external nonReentrant {
        uint256 gasStart = gasleft();
        if (pulls[requestId].status != PullStatus.Auctioning) revert BadStatus();
        Auction storage a = auctions[requestId];
        if (block.timestamp < a.deadline) revert AuctionNotEnded();
        uint256 listingId = a.listingId;
        uint256 amount = a.highBid;
        address winner = a.highBidder;
        --openAuctions;

        PullStatus outcome = PullStatus.Sold;
        if (FwaClientLib.listing(FWA, listingId).status != LISTING_ALLOCATED) {
            outcome = PullStatus.Forced;
            emit PullForced(requestId, listingId, FwaClientLib.classifyForced(FWA, listingId));
            if (winner != address(0)) _refundBid(winner, amount);
            winner = address(0);
        } else if (winner != address(0) && _deliver(listingId, winner)) {
            bidEscrow -= amount;
        } else {
            if (winner != address(0)) _refundBid(winner, amount);
            winner = address(0);
            // SPEC: a failed sale reverts the whole finalize so it can be retried; the bidder stays high.
            FwaClientLib.settleForEth(FWA, listingId);
        }
        pulls[requestId].status = outcome;
        emit AuctionFinalized(requestId, winner, winner == address(0) ? 0 : amount);
        emit PullResolved(requestId, listingId, outcome);

        _absorb();
        _payFees();
        _finishIfDone();
        _reimburse(gasStart, FINALIZE_GAS_CAP, true);
    }

    /// @notice Sends the caller's credited bid refunds to `to`.
    // SPEC: the claim names a recipient, so a bidder that cannot receive ETH is not locked out.
    function claimBidRefund(address to) external nonReentrant returns (uint256 amount) {
        amount = bidRefunds[msg.sender];
        if (amount == 0 || to == address(0)) revert BadParams();
        bidRefunds[msg.sender] = 0;
        creditedRefunds -= amount;
        SafeTransferLib.safeTransferETH(to, amount);
        emit BidRefundClaimed(msg.sender, to, amount);
    }

    /// @notice Pulls an NFT FWA failed to deliver to this vault. It stays here for `sweepNft`.
    function recoverStuck(uint256 listingId) external nonReentrant {
        FwaClientLib.recoverStuck(FWA, listingId);
    }

    /// @notice Takes this vault's whole FWA acquisition refund credit into idle ETH.
    function withdrawAcquisitionRefund() external nonReentrant returns (uint256 amount) {
        amount = FwaClientLib.withdrawRefund(FWA);
        _absorb();
    }

    /// @notice Credits any untracked ETH on this address to idle.
    function reconcile() external nonReentrant {
        _absorb();
    }

    /* ------------------------------------------------------------------ */
    /*                               SETTINGS                              */
    /* ------------------------------------------------------------------ */

    function setKeepCollections(address[] calldata collections, bool keep) external onlyOwner nonReentrant {
        _setKeepCollections(collections, keep);
    }

    function setKeepTokens(KeepToken[] calldata tokens, bool keep) external onlyOwner nonReentrant {
        _setKeepTokens(tokens, keep);
    }

    function setKeepers(address[] calldata keepers, bool approved) external onlyOwner nonReentrant {
        _setKeepers(keepers, approved);
    }

    function setAutoReturn(bool enabled) external onlyOwner nonReentrant {
        autoReturn = enabled;
        emit AutoReturnSet(enabled);
    }

    function setGasCeiling(uint256 ceiling) external onlyOwner nonReentrant {
        if (ceiling == 0 || ceiling > MAX_GAS_CEILING) revert BadParams();
        gasCeiling = ceiling;
        emit GasCeilingSet(ceiling);
    }

    /* ------------------------------------------------------------------ */
    /*                               REWARDS                               */
    /* ------------------------------------------------------------------ */

    /// @notice The reward vault's series for this vault.
    function series() external view returns (address) {
        return FACTORY;
    }

    /// @notice Registers with the shared reward vault and locks the owner's whole share. Permissionless;
    ///         reverts until the reward vault allowlists the factory.
    function registerRewards() external nonReentrant {
        if (rewardsRegistered) revert BadStatus();
        rewardsRegistered = true;
        IVaultFactory(FACTORY).registerRound();
        IRewardVault(REWARD_VAULT).updateShare(OWNER, 1);
        IRewardVault(REWARD_VAULT).lockShares(1);
        emit RewardsRegistered();
    }

    /// @notice Harvests closed epochs' purchaser rewards into the reward vault. Permissionless.
    function harvestRewards(uint256[] calldata epochs) external nonReentrant returns (uint256) {
        return IRewardVault(REWARD_VAULT).harvest(epochs, false, 0);
    }

    /// @notice Reward vault callback inside `harvest`. The router, not this vault, calls `acquire`, so
    ///         this vault has no accrued builder stream.
    function collectRewards(uint256[] calldata epochs, bool accrued, uint256) external {
        if (msg.sender != REWARD_VAULT) revert Unauthorized();
        if (accrued) revert AccruedNotSupported();
        FwaClientLib.claimEpochs(REWARDS, TOKEN, REWARD_VAULT, epochs);
    }

    /* ------------------------------------------------------------------ */
    /*                                VIEWS                                */
    /* ------------------------------------------------------------------ */

    /// @notice Idle ETH plus kept NFTs at their backstop, less fees owed. In-flight pulls and open
    ///         auctions count as zero.
    // SPEC: an allocated pull not yet synced also counts as zero (conservative); M1 routes at reveal
    // in the same `sync`, so there is no separate revealed receivable.
    function runValue() public view returns (uint256) {
        uint256 gross = idle + keptValue;
        return gross > feeOwed ? gross - feeOwed : 0;
    }

    function runFloor() public view returns (uint256) {
        return runStartValue * (BPS - run.maxDrawdownBps) / BPS;
    }

    function outstanding() external view returns (uint256[] memory) {
        return _outstanding;
    }

    /// @notice Pulls awaiting reveal or routing. Open auctions are counted in `openAuctions`.
    function outstandingCount() external view returns (uint256) {
        return _outstanding.length;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    /* ------------------------------------------------------------------ */
    /*                              INTERNAL                               */
    /* ------------------------------------------------------------------ */

    // SPEC: a run needs nonzero idle ETH, so `createVault` with no value reverts.
    function _startRun(RunParams calldata params) internal {
        // SPEC: maxPulls and maxPullCostWei must be nonzero and the deadline in the future; a run
        // that could never pull is rejected rather than started. maxDrawdownBps = 0 is allowed.
        if (
            params.maxDrawdownBps > BPS || params.maxPullCostWei == 0 || params.maxPulls == 0
                || params.deadline <= block.timestamp
        ) revert BadParams();
        _payFees();
        if (idle == 0) revert BadParams();
        run = params;
        runStartValue = idle;
        keptValue = 0;
        pullsRequested = 0;
        keeps = 0;
        status = Status.Running;
        emit RunStarted(idle, params);
    }

    /// @dev Pulls whose cost stays above the floor and within idle ETH.
    ///      A keeper call first reserves its worst-case reimbursement so it cannot cross the floor.
    function _affordable(uint256 total, uint256 unitCost, bool byKeeper) internal view returns (uint256) {
        uint256 value = runValue();
        uint256 floor = runFloor() + (byKeeper ? REQUEST_GAS_CAP * gasCeiling : 0);
        uint256 byFloor = value > floor ? (value - floor) / unitCost : 0;
        return _min(byFloor, idle / total);
    }

    function _acquire(uint256 count, uint256 total) internal {
        uint256 balanceBefore = address(this).balance;
        (uint256[] memory ids, uint256 spentPerPull) = IVaultRouter(ROUTER).acquireBatch{value: count * total}(count);
        idle -= balanceBefore - address(this).balance;
        // An FWA fee never approaches 2^128 wei.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 price = uint128(spentPerPull - IFWAV2(FWA).vrfServiceFee());
        for (uint256 i; i < ids.length; ++i) {
            pulls[ids[i]] = Pull(price, PullStatus.Pending);
            _outstanding.push(ids[i]);
        }
        pullsRequested += count;
        emit PullsRequested(ids, spentPerPull);
    }

    /// @dev True when the pull reached a final outcome and leaves the outstanding set.
    function _resolve(uint256 requestId) internal returns (bool) {
        (uint256 price, uint256 listingId, uint8 acquisition) = FwaClientLib.status(FWA, requestId);
        PullStatus outcome;
        if (acquisition == ACQ_FULFILLED) {
            FwaClientLib.ListingSnapshot memory s = FwaClientLib.listing(FWA, listingId);
            if (s.status == LISTING_ALLOCATED) {
                outcome = _route(requestId, listingId, s);
                if (outcome == PullStatus.None) return false;
            } else {
                outcome = PullStatus.Forced;
                emit PullForced(requestId, listingId, FwaClientLib.classifyForced(FWA, listingId));
            }
            // SPEC: every allocated pull is a completed purchase, including forced outcomes.
            feeOwed += price * PULL_FEE_PPM / PPM;
        } else if (acquisition == ACQ_EXPIRED || acquisition == ACQ_REFUNDED) {
            outcome = PullStatus.Refunded;
        } else {
            return false;
        }
        pulls[requestId].status = outcome;
        emit PullResolved(requestId, listingId, outcome);
        return true;
    }

    /// @dev Keep list (token entry, then collection) goes to the owner; a failed keep sells back; any
    ///      other reveal opens a miss auction when `_auctionEnd` allows one, else sells back. `None` when
    ///      even the sale failed, so the pull stays outstanding.
    function _route(uint256 requestId, uint256 listingId, FwaClientLib.ListingSnapshot memory s)
        internal
        returns (PullStatus)
    {
        uint256 backstop = s.value * IFWA(FWA).settlementDiscountBps() / BPS;
        if (
            (keepToken[s.collection][s.tokenId] || keepCollection[s.collection])
                && !FwaClientLib.forcesEthSettlement(s.collection)
        ) {
            try this.settleSelf(listingId, OWNER) {
                keptValue += backstop;
                ++keeps;
                return PullStatus.Kept;
            } catch {}
            // SPEC: a failed keep goes straight to sell back (routing step 3), never to an auction.
        } else {
            uint256 hard = _auctionEnd(s, backstop);
            if (hard != 0) {
                uint256 deadline = _min(block.timestamp + AUCTION_DURATION, hard);
                auctions[requestId] = Auction({
                    listingId: listingId,
                    backstop: backstop,
                    highBid: 0,
                    highBidder: address(0),
                    deadline: deadline,
                    hardDeadline: hard
                });
                ++openAuctions;
                emit AuctionStarted(requestId, listingId, backstop, deadline, hard);
                return PullStatus.Auctioning;
            }
        }
        try this.settleSelf(listingId, address(0)) {
            return PullStatus.Sold;
        } catch {
            return PullStatus.None;
        }
    }

    /// @dev The hard deadline of a miss auction for this reveal, or zero when it sells back: the
    ///      auction cap is reached, the collection is not auction-eligible, too little of the
    ///      settlement window remains, or the oracle rule (fresh reading) or the backing rule (no
    ///      fresh reading) does not call for one.
    function _auctionEnd(FwaClientLib.ListingSnapshot memory s, uint256 backstop) internal view returns (uint256 hard) {
        if (openAuctions >= MAX_AUCTIONS || backstop == 0 || FwaClientLib.forcesEthSettlement(s.collection)) return 0;
        uint256 windowEnd = uint256(s.allocatedAt) + IFWA(FWA).settlementWindow();
        // SPEC: an auction that could not run at least one extension period sells back instead.
        if (windowEnd < block.timestamp + AUCTION_SETTLE_BUFFER + AUCTION_EXTENSION) return 0;
        hard = _min(block.timestamp + AUCTION_MAX_DURATION, windowEnd - AUCTION_SETTLE_BUFFER);
        (bool fresh, uint256 oracleBid) = FwaClientLib.freshFloorBid(FWA, s.collection);
        if (fresh) {
            if (
                oracleBid <= backstop || oracleBid - backstop < AUCTION_MIN_SURPLUS
                    || (oracleBid - backstop) * BPS / backstop < AUCTION_GAP_BPS
            ) return 0;
        } else if (s.value < AUCTION_NO_ORACLE_BACKING) {
            return 0;
        }
    }

    /// @dev True when the NFT reached `to`.
    function _deliver(uint256 listingId, address to) internal returns (bool) {
        try this.settleSelf(listingId, to) {
            return true;
        } catch {
            return false;
        }
    }

    /// @dev Pushes a bid back under a gas stipend; a failed push becomes a claimable credit.
    // SPEC: the push uses a 100,000 gas stipend so a hostile receiver cannot block a new bid.
    function _refundBid(address to, uint256 amount) internal {
        bidEscrow -= amount;
        bool credited = !SafeTransferLib.trySafeTransferETH(to, amount, SafeTransferLib.GAS_STIPEND_NO_GRIEF);
        if (credited) {
            bidRefunds[to] += amount;
            creditedRefunds += amount;
        }
        emit BidRefunded(to, amount, credited);
    }

    function _windDown() internal {
        status = Status.WindingDown;
        emit RunWindingDown();
    }

    function _finishIfDone() internal {
        if (status != Status.WindingDown || _outstanding.length != 0 || openAuctions != 0) return;
        status = Status.Idle;
        uint256 returned;
        if (autoReturn) {
            _absorb();
            _payFees();
            returned = _sendIdle();
        }
        emit RunEnded(returned);
    }

    /// @dev Credits untracked ETH to idle. Bid escrow and credited refunds are never absorbable.
    function _absorb() internal {
        uint256 absorbable = address(this).balance - bidEscrow - creditedRefunds;
        if (absorbable > idle) idle = absorbable;
    }

    function _payFees() internal {
        uint256 amount = _min(feeOwed, idle);
        if (amount == 0) return;
        feeOwed -= amount;
        idle -= amount;
        SafeTransferLib.forceSafeTransferETH(FEE_RECIPIENT, amount);
        emit FeePaid(amount);
    }

    function _sendIdle() internal returns (uint256 amount) {
        amount = idle;
        if (amount == 0) return 0;
        idle = 0;
        SafeTransferLib.forceSafeTransferETH(OWNER, amount);
    }

    /// @dev Approved keepers only, at min(basefee + PRIORITY_CAP, tx.gasprice, gasCeiling), gas capped
    ///      per function, never more than idle ETH.
    // SPEC: above the ceiling the keeper is paid at the ceiling, so the part above it is not reimbursed.
    ///      Protective calls (sync, finalizeAuction) settle pulls already bought inside FWA's short
    ///      settlement window, so they ignore the owner's ceiling and stop at MAX_GAS_CEILING instead.
    function _reimburse(uint256 gasStart, uint256 gasCap, bool protective) internal {
        if (!isKeeper[msg.sender]) return;
        uint256 used = _min(gasStart - gasleft() + GAS_OVERHEAD, gasCap);
        uint256 price = _min(_min(block.basefee + PRIORITY_CAP, tx.gasprice), protective ? MAX_GAS_CEILING : gasCeiling);
        uint256 amount = _min(used * price, idle);
        if (amount == 0) return;
        idle -= amount;
        SafeTransferLib.forceSafeTransferETH(msg.sender, amount);
        emit KeeperReimbursed(msg.sender, used, price, amount);
    }

    function _setKeepCollections(address[] calldata collections, bool keep) internal {
        for (uint256 i; i < collections.length; ++i) {
            keepCollection[collections[i]] = keep;
            emit KeepCollectionSet(collections[i], keep);
        }
    }

    function _setKeepTokens(KeepToken[] calldata tokens, bool keep) internal {
        for (uint256 i; i < tokens.length; ++i) {
            keepToken[tokens[i].collection][tokens[i].tokenId] = keep;
            emit KeepTokenSet(tokens[i].collection, tokens[i].tokenId, keep);
        }
    }

    function _setKeepers(address[] calldata keepers, bool approved) internal {
        for (uint256 i; i < keepers.length; ++i) {
            isKeeper[keepers[i]] = approved;
            emit KeeperSet(keepers[i], approved);
        }
    }

    function _useTransientReentrancyGuardOnlyOnMainnet() internal pure override returns (bool) {
        return false;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
