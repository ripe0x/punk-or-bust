// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {IFWA} from "../../src/interfaces/IFWA.sol";
import {IFWAV2} from "../../src/interfaces/IFWAV2.sol";
import {FwaV2RewardsDouble} from "./FwaV2RewardsDouble.sol";
import {MockFWAToken} from "./MockFWAToken.sol";
import {TestERC721} from "./TestERC721.sol";

/// @notice The FWA V2 pool calls the harness makes beyond `IFWA` and `IFWAV2`. Signatures follow
///         `refs/fwa-v2/src/FWAV2/FWAV2.sol.txt`.
interface IFwaV2Pool is IFWA, IFWAV2 {
    function listNFT(address collection, uint256 tokenId) external payable returns (uint256 listingId);
    function nextListingId() external view returns (uint256);
    function nextSequenceToProcess() external view returns (uint64);
    function ownerAcquisitionFeeBps() external view returns (uint256);
    function ownerSettlementFeeBps() external view returns (uint256);
    function depositorReclaimNFT(uint256 listingId) external;
    function depositorReclaimBacking(uint256 listingId) external;
    function finalizeUnsettled(uint256 listingId) external;
    function setUint(uint256 key, uint256 value) external;
    function setBool(uint256 key, bool value) external;
    function setRewards(address module) external;
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external;
}

/// @dev Same field layout as Chainlink's `VRFV2PlusClient.RandomWordsRequest`, so the selector matches.
struct RandomWordsRequest {
    bytes32 keyHash;
    uint256 subId;
    uint16 requestConfirmations;
    uint32 callbackGasLimit;
    uint32 numWords;
    bytes extraArgs;
}

/// @notice VRF coordinator double: hands out request ids and delivers words on demand.
contract VrfCoordinatorDouble {
    uint256 public lastRequestId;
    mapping(uint256 requestId => address consumer) public consumerOf;

    function requestRandomWords(RandomWordsRequest calldata) external returns (uint256 requestId) {
        requestId = ++lastRequestId;
        consumerOf[requestId] = msg.sender;
    }

    function pendingRequestExists(uint256) external pure returns (bool) {
        return false;
    }

    function fulfill(uint256 requestId, uint256 word) external {
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        IFwaV2Pool(consumerOf[requestId]).rawFulfillRandomWords(requestId, words);
    }
}

/// @notice VRF service double: a fixed per-request fee, and `prepareRequests` keeps the ETH.
contract VrfServiceDouble {
    uint256 public requestFee;
    uint256 public preparedRequests;

    constructor(uint256 fee) {
        requestFee = fee;
    }

    function prepareRequests(uint256 requestCount) external payable {
        preparedRequests += requestCount;
    }
}

/// @notice Floor oracle double. Unset collections read bid 90 ETH, ask 100 ETH, observed now, over a
///         7 day challenge.
contract FloorOracleDouble {
    struct Range {
        uint256 bid;
        uint256 ask;
        uint48 observedAt;
        uint48 periodUsed;
        bool set;
    }

    mapping(address collection => Range) internal ranges;

    function setFloorRange(address collection, uint256 bid, uint256 ask, uint48 observedAt, uint48 periodUsed)
        external
    {
        ranges[collection] = Range(bid, ask, observedAt, periodUsed, true);
    }

    function getFloorRange(address collection)
        external
        view
        returns (uint256 bidPrice, uint256 askPrice, uint48 observedAt, uint48 periodUsed)
    {
        Range memory r = ranges[collection];
        if (!r.set) return (90 ether, 100 ether, uint48(block.timestamp), 7 days);
        return (r.bid, r.ask, r.observedAt, r.periodUsed);
    }
}

/// @notice Purchase notifier double: counts notifications and never reverts.
contract PurchaseNotifierDouble {
    uint256 public notifications;

    function notifyPurchase(address, uint256, address, address, uint256, uint256, uint8) external {
        ++notifications;
    }
}

/// @notice Deploys the real verified FWA V2 pool from `refs/fwa-v2/FWAV2.json` against doubles for its
///         external dependencies, and drives listings and allocations.
abstract contract FwaV2Harness is Test {
    /// @dev `FWAV2ConfigKeys` values from `refs/fwa-v2/src/FWAV2/FWAV2ConfigKeys.sol.txt`.
    uint256 internal constant KEY_SURCHARGE_BPS = 13;
    uint256 internal constant KEY_SETTLEMENT_DISCOUNT_BPS = 17;
    uint256 internal constant KEY_ACQUISITIONS_ENABLED = 41;
    uint256 internal constant KEY_WHITELIST_ENABLED = 43;

    uint8 internal constant LISTING_ACTIVE = 1;
    uint8 internal constant LISTING_ALLOCATED = 2;
    uint8 internal constant LISTING_SETTLED = 4;
    uint8 internal constant ACQUISITION_FULFILLED = 2;

    uint256 internal constant VRF_FEE = 0.001 ether;
    /// @dev Below the pool's 900,000 fast-path floor, so the callback only caches the word and
    ///      `processAcquisitions` does the allocation.
    uint32 internal constant CALLBACK_GAS_LIMIT = 500_000;
    /// @dev 10:13 UTC, outside the pool's purchase blackout.
    uint256 internal constant START_TIME = 1_700_000_000;

    IFwaV2Pool internal pool;
    FwaV2RewardsDouble internal rewards;
    MockFWAToken internal fwat;
    VrfCoordinatorDouble internal coordinator;
    VrfServiceDouble internal vrfService;
    FloorOracleDouble internal oracle;
    PurchaseNotifierDouble internal notifier;
    TestERC721 internal nft;

    function _deployFwaV2(uint256 settlementDiscountBps) internal {
        vm.warp(START_TIME);
        vm.roll(1000);

        coordinator = new VrfCoordinatorDouble();
        vrfService = new VrfServiceDouble(VRF_FEE);
        oracle = new FloorOracleDouble();
        notifier = new PurchaseNotifierDouble();

        pool = IFwaV2Pool(
            deployCode(
                "refs/fwa-v2/FWAV2.json",
                abi.encode(
                    address(coordinator),
                    uint256(1),
                    bytes32(uint256(1)),
                    CALLBACK_GAS_LIMIT,
                    address(vrfService),
                    address(oracle),
                    address(notifier)
                )
            )
        );

        fwat = new MockFWAToken();
        rewards = new FwaV2RewardsDouble(address(fwat), address(pool));
        pool.setRewards(address(rewards));
        pool.setBool(KEY_WHITELIST_ENABLED, false);
        pool.setUint(KEY_SURCHARGE_BPS, 0);
        pool.setUint(KEY_SETTLEMENT_DISCOUNT_BPS, settlementDiscountBps);
        pool.setBool(KEY_ACQUISITIONS_ENABLED, true);

        nft = new TestERC721();
    }

    /// @notice Mints `tokenId` to `depositor` and lists it with `backing` ETH.
    function _list(address depositor, uint256 tokenId, uint256 backing) internal returns (uint256 listingId) {
        nft.mint(depositor, tokenId);
        vm.deal(depositor, depositor.balance + backing);
        vm.startPrank(depositor);
        nft.approve(address(pool), tokenId);
        listingId = pool.listNFT{value: backing}(address(nft), tokenId);
        vm.stopPrank();
        assertEq(_listingStatus(listingId), LISTING_ACTIVE, "listing active");
    }

    /// @notice The random word that makes the pool select `listingId` right now: the pool takes
    ///         `word % totalWeight` and descends its segment tree, whose leaves are active listings in
    ///         `slot` order, so the target is the weight of every active listing in a lower slot.
    function _wordFor(uint256 listingId) internal view returns (uint256 word) {
        (,,,, uint256 targetWeight,,,, uint256 targetSlot,, uint8 targetStatus) = pool.listings(listingId);
        require(targetStatus == LISTING_ACTIVE && targetWeight != 0, "target not active");
        uint256 end = pool.nextListingId();
        for (uint256 id = 1; id < end; ++id) {
            (,,,, uint256 weight,,,, uint256 slot,, uint8 status) = pool.listings(id);
            if (status == LISTING_ACTIVE && slot < targetSlot) word += weight;
        }
        require(word < pool.totalWeight(), "word out of range");
    }

    /// @notice Delivers the word that selects `listingId` for `requestId` and processes it. The request
    ///         must be next in the pool's sequence, so the tree the word was derived from is the tree
    ///         it settles against.
    function _allocate(uint256 requestId, uint256 listingId) internal {
        (uint64 sequence,,,,,) = pool.acquisitionMeta(requestId);
        assertEq(sequence, pool.nextSequenceToProcess(), "request is next in sequence");

        coordinator.fulfill(requestId, _wordFor(listingId));
        pool.processAcquisitions(1);

        (,,, uint256 allocated, uint8 status) = pool.acquisitions(requestId);
        assertEq(status, ACQUISITION_FULFILLED, "acquisition fulfilled");
        assertEq(allocated, listingId, "intended listing allocated");
        assertEq(_listingStatus(listingId), LISTING_ALLOCATED, "listing allocated");
    }

    function _listingStatus(uint256 listingId) internal view returns (uint8 status) {
        (,,,,,,,,,, status) = pool.listings(listingId);
    }

    function _listingValue(uint256 listingId) internal view returns (uint256 value) {
        (,,,,, value,,,,,) = pool.listings(listingId);
    }
}
