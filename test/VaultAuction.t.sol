// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";

import {FwaClientLib} from "../src/fwa/FwaClientLib.sol";
import {Vault} from "../src/Vault.sol";
import {ControlledERC721, VaultTestBase} from "./harness/VaultTestBase.sol";

/// @notice Bidder contract whose `receive` can be switched off.
contract SwitchableBidder {
    Vault internal immutable VAULT;
    bool public accepts;

    constructor(Vault vault_) {
        VAULT = vault_;
    }

    function setAccepts(bool value) external {
        accepts = value;
    }

    function bid(uint256 requestId) external payable {
        VAULT.bid{value: msg.value}(requestId);
    }

    function claim(address to) external returns (uint256) {
        return VAULT.claimBidRefund(to);
    }

    receive() external payable {
        require(accepts, "no ETH");
    }
}

/// @notice ERC721 that reports `transfersRestricted() == true`.
contract RestrictedERC721 is ControlledERC721 {
    function transfersRestricted() external pure returns (bool) {
        return true;
    }
}

/// @notice Miss auction routing (hazard 11: the floor oracle) and the auction itself.
contract VaultAuctionTest is VaultTestBase {
    uint48 internal constant PERIOD = 12 hours;
    uint256 internal constant KEY_SETTLEMENT_WINDOW = 20;
    bytes32 internal constant REIMBURSED = keccak256("KeeperReimbursed(address,uint256,uint256,uint256)");

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    enum Reading {
        Stale,
        ShortChallenge,
        ManualOverride,
        Missing,
        Reverting,
        Malformed,
        Exempt
    }

    function setUp() public override {
        super.setUp();
        _createVault(20 ether, _params());
    }

    /* ------------------------------ helpers ------------------------------ */

    function _setBid(address collection, uint256 bid) internal {
        oracle.setFloorRange(collection, bid, 100 ether, uint48(block.timestamp), PERIOD);
    }

    /// @notice Lists `tokenId` of `nft` with `backing`, sets a fresh oracle bid, pulls it and syncs.
    function _reveal(uint256 tokenId, uint256 backing, uint256 oracleBid) internal returns (uint256 requestId) {
        uint256 listingId = _list(depositor, tokenId, backing);
        _setBid(address(nft), oracleBid);
        requestId = _pullAndSync(listingId);
    }

    /// @notice An open auction on a 1 ETH listing (backstop 0.9 ETH).
    function _openAuction(uint256 tokenId) internal returns (uint256 requestId) {
        requestId = _reveal(tokenId, 1 ether, 2 ether);
        assertEq(uint8(_status(requestId)), uint8(Vault.PullStatus.Auctioning), "auctioning");
    }

    function _status(uint256 requestId) internal view returns (Vault.PullStatus s) {
        (, s) = vault.pulls(requestId);
    }

    function _auction(uint256 requestId) internal view returns (Vault.Auction memory a) {
        (a.listingId, a.backstop, a.highBid, a.highBidder, a.deadline, a.hardDeadline) = vault.auctions(requestId);
    }

    function _bid(address bidder, uint256 requestId, uint256 amount) internal {
        vm.deal(bidder, bidder.balance + amount);
        vm.prank(bidder);
        vault.bid{value: amount}(requestId);
    }

    function _assertLedger() internal view {
        assertEq(
            address(vault).balance, vault.idle() + vault.bidEscrow() + vault.creditedRefunds(), "balance fully tracked"
        );
    }

    /* ------------------------------ routing ------------------------------ */

    /// @dev Backstop 0.9 ETH: an oracle bid of 0.981 ETH is a 900 bps gap, one wei less is 899.
    function testGapRuleBothSides() public {
        uint256 below = _reveal(1, 1 ether, 0.981 ether - 1);
        assertEq(uint8(_status(below)), uint8(Vault.PullStatus.Sold), "899 bps sells back");
        assertEq(nft.ownerOf(1), depositor, "NFT back to depositor");

        uint256 at = _reveal(2, 1 ether, 0.981 ether);
        assertEq(uint8(_status(at)), uint8(Vault.PullStatus.Auctioning), "900 bps auctions");
        Vault.Auction memory a = _auction(at);
        assertEq(a.backstop, 0.9 ether, "backstop");
        assertEq(vault.openAuctions(), 1, "one open");
        assertEq(nft.ownerOf(2), address(pool), "NFT never taken by the vault");
    }

    /// @dev Backstop 0.09 ETH: the gap is far above 900 bps, so only the 0.01 ETH surplus decides.
    function testMinSurplusBothSides() public {
        uint256 below = _reveal(1, 0.1 ether, 0.1 ether - 1);
        assertEq(uint8(_status(below)), uint8(Vault.PullStatus.Sold), "surplus below 0.01 ETH sells back");

        uint256 at = _reveal(2, 0.1 ether, 0.1 ether);
        assertEq(uint8(_status(at)), uint8(Vault.PullStatus.Auctioning), "surplus of 0.01 ETH auctions");
    }

    /// @dev A fresh reading with no gap sells back even when backing is at least 1 ETH.
    function testFreshReadingOverridesBackingRule() public {
        uint256 id = _reveal(1, 1.5 ether, 1.35 ether);
        assertEq(uint8(_status(id)), uint8(Vault.PullStatus.Sold), "fresh, no gap");
    }

    function testStaleFallsBackToBackingRule() public {
        _checkFallback(Reading.Stale);
    }

    function testShortChallengeFallsBackToBackingRule() public {
        _checkFallback(Reading.ShortChallenge);
    }

    function testManualOverrideFallsBackToBackingRule() public {
        _checkFallback(Reading.ManualOverride);
    }

    function testMissingFallsBackToBackingRule() public {
        _checkFallback(Reading.Missing);
    }

    function testRevertingOracleFallsBackToBackingRule() public {
        _checkFallback(Reading.Reverting);
    }

    function testMalformedOracleFallsBackToBackingRule() public {
        _checkFallback(Reading.Malformed);
    }

    function testExemptCollectionFallsBackToBackingRule() public {
        _checkFallback(Reading.Exempt);
    }

    /// @dev With no usable reading, a 1 ETH listing auctions and a 0.99 ETH listing sells back, even
    ///      though the unusable reading shows a large gap.
    function _checkFallback(Reading mode) internal {
        if (mode == Reading.Exempt) pool.setOracleExemptCollection(address(nft), true);
        uint256 big = _list(depositor, 1, 1 ether);
        uint256 small = _list(depositor, 2, 0.99 ether);

        // forge-lint: disable-next-line(unsafe-typecast)
        uint48 ts = uint48(block.timestamp);
        if (mode == Reading.Stale) {
            oracle.setFloorRange(address(nft), 5 ether, 100 ether, ts - pool.maxOracleAge() - 1, PERIOD);
        } else if (mode == Reading.ShortChallenge) {
            oracle.setFloorRange(address(nft), 5 ether, 100 ether, ts, pool.minOracleChallengePeriod() - 1);
        } else if (mode == Reading.ManualOverride) {
            oracle.setFloorRange(address(nft), 5 ether, 100 ether, ts, type(uint48).max);
        } else if (mode == Reading.Missing) {
            oracle.setFloorRange(address(nft), 0, 0, 0, 0);
        } else if (mode == Reading.Reverting) {
            vm.mockCallRevert(address(oracle), abi.encodeWithSignature("getFloorRange(address)"), "down");
        } else if (mode == Reading.Malformed) {
            vm.mockCall(
                address(oracle), abi.encodeWithSignature("getFloorRange(address)"), abi.encode(5 ether, 100 ether)
            );
        } else {
            _setBid(address(nft), 5 ether);
        }

        uint256 smallId = _pullAndSync(small);
        assertEq(uint8(_status(smallId)), uint8(Vault.PullStatus.Sold), "below 1 ETH sells back");
        uint256 bigId = _pullAndSync(big);
        assertEq(uint8(_status(bigId)), uint8(Vault.PullStatus.Auctioning), "1 ETH backing auctions");
    }

    function testTransferRestrictedCollectionSellsBack() public {
        RestrictedERC721 restricted = new RestrictedERC721();
        uint256 listingId = _listCustom(restricted, 1, 1 ether);
        _setBid(address(restricted), 5 ether);
        uint256 id = _pullAndSync(listingId);
        assertEq(uint8(_status(id)), uint8(Vault.PullStatus.Sold), "ineligible");
        assertEq(restricted.ownerOf(1), depositor, "sold back");
    }

    function testKeepFailureSellsBackWithoutAuction() public {
        ControlledERC721 blocked = new ControlledERC721();
        blocked.setBlocked(address(vault), true);
        vm.prank(owner);
        vault.setKeepCollections(_one(address(blocked)), true);
        uint256 listingId = _listCustom(blocked, 1, 1 ether);
        _setBid(address(blocked), 5 ether);
        uint256 id = _pullAndSync(listingId);
        assertEq(uint8(_status(id)), uint8(Vault.PullStatus.Sold), "keep failed, sold back");
    }

    function testConcurrentAuctionCap() public {
        uint256 cap = vault.MAX_AUCTIONS();
        for (uint256 i; i < cap; ++i) {
            _openAuction(i + 1);
        }
        assertEq(vault.openAuctions(), cap, "at cap");
        uint256 id = _reveal(100, 1 ether, 2 ether);
        assertEq(uint8(_status(id)), uint8(Vault.PullStatus.Sold), "sells back at the cap");
        assertEq(vault.outstandingCount(), 0, "auctions left the outstanding set");
        assertEq(vault.openAuctions(), cap, "still at cap");
    }

    /* ------------------------------ bidding ------------------------------ */

    function testOpeningAndIncrementMinimums() public {
        uint256 id = _openAuction(1);
        uint256 opening = 0.9 ether * 10_500 / 10_000;

        vm.deal(alice, 10 ether);
        vm.prank(alice);
        vm.expectRevert(Vault.BidTooLow.selector);
        vault.bid{value: opening - 1}(id);
        _bid(alice, id, opening);

        uint256 next = opening * 10_500 / 10_000;
        vm.deal(bob, 10 ether);
        vm.prank(bob);
        vm.expectRevert(Vault.BidTooLow.selector);
        vault.bid{value: next - 1}(id);
        _bid(bob, id, next);

        Vault.Auction memory a = _auction(id);
        assertEq(a.highBid, next, "high bid");
        assertEq(a.highBidder, bob, "high bidder");
        assertEq(vault.bidEscrow(), next, "only the high bid is escrowed");

        vm.expectRevert(Vault.BadStatus.selector);
        vault.bid{value: 1 ether}(id + 1);
    }

    function testExtensionCappedAtSixtyMinutes() public {
        uint256 id = _openAuction(1);
        uint256 start = block.timestamp;
        Vault.Auction memory a = _auction(id);
        assertEq(a.deadline, start + vault.AUCTION_DURATION(), "base duration");
        assertEq(a.hardDeadline, start + 60 minutes, "hard cap");

        uint256 amount = 0.945 ether;
        _bid(alice, id, amount);
        assertEq(_auction(id).deadline, a.deadline, "early bid does not extend");

        address[2] memory bidders = [bob, alice];
        uint256 rounds;
        while (_auction(id).deadline < a.hardDeadline) {
            vm.warp(_auction(id).deadline - 1);
            amount = amount * 10_500 / 10_000 + 1;
            _bid(bidders[rounds % 2], id, amount);
            uint256 deadline = _auction(id).deadline;
            assertLe(deadline, a.hardDeadline, "never past the cap");
            assertEq(deadline, _min(vm.getBlockTimestamp() + 5 minutes, a.hardDeadline), "5 minute extension");
            ++rounds;
        }
        assertGt(rounds, 1, "extended repeatedly");

        vm.warp(a.hardDeadline);
        vm.deal(bob, 100 ether);
        vm.prank(bob);
        vm.expectRevert(Vault.AuctionEnded.selector);
        vault.bid{value: 100 ether}(id);
    }

    /// @dev The hard deadline sits a settle buffer before the purchaser window ends, so the depositor
    ///      cannot reclaim while the auction runs.
    function testHardCapRespectsSettlementWindow() public {
        uint256 listingId = _list(depositor, 1, 1 ether);
        _setBid(address(nft), 2 ether);
        uint256 id = _requestOne();
        _allocate(id, listingId);
        (,,,,,,,,, uint64 allocatedAt,) = pool.listings(listingId);
        uint256 windowEnd = uint256(allocatedAt) + pool.settlementWindow();

        vm.warp(windowEnd - 30 minutes - 40 minutes);
        _setBid(address(nft), 2 ether);
        vault.sync(32);
        Vault.Auction memory a = _auction(id);
        assertEq(a.hardDeadline, windowEnd - vault.AUCTION_SETTLE_BUFFER(), "window bounds the cap");
        assertEq(a.deadline, block.timestamp + 30 minutes, "base duration fits");

        uint256 amount = 0.945 ether;
        while (_auction(id).deadline < a.hardDeadline) {
            vm.warp(_auction(id).deadline - 1);
            _bid(alice, id, amount);
            amount = amount * 10_500 / 10_000 + 1;
        }
        assertEq(_auction(id).deadline, a.hardDeadline, "extension clamped to the window cap");

        vm.warp(a.hardDeadline);
        vm.prank(depositor);
        vm.expectRevert();
        pool.depositorReclaimNFT(listingId);

        vault.finalizeAuction(id);
        assertEq(nft.ownerOf(1), alice, "winner delivered inside the window");
    }

    function testLateRevealSellsBack() public {
        uint256 listingId = _list(depositor, 1, 1 ether);
        uint256 id = _requestOne();
        _allocate(id, listingId);
        (,,,,,,,,, uint64 allocatedAt,) = pool.listings(listingId);
        vm.warp(uint256(allocatedAt) + pool.settlementWindow() - 30 minutes - 5 minutes + 1);
        _setBid(address(nft), 2 ether);
        vault.sync(32);
        assertEq(uint8(_status(id)), uint8(Vault.PullStatus.Sold), "too little window left");
    }

    function testOutbidRefundPushed() public {
        uint256 id = _openAuction(1);
        _bid(alice, id, 1 ether);
        assertEq(alice.balance, 0, "escrowed");
        _bid(bob, id, 1.05 ether);
        assertEq(alice.balance, 1 ether, "refunded on outbid");
        assertEq(vault.bidEscrow(), 1.05 ether, "escrow follows the high bid");
        _assertLedger();
    }

    function testOutbidRefundCreditedWhenReceiveReverts() public {
        uint256 id = _openAuction(1);
        SwitchableBidder hostile = new SwitchableBidder(vault);
        vm.deal(address(this), 1 ether);
        hostile.bid{value: 1 ether}(id);

        _bid(bob, id, 1.05 ether);
        assertEq(vault.bidRefunds(address(hostile)), 1 ether, "credited");
        assertEq(vault.creditedRefunds(), 1 ether, "credit total");
        assertEq(_auction(id).highBidder, bob, "new bid not blocked");
        _assertLedger();

        vm.expectRevert();
        hostile.claim(address(hostile));

        hostile.setAccepts(true);
        assertEq(hostile.claim(address(hostile)), 1 ether, "claimed");
        assertEq(address(hostile).balance, 1 ether, "paid");
        assertEq(vault.creditedRefunds(), 0, "credit cleared");

        vm.expectRevert(Vault.BadParams.selector);
        hostile.claim(address(hostile));
        _assertLedger();
    }

    function testCreditClaimableToAnotherAddress() public {
        uint256 id = _openAuction(1);
        SwitchableBidder hostile = new SwitchableBidder(vault);
        vm.deal(address(this), 1 ether);
        hostile.bid{value: 1 ether}(id);
        _bid(bob, id, 1.05 ether);
        hostile.claim(stranger);
        assertEq(stranger.balance, 1 ether, "paid to the named recipient");
    }

    /* ----------------------------- finalizing ----------------------------- */

    function testWinnerDelivered() public {
        uint256 id = _openAuction(1);
        _bid(alice, id, 1.2 ether);
        uint256 idleBefore = vault.idle();

        vm.expectRevert(Vault.AuctionNotEnded.selector);
        vault.finalizeAuction(id);

        vm.warp(_auction(id).deadline);
        vm.prank(stranger);
        vault.finalizeAuction(id);
        assertEq(nft.ownerOf(1), alice, "winner holds the NFT");
        assertEq(uint8(_status(id)), uint8(Vault.PullStatus.Sold), "sold");
        assertEq(vault.idle(), idleBefore + 1.2 ether, "bid is proceeds");
        assertEq(vault.bidEscrow(), 0, "escrow released");
        assertEq(vault.openAuctions(), 0, "closed");
        _assertLedger();

        vm.expectRevert(Vault.BadStatus.selector);
        vault.finalizeAuction(id);
    }

    function testNoBidSellsBack() public {
        uint256 id = _openAuction(1);
        uint256 idleBefore = vault.idle();
        vm.warp(_auction(id).deadline);
        vault.finalizeAuction(id);
        assertEq(nft.ownerOf(1), depositor, "sold back");
        assertEq(uint8(_status(id)), uint8(Vault.PullStatus.Sold), "sold");
        assertEq(vault.idle(), idleBefore + 0.9 ether, "backstop");
        _assertLedger();
    }

    function testDeliveryFailureRefundsAndSellsBack() public {
        ControlledERC721 blocked = new ControlledERC721();
        uint256 listingId = _listCustom(blocked, 1, 1 ether);
        _setBid(address(blocked), 2 ether);
        uint256 id = _pullAndSync(listingId);
        assertEq(uint8(_status(id)), uint8(Vault.PullStatus.Auctioning), "auctioning");

        _bid(alice, id, 1 ether);
        blocked.setBlocked(alice, true);
        uint256 idleBefore = vault.idle();
        vm.warp(_auction(id).deadline);
        vault.finalizeAuction(id);

        assertEq(blocked.ownerOf(1), depositor, "sold back");
        assertEq(alice.balance, 1 ether, "bidder refunded");
        assertEq(uint8(_status(id)), uint8(Vault.PullStatus.Sold), "sold");
        assertEq(vault.idle(), idleBefore + 0.9 ether, "backstop");
        assertEq(vault.bidEscrow(), 0, "escrow released");
        _assertLedger();
    }

    /// @dev The pool shortens its window mid-auction and the depositor settles first: recorded as
    ///      forced, the bidder refunded, the backstop ETH joins idle.
    function testForcedDuringAuction() public {
        uint256 id = _openAuction(1);
        Vault.Auction memory a = _auction(id);
        SwitchableBidder hostile = new SwitchableBidder(vault);
        vm.deal(address(this), 1 ether);
        hostile.bid{value: 1 ether}(id);

        uint256 idleBefore = vault.idle();
        pool.setUint(KEY_SETTLEMENT_WINDOW, 10 minutes);
        vm.warp(block.timestamp + 10 minutes);
        vm.prank(depositor);
        pool.depositorReclaimNFT(a.listingId);
        vault.reconcile();
        _assertLedger();

        vm.warp(a.deadline);
        vm.expectEmit(address(vault));
        emit Vault.PullForced(id, a.listingId, FwaClientLib.ForcedKind.ForcedEth);
        vault.finalizeAuction(id);
        assertEq(uint8(_status(id)), uint8(Vault.PullStatus.Forced), "forced");
        assertEq(vault.bidRefunds(address(hostile)), 1 ether, "hostile bidder credited");
        assertEq(vault.idle(), idleBefore + 0.9 ether, "forced ETH absorbed, escrow not");
        _assertLedger();
    }

    /* ---------------------------- run and ledger ---------------------------- */

    function testRunWaitsForOpenAuction() public {
        uint256 id = _openAuction(1);
        _bid(alice, id, 1 ether);
        vm.prank(owner);
        vault.stop();
        assertEq(uint8(vault.status()), uint8(Vault.Status.WindingDown), "waits for the auction");

        vm.warp(_auction(id).deadline);
        assertEq(vault.sync(32), 0, "sync does not finalize");
        assertEq(uint8(vault.status()), uint8(Vault.Status.WindingDown), "still winding down");
        assertEq(uint8(_status(id)), uint8(Vault.PullStatus.Auctioning), "still auctioning");

        vm.prank(owner);
        vm.expectRevert(Vault.BadStatus.selector);
        vault.withdraw();

        vault.finalizeAuction(id);
        assertEq(uint8(vault.status()), uint8(Vault.Status.Idle), "run ended");
        assertEq(address(vault).balance, 0, "auto-returned");
        assertEq(nft.ownerOf(1), alice, "delivered");
    }

    function testAuctionsCountAsInFlight() public {
        _openAuction(1);
        assertEq(vault.outstandingCount(), 0, "no pull outstanding");
        uint256 value = vault.runValue();
        assertEq(value, vault.idle() - vault.feeOwed(), "auction valued at zero");

        // A stop condition with an auction in flight winds down but does not end the run.
        vm.warp(block.timestamp + 7 days + 1);
        vault.sync(32);
        assertEq(uint8(vault.status()), uint8(Vault.Status.WindingDown), "auction keeps the run open");
    }

    function testKeeperReimbursedForFinalize() public {
        uint256 id = _openAuction(1);
        vm.warp(_auction(id).deadline);
        vm.fee(1 gwei);
        vm.txGasPrice(1 gwei);
        vm.recordLogs();
        vm.prank(keeper);
        vault.finalizeAuction(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 amount;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == REIMBURSED) {
                (,, amount) = abi.decode(logs[i].data, (uint256, uint256, uint256));
            }
        }
        assertGt(amount, 0, "reimbursed");
        assertEq(keeper.balance, amount, "paid");
        assertLe(amount, vault.FINALIZE_GAS_CAP() * 1 gwei, "bounded");
    }

    function testStrangerNotReimbursedForFinalize() public {
        uint256 id = _openAuction(1);
        vm.warp(_auction(id).deadline);
        vm.fee(1 gwei);
        vm.txGasPrice(1 gwei);
        vm.prank(stranger);
        vault.finalizeAuction(id);
        assertEq(stranger.balance, 0, "not reimbursed");
    }

    /// @dev Escrowed bids and credited refunds never join idle, whatever else lands on the vault, and
    ///      the owner's withdrawal or auto-return never touches them.
    function testFuzzEscrowNeverAbsorbed(uint96 donation, uint8 bids, bool hostileFirst, bool deliver) public {
        ControlledERC721 collection = new ControlledERC721();
        uint256 listingId = _listCustom(collection, 1, 1 ether);
        _setBid(address(collection), 2 ether);
        uint256 id = _pullAndSync(listingId);
        assertEq(uint8(_status(id)), uint8(Vault.PullStatus.Auctioning), "auctioning");
        bids = uint8(bound(bids, 1, 12));
        SwitchableBidder hostile = new SwitchableBidder(vault);

        uint256 amount = 0.945 ether;
        for (uint256 i; i < bids; ++i) {
            if ((i % 2 == 0) == hostileFirst) {
                vm.deal(address(this), amount);
                hostile.bid{value: amount}(id);
            } else {
                _bid(alice, id, amount);
            }
            amount = amount * 10_500 / 10_000 + 1;
        }

        uint256 idleBefore = vault.idle();
        vm.deal(address(vault), address(vault).balance + donation);
        vault.reconcile();
        assertEq(vault.idle(), idleBefore + donation, "only the donation joins idle");
        _assertLedger();
        uint256 held = vault.bidEscrow() + vault.creditedRefunds();
        assertGt(held, 0, "bids held");

        vm.prank(owner);
        vault.stop();
        vm.prank(owner);
        vm.expectRevert(Vault.BadStatus.selector);
        vault.withdraw();

        if (!deliver) {
            collection.setBlocked(alice, true);
            collection.setBlocked(address(hostile), true);
        }
        vm.warp(_auction(id).deadline);
        vault.finalizeAuction(id);
        assertEq(collection.ownerOf(1), deliver ? _auction(id).highBidder : depositor, "delivered or sold back");
        assertEq(uint8(vault.status()), uint8(Vault.Status.Idle), "run ended");
        assertEq(vault.bidEscrow(), 0, "no escrow once finalized");
        assertEq(address(vault).balance, vault.creditedRefunds(), "only bidder credit stays");

        vm.prank(owner);
        vault.withdraw();
        assertEq(address(vault).balance, vault.creditedRefunds(), "withdraw leaves credit");

        uint256 credit = vault.bidRefunds(address(hostile));
        if (credit != 0) {
            hostile.setAccepts(true);
            hostile.claim(address(hostile));
        }
        assertEq(address(vault).balance, 0, "all credit claimed");
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
