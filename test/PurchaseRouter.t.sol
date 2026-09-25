// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PurchaseRouter} from "../src/PurchaseRouter.sol";
import {VaultTestBase} from "./harness/VaultTestBase.sol";

/// @notice Hazard 10: the builder reward accrues to the router, never the vault, and only the treasury
///         can turn it into FWAT.
contract PurchaseRouterTest is VaultTestBase {
    uint256 internal constant KEY_WITHDRAW_ONLY = 42;

    uint256 internal allowance;

    function setUp() public override {
        super.setUp();
        _createVault(5 ether, _params());
        uint256 listingId = _list(depositor, 1, 1 ether);
        _list(depositor, 2, 1 ether);
        (uint256 fee,) = _price();
        _pullAndSync(listingId);

        uint256 acquisitionShare = fee * pool.ownerAcquisitionFeeBps() / BPS * 1500 / BPS;
        uint256 settlementShare = (1 ether - 1 ether * DISCOUNT_BPS / BPS) * 1500 / BPS;
        allowance = rewards.tokenBuyAllowance(address(router));
        assertGt(acquisitionShare, 0, "nonzero share");
        assertEq(allowance, acquisitionShare + settlementShare, "15% of both protocol fees to router");
        assertEq(rewards.tokenBuyAllowance(address(vault)), 0, "vault earns none");
    }

    function testOnlyTreasuryClaims() public {
        vm.prank(stranger);
        vm.expectRevert(PurchaseRouter.Unauthorized.selector);
        router.claimAndQueueBuilderRewards(1, block.timestamp + 1 hours);

        vm.prank(address(vault));
        vm.expectRevert(PurchaseRouter.Unauthorized.selector);
        router.claimAndQueueBuilderRewards(1, block.timestamp + 1 hours);

        uint256 expected = allowance * rewards.tokensPerEth();
        vm.prank(treasury);
        (uint256 amount, uint256 pending) = router.claimAndQueueBuilderRewards(expected, block.timestamp + 1 hours);
        assertEq(amount, expected, "claimed");
        assertEq(pending, expected, "queued for treasury");
        assertEq(rewards.tokenBuyAllowance(address(router)), 0, "allowance spent");

        router.claimTreasury();
        assertEq(fwat.balanceOf(treasury), expected, "treasury holds FWAT");
    }

    function testSignedClaim() public {
        uint256 minOut = allowance * rewards.tokensPerEth();
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = router.nextSwapNonce();
        bytes32 digest = router.swapAuthorizationDigest(allowance, minOut, deadline, nonce);

        (address other, uint256 otherKey) = makeAddrAndKey("other");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(otherKey, digest);
        vm.prank(other);
        vm.expectRevert(PurchaseRouter.Unauthorized.selector);
        router.claimAndQueueBuilderRewardsAuthorized(allowance, minOut, deadline, nonce, abi.encodePacked(r, s, v));

        (v, r, s) = vm.sign(treasuryKey, digest);
        bytes memory signature = abi.encodePacked(r, s, v);
        vm.prank(stranger);
        (uint256 amount,) = router.claimAndQueueBuilderRewardsAuthorized(allowance, minOut, deadline, nonce, signature);
        assertEq(amount, minOut, "claimed");
        assertEq(helper.pending(treasury), minOut, "queued for treasury");

        vm.expectRevert(PurchaseRouter.BadAmount.selector);
        router.claimAndQueueBuilderRewardsAuthorized(allowance, minOut, deadline, nonce, signature);
    }

    function testDeadlineBounds() public {
        vm.startPrank(treasury);
        vm.expectRevert(PurchaseRouter.BadDeadline.selector);
        router.claimAndQueueBuilderRewards(1, block.timestamp - 1);
        vm.expectRevert(PurchaseRouter.BadDeadline.selector);
        router.claimAndQueueBuilderRewards(1, block.timestamp + 1 hours + 1);
        vm.stopPrank();
    }

    function testEmergencyAllowanceExitToTreasury() public {
        vm.expectRevert();
        router.recoverBuilderAllowanceAsETH();

        pool.setBool(KEY_WITHDRAW_ONLY, true);
        uint256 before = treasury.balance;
        vm.prank(stranger);
        assertEq(router.recoverBuilderAllowanceAsETH(), allowance, "recovered");
        assertEq(treasury.balance - before, allowance, "ETH to treasury");
    }

    function testSweepsGoToTreasury() public {
        uint256 before = treasury.balance;
        vm.deal(address(router), 1 ether);
        vm.prank(stranger);
        router.sweepETH();
        assertEq(treasury.balance - before, 1 ether, "ETH swept");

        nft.mint(address(router), 99);
        router.rescueNFT(address(nft), 99);
        assertEq(nft.ownerOf(99), treasury, "NFT swept");

        vm.expectRevert(PurchaseRouter.BadConfig.selector);
        router.rescueToken(address(fwat), 1);
    }

    function testRouterRejectsStrayEth() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(router).call{value: 1 ether}("");
        assertFalse(ok, "stray ETH rejected");
    }
}
