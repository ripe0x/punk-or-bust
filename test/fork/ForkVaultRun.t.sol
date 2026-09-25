// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/console2.sol";

import {Vault} from "../../src/Vault.sol";
import {FwaClientLib} from "../../src/fwa/FwaClientLib.sol";
import {ForkBase} from "./ForkBase.sol";

interface IOwnerOf {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @notice One vault run end to end on the live pool: a keep-list hit, an oracle-routed miss sold
///         back, the pull fee, and the auto-return.
contract ForkVaultRunTest is ForkBase {
    /// @dev Active at `FORK_BLOCK`: VeeFriends Series 2 #49028 (keep list) and Wolf Game #9472 (miss).
    address internal constant KEEP_COLLECTION = 0x9378368ba6b85c1FbA5b131b530f5F5bEdf21A18;
    uint256 internal constant KEEP_LISTING = 39_716;
    uint256 internal constant KEEP_TOKEN = 49_028;
    address internal constant MISS_COLLECTION = 0xC7E67762821b2ED6c0a1F423547B2899822d8650;
    uint256 internal constant MISS_LISTING = 39_722;
    /// @dev The miss collection's live oracle reading: fresh, and under the backstop.
    uint256 internal constant MISS_ORACLE_BID = 0.0423 ether;

    function setUp() public override {
        super.setUp();
        if (!forked) return;
        _clearQueue();
        _deployStack();
    }

    function testVaultRunOnLivePool() public onlyFork {
        Vault vault = _createVault(1 ether, _one(KEEP_COLLECTION), 2, 1);
        assertTrue(vault.rewardsRegistered(), "registered with the live reward vault");

        vm.prank(owner);
        assertEq(vault.requestPulls(2), 2, "two pulls");
        uint256[] memory ids = vault.outstanding();
        _allocate(ids[0], KEEP_LISTING);
        _allocate(ids[1], MISS_LISTING);

        (bool fresh, uint256 oracleBid) = FwaClientLib.freshFloorBid(address(POOL), MISS_COLLECTION);
        uint256 missValue = _listingValue(MISS_LISTING);
        uint256 backstop = missValue * POOL.settlementDiscountBps() / 10_000;
        assertTrue(fresh, "fresh live reading");
        assertEq(oracleBid, MISS_ORACLE_BID, "live oracle bid");
        assertLt(oracleBid, backstop, "reading under the backstop, so the miss sells back");
        console2.log("miss oracle bid", oracleBid);
        console2.log("miss backstop", backstop);

        uint256 fees;
        for (uint256 i; i < ids.length; ++i) {
            (,, uint256 escrow,,) = POOL.acquisitions(ids[i]);
            fees += escrow * vault.PULL_FEE_PPM() / vault.PPM();
        }
        uint256 vaultBefore = address(vault).balance;
        uint256 ownerBefore = owner.balance;
        uint256 feeBefore = FEE_RECIPIENT.balance;

        vm.prank(stranger);
        assertEq(vault.sync(32), 2, "both resolved");

        (, Vault.PullStatus keepOutcome) = vault.pulls(ids[0]);
        (, Vault.PullStatus missOutcome) = vault.pulls(ids[1]);
        assertEq(uint8(keepOutcome), uint8(Vault.PullStatus.Kept), "keep-list hit kept");
        assertEq(uint8(missOutcome), uint8(Vault.PullStatus.Sold), "miss sold back");
        assertEq(IOwnerOf(KEEP_COLLECTION).ownerOf(KEEP_TOKEN), owner, "NFT in the owner wallet");
        assertEq(FEE_RECIPIENT.balance - feeBefore, fees, "pull fee to the fee recipient");

        assertEq(uint8(vault.status()), uint8(Vault.Status.Idle), "run finished on the keep target");
        assertEq(address(vault).balance, 0, "vault emptied");
        assertEq(owner.balance - ownerBefore, vaultBefore + backstop - fees, "auto-return includes the sale");
        console2.log("pull fees", fees);
        console2.log("returned", owner.balance - ownerBefore);
    }
}
