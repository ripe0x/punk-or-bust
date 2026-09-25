// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";

import {IFWA} from "../src/interfaces/IFWA.sol";
import {Vault} from "../src/Vault.sol";
import {VaultTestBase} from "./harness/VaultTestBase.sol";

contract VaultKeeperTest is VaultTestBase {
    bytes32 internal constant REIMBURSED = keccak256("KeeperReimbursed(address,uint256,uint256,uint256)");
    bytes32 internal constant BOUNTY = keccak256("BountyPaid(address,uint256)");

    function setUp() public override {
        super.setUp();
        _createVault(5 ether, _params());
        _list(depositor, 1, 1 ether);
        _list(depositor, 2, 1 ether);
    }

    /// @dev Keeper `requestPulls(1)`; returns the logged reimbursement and the keeper's balance gain.
    function _keeperRequest() internal returns (uint256 gasUsed, uint256 price, uint256 amount, uint256 gained) {
        uint256 before = keeper.balance;
        vm.recordLogs();
        vm.prank(keeper);
        vault.requestPulls(1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == REIMBURSED) {
                (gasUsed, price, amount) = abi.decode(logs[i].data, (uint256, uint256, uint256));
            }
        }
        gained = keeper.balance - before;
    }

    function testPublicCallerRequestsAndIsPaid() public {
        vm.fee(1 gwei);
        vm.txGasPrice(1.2 gwei);
        vm.recordLogs();
        vm.prank(stranger);
        assertEq(vault.requestPulls(1), 1, "anyone may request");
        (uint256 gasPaid, uint256 bounty) = _paidFromLogs(stranger);
        assertGt(gasPaid, 0, "gas reimbursed");
        assertEq(bounty, vault.DEFAULT_BOUNTY(), "bounty");
        assertEq(stranger.balance, gasPaid + bounty, "paid together");
    }

    function testPrivateModeBlocksPublicAndPaysOnlyKeepers() public {
        vm.prank(stranger);
        vm.expectRevert(Vault.Unauthorized.selector);
        vault.setPrivateMode(true);
        vm.prank(owner);
        vault.setPrivateMode(true);
        assertTrue(vault.privateMode(), "private");

        vm.prank(stranger);
        vm.expectRevert(Vault.Unauthorized.selector);
        vault.requestPulls(1);

        vm.prank(keeper);
        assertEq(vault.requestPulls(1), 1, "keeper may request");
        assertEq(keeper.balance, vault.bountyWei(), "keeper paid");
        vm.prank(owner);
        assertEq(vault.requestPulls(1), 1, "owner may request");

        uint256[] memory ids = vault.outstanding();
        _allocate(ids[0], 1);
        vm.prank(stranger);
        assertEq(vault.sync(32), 1, "anyone can still sync");
        assertEq(stranger.balance, 0, "stranger not paid in private mode");
        _allocate(ids[1], 2);
        uint256 before = keeper.balance;
        vm.prank(keeper);
        vault.sync(32);
        assertEq(keeper.balance - before, vault.bountyWei(), "keeper paid for sync");
    }

    function testRevokedKeeperCannotRequestInPrivateMode() public {
        vm.startPrank(owner);
        vault.setPrivateMode(true);
        vault.setKeepers(_one(keeper), false);
        vm.stopPrank();
        assertFalse(vault.isKeeper(keeper), "revoked");
        vm.prank(keeper);
        vm.expectRevert(Vault.Unauthorized.selector);
        vault.requestPulls(1);
    }

    function testNoPayWithoutUsefulWork() public {
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(stranger);
        assertEq(vault.requestPulls(1), 0, "winds down, no pull");
        assertEq(stranger.balance, 0, "nothing opened, nothing paid");
    }

    function testReimbursementBoundedByCeilingAndAppliesMidRun() public {
        vm.fee(1 gwei);
        vm.txGasPrice(1.2 gwei);
        (uint256 gasUsed, uint256 price, uint256 amount, uint256 gained) = _keeperRequest();
        assertEq(price, 1.2 gwei, "ceiling binds");
        assertEq(amount, gasUsed * price, "gas times price");
        assertEq(gained, amount + vault.bountyWei(), "paid to keeper with bounty");
        assertLe(gasUsed, vault.REQUEST_GAS_CAP(), "per-call gas cap");

        vm.prank(owner);
        vault.setGasCeiling(0.5 gwei);
        vm.fee(0.4 gwei);
        vm.txGasPrice(0.5 gwei);
        (uint256 gasUsed2, uint256 price2, uint256 amount2, uint256 gained2) = _keeperRequest();
        assertEq(price2, 0.5 gwei, "new ceiling applies immediately");
        assertEq(amount2, gasUsed2 * price2, "gas times new price");
        assertEq(gained2, amount2 + vault.bountyWei(), "paid");
    }

    function testReimbursementUsesPriorityCapAndTxPrice() public {
        vm.prank(owner);
        vault.setGasCeiling(100 gwei);
        vm.fee(3 gwei);
        vm.txGasPrice(20 gwei);
        (, uint256 price,,) = _keeperRequest();
        assertEq(price, 5 gwei, "basefee plus priority cap");

        vm.txGasPrice(4 gwei);
        (, price,,) = _keeperRequest();
        assertEq(price, 4 gwei, "tx gas price");
    }

    /// @dev The owner spends idle down to less than one bounty; a keep brings no ETH back, so the
    ///      paying sync is capped at what idle holds.
    function testPaymentNeverExceedsIdle() public {
        vm.startPrank(owner);
        vault.stop();
        (uint256 fee, uint256 total) = _price();
        uint256 leftover = 0.0001 ether;
        vm.deal(owner, 2 ether);
        vault.startRun{value: total + fee * 250 / 1_000_000 + leftover}(_params());
        vault.setKeepCollections(_one(address(nft)), true);
        assertEq(vault.requestPulls(1), 1, "owner pulls");
        vm.stopPrank();
        uint256[] memory ids = vault.outstanding();
        _allocate(ids[0], 1);

        vm.prank(stranger);
        assertEq(vault.sync(32), 1, "kept");
        assertEq(nft.ownerOf(1), owner, "kept to owner");
        assertGt(stranger.balance, 0, "paid what idle holds");
        assertLe(stranger.balance, leftover, "never more than idle");
        assertLt(stranger.balance, vault.bountyWei(), "bounty cut short");
        assertEq(vault.idle(), 0, "idle drained, never negative");
    }

    function testOwnerNeverPaid() public {
        vm.fee(1 gwei);
        vm.txGasPrice(1.2 gwei);
        uint256 before = owner.balance;
        vm.prank(owner);
        vault.requestPulls(1);
        assertEq(owner.balance, before, "owner not paid for requests");

        uint256[] memory ids = vault.outstanding();
        _allocate(ids[0], 1);
        vm.prank(owner);
        assertEq(vault.sync(32), 1, "owner syncs");
        assertEq(owner.balance, before, "owner not paid for sync");
    }

    function testPaidForSyncOnlyWhenItResolves() public {
        vm.fee(1 gwei);
        vm.txGasPrice(1.2 gwei);
        vm.prank(stranger);
        vault.sync(32);
        assertEq(stranger.balance, 0, "nothing resolved, nothing paid");

        _keeperRequest();
        uint256[] memory ids = vault.outstanding();
        _allocate(ids[0], 1);
        vm.prank(stranger);
        vault.sync(32);
        assertGt(stranger.balance, vault.bountyWei(), "paid gas and bounty for a resolving sync");
        assertLe(stranger.balance, vault.SYNC_GAS_CAP() * 1.2 gwei + vault.bountyWei(), "bounded");
    }

    /// @dev Stranger sync of one allocated pull `age` after FWA allocated it; returns the bounty paid.
    function _syncBountyAt(uint256 tokenId, uint256 age) internal returns (uint256) {
        uint256 listingId = _list(depositor, tokenId, 1 ether);
        uint256 id = _requestOne();
        _allocate(id, listingId);
        vm.warp(block.timestamp + age);
        uint256 before = stranger.balance;
        vm.prank(stranger);
        assertEq(vault.sync(32), 1, "resolved");
        return stranger.balance - before;
    }

    function testSyncBountyEscalates() public {
        uint256 lo = vault.bountyWei();
        uint256 hi = vault.syncBountyMaxWei();
        assertEq(_syncBountyAt(10, 0), lo, "0 min: base bounty");
        assertEq(_syncBountyAt(11, 15 minutes), lo + (hi - lo) / 2, "15 min: halfway");
        assertEq(_syncBountyAt(12, 30 minutes), hi, "30 min: max");
        assertEq(_syncBountyAt(13, 45 minutes), hi, "45 min: capped");
    }

    function testSyncBountyUsesOldestResolvedPull() public {
        uint256 a = _requestOne();
        _allocate(a, 1);
        vm.warp(block.timestamp + 20 minutes);
        uint256 b = _requestOne();
        _allocate(b, 2);
        (uint256 resolvable, uint256 oldest,) = vault.syncStatus();
        assertEq(resolvable, 2, "both resolvable");
        assertEq(oldest, block.timestamp - 20 minutes, "oldest allocation");
        vm.warp(block.timestamp + 1 minutes);
        vm.prank(stranger);
        assertEq(vault.sync(32), 2, "both resolved");
        uint256 lo = vault.bountyWei();
        assertEq(stranger.balance, lo + (vault.syncBountyMaxWei() - lo) * 21 / 30, "priced by the oldest");
    }

    function testSetBountiesBounds() public {
        vm.prank(stranger);
        vm.expectRevert(Vault.Unauthorized.selector);
        vault.setBounties(0.001 ether, 0.01 ether);

        vm.startPrank(owner);
        vm.expectRevert(Vault.BadParams.selector);
        vault.setBounties(0.0003 ether - 1, 0.003 ether);
        vm.expectRevert(Vault.BadParams.selector);
        vault.setBounties(0.0003 ether, 0.003 ether - 1);
        vm.expectRevert(Vault.BadParams.selector);
        vault.setBounties(0.003 ether + 1, 0.03 ether);
        vm.expectRevert(Vault.BadParams.selector);
        vault.setBounties(0.003 ether, 0.03 ether + 1);
        vault.setBounties(0.003 ether, 0.03 ether);
        assertEq(vault.bountyWei(), 0.003 ether, "max bounty");
        assertEq(vault.syncBountyMaxWei(), 0.03 ether, "max sync bounty");
        vault.setBounties(0.0003 ether, 0.003 ether);
        vault.setBounties(0.002 ether, 0.004 ether);
        vm.stopPrank();

        vm.prank(stranger);
        vault.requestPulls(1);
        assertEq(stranger.balance, 0.002 ether, "raised bounty applies");
    }

    /// @dev Idle covers one pull plus the gas reserve but not the bounty: a paid caller is refused
    ///      the pull, the owner is not.
    function testFloorReserveIncludesBounty() public {
        vm.startPrank(owner);
        vault.stop();
        (uint256 fee, uint256 total) = _price();
        uint256 funding =
            total + fee * 250 / 1_000_000 + vault.REQUEST_GAS_CAP() * vault.gasCeiling() + vault.bountyWei() - 1;
        vm.deal(owner, funding);
        vault.startRun{value: funding}(_params());
        vm.stopPrank();

        uint256 snap = vm.snapshotState();
        vm.prank(stranger);
        assertEq(vault.requestPulls(1), 0, "reserve with bounty blocks the pull");
        vm.revertToState(snap);
        vm.prank(owner);
        assertEq(vault.requestPulls(1), 1, "owner reserves nothing");
    }

    /// @dev The callback only caches the word (fast path skipped), leaving the request `Ready`. A
    ///      sync advances FWA's sequence itself and is paid for it.
    function testSyncProcessesReadyRequest() public {
        uint256 id = _requestOne();
        (uint256 resolvable,,) = vault.syncStatus();
        assertEq(resolvable, 0, "pending is not resolvable");
        coordinator.fulfill(id, _wordFor(1));
        (,,,, uint8 st) = pool.acquisitions(id);
        assertEq(st, uint8(IFWA.AcquisitionStatus.Ready), "ready");
        (uint256 r, uint256 oldest,) = vault.syncStatus();
        assertEq(r, 1, "ready counts as resolvable");
        assertEq(oldest, 0, "nothing allocated yet");

        vm.prank(stranger);
        assertEq(vault.sync(0), 0, "processes without resolving");
        (,,,, st) = pool.acquisitions(id);
        assertEq(st, uint8(IFWA.AcquisitionStatus.Fulfilled), "processed by the vault");
        assertEq(stranger.balance, vault.bountyWei(), "processing alone is paid");
        (r, oldest,) = vault.syncStatus();
        assertEq(r, 1, "fulfilled is resolvable");
        assertEq(oldest, block.timestamp, "allocated now");

        vm.prank(stranger);
        assertEq(vault.sync(32), 1, "resolved");
        (r, oldest,) = vault.syncStatus();
        assertEq(r + oldest, 0, "nothing left");
    }

    function testSyncProcessesAndResolvesInOneCall() public {
        uint256 id = _requestOne();
        coordinator.fulfill(id, _wordFor(1));
        vm.fee(1 gwei);
        vm.txGasPrice(1 gwei);
        vm.prank(stranger);
        assertEq(vault.sync(32), 1, "unstuck and resolved");
        assertEq(uint8(_pullStatusOf(id)), uint8(Vault.PullStatus.Sold), "sold back");
        assertGt(stranger.balance, vault.bountyWei(), "paid");
    }

    function _pullStatusOf(uint256 id) internal view returns (Vault.PullStatus s) {
        (, s) = vault.pulls(id);
    }

    function _paidFromLogs(address who) internal returns (uint256 gasPaid, uint256 bounty) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(vault) || logs[i].topics.length < 2) continue;
            if (logs[i].topics[1] != bytes32(uint256(uint160(who)))) continue;
            if (logs[i].topics[0] == REIMBURSED) (,, gasPaid) = abi.decode(logs[i].data, (uint256, uint256, uint256));
            if (logs[i].topics[0] == BOUNTY) bounty = abi.decode(logs[i].data, (uint256));
        }
    }

    function testGasCeilingBounds() public {
        vm.startPrank(owner);
        vm.expectRevert(Vault.BadParams.selector);
        vault.setGasCeiling(0);
        vm.expectRevert(Vault.BadParams.selector);
        vault.setGasCeiling(100 gwei + 1);
        vault.setGasCeiling(100 gwei);
        vm.stopPrank();
        assertEq(vault.gasCeiling(), 100 gwei, "max allowed");

        vm.prank(keeper);
        vm.expectRevert(Vault.Unauthorized.selector);
        vault.setGasCeiling(1 gwei);
    }

    function testKeeperCannotSpendAboveCeilingButOwnerCan() public {
        vm.fee(1 gwei);
        vm.txGasPrice(1.2 gwei + 1);
        vm.prank(keeper);
        vm.expectRevert(Vault.GasPriceTooHigh.selector);
        vault.requestPulls(1);
        vm.prank(stranger);
        vm.expectRevert(Vault.GasPriceTooHigh.selector);
        vault.requestPulls(1);

        vm.prank(owner);
        assertEq(vault.requestPulls(1), 1, "owner may pull at any gas price");
    }

    function testKeeperRequestReservesReimbursementAboveFloor() public {
        vm.fee(1 gwei);
        vm.txGasPrice(1.2 gwei);
        for (uint256 i; i < 40 && vault.outstandingCount() < 32; ++i) {
            vm.prank(keeper);
            try vault.requestPulls(5) {}
            catch {
                break;
            }
        }
        uint256 reserve = vault.REQUEST_GAS_CAP() * vault.gasCeiling() + vault.bountyWei();
        assertGe(vault.runValue() + reserve, vault.runFloor(), "keeper spend never crosses floor");
    }

    /// @dev Keeper `sync`; returns the logged reimbursement price.
    function _keeperSyncPrice() internal returns (uint256 price) {
        vm.recordLogs();
        vm.prank(keeper);
        vault.sync(32);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == REIMBURSED) {
                (, price,) = abi.decode(logs[i].data, (uint256, uint256, uint256));
            }
        }
    }

    function testSyncReimbursedAboveOwnerCeiling() public {
        vm.prank(owner);
        vault.requestPulls(2);
        uint256[] memory ids = vault.outstanding();
        _allocate(ids[0], 1);

        vm.fee(40 gwei);
        vm.txGasPrice(45 gwei);
        assertEq(_keeperSyncPrice(), 42 gwei, "basefee plus tip, owner ceiling ignored");

        _allocate(ids[1], 2);
        vm.fee(150 gwei);
        vm.txGasPrice(160 gwei);
        assertEq(_keeperSyncPrice(), 100 gwei, "hard cap");
    }
}
