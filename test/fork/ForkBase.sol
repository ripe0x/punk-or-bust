// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {PurchaseRouter} from "../../src/PurchaseRouter.sol";
import {Vault} from "../../src/Vault.sol";
import {VaultFactory} from "../../src/VaultFactory.sol";
import {IFWARewards} from "../../src/interfaces/IFWARewards.sol";
import {IFwaV2Pool} from "../harness/FwaV2Harness.sol";

interface IForkPool is IFwaV2Pool {
    function lastIssuedSequence() external view returns (uint64);
    function reservedListingCount(uint64 sequence) external view returns (uint256);
    function retainedToProtocol() external view returns (bool);
    function callbackGasLimit() external view returns (uint32);
    function owner() external view returns (address);
}

interface IForkRewards is IFWARewards {
    function fwa() external view returns (address);
    function token() external view returns (address);
    function builderRewardBps() external view returns (uint256);
    function tokenPoolManager() external view returns (address);
    function tokenHook() external view returns (address);
    function onTokenReceived(uint256 depositorAmt, uint256 purchaserAmt) external;
    function settlementBuilderReward(uint256 listingId, uint256 protocolFee) external view returns (uint256);
}

interface IForkToken {
    function owner() external view returns (address);
    function permit2() external view returns (address);
    function isDistributor(address account) external view returns (bool);
    function setDistributor(address account, bool enabled) external;
    function balanceOf(address account) external view returns (uint256);
}

interface IForkRewardVault {
    function owner() external view returns (address);
    function token() external view returns (address);
    function setSeries(address series, bool allowed) external;
    function seriesAllowed(address series) external view returns (bool);
    function seriesOf(address round) external view returns (address);
    function shareOf(address round, address account) external view returns (uint256);
    function lockedTotal(address round) external view returns (uint256);
    function totalReceived(address round) external view returns (uint256);
    function claimable(address round, address account) external view returns (uint256);
    function claim(address round, address account) external;
}

interface IForkHelper {
    function token() external view returns (address);
    function permit2() external view returns (address);
}

/// @notice Mainnet fork at a pinned block. Every suite skips when `MAINNET_RPC_URL` is unset.
abstract contract ForkBase is Test {
    uint256 internal constant FORK_BLOCK = 26_055_939;

    IForkPool internal constant POOL = IForkPool(0x958C41181182e76F221331b2755b77D9e1426A98);
    IForkRewards internal constant REWARDS = IForkRewards(0xA54b44C7a894AA19C49734A753D01f9B8C5f6516);
    IForkToken internal constant TOKEN = IForkToken(0xa0Df17B5aC76ABaBA36E1450E2cbCd18A620C845);
    address internal constant FLOOR_ORACLE = 0xaA4D9009a4664604b57644bF13e447E9036727DC;
    IForkRewardVault internal constant REWARD_VAULT = IForkRewardVault(0xEa20a110ad3Dfc483977d14f80203994E65D34FB);
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant HELPER = 0xcE6d5B618e034f87C7a8B6dCa65FB8669b8c301B;
    address internal constant FEE_RECIPIENT = 0xea194A186EBe76A84E2B2027f5f23F81939c05AD;
    /// @dev Chainlink VRF v2.5 coordinator, read from the pool's storage slot 0.
    address internal constant COORDINATOR = 0xD7f86b4b8Cae7D942340FF628F82735b7a20893a;

    /// @dev Pool storage slots from the verified source's layout.
    uint256 internal constant SLOT_COORDINATOR = 0;
    uint256 internal constant SLOT_STAGING_HEAD = 32;
    uint256 internal constant SLOT_TREE = 56;
    uint256 internal constant LEAF_BASE = 1 << 32;

    uint8 internal constant ACQ_PENDING = 1;
    uint8 internal constant ACQ_FULFILLED = 2;
    uint8 internal constant ACQ_READY = 5;
    uint8 internal constant LISTING_ACTIVE = 1;
    uint8 internal constant LISTING_ALLOCATED = 2;

    bool internal forked;
    VaultFactory internal factory;
    PurchaseRouter internal router;
    /// @dev Labels chosen so the addresses hold no code on mainnet.
    address internal owner = makeAddr("fork vault owner");
    address internal stranger = makeAddr("fork stranger");

    modifier onlyFork() {
        if (!forked) vm.skip(true);
        _;
    }

    function setUp() public virtual {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc, FORK_BLOCK);
        vm.txGasPrice(1 gwei);
        require(owner.code.length == 0 && stranger.code.length == 0, "fork actor has code");
        forked = true;
    }

    /// @notice Resolves every request other purchasers left in the pool's sequence, then activates
    ///         the staging queue, so words chosen from the current tree settle against it.
    function _clearQueue() internal {
        uint64 next = POOL.nextSequenceToProcess();
        uint64 last = POOL.lastIssuedSequence();
        if (next <= last) {
            vm.roll(block.number + POOL.selectionTimeoutBlocks() + 1);
            POOL.processAcquisitions(last - next + 1);
        }
        assertEq(POOL.nextSequenceToProcess(), POOL.lastIssuedSequence() + 1, "queue empty");
        POOL.activateListings(64);
        assertEq(uint256(vm.load(address(POOL), bytes32(SLOT_STAGING_HEAD))), 0, "staging empty");
    }

    function _deployStack() internal {
        factory = new VaultFactory(address(POOL), address(REWARD_VAULT), FEE_RECIPIENT, HELPER);
        router = PurchaseRouter(payable(factory.ROUTER()));
        vm.prank(REWARD_VAULT.owner());
        REWARD_VAULT.setSeries(address(factory), true);
    }

    function _createVault(uint256 value, address[] memory keep, uint256 maxPulls, uint256 stopAfterKeeps)
        internal
        returns (Vault vault)
    {
        Vault.RunParams memory params = Vault.RunParams({
            maxDrawdownBps: 10_000,
            maxPullCostWei: 0.5 ether,
            stopAfterKeeps: stopAfterKeeps,
            deadline: block.timestamp + 1 days,
            maxPulls: maxPulls
        });
        vm.deal(owner, value);
        vm.prank(owner);
        vault = Vault(
            payable(factory.createVault{value: value}(
                    keep, new Vault.KeepToken[](0), new address[](0), params, 1.2 gwei, true
                ))
        );
    }

    function _tree(uint256 node) internal view returns (uint256) {
        return uint256(vm.load(address(POOL), keccak256(abi.encode(node, SLOT_TREE))));
    }

    /// @notice The word that selects `listingId`: the summed weight of every leaf left of its slot.
    function _wordFor(uint256 listingId) internal view returns (uint256 word) {
        (,,,, uint256 weight,,,, uint256 slot,, uint8 status) = POOL.listings(listingId);
        require(status == LISTING_ACTIVE && weight != 0, "target not active");
        uint256 node = LEAF_BASE + slot - 1;
        assertEq(_tree(node), weight, "leaf weight");
        while (node > 1) {
            if (node & 1 == 1) word += _tree(node - 1);
            node >>= 1;
        }
        require(word < POOL.totalWeight(), "word out of range");
    }

    /// @notice Delivers the word for `listingId` as the coordinator and processes the request.
    function _allocate(uint256 requestId, uint256 listingId) internal {
        (uint64 sequence,,,,,) = POOL.acquisitionMeta(requestId);
        assertEq(sequence, POOL.nextSequenceToProcess(), "request is next");
        assertEq(POOL.reservedListingCount(sequence), 0, "no reserved batch");
        uint256[] memory words = new uint256[](1);
        words[0] = _wordFor(listingId);
        vm.prank(COORDINATOR);
        POOL.rawFulfillRandomWords(requestId, words);
        (,,,, uint8 status) = POOL.acquisitions(requestId);
        if (status == ACQ_READY) POOL.processAcquisitions(1);
        uint256 allocated;
        (,,, allocated, status) = POOL.acquisitions(requestId);
        assertEq(status, ACQ_FULFILLED, "fulfilled");
        assertEq(allocated, listingId, "intended listing");
    }

    function _listingStatus(uint256 listingId) internal view returns (uint8 status) {
        (,,,,,,,,,, status) = POOL.listings(listingId);
    }

    function _listingValue(uint256 listingId) internal view returns (uint256 value) {
        (,,,,, value,,,,,) = POOL.listings(listingId);
    }

    function _one(address a) internal pure returns (address[] memory list) {
        list = new address[](1);
        list[0] = a;
    }
}
