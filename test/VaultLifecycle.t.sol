// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vault} from "../src/Vault.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {VaultTestBase} from "./harness/VaultTestBase.sol";

contract VaultLifecycleTest is VaultTestBase {
    uint256 internal constant FEE_PPM = 250;

    function testCreateVaultStartsFirstRun() public {
        address predicted = factory.predictVault(owner);
        _createVault(3 ether, _params());
        assertEq(address(vault), predicted, "CREATE2 address");
        assertEq(factory.vaultOf(owner), address(vault), "registry");
        assertTrue(factory.isVault(address(vault)) && factory.isRound(address(vault)), "is vault and round");
        assertEq(vault.OWNER(), owner, "owner");
        assertEq(uint8(vault.status()), uint8(Vault.Status.Running), "running");
        assertEq(vault.idle(), 3 ether, "idle");
        assertEq(vault.runStartValue(), 3 ether, "run start value");
        assertTrue(vault.autoReturn(), "auto-return default on");
        assertEq(vault.gasCeiling(), 1.2 gwei, "default ceiling");
        assertTrue(vault.isKeeper(keeper), "keeper set");

        vm.deal(owner, 1 ether);
        vm.prank(owner);
        vm.expectRevert(VaultFactory.VaultExists.selector);
        factory.createVault{value: 1 ether}(new address[](0), new Vault.KeepToken[](0), new address[](0), _params());
    }

    function testInitializeOnlyFactory() public {
        _createVault(1 ether, _params());
        vm.expectRevert(Vault.Unauthorized.selector);
        vault.initialize(stranger, new address[](0), new Vault.KeepToken[](0), new address[](0), _params());
    }

    function testKeepHitGoesToOwnerWallet() public {
        _createVault(3 ether, _params(), _one(address(nft)));
        uint256 listingId = _list(depositor, 7, 1 ether);
        uint256 requestId = _pullAndSync(listingId);

        assertEq(nft.ownerOf(7), owner, "owner wallet holds the NFT");
        (, Vault.PullStatus pullStatus) = vault.pulls(requestId);
        assertEq(uint8(pullStatus), uint8(Vault.PullStatus.Kept), "kept");
        assertEq(vault.keeps(), 1, "keep counted");
        assertEq(vault.keptValue(), 1 ether * DISCOUNT_BPS / BPS, "backstop given up counts as value");
        assertEq(vault.outstandingCount(), 0, "resolved");
    }

    function testTokenEntryKeepsWithoutCollectionEntry() public {
        _createVault(3 ether, _params());
        Vault.KeepToken[] memory tokens = new Vault.KeepToken[](1);
        tokens[0] = Vault.KeepToken(address(nft), 8);
        vm.prank(owner);
        vault.setKeepTokens(tokens, true);

        _list(depositor, 7, 1 ether);
        uint256 target = _list(depositor, 8, 1 ether);
        _pullAndSync(target);
        assertEq(nft.ownerOf(8), owner, "token entry kept");
    }

    function testMissSellsBackAndRecycles() public {
        _createVault(1.5 ether, _params());
        uint256[3] memory ids =
            [_list(depositor, 1, 1 ether), _list(depositor, 2, 1 ether), _list(depositor, 3, 1 ether)];
        (, uint256 total) = _price();
        assertGt(total, 0.75 ether, "a second pull needs recycled ETH");

        for (uint256 i; i < 3; ++i) {
            uint256 requestId = _pullAndSync(ids[i]);
            (, Vault.PullStatus pullStatus) = vault.pulls(requestId);
            assertEq(uint8(pullStatus), uint8(Vault.PullStatus.Sold), "sold back");
            assertEq(nft.ownerOf(i + 1), depositor, "NFT back to depositor");
        }
        assertEq(vault.pullsRequested(), 3, "three pulls in one run");
        assertEq(uint8(vault.status()), uint8(Vault.Status.Running), "still running");
    }

    function testPullFeeExactAndOnlyOnCompletion() public {
        _createVault(3 ether, _params());
        uint256 listingId = _list(depositor, 1, 1 ether);
        _list(depositor, 2, 1 ether);
        (uint256 fee,) = _price();

        uint256 requestId = _requestOne();
        (,, uint256 escrow,,) = pool.acquisitions(requestId);
        assertEq(escrow, fee, "escrow is the price excluding VRF");
        assertEq(treasury.balance, 0, "no fee at request");
        _allocate(requestId, listingId);
        vault.sync(32);
        assertEq(treasury.balance, escrow * FEE_PPM / 1_000_000, "250 ppm of price excluding VRF");
        assertEq(vault.feeOwed(), 0, "paid");
    }

    function testRefundedPullPaysNoFee() public {
        _createVault(3 ether, _params());
        _list(depositor, 1, 1 ether);
        uint256 requestId = _requestOne();
        (,, uint256 escrow,,) = pool.acquisitions(requestId);
        uint256 idleBefore = vault.idle();

        vm.roll(block.number + pool.selectionTimeoutBlocks() + 1);
        pool.processAcquisitions(1);
        (,,,, uint8 st) = pool.acquisitions(requestId);
        assertEq(st, 3, "expired");

        vault.sync(32);
        (, Vault.PullStatus pullStatus) = vault.pulls(requestId);
        assertEq(uint8(pullStatus), uint8(Vault.PullStatus.Refunded), "refunded");
        assertEq(treasury.balance, 0, "no fee");
        assertEq(vault.idle(), idleBefore + escrow, "escrow back in idle");
        assertEq(pool.acquisitionRefundCredit(address(vault)), 0, "credit taken");
    }

    function testZeroDrawdownNeverPulls() public {
        Vault.RunParams memory p = _params();
        p.maxDrawdownBps = 0;
        _createVault(3 ether, p);
        _list(depositor, 1, 1 ether);

        vm.prank(keeper);
        assertEq(vault.requestPulls(5), 0, "no pull");
        assertEq(uint8(vault.status()), uint8(Vault.Status.Idle), "run ended");
        assertEq(owner.balance, 3 ether, "all returned");
    }

    function testFullDrawdownPullsUntilEmpty() public {
        _createVault(1.2 ether, _params());
        uint256 first = _list(depositor, 1, 1 ether);
        uint256 second = _list(depositor, 2, 1 ether);
        _list(depositor, 3, 1 ether);

        _pullAndSync(first);
        _pullAndSync(second);
        (, uint256 total) = _price();
        assertLt(vault.idle(), total, "cannot afford another");

        uint256 left = vault.idle();
        vm.prank(keeper);
        assertEq(vault.requestPulls(1), 0, "no pull");
        assertEq(uint8(vault.status()), uint8(Vault.Status.Idle), "ended");
        assertEq(owner.balance, left, "remainder returned");
    }

    function testFloorClampsAndWaitsForInFlight() public {
        Vault.RunParams memory p = _params();
        p.maxDrawdownBps = 1500;
        _createVault(10 ether, p);
        uint256 first = _list(depositor, 1, 1 ether);
        _list(depositor, 2, 1 ether);

        vm.prank(keeper);
        assertEq(vault.requestPulls(5), 1, "floor allows one");

        vm.prank(keeper);
        vm.expectRevert(Vault.FloorReached.selector);
        vault.requestPulls(1);

        uint256[] memory ids = vault.outstanding();
        _allocate(ids[0], first);
        vault.sync(32);

        // Each sold pull loses about 0.1 ETH; keep pulling until the floor ends the run.
        uint256 pulls = 1;
        for (uint256 tokenId = 10; vault.status() == Vault.Status.Running; ++tokenId) {
            uint256 listingId = _list(depositor, tokenId, 1 ether);
            vm.prank(keeper);
            if (vault.requestPulls(1) == 0) break;
            ids = vault.outstanding();
            _allocate(ids[0], listingId);
            vault.sync(32);
            ++pulls;
        }
        assertGt(pulls, 1, "sale proceeds funded more pulls");
        assertEq(uint8(vault.status()), uint8(Vault.Status.Idle), "ended on floor with nothing in flight");
        assertGe(owner.balance, 8.5 ether, "at or above the floor");
    }

    function testDeadlineEndsRun() public {
        _createVault(3 ether, _params());
        _list(depositor, 1, 1 ether);
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(keeper);
        assertEq(vault.requestPulls(1), 0, "no pull after deadline");
        assertEq(uint8(vault.status()), uint8(Vault.Status.Idle), "ended");
    }

    function testDeadlineEndsRunOnSync() public {
        _createVault(3 ether, _params());
        uint256 listingId = _list(depositor, 1, 1 ether);
        uint256 requestId = _requestOne();
        _allocate(requestId, listingId);
        vm.warp(block.timestamp + 7 days + 1);
        vault.sync(32);
        assertEq(uint8(vault.status()), uint8(Vault.Status.Idle), "ended by sync");
    }

    function testMaxPullsClampsAndEnds() public {
        Vault.RunParams memory p = _params();
        p.maxPulls = 2;
        _createVault(5 ether, p);
        uint256 first = _list(depositor, 1, 1 ether);
        uint256 second = _list(depositor, 2, 1 ether);

        vm.prank(keeper);
        assertEq(vault.requestPulls(5), 2, "clamped to maxPulls");
        vm.prank(keeper);
        assertEq(vault.requestPulls(1), 0, "cap reached");
        assertEq(uint8(vault.status()), uint8(Vault.Status.WindingDown), "winding down with pulls in flight");

        uint256[] memory ids = vault.outstanding();
        _allocate(ids[0], first);
        _allocate(ids[1], second);
        vault.sync(32);
        assertEq(uint8(vault.status()), uint8(Vault.Status.Idle), "idle once resolved");
        assertEq(address(vault).balance, 0, "returned");
    }

    function testStopAfterKeeps() public {
        Vault.RunParams memory p = _params();
        p.stopAfterKeeps = 1;
        _createVault(3 ether, p, _one(address(nft)));
        uint256 first = _list(depositor, 1, 1 ether);
        _list(depositor, 2, 1 ether);
        _pullAndSync(first);
        assertEq(uint8(vault.status()), uint8(Vault.Status.Idle), "keep target reached");
        assertEq(nft.ownerOf(1), owner, "kept");
    }

    function testAutoReturnOff() public {
        _createVault(3 ether, _params());
        vm.prank(owner);
        vault.setAutoReturn(false);
        vm.prank(owner);
        vault.stop();
        assertEq(uint8(vault.status()), uint8(Vault.Status.Idle), "idle");
        assertEq(address(vault).balance, 3 ether, "kept in vault");

        vm.prank(stranger);
        vm.expectRevert(Vault.Unauthorized.selector);
        vault.withdraw();
        vm.prank(owner);
        vault.withdraw();
        assertEq(owner.balance, 3 ether, "withdrawn");
    }

    function testWithdrawOnlyWhenIdle() public {
        _createVault(3 ether, _params());
        vm.prank(owner);
        vm.expectRevert(Vault.BadStatus.selector);
        vault.withdraw();
    }

    function testStopMidRunWindsDown() public {
        _createVault(3 ether, _params());
        uint256 listingId = _list(depositor, 1, 1 ether);
        uint256 requestId = _requestOne();

        vm.prank(owner);
        vault.stop();
        assertEq(uint8(vault.status()), uint8(Vault.Status.WindingDown), "winding down");
        vm.prank(keeper);
        vm.expectRevert(Vault.BadStatus.selector);
        vault.requestPulls(1);

        _allocate(requestId, listingId);
        vm.prank(stranger);
        vault.sync(32);
        assertEq(uint8(vault.status()), uint8(Vault.Status.Idle), "idle");
        assertEq(address(vault).balance, 0, "auto-returned");
        assertGt(owner.balance, 0, "owner paid");
    }

    function testStartRunAgainAndDeposit() public {
        _createVault(3 ether, _params());
        vm.prank(owner);
        vault.stop();

        vm.deal(owner, 2 ether);
        vm.prank(owner);
        vault.startRun{value: 2 ether}(_params());
        assertEq(vault.runStartValue(), 2 ether, "new run");

        vm.deal(owner, 1 ether);
        vm.prank(owner);
        vault.deposit{value: 1 ether}();
        assertEq(vault.runStartValue(), 3 ether, "deposit raises start value");
        assertEq(vault.idle(), 3 ether, "idle");

        vm.prank(owner);
        vm.expectRevert(Vault.BadStatus.selector);
        vault.startRun(_params());
    }

    function testRunParamsValidated() public {
        Vault.RunParams memory p = _params();
        p.maxDrawdownBps = BPS + 1;
        vm.deal(owner, 1 ether);
        vm.prank(owner);
        vm.expectRevert(Vault.BadParams.selector);
        factory.createVault{value: 1 ether}(new address[](0), new Vault.KeepToken[](0), new address[](0), p);
    }

    /// @dev The floor admits a pull exactly when value minus its cost stays at or above it.
    function testFuzzDrawdownAccounting(uint96 funding, uint16 drawdownBps, uint96 deposit) public {
        funding = uint96(bound(funding, 0.01 ether, 50 ether));
        deposit = uint96(bound(deposit, 0, 20 ether));
        drawdownBps = uint16(bound(drawdownBps, 0, BPS));
        Vault.RunParams memory p = _params();
        p.maxDrawdownBps = drawdownBps;
        _createVault(funding, p);
        _list(depositor, 1, 1 ether);
        if (deposit != 0) {
            vm.deal(owner, deposit);
            vm.prank(owner);
            vault.deposit{value: deposit}();
        }

        uint256 start = uint256(funding) + deposit;
        assertEq(vault.runStartValue(), start, "start value");
        uint256 floor = start * (BPS - drawdownBps) / BPS;
        assertEq(vault.runFloor(), floor, "floor");

        (uint256 fee, uint256 total) = _price();
        uint256 unit = total + fee * FEE_PPM / 1_000_000;
        uint256 expected = start > floor ? (start - floor) / unit : 0;
        if (start / total < expected) expected = start / total;
        if (expected > 5) expected = 5;

        vm.prank(keeper);
        uint256 requested = vault.requestPulls(5);
        assertEq(requested, expected, "pulls admitted");
        if (requested != 0) {
            assertGe(vault.runValue(), floor, "value stays at or above floor");
            assertEq(vault.idle(), start - requested * total, "idle debited by exact cost");
        } else {
            assertEq(uint8(vault.status()), uint8(Vault.Status.Idle), "run ended");
        }
    }
}
