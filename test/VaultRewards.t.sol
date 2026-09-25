// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IFWA} from "../src/interfaces/IFWA.sol";
import {IFWARewards} from "../src/interfaces/IFWARewards.sol";
import {Vault} from "../src/Vault.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {VaultTestBase} from "./harness/VaultTestBase.sol";

contract VaultRewardsTest is VaultTestBase {
    function _epochs() internal pure returns (uint256[] memory epochs) {
        epochs = new uint256[](1);
    }

    function testRegistrationFailsSoftlyThenSucceeds() public {
        vm.expectEmit(false, false, false, false, address(factory));
        emit VaultFactory.RewardsRegistrationSkipped(address(0));
        _createVault(3 ether, _params());
        assertFalse(vault.rewardsRegistered(), "not registered");
        assertEq(uint8(vault.status()), uint8(Vault.Status.Running), "vault works regardless");

        vm.expectRevert();
        vault.registerRewards();

        vm.prank(rewardVaultOwner);
        rewardVault.setSeries(address(factory), true);
        vm.prank(stranger);
        vault.registerRewards();
        assertTrue(vault.rewardsRegistered(), "registered");
        assertEq(rewardVault.seriesOf(address(vault)), address(factory), "series");
        assertEq(rewardVault.shareOf(address(vault), owner), 1, "owner share");
        assertEq(rewardVault.lockedTotal(address(vault)), 1, "locked at 100%");

        vm.expectRevert(Vault.BadStatus.selector);
        vault.registerRewards();
    }

    function testRegisteredAtCreationOnceAllowlisted() public {
        vm.prank(rewardVaultOwner);
        rewardVault.setSeries(address(factory), true);
        _createVault(3 ether, _params());
        assertTrue(vault.rewardsRegistered(), "registered at creation");
        assertEq(rewardVault.lockedTotal(address(vault)), 1, "locked");
    }

    function testOnlyVaultsRegister() public {
        vm.prank(rewardVaultOwner);
        rewardVault.setSeries(address(factory), true);
        vm.prank(stranger);
        vm.expectRevert(VaultFactory.Unauthorized.selector);
        factory.registerRound();
    }

    function testCollectRewardsOnlyFromRewardVault() public {
        _createVault(3 ether, _params());
        vm.prank(stranger);
        vm.expectRevert(Vault.Unauthorized.selector);
        vault.collectRewards(_epochs(), false, 0);

        vm.prank(address(rewardVault));
        vm.expectRevert(Vault.AccruedNotSupported.selector);
        vault.collectRewards(_epochs(), true, 0);
    }

    function testHarvestAndClaimToOwner() public {
        vm.prank(rewardVaultOwner);
        rewardVault.setSeries(address(factory), true);
        _createVault(3 ether, _params());
        uint256 listingId = _list(depositor, 1, 1 ether);
        _list(depositor, 2, 1 ether);
        _pullAndSync(listingId);
        assertEq(rewards.userAcquisitionsInEpoch(0, address(vault)), 1, "epoch unit to vault");
        assertEq(rewards.userAcquisitionsInEpoch(0, address(router)), 0, "none to router");

        rewards.fundEpoch(0, 1000 ether);
        fwat.setDistributor(address(rewardVault), true);
        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(stranger);
        uint256 harvested = vault.harvestRewards(_epochs());
        assertEq(harvested, 1000 ether, "whole pot to the only purchaser");
        assertEq(fwat.balanceOf(address(rewardVault)), 1000 ether, "in reward vault");

        vm.prank(stranger);
        rewardVault.claim(address(vault), owner);
        assertEq(fwat.balanceOf(owner), 1000 ether, "owner paid");
    }

    /// @dev The rewards module is read from FWA at claim time, so a replaced module is followed.
    function testCollectFollowsChangedRewardsModule() public {
        _createVault(3 ether, _params());
        address moved = makeAddr("movedRewards");
        vm.etch(moved, hex"00");
        vm.mockCall(address(pool), abi.encodeWithSelector(IFWA.rewards.selector), abi.encode(moved));
        vm.mockCall(moved, abi.encodeWithSelector(IFWARewards.claimEpochTokens.selector), abi.encode(uint256(0)));
        fwat.setDistributor(address(rewardVault), true);
        uint256[] memory epochs = _epochs();
        vm.expectCall(moved, abi.encodeCall(IFWARewards.claimEpochTokens, (epochs)));
        vm.prank(address(rewardVault));
        vault.collectRewards(epochs, false, 0);
    }
}
