// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";

import {Vault} from "../src/Vault.sol";
import {VaultTestBase} from "./harness/VaultTestBase.sol";

contract VaultKeeperTest is VaultTestBase {
    bytes32 internal constant REIMBURSED = keccak256("KeeperReimbursed(address,uint256,uint256,uint256)");

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

    function testNonKeeperCannotRequest() public {
        vm.prank(stranger);
        vm.expectRevert(Vault.Unauthorized.selector);
        vault.requestPulls(1);

        vm.prank(owner);
        assertEq(vault.requestPulls(1), 1, "owner may request");
    }

    function testRevokedKeeperCannotRequest() public {
        vm.prank(owner);
        vault.setKeepers(_one(keeper), false);
        vm.prank(keeper);
        vm.expectRevert(Vault.Unauthorized.selector);
        vault.requestPulls(1);
    }

    function testReimbursementBoundedByCeilingAndAppliesMidRun() public {
        vm.fee(1 gwei);
        vm.txGasPrice(1.2 gwei);
        (uint256 gasUsed, uint256 price, uint256 amount, uint256 gained) = _keeperRequest();
        assertEq(price, 1.2 gwei, "ceiling binds");
        assertEq(amount, gasUsed * price, "gas times price");
        assertEq(gained, amount, "paid to keeper");
        assertLe(gasUsed, vault.REQUEST_GAS_CAP(), "per-call gas cap");

        vm.prank(owner);
        vault.setGasCeiling(0.5 gwei);
        vm.fee(0.4 gwei);
        vm.txGasPrice(0.5 gwei);
        (uint256 gasUsed2, uint256 price2, uint256 amount2, uint256 gained2) = _keeperRequest();
        assertEq(price2, 0.5 gwei, "new ceiling applies immediately");
        assertEq(amount2, gasUsed2 * price2, "gas times new price");
        assertEq(gained2, amount2, "paid");
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

    function testReimbursementNeverExceedsIdle() public {
        vm.startPrank(owner);
        vault.stop();
        vault.setAutoReturn(false);
        vault.withdraw();
        vm.deal(owner, 0.0005 ether);
        vault.startRun{value: 0.0005 ether}(_params());
        vault.setGasCeiling(100 gwei);
        vm.stopPrank();
        vm.fee(98 gwei);
        vm.txGasPrice(100 gwei);

        // Too little ETH to pull: the call winds the run down and the reimbursement is capped at idle.
        (,, uint256 amount, uint256 gained) = _keeperRequest();
        assertEq(amount, 0.0005 ether, "capped at idle");
        assertEq(gained, amount, "paid");
        assertEq(vault.idle(), 0, "idle drained, never negative");
    }

    function testOwnerAndStrangerNotReimbursed() public {
        vm.fee(1 gwei);
        vm.txGasPrice(2 gwei);
        uint256 before = owner.balance;
        vm.prank(owner);
        vault.requestPulls(1);
        assertEq(owner.balance, before, "owner not reimbursed");

        uint256[] memory ids = vault.outstanding();
        _allocate(ids[0], 1);
        vm.prank(stranger);
        assertEq(vault.sync(32), 1, "anyone can sync");
        assertEq(stranger.balance, 0, "stranger not reimbursed");
    }

    function testKeeperReimbursedForSyncOnlyWhenItResolves() public {
        vm.fee(1 gwei);
        vm.txGasPrice(1.2 gwei);
        vm.prank(keeper);
        vault.sync(32);
        assertEq(keeper.balance, 0, "nothing resolved, nothing paid");

        _keeperRequest();
        uint256 before = keeper.balance;
        uint256[] memory ids = vault.outstanding();
        _allocate(ids[0], 1);
        vm.prank(keeper);
        vault.sync(32);
        assertGt(keeper.balance, before, "paid for a resolving sync");
        assertLe(keeper.balance - before, vault.SYNC_GAS_CAP() * 1.2 gwei, "bounded");
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
        uint256 reserve = vault.REQUEST_GAS_CAP() * vault.gasCeiling();
        assertGe(vault.runValue() + reserve, vault.runFloor(), "keeper spend never crosses floor");
    }
}
