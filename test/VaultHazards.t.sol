// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {FwaClientLib} from "../src/fwa/FwaClientLib.sol";
import {PurchaseRouter} from "../src/PurchaseRouter.sol";
import {Vault} from "../src/Vault.sol";
import {ControlledERC721, VaultTestBase} from "./harness/VaultTestBase.sol";

/// @notice One test or more per hazard in docs/FWA-HAZARDS.md. Hazard 10 is in PurchaseRouter.t.sol;
///         hazard 11 (floor oracle) is in VaultAuction.t.sol.
contract VaultHazardsTest is VaultTestBase {
    uint8 internal constant ACQ_EXPIRED = 3;
    uint8 internal constant ACQ_TIMED_OUT = 6;

    function setUp() public override {
        super.setUp();
        _createVault(5 ether, _params());
    }

    function _pullStatus(uint256 requestId) internal view returns (Vault.PullStatus s) {
        (, s) = vault.pulls(requestId);
    }

    /// @dev Hazards 1 and 3: after the purchaser window the depositor takes the NFT back and the ETH bid
    ///      lands with no callback; balance reconciliation credits it.
    function testDepositorReclaimNftAfterWindow() public {
        uint256 listingId = _list(depositor, 1, 1 ether);
        uint256 requestId = _requestOne();
        _allocate(requestId, listingId);
        uint256 idleBefore = vault.idle();

        vm.warp(block.timestamp + pool.settlementWindow());
        vm.prank(depositor);
        pool.depositorReclaimNFT(listingId);
        uint256 bid = 1 ether * DISCOUNT_BPS / BPS;
        assertEq(address(vault).balance, idleBefore + bid, "ETH arrived");
        assertEq(vault.idle(), idleBefore, "not yet tracked");

        vm.expectEmit(address(vault));
        emit Vault.PullForced(requestId, listingId, FwaClientLib.ForcedKind.ForcedEth);
        _ownerSync();
        assertEq(uint8(_pullStatus(requestId)), uint8(Vault.PullStatus.Forced), "forced");
        assertEq(vault.idle() + treasury.balance, idleBefore + bid, "credited to idle, less the pull fee");
    }

    /// @dev Hazard 1: the depositor keeps the ETH and the NFT lands in the vault; the owner sweeps it.
    function testDepositorReclaimBackingSendsNftToVault() public {
        uint256 listingId = _list(depositor, 1, 1 ether);
        uint256 requestId = _requestOne();
        _allocate(requestId, listingId);

        vm.warp(block.timestamp + pool.settlementWindow());
        vm.prank(depositor);
        pool.depositorReclaimBacking(listingId);
        assertEq(nft.ownerOf(1), address(vault), "NFT in vault");

        vm.expectEmit(address(vault));
        emit Vault.PullForced(requestId, listingId, FwaClientLib.ForcedKind.ForcedNft);
        _ownerSync();

        vm.prank(stranger);
        vm.expectRevert(Vault.Unauthorized.selector);
        vault.sweepNft(address(nft), 1);
        vm.prank(owner);
        vault.sweepNft(address(nft), 1);
        assertEq(nft.ownerOf(1), owner, "swept to owner");
    }

    /// @dev Hazard 2: after the finalize window anyone sends the NFT to the vault.
    function testFinalizeUnsettledThenSweep() public {
        uint256 listingId = _list(depositor, 1, 1 ether);
        uint256 requestId = _requestOne();
        _allocate(requestId, listingId);

        vm.warp(block.timestamp + pool.finalizeWindow());
        vm.prank(stranger);
        pool.finalizeUnsettled(listingId);
        assertEq(nft.ownerOf(1), address(vault), "NFT arrived unasked");

        _ownerSync();
        assertEq(uint8(_pullStatus(requestId)), uint8(Vault.PullStatus.Forced), "forced");
        vm.prank(owner);
        vault.sweepNft(address(nft), 1);
        assertEq(nft.ownerOf(1), owner, "swept");
    }

    /// @dev Hazard 3: untracked ETH joins idle on reconcile.
    function testReconcileCreditsUntrackedEth() public {
        uint256 idleBefore = vault.idle();
        vm.deal(address(vault), address(vault).balance + 1 ether);
        vm.prank(stranger);
        vault.reconcile();
        assertEq(vault.idle(), idleBefore + 1 ether, "credited");
    }

    /// @dev Hazard 4: refund credit is per address and withdrawn in one sum by anyone.
    function testRefundCreditWithdrawal() public {
        _list(depositor, 1, 1 ether);
        uint256 first = _requestOne();
        uint256 second = _requestOne();
        (,, uint256 escrow,,) = pool.acquisitions(first);

        vm.roll(block.number + pool.selectionTimeoutBlocks() + 1);
        pool.processAcquisitions(2);
        (,,,, uint8 st) = pool.acquisitions(second);
        assertEq(st, ACQ_EXPIRED, "expired");
        assertEq(pool.acquisitionRefundCredit(address(vault)), 2 * escrow, "credit summed");

        uint256 idleBefore = vault.idle();
        vm.prank(stranger);
        assertEq(vault.withdrawAcquisitionRefund(), 2 * escrow, "withdrawn");
        assertEq(vault.idle(), idleBefore + 2 * escrow, "idle credited");

        _ownerSync();
        assertEq(uint8(_pullStatus(first)), uint8(Vault.PullStatus.Refunded), "first refunded");
        assertEq(uint8(_pullStatus(second)), uint8(Vault.PullStatus.Refunded), "second refunded");
        assertEq(treasury.balance, 0, "no fee");
    }

    /// @dev Hazard 5: FWA fails to deliver, records the vault as stuck recipient; recovery pulls it.
    function testStuckNftRecovery() public {
        ControlledERC721 paused = new ControlledERC721();
        uint256 listingId = _listCustom(paused, 1, 1 ether);
        uint256 requestId = _requestOne();
        _allocate(requestId, listingId);

        paused.setPaused(true);
        vm.warp(block.timestamp + pool.finalizeWindow());
        pool.finalizeUnsettled(listingId);
        assertEq(pool.stuckNFTRecipient(listingId), address(vault), "stuck for vault");

        vm.expectEmit(address(vault));
        emit Vault.PullForced(requestId, listingId, FwaClientLib.ForcedKind.StuckNft);
        _ownerSync();

        vm.expectRevert();
        vault.recoverStuck(listingId);

        paused.setPaused(false);
        vm.prank(stranger);
        vault.recoverStuck(listingId);
        assertEq(paused.ownerOf(1), address(vault), "recovered");
        vm.prank(owner);
        vault.sweepNft(address(paused), 1);
        assertEq(paused.ownerOf(1), owner, "swept");
    }

    /// @dev Hazard 6: a keep that reverts falls back to selling back in the same sync.
    function testKeepRevertFallsBackToSale() public {
        ControlledERC721 restricted = new ControlledERC721();
        restricted.setBlocked(address(vault), true);
        vm.prank(owner);
        vault.setKeepCollections(_one(address(restricted)), true);

        uint256 listingId = _listCustom(restricted, 1, 1 ether);
        uint256 idleBefore = vault.idle();
        uint256 requestId = _requestOne();
        uint256 total = idleBefore - vault.idle();
        _allocate(requestId, listingId);
        _ownerSync();

        assertEq(uint8(_pullStatus(requestId)), uint8(Vault.PullStatus.Sold), "sold back");
        assertEq(restricted.ownerOf(1), depositor, "NFT to depositor");
        assertEq(vault.keeps(), 0, "no keep");
        assertEq(vault.idle(), idleBefore - total + 1 ether * DISCOUNT_BPS / BPS - treasury.balance, "bid credited");
    }

    /// @dev Hazard 7: a word after its deadline times the request out; it refunds at the head.
    function testTimedOutRequestRefunds() public {
        _list(depositor, 1, 1 ether);
        uint256 requestId = _requestOne();
        (,, uint256 escrow,,) = pool.acquisitions(requestId);

        vm.roll(block.number + pool.selectionTimeoutBlocks() + 1);
        coordinator.fulfill(requestId, 0);
        (,,,, uint8 st) = pool.acquisitions(requestId);
        assertEq(st, ACQ_TIMED_OUT, "timed out");

        // The vault's own sync advances FWA's sequence past the timed-out head, then takes the refund.
        uint256 idleBefore = vault.idle();
        _ownerSync();
        assertEq(uint8(_pullStatus(requestId)), uint8(Vault.PullStatus.Refunded), "refunded");
        assertEq(vault.idle(), idleBefore + escrow, "escrow back");
    }

    /// @dev Hazard 8: no requests during the purchase blackout.
    function testPurchaseBlackout() public {
        _list(depositor, 1, 1 ether);
        vm.warp(block.timestamp + 1 hours + 32 minutes);
        assertTrue(pool.isPurchaseBlackout(), "blackout");
        vm.prank(keeper);
        vm.expectRevert(Vault.PurchaseBlackout.selector);
        vault.requestPulls(1);
    }

    /// @dev Hazard 9: at most 5 per request, 32 outstanding.
    function testBatchAndOutstandingLimits() public {
        _list(depositor, 1, 1 ether);
        vm.prank(keeper);
        vm.expectRevert(Vault.BadCount.selector);
        vault.requestPulls(6);

        vm.deal(owner, 40 ether);
        vm.prank(owner);
        vault.deposit{value: 40 ether}();
        (, uint256 total) = _price();
        assertGt(40 ether, 32 * total, "funded for 32");
        for (uint256 i; i < 6; ++i) {
            vm.prank(keeper);
            vault.requestPulls(5);
        }
        vm.prank(keeper);
        assertEq(vault.requestPulls(5), 2, "clamped to 32 outstanding");
        vm.prank(keeper);
        vm.expectRevert(Vault.TooManyOutstanding.selector);
        vault.requestPulls(1);
    }

    /// @dev Hazard 12: the ETH bid uses the live settlement discount.
    function testLiveSettlementDiscount() public {
        pool.setUint(KEY_SETTLEMENT_DISCOUNT_BPS, 8000);
        // Oracle bid at the new backstop, so the miss sells back rather than opening an auction.
        oracle.setFloorRange(address(nft), 0.8 ether, 100 ether, uint48(block.timestamp), 12 hours);
        uint256 listingId = _list(depositor, 1, 1 ether);
        uint256 requestId = _requestOne();
        _allocate(requestId, listingId);
        uint256 before = address(vault).balance;
        _ownerSync();
        assertEq(address(vault).balance + treasury.balance - before, 0.8 ether, "80% bid");
    }

    function testSettleSelfOnlySelf() public {
        vm.expectRevert(Vault.Unauthorized.selector);
        vault.settleSelf(1, owner);
    }

    function testRouterRejectsNonVault() public {
        _list(depositor, 1, 1 ether);
        vm.deal(stranger, 2 ether);
        vm.prank(stranger);
        vm.expectRevert(PurchaseRouter.Unauthorized.selector);
        router.acquireBatch{value: 2 ether}(1);
    }
}
