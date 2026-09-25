// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "solady/auth/Ownable.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

import {MockFWAToken} from "./MockFWAToken.sol";

interface IFwaV2RewardsCore {
    function canRescueRewards() external view returns (bool);
    function acquisitions(uint256 requestId)
        external
        view
        returns (address purchaser, uint256 requestBlock, uint256 priceEscrowed, uint256 listingId, uint8 status);
}

/// @title FwaV2RewardsDouble
/// @notice Test double for the FWA V2 rewards module, built from the verified source in
///         `refs/fwa-v2-rewards/src/FWAV2/FWAV2Rewards.sol.txt`.
/// @dev Mirrors the verified state changes and reverts (some events are omitted) of `onListingActivated`, `onListingRepriced`,
///      `onListingRemoved`, `registerAcquisition`, `settleAcquisition`, `refundAcquisition`,
///      `settlementBuilderReward`, `settleListing`, `startEpochs`, `currentEpoch`, `claimEpochTokens`,
///      `purchaserEpochAmount`, `withdrawTokenBuyAllowanceAsETH`, `setBuilderRewardBps` and every public
///      getter the pool or the client library reads (`token`, `fwa`, `buyback`, `tokenBuyAllowance`,
///      `acquisitionRewards`, the epoch mappings).
///
///      Simplified: there is no Uniswap v4 pool, so `buyFor` and `claimAccruedTokens` mint
///      `tokensPerEth` mock tokens per wei instead of swapping, and the double keeps the ETH. The
///      buyback is never bound, and `fundEpoch` stands in for `onTokenReceived` routing into an epoch
///      pot. `fwa` is set in the constructor rather than by `setFWA`.
///
///      A mainnet fork conformance test against the deployed module is required before this double
///      is relied on beyond these tests.
contract FwaV2RewardsDouble is Ownable, ReentrancyGuard {
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_BUILDER_REWARD_BPS = 2500;
    uint8 internal constant CORE_ACQUISITION_FULFILLED = 2;
    uint256 internal constant SCALE = 1e36;

    enum AcquisitionRewardStatus {
        None,
        Pending,
        Settled,
        Refunded
    }

    struct ListingReward {
        address depositor;
        bool active;
        uint256 sqrtBacking;
        uint256 tokenDebt;
    }

    struct AcquisitionReward {
        address purchaser;
        uint64 epoch;
        AcquisitionRewardStatus status;
        uint256 tokenSlice;
        address caller;
    }

    struct SettlementReward {
        address caller;
        uint16 shareBps;
        bool settled;
    }

    address public immutable token;
    address public fwa;
    address public buyback;

    mapping(uint256 listingId => ListingReward reward) public listingRewards;
    uint256 public sqrtBackingTotal;
    uint256 public accTokenPerSqrt;
    mapping(address depositor => uint256 amount) public tokenCredit;

    mapping(address caller => uint256 ethOwed) public tokenBuyAllowance;
    uint256 public tokenBuyAllowanceTotal;
    mapping(uint256 requestId => AcquisitionReward reward) public acquisitionRewards;
    mapping(uint256 requestId => uint16 shareBps) public acquisitionBuilderRewardBps;
    mapping(uint256 listingId => SettlementReward reward) public settlementRewards;
    uint256 public builderRewardBps = 1500;

    uint256 public epochStart;
    mapping(uint256 epoch => uint256 amount) public purchaserEpochPot;
    mapping(uint256 epoch => uint256 acquisitions) public acquisitionsInEpoch;
    mapping(uint256 epoch => mapping(address purchaser => uint256 acquisitions)) public userAcquisitionsInEpoch;
    mapping(uint256 epoch => uint256 acquisitions) public pendingAcquisitionsInEpoch;
    mapping(uint256 epoch => mapping(address purchaser => bool claimed)) public purchaserClaimed;
    mapping(uint256 epoch => bool swept) public purchaserEpochSwept;

    /// @notice Simplified buy rate: mock tokens minted per wei spent.
    uint256 public tokensPerEth = 1000;

    event AcquisitionRewardRegistered(
        uint256 indexed requestId,
        address indexed purchaser,
        uint64 indexed epoch,
        address caller,
        uint256 tokenSlice,
        uint256 builderRewardBps
    );
    event AcquisitionTokenAccrued(address indexed caller, uint256 indexed requestId, uint256 slice);
    event AcquisitionRewardRefunded(uint256 indexed requestId, uint64 indexed epoch);
    event SettlementBuilderRewardAccrued(
        uint256 indexed listingId, address indexed caller, uint256 protocolFee, uint256 slice
    );

    error ZeroAddress();
    error InvalidConfig();
    error OnlyFWA();
    error ListingAlreadyActive();
    error ListingNotActive();
    error UnknownRequest();
    error AcquisitionAlreadyTerminal();
    error IncorrectTokenSlice();
    error InvalidAcquisitionLink();
    error SettlementAlreadyTerminal();
    error NoTokenReward();
    error EpochNotClosed();
    error EpochStillPending();
    error AlreadyClaimed();
    error SlippageBuy();
    error RescueNotAllowed();

    constructor(address token_, address fwa_) {
        if (token_ == address(0) || fwa_ == address(0)) revert ZeroAddress();
        token = token_;
        fwa = fwa_;
        _initializeOwner(msg.sender);
    }

    modifier onlyFWA() {
        if (msg.sender != fwa) revert OnlyFWA();
        _;
    }

    /* ------------------------------------------------------------------ */
    /*                     LISTING HOOKS (VERIFIED LOGIC)                  */
    /* ------------------------------------------------------------------ */

    function onListingActivated(uint256 listingId, address depositor, uint256 backing) external onlyFWA {
        if (depositor == address(0) || backing == 0) revert InvalidConfig();

        ListingReward storage reward = listingRewards[listingId];
        if (reward.active) revert ListingAlreadyActive();

        uint256 sqrtBacking = FixedPointMathLib.sqrt(backing);
        reward.depositor = depositor;
        reward.active = true;
        reward.sqrtBacking = sqrtBacking;
        reward.tokenDebt = _ceilDiv(sqrtBacking * accTokenPerSqrt, SCALE);
        sqrtBackingTotal += sqrtBacking;
    }

    function onListingRepriced(uint256 listingId, uint256 backing) external onlyFWA {
        ListingReward storage reward = listingRewards[listingId];
        if (!reward.active) revert ListingNotActive();

        _creditPending(reward);

        uint256 oldSqrtBacking = reward.sqrtBacking;
        uint256 newSqrtBacking = FixedPointMathLib.sqrt(backing);
        sqrtBackingTotal = sqrtBackingTotal - oldSqrtBacking + newSqrtBacking;
        reward.sqrtBacking = newSqrtBacking;
        reward.tokenDebt = _ceilDiv(newSqrtBacking * accTokenPerSqrt, SCALE);
    }

    function onListingRemoved(uint256 listingId) external onlyFWA {
        ListingReward storage reward = listingRewards[listingId];
        if (!reward.active) revert ListingNotActive();

        _creditPending(reward);

        sqrtBackingTotal -= reward.sqrtBacking;
        delete listingRewards[listingId];
    }

    /* ------------------------------------------------------------------ */
    /*                   ACQUISITION HOOKS (VERIFIED LOGIC)                */
    /* ------------------------------------------------------------------ */

    function registerAcquisition(uint256 requestId, address purchaser, address caller, uint256 protocolFee)
        external
        onlyFWA
        returns (uint256 slice, uint64 rewardEpoch)
    {
        if (purchaser == address(0) || caller == address(0)) revert InvalidConfig();
        if (acquisitionRewards[requestId].status != AcquisitionRewardStatus.None) revert AcquisitionAlreadyTerminal();

        uint256 shareBps = builderRewardBps;
        // builderRewardBps is capped at MAX_BUILDER_REWARD_BPS, so it fits uint16.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint16 eligibleShareBps = caller != purchaser ? uint16(shareBps) : 0;
        slice = FixedPointMathLib.fullMulDiv(protocolFee, eligibleShareBps, BPS);
        rewardEpoch = currentEpoch();

        acquisitionRewards[requestId] = AcquisitionReward({
            purchaser: purchaser,
            epoch: rewardEpoch,
            status: AcquisitionRewardStatus.Pending,
            tokenSlice: slice,
            caller: caller
        });
        acquisitionBuilderRewardBps[requestId] = eligibleShareBps;
        pendingAcquisitionsInEpoch[rewardEpoch] += 1;

        emit AcquisitionRewardRegistered(requestId, purchaser, rewardEpoch, caller, slice, shareBps);
    }

    function settleAcquisition(uint256 requestId) external payable onlyFWA {
        AcquisitionReward storage reward = acquisitionRewards[requestId];
        if (reward.status == AcquisitionRewardStatus.None) revert UnknownRequest();
        if (reward.status != AcquisitionRewardStatus.Pending) revert AcquisitionAlreadyTerminal();
        if (msg.value != reward.tokenSlice) revert IncorrectTokenSlice();

        (address purchaser,,, uint256 listingId, uint8 status) = IFwaV2RewardsCore(fwa).acquisitions(requestId);
        if (
            purchaser != reward.purchaser || listingId == 0 || status != CORE_ACQUISITION_FULFILLED
                || settlementRewards[listingId].caller != address(0)
        ) revert InvalidAcquisitionLink();
        settlementRewards[listingId] =
            SettlementReward({caller: reward.caller, shareBps: acquisitionBuilderRewardBps[requestId], settled: false});

        reward.status = AcquisitionRewardStatus.Settled;
        uint64 epoch = reward.epoch;
        pendingAcquisitionsInEpoch[epoch] -= 1;
        acquisitionsInEpoch[epoch] += 1;
        userAcquisitionsInEpoch[epoch][reward.purchaser] += 1;

        uint256 slice = reward.tokenSlice;
        if (slice != 0) {
            tokenBuyAllowance[reward.caller] += slice;
            tokenBuyAllowanceTotal += slice;
        }

        emit AcquisitionTokenAccrued(reward.caller, requestId, slice);
    }

    function refundAcquisition(uint256 requestId) external onlyFWA {
        AcquisitionReward storage reward = acquisitionRewards[requestId];
        if (reward.status == AcquisitionRewardStatus.None) revert UnknownRequest();
        if (reward.status != AcquisitionRewardStatus.Pending) revert AcquisitionAlreadyTerminal();

        reward.status = AcquisitionRewardStatus.Refunded;
        pendingAcquisitionsInEpoch[reward.epoch] -= 1;
        emit AcquisitionRewardRefunded(requestId, reward.epoch);
    }

    function settlementBuilderReward(uint256 listingId, uint256 protocolFee) external view returns (uint256 slice) {
        SettlementReward storage reward = settlementRewards[listingId];
        if (reward.caller == address(0) || reward.settled) return 0;
        return FixedPointMathLib.fullMulDiv(protocolFee, reward.shareBps, BPS);
    }

    function settleListing(uint256 listingId, uint256 protocolFee) external payable onlyFWA {
        SettlementReward storage reward = settlementRewards[listingId];
        if (reward.caller == address(0)) {
            if (msg.value != 0) revert IncorrectTokenSlice();
            return;
        }
        if (reward.settled) revert SettlementAlreadyTerminal();
        uint256 slice = FixedPointMathLib.fullMulDiv(protocolFee, reward.shareBps, BPS);
        if (msg.value != slice) revert IncorrectTokenSlice();

        reward.settled = true;
        address caller = reward.caller;
        if (slice != 0) {
            tokenBuyAllowance[caller] += slice;
            tokenBuyAllowanceTotal += slice;
        }
        emit SettlementBuilderRewardAccrued(listingId, caller, protocolFee, slice);
    }

    /* ------------------------------------------------------------------ */
    /*                       EPOCHS (VERIFIED LOGIC)                       */
    /* ------------------------------------------------------------------ */

    function startEpochs() external onlyFWA {
        if (epochStart != 0) return;
        epochStart = block.timestamp;
    }

    function currentEpoch() public view returns (uint64) {
        uint256 start = epochStart;
        if (start == 0 || block.timestamp <= start) return 0;
        return uint64((block.timestamp - start) / 1 days);
    }

    function claimEpochTokens(uint256[] calldata epochs) external nonReentrant returns (uint256 total) {
        uint256 current = currentEpoch();

        for (uint256 i; i < epochs.length; ++i) {
            uint256 epoch = epochs[i];
            if (epoch >= current) revert EpochNotClosed();
            if (pendingAcquisitionsInEpoch[epoch] != 0) revert EpochStillPending();
            if (purchaserEpochSwept[epoch] || purchaserClaimed[epoch][msg.sender]) revert AlreadyClaimed();

            uint256 mine = userAcquisitionsInEpoch[epoch][msg.sender];
            if (mine == 0) continue;

            purchaserClaimed[epoch][msg.sender] = true;
            total += purchaserEpochAmount(epoch) * mine / acquisitionsInEpoch[epoch];
        }

        if (total == 0) revert NoTokenReward();
        SafeTransferLib.safeTransfer(token, msg.sender, total);
    }

    function purchaserEpochAmount(uint256 epoch) public view returns (uint256) {
        return purchaserEpochPot[epoch];
    }

    /* ------------------------------------------------------------------ */
    /*                        BUILDER ALLOWANCE EXITS                      */
    /* ------------------------------------------------------------------ */

    /// @dev Simplified: mints instead of swapping. The allowance accounting matches the verified source.
    function claimAccruedTokens(uint256 minOut) external nonReentrant returns (uint256 tokenOut) {
        uint256 amount = tokenBuyAllowance[msg.sender];
        if (amount == 0) revert NoTokenReward();

        tokenBuyAllowance[msg.sender] = 0;
        tokenBuyAllowanceTotal -= amount;
        tokenOut = _buyTokens(amount, minOut);
        SafeTransferLib.safeTransfer(token, msg.sender, tokenOut);
    }

    function withdrawTokenBuyAllowanceAsETH() external nonReentrant returns (uint256 amount) {
        address core = fwa;
        if (core == address(0) || !IFwaV2RewardsCore(core).canRescueRewards()) revert RescueNotAllowed();

        amount = tokenBuyAllowance[msg.sender];
        if (amount == 0) revert NoTokenReward();
        tokenBuyAllowance[msg.sender] = 0;
        tokenBuyAllowanceTotal -= amount;
        SafeTransferLib.forceSafeTransferETH(msg.sender, amount);
    }

    /// @dev Simplified: mints instead of swapping.
    function buyFor(address recipient, uint256 minOut)
        external
        payable
        onlyFWA
        nonReentrant
        returns (uint256 tokenOut)
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert NoTokenReward();

        tokenOut = _buyTokens(msg.value, minOut);
        SafeTransferLib.safeTransfer(token, recipient, tokenOut);
    }

    function setBuilderRewardBps(uint256 bps) external onlyOwner {
        if (bps > MAX_BUILDER_REWARD_BPS) revert InvalidConfig();
        builderRewardBps = bps;
    }

    /* ------------------------------------------------------------------ */
    /*                              TEST ONLY                              */
    /* ------------------------------------------------------------------ */

    /// @notice Stands in for buyback routing: mints `amount` into `epoch`'s purchaser pot.
    function fundEpoch(uint256 epoch, uint256 amount) external {
        MockFWAToken(token).mint(address(this), amount);
        purchaserEpochPot[epoch] += amount;
    }

    function _buyTokens(uint256 ethIn, uint256 minOut) internal returns (uint256 tokenOut) {
        tokenOut = ethIn * tokensPerEth;
        if (tokenOut < minOut) revert SlippageBuy();
        if (tokenOut == 0) revert NoTokenReward();
        MockFWAToken(token).mint(address(this), tokenOut);
    }

    function _pendingToken(ListingReward storage reward) internal view returns (uint256) {
        uint256 accrued = reward.sqrtBacking * accTokenPerSqrt / SCALE;
        return accrued > reward.tokenDebt ? accrued - reward.tokenDebt : 0;
    }

    function _creditPending(ListingReward storage reward) internal {
        uint256 pending = _pendingToken(reward);
        if (pending == 0) return;
        tokenCredit[reward.depositor] += pending;
    }

    function _ceilDiv(uint256 x, uint256 y) internal pure returns (uint256) {
        return x == 0 ? 0 : (x - 1) / y + 1;
    }
}
