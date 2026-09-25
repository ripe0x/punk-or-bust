// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {FwaClientLib} from "../src/fwa/FwaClientLib.sol";
import {IFWAV2} from "../src/interfaces/IFWAV2.sol";
import {FwaV2Harness} from "./harness/FwaV2Harness.sol";

/// @notice FWA purchaser of record that drives the pool through `FwaClientLib`.
contract LibPurchaser {
    address public immutable fwa;
    bool public rejectEth;
    uint256 public ethReceipts;
    uint256 public nftReceipts;

    constructor(address fwa_) {
        fwa = fwa_;
    }

    receive() external payable {
        require(!rejectEth, "rejecting ETH");
        ++ethReceipts;
    }

    function setRejectEth(bool reject) external {
        rejectEth = reject;
    }

    function acquire(uint256 value) external returns (uint256 requestId, uint256 spent) {
        return FwaClientLib.acquire(fwa, value);
    }

    function settleForEth(uint256 listingId) external returns (uint256) {
        return FwaClientLib.settleForEth(fwa, listingId);
    }

    function keepAndForward(uint256 listingId, address to) external {
        FwaClientLib.keepAndForward(fwa, listingId, to);
    }

    function classifyForced(uint256 listingId) external view returns (FwaClientLib.ForcedKind) {
        return FwaClientLib.classifyForced(fwa, listingId);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        ++nftReceipts;
        return this.onERC721Received.selector;
    }
}

/// @notice A separate `acquire` caller that names another address as purchaser, so FWA's builder
///         reward accrues to it.
contract BuilderCaller {
    receive() external payable {}

    function acquireFor(address fwa, address purchaser) external payable returns (uint256 requestId) {
        uint256[] memory ids =
            IFWAV2(fwa).acquire{value: msg.value}(purchaser, 1, 0, 0, IFWAV2(fwa).selectionSlippageBps());
        requestId = ids[0];
    }
}

contract FwaClientLibV2Test is FwaV2Harness {
    uint256 internal constant DISCOUNT_BPS = 8750;
    uint256 internal constant BPS = 10_000;

    LibPurchaser internal purchaser;
    address internal depositor = makeAddr("depositor");

    function setUp() public {
        _deployFwaV2(DISCOUNT_BPS);
        purchaser = new LibPurchaser(address(pool));
        vm.deal(address(purchaser), 100 ether);
    }

    /// @dev Lists three NFTs so selection has to pick among them, then acquires through the library.
    function _listThreeAndAcquire() internal returns (uint256 requestId, uint256 target) {
        _list(depositor, 1, 1 ether);
        target = _list(depositor, 2, 2 ether);
        _list(depositor, 3, 0.5 ether);

        (,, uint256 total) = FwaClientLib.quote(address(pool));
        uint256 spent;
        (requestId, spent) = purchaser.acquire(total + 1 ether);
        assertEq(spent, total, "overpayment returned in call");
    }

    function testAllocateSelectsEachListing() public {
        uint256[3] memory ids =
            [_list(depositor, 1, 1 ether), _list(depositor, 2, 2 ether), _list(depositor, 3, 0.5 ether)];
        uint256[3] memory order = [ids[2], ids[0], ids[1]];
        for (uint256 i; i < 3; ++i) {
            (,, uint256 total) = FwaClientLib.quote(address(pool));
            (uint256 requestId,) = purchaser.acquire(total);
            _allocate(requestId, order[i]);
        }
        assertEq(pool.totalWeight(), 0, "pool drained");
    }

    function testSettleForEthPaysDiscountedBacking() public {
        (uint256 requestId, uint256 listingId) = _listThreeAndAcquire();
        _allocate(requestId, listingId);

        uint256 backing = _listingValue(listingId);
        uint256 proceeds = purchaser.settleForEth(listingId);

        assertEq(proceeds, backing * DISCOUNT_BPS / BPS, "backing * discount");
        assertEq(proceeds, backing * pool.settlementDiscountBps() / BPS, "live discount");
        assertEq(nft.ownerOf(2), depositor, "NFT back to depositor");
        assertEq(_listingStatus(listingId), LISTING_SETTLED, "settled");
    }

    function testKeepAndForwardDeliversToRecipient() public {
        (uint256 requestId, uint256 listingId) = _listThreeAndAcquire();
        _allocate(requestId, listingId);

        address recipient = makeAddr("recipient");
        uint256 depositorBefore = depositor.balance;
        purchaser.keepAndForward(listingId, recipient);

        assertEq(nft.ownerOf(2), recipient, "recipient owns the NFT");
        assertEq(purchaser.nftReceipts(), 1, "passed through the purchaser");
        uint256 backing = _listingValue(listingId);
        uint256 settlementFee = backing * pool.ownerSettlementFeeBps() / BPS;
        assertEq(depositor.balance - depositorBefore, backing - settlementFee, "backing to depositor");
    }

    function testDirectAcquireAccruesNoBuilderAllowance() public {
        (uint256 requestId, uint256 listingId) = _listThreeAndAcquire();
        (address registered,,, uint256 slice, address caller) = rewards.acquisitionRewards(requestId);
        assertEq(registered, address(purchaser), "purchaser registered");
        assertEq(caller, address(purchaser), "caller is purchaser");
        assertEq(slice, 0, "no builder slice");

        _allocate(requestId, listingId);
        assertEq(rewards.tokenBuyAllowance(address(purchaser)), 0, "no allowance after allocation");
        assertEq(rewards.userAcquisitionsInEpoch(0, address(purchaser)), 1, "epoch unit to purchaser");

        purchaser.settleForEth(listingId);
        assertEq(rewards.tokenBuyAllowance(address(purchaser)), 0, "no allowance after settlement");
        assertEq(rewards.tokenBuyAllowanceTotal(), 0, "no allowance anywhere");
    }

    function testSeparateCallerEarnsBuilderAllowance() public {
        _list(depositor, 1, 1 ether);
        uint256 listingId = _list(depositor, 2, 2 ether);
        _list(depositor, 3, 0.5 ether);

        BuilderCaller builder = new BuilderCaller();
        (uint256 fee,, uint256 total) = FwaClientLib.quote(address(pool));
        vm.deal(address(this), total);
        uint256 requestId = builder.acquireFor{value: total}(address(pool), address(purchaser));

        (address registered,,,, address caller) = rewards.acquisitionRewards(requestId);
        assertEq(registered, address(purchaser), "purchaser of record");
        assertEq(caller, address(builder), "builder is caller");

        _allocate(requestId, listingId);

        assertEq(rewards.builderRewardBps(), 1500, "default builder share");
        uint256 acquisitionProtocolFee = fee * pool.ownerAcquisitionFeeBps() / BPS;
        uint256 acquisitionShare = acquisitionProtocolFee * 1500 / BPS;
        assertGt(acquisitionShare, 0, "nonzero share");
        assertEq(rewards.tokenBuyAllowance(address(builder)), acquisitionShare, "15% of acquisition protocol fee");
        assertEq(rewards.tokenBuyAllowance(address(purchaser)), 0, "purchaser earns none");
        assertEq(rewards.userAcquisitionsInEpoch(0, address(purchaser)), 1, "epoch unit to purchaser");
        assertEq(rewards.userAcquisitionsInEpoch(0, address(builder)), 0, "no epoch unit to caller");

        uint256 backing = _listingValue(listingId);
        uint256 proceeds = purchaser.settleForEth(listingId);
        uint256 settlementProtocolFee = backing - proceeds;
        uint256 settlementShare = settlementProtocolFee * 1500 / BPS;
        assertEq(
            rewards.tokenBuyAllowance(address(builder)),
            acquisitionShare + settlementShare,
            "plus 15% of settlement protocol fee"
        );
        assertEq(rewards.tokenBuyAllowance(address(purchaser)), 0, "purchaser still earns none");
        assertEq(address(rewards).balance, acquisitionShare + settlementShare, "shares funded in ETH");
    }

    /// @dev Hazard 3: depositor resolution pays the purchaser by forced ETH transfer, with no call the
    ///      purchaser can observe or refuse.
    function testDepositorReclaimNftPaysEthWithoutCallback() public {
        (uint256 requestId, uint256 listingId) = _listThreeAndAcquire();
        _allocate(requestId, listingId);
        assertEq(uint8(purchaser.classifyForced(listingId)), uint8(FwaClientLib.ForcedKind.None), "still allocated");

        uint256 window = pool.settlementWindow();
        vm.warp(block.timestamp + window - 1);
        vm.prank(depositor);
        vm.expectRevert(bytes4(keccak256("SettlementWindowNotElapsed()")));
        pool.depositorReclaimNFT(listingId);

        vm.warp(block.timestamp + 1);
        purchaser.setRejectEth(true);
        uint256 receiptsBefore = purchaser.ethReceipts();
        uint256 balanceBefore = address(purchaser).balance;

        vm.prank(depositor);
        pool.depositorReclaimNFT(listingId);

        uint256 backing = _listingValue(listingId);
        assertEq(address(purchaser).balance - balanceBefore, backing * DISCOUNT_BPS / BPS, "ETH bid arrived");
        assertEq(purchaser.ethReceipts(), receiptsBefore, "no receive callback ran");
        assertEq(purchaser.nftReceipts(), 0, "no NFT callback");
        assertEq(nft.ownerOf(2), depositor, "depositor took the NFT");
        assertEq(uint8(purchaser.classifyForced(listingId)), uint8(FwaClientLib.ForcedKind.ForcedEth), "ForcedEth");
    }
}
