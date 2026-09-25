// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/console2.sol";
import {Vm} from "forge-std/Vm.sol";

import {Vault} from "../../src/Vault.sol";
import {FwaClientLib} from "../../src/fwa/FwaClientLib.sol";
import {FwaV2RewardsDouble} from "../harness/FwaV2RewardsDouble.sol";
import {MockFWAToken} from "../harness/MockFWAToken.sol";
import {RewardVaultDouble} from "../harness/RewardVaultDouble.sol";
import {ForkBase} from "./ForkBase.sol";

/// @notice Series and round in one contract, so the reward vault double can be driven with the same
///         share and harvested amount as a live vault.
contract StubRound {
    RewardVaultDouble internal immutable DOUBLE;
    MockFWAToken internal immutable TOKEN;
    uint256 internal pendingHarvest;

    constructor(RewardVaultDouble double, MockFWAToken token) {
        DOUBLE = double;
        TOKEN = token;
    }

    function series() external view returns (address) {
        return address(this);
    }

    function isRound(address round) external view returns (bool) {
        return round == address(this);
    }

    function register(address account, uint256 share) external {
        DOUBLE.registerRound(address(this));
        DOUBLE.updateShare(account, share);
        DOUBLE.lockShares(share);
    }

    function harvest(uint256 amount) external returns (uint256) {
        pendingHarvest = amount;
        return DOUBLE.harvest(new uint256[](1), false, 0);
    }

    function collectRewards(uint256[] calldata, bool, uint256) external {
        TOKEN.mint(address(DOUBLE), pendingHarvest);
    }
}

/// @notice Drives the live rewards module, reward vault, Permit2 and FWAT transfer helper through the
///         factory, router and vault, and runs each test double side by side on identical inputs.
contract ForkDoublesConformanceTest is ForkBase {
    /// @dev Active at `FORK_BLOCK`: SAVE ETH #284, a miss that sells back under its fresh oracle reading.
    uint256 internal constant LISTING = 39_720;
    bytes32 internal constant SETTLEMENT_ACCRUED =
        keccak256("SettlementBuilderRewardAccrued(uint256,address,uint256,uint256)");

    function setUp() public override {
        super.setUp();
        if (!forked) return;
        _clearQueue();
        _deployStack();
        vm.deal(address(this), 1 ether);
    }

    /// @notice The double reads the core's acquisition record from its `fwa`, which is this test.
    function acquisitions(uint256 requestId)
        external
        view
        returns (address purchaser, uint256 requestBlock, uint256 priceEscrowed, uint256 listingId, uint8 status)
    {
        return POOL.acquisitions(requestId);
    }

    function _pullOne(Vault vault) internal returns (uint256 requestId) {
        vm.prank(owner);
        assertEq(vault.requestPulls(1), 1, "one pull");
        requestId = vault.outstanding()[0];
    }

    function testRewardsDoubleMatchesLiveModule() public onlyFork {
        Vault vault = _createVault(1 ether, new address[](0), 1, 0);
        FwaV2RewardsDouble double = new FwaV2RewardsDouble(address(new MockFWAToken()), address(this));
        uint256 bps = REWARDS.builderRewardBps();
        assertEq(double.builderRewardBps(), bps, "double builder bps");

        uint256 id = _pullOne(vault);
        (,, uint256 escrow,,) = POOL.acquisitions(id);
        uint256 protocolFee = escrow * POOL.ownerAcquisitionFeeBps() / 10_000;
        (address purchaser, uint64 epoch, uint8 status, uint256 slice, address caller) = REWARDS.acquisitionRewards(id);
        assertEq(caller, address(router), "builder is the router");
        assertEq(purchaser, address(vault), "purchaser is the vault");
        assertEq(status, 1, "pending");
        assertEq(slice, protocolFee * bps / 10_000, "slice of the protocol fee");
        assertGt(slice, 0, "nonzero slice");

        (uint256 dSlice,) = double.registerAcquisition(id, address(vault), address(router), protocolFee);
        assertEq(dSlice, slice, "double slice");

        _allocate(id, LISTING);
        assertEq(REWARDS.tokenBuyAllowance(address(router)), slice, "live allowance after acquisition");
        double.settleAcquisition{value: dSlice}(id);
        assertEq(double.tokenBuyAllowance(address(router)), slice, "double allowance after acquisition");
        assertEq(REWARDS.userAcquisitionsInEpoch(epoch, address(vault)), 1, "live epoch unit");
        assertEq(double.userAcquisitionsInEpoch(0, address(vault)), 1, "double epoch unit");

        uint256 value = _listingValue(LISTING);
        uint256 retained = value - value * POOL.settlementDiscountBps() / 10_000;
        uint256[3] memory probes = [uint256(1), 1e15, retained];
        for (uint256 i; i < probes.length; ++i) {
            assertEq(
                double.settlementBuilderReward(LISTING, probes[i]),
                REWARDS.settlementBuilderReward(LISTING, probes[i]),
                "settlement quote"
            );
        }

        vm.recordLogs();
        vm.prank(stranger);
        vault.sync(8);
        (, Vault.PullStatus outcome) = vault.pulls(id);
        assertEq(uint8(outcome), uint8(Vault.PullStatus.Sold), "sold back");
        (uint256 liveFee, uint256 liveSlice) = _settlementAccrued(vm.getRecordedLogs());
        assertEq(liveFee, retained, "settlement protocol fee is the retained backing");

        uint256 settleSlice = double.settlementBuilderReward(LISTING, liveFee);
        assertEq(settleSlice, liveSlice, "double settlement slice");
        double.settleListing{value: settleSlice}(LISTING, liveFee);
        assertEq(REWARDS.tokenBuyAllowance(address(router)), slice + liveSlice, "live allowance after settlement");
        assertEq(double.tokenBuyAllowance(address(router)), slice + liveSlice, "double allowance after settlement");
        console2.log("acquisition slice", slice);
        console2.log("settlement slice", liveSlice);

        // A purchaser calling for itself earns no builder share, live or in the double.
        (,, uint256 total) = POOL.quoteAcquisitionPrice();
        vm.deal(stranger, total);
        vm.prank(stranger);
        uint256 direct = POOL.acquire{value: total}(stranger, 1, 0, 0, 0)[0];
        (,,, uint256 directSlice, address directCaller) = REWARDS.acquisitionRewards(direct);
        assertEq(directCaller, stranger, "direct caller");
        assertEq(directSlice, 0, "no self builder share");
        (dSlice,) = double.registerAcquisition(direct, stranger, stranger, protocolFee);
        assertEq(dSlice, 0, "double self share");
    }

    function testRewardVaultDoubleMatchesLiveVault() public onlyFork {
        Vault vault = _createVault(1 ether, new address[](0), 1, 0);
        assertTrue(vault.rewardsRegistered(), "registered at creation");
        assertEq(REWARD_VAULT.seriesOf(address(vault)), address(factory), "series");
        assertEq(REWARD_VAULT.shareOf(address(vault), owner), 1, "owner share");
        assertEq(REWARD_VAULT.lockedTotal(address(vault)), 1, "locked at 100%");

        uint256 id = _pullOne(vault);
        _allocate(id, LISTING);
        vault.sync(8);

        (, uint64 epoch,,,) = REWARDS.acquisitionRewards(id);
        assertEq(REWARDS.currentEpoch(), epoch, "pull in the current epoch");
        vm.prank(address(TOKEN));
        REWARDS.onTokenReceived(0, 1000 ether);
        vm.warp(block.timestamp + 1 days);
        assertEq(REWARDS.pendingAcquisitionsInEpoch(epoch), 0, "epoch settled");
        uint256 expected = REWARDS.purchaserEpochAmount(epoch) * REWARDS.userAcquisitionsInEpoch(epoch, address(vault))
            / REWARDS.acquisitionsInEpoch(epoch);

        uint256[] memory epochs = new uint256[](1);
        epochs[0] = epoch;
        assertFalse(TOKEN.isDistributor(address(REWARD_VAULT)), "grant absent at the pinned block");
        vm.expectRevert(FwaClientLib.FwatCustodyUnavailable.selector);
        vault.harvestRewards(epochs);

        vm.prank(TOKEN.owner());
        TOKEN.setDistributor(address(REWARD_VAULT), true);
        vm.prank(stranger);
        uint256 harvested = vault.harvestRewards(epochs);
        assertEq(harvested, expected, "vault share of the epoch pot");
        assertEq(REWARD_VAULT.totalReceived(address(vault)), harvested, "live received");

        MockFWAToken mock = new MockFWAToken();
        RewardVaultDouble double = new RewardVaultDouble(address(mock), address(this));
        StubRound round = new StubRound(double, mock);
        double.setSeries(address(round), true);
        round.register(owner, 1);
        assertEq(round.harvest(harvested), harvested, "double harvest");
        assertEq(double.claimable(address(round), owner), harvested, "double claimable");
        assertEq(REWARD_VAULT.claimable(address(vault), owner), harvested, "live claimable");

        vm.prank(stranger);
        REWARD_VAULT.claim(address(vault), owner);
        double.claim(address(round), owner);
        assertEq(TOKEN.balanceOf(owner), harvested, "live claim paid the owner");
        assertEq(mock.balanceOf(owner), harvested, "double claim paid the owner");
        assertEq(REWARD_VAULT.claimable(address(vault), owner), 0, "live claimed");
        assertEq(double.claimable(address(round), owner), 0, "double claimed");
        console2.log("harvested", harvested);
    }

    function testRouterBuilderClaimThroughPermit2AndHelper() public onlyFork {
        Vault vault = _createVault(1 ether, new address[](0), 1, 0);
        _allocate(_pullOne(vault), LISTING);
        vault.sync(8);
        uint256 allowance = REWARDS.tokenBuyAllowance(address(router));
        assertGt(allowance, 0, "router allowance");

        vm.prank(stranger);
        vm.expectRevert();
        router.claimAndQueueBuilderRewards(1, block.timestamp + 10 minutes);

        vm.prank(FEE_RECIPIENT);
        (uint256 amount, uint256 totalPending) = router.claimAndQueueBuilderRewards(1, block.timestamp + 10 minutes);
        assertGt(amount, 0, "FWAT bought");
        assertGe(totalPending, amount, "queued for the treasury");
        assertEq(REWARDS.tokenBuyAllowance(address(router)), 0, "allowance spent");
        assertEq(TOKEN.balanceOf(address(router)), 0, "router holds nothing");

        // The live helper releases a deposit one block after it lands.
        vm.expectRevert(abi.encodeWithSignature("ClaimDelayNotMet(uint256)", block.number + 1));
        router.claimTreasury();
        vm.roll(block.number + 1);
        uint256 before = TOKEN.balanceOf(FEE_RECIPIENT);
        router.claimTreasury();
        assertEq(TOKEN.balanceOf(FEE_RECIPIENT) - before, totalPending, "treasury paid");
        console2.log("builder allowance wei", allowance);
        console2.log("FWAT bought", amount);
        console2.log("treasury pending paid", totalPending);
    }

    function _settlementAccrued(Vm.Log[] memory logs) internal view returns (uint256 fee, uint256 slice) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(REWARDS) && logs[i].topics[0] == SETTLEMENT_ACCRUED) {
                assertEq(uint256(logs[i].topics[1]), LISTING, "settled listing");
                assertEq(address(uint160(uint256(logs[i].topics[2]))), address(router), "settlement caller");
                return abi.decode(logs[i].data, (uint256, uint256));
            }
        }
        revert("no settlement accrual");
    }
}
