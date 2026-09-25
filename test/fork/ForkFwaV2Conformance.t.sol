// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ForkBase, IForkHelper} from "./ForkBase.sol";

interface IVrfServiceFee {
    function requestFee() external view returns (uint256);
}

/// @notice The deployed FWA V2 pool and rewards module run the vendored verified bytecode, and hold the
///         configuration the vault and router rely on.
contract ForkFwaV2ConformanceTest is ForkBase {
    /// @dev The pool's two immutables: the VRF service and the purchase notifier.
    address internal constant VRF_SERVICE = 0xCACBd874e24B533935176154E990Bf710F56693A;
    address internal constant PURCHASE_NOTIFIER = 0x612dF3a344990F8E53499ec1bC79Be63cFa496D0;

    /// @dev Live values at `FORK_BLOCK`. The vault reads each of them live; these pin what it saw.
    uint256 internal constant SETTLEMENT_DISCOUNT_BPS = 9000;
    uint256 internal constant SETTLEMENT_WINDOW = 1 hours;
    uint256 internal constant FINALIZE_WINDOW = 1 hours;
    uint256 internal constant MAX_ORACLE_AGE = 7 days;
    uint256 internal constant MIN_ORACLE_CHALLENGE_PERIOD = 6 hours;
    uint256 internal constant OWNER_ACQUISITION_FEE_BPS = 100;
    uint256 internal constant SELECTION_TIMEOUT_BLOCKS = 30;
    uint256 internal constant BUILDER_REWARD_BPS = 1500;
    uint256 internal constant MAX_BATCH = 5;

    function testPoolRuntimeMatchesVerified() public onlyFork {
        address[] memory imms = _matchMasked(address(POOL).code, vm.getDeployedCode("refs/fwa-v2/FWAV2.json"), "pool");
        assertEq(imms.length, 2, "pool immutables");
        assertTrue(_has(imms, VRF_SERVICE) && _has(imms, PURCHASE_NOTIFIER), "pool immutable values");
        assertEq(POOL.vrfServiceFee(), IVrfServiceFee(VRF_SERVICE).requestFee(), "vrf service immutable");
    }

    function testRewardsRuntimeMatchesVerified() public onlyFork {
        address[] memory imms =
            _matchMasked(address(REWARDS).code, vm.getDeployedCode("refs/fwa-v2-rewards/FWAV2Rewards.json"), "rewards");
        assertEq(imms.length, 3, "rewards immutables");
        assertTrue(_has(imms, REWARDS.token()), "token immutable");
        assertTrue(_has(imms, REWARDS.tokenPoolManager()), "pool manager immutable");
        assertTrue(_has(imms, REWARDS.tokenHook()), "hook immutable");
    }

    function testPoolConfigTheVaultReads() public onlyFork {
        assertEq(POOL.rewards(), address(REWARDS), "rewards");
        assertEq(POOL.token(), address(TOKEN), "token");
        assertEq(POOL.floorOracle(), FLOOR_ORACLE, "floor oracle");
        assertEq(POOL.settlementDiscountBps(), SETTLEMENT_DISCOUNT_BPS, "settlement discount");
        assertEq(POOL.settlementWindow(), SETTLEMENT_WINDOW, "settlement window");
        assertEq(POOL.finalizeWindow(), FINALIZE_WINDOW, "finalize window");
        assertEq(POOL.maxOracleAge(), MAX_ORACLE_AGE, "max oracle age");
        assertEq(POOL.minOracleChallengePeriod(), MIN_ORACLE_CHALLENGE_PERIOD, "min challenge period");
        assertEq(POOL.ownerAcquisitionFeeBps(), OWNER_ACQUISITION_FEE_BPS, "owner acquisition fee");
        assertEq(POOL.selectionTimeoutBlocks(), SELECTION_TIMEOUT_BLOCKS, "selection timeout");
        assertTrue(POOL.retainedToProtocol(), "retained to protocol");
        assertGt(POOL.activeListingCount(), 0, "live listings");
    }

    /// @notice `maxAcquisitionsPerTx` is internal: a batch of six fails the count check, a batch of
    ///         five passes it and fails later on payment.
    function testBatchLimitIsFive() public onlyFork {
        vm.expectRevert(bytes4(keccak256("InvalidAcquisitionCount()")));
        POOL.acquire(stranger, MAX_BATCH + 1, 0, 0, 0);
        vm.expectRevert(bytes4(keccak256("InsufficientPayment()")));
        POOL.acquire(stranger, MAX_BATCH, 0, 0, 0);
    }

    function testRewardsConfig() public onlyFork {
        assertEq(REWARDS.builderRewardBps(), BUILDER_REWARD_BPS, "builder reward bps");
        assertEq(REWARDS.fwa(), address(POOL), "rewards fwa");
        assertEq(REWARDS.token(), address(TOKEN), "rewards token");
    }

    /// @notice Storage slots the fork helpers read: the VRF coordinator and the selection tree root.
    function testPoolStorageLayout() public onlyFork {
        assertEq(address(uint160(uint256(vm.load(address(POOL), bytes32(SLOT_COORDINATOR))))), COORDINATOR);
        assertEq(_tree(1), POOL.totalWeight(), "tree root is total weight");
        vm.expectRevert(bytes4(keccak256("OnlyCoordinator()")));
        POOL.rawFulfillRandomWords(1, new uint256[](1));
    }

    function testTransferHelperAndRewardVault() public onlyFork {
        assertEq(IForkHelper(HELPER).token(), address(TOKEN), "helper token");
        assertEq(IForkHelper(HELPER).permit2(), PERMIT2, "helper permit2");
        assertEq(TOKEN.permit2(), PERMIT2, "token permit2");
        assertEq(REWARD_VAULT.token(), address(TOKEN), "reward vault token");
        assertTrue(TOKEN.isDistributor(HELPER), "helper is distributor");
        assertTrue(TOKEN.isDistributor(address(REWARDS)), "rewards is distributor");
        assertFalse(TOKEN.isDistributor(address(REWARD_VAULT)), "reward vault grant absent at pinned block");
    }

    /// @dev Walks both codes; every difference must sit in a zeroed PUSH32 operand of `ref` (an
    ///      immutable), which is masked. Returns the distinct immutable values as addresses.
    function _matchMasked(bytes memory live, bytes memory ref, string memory label)
        internal
        pure
        returns (address[] memory imms)
    {
        assertEq(live.length, ref.length, string.concat(label, " code length"));
        address[] memory found = new address[](8);
        uint256 n;
        uint256 i;
        while (i < live.length) {
            if (live[i] == ref[i]) {
                ++i;
                continue;
            }
            uint256 q = i;
            while (ref[q] == 0) --q;
            require(ref[q] == 0x7f, "difference outside a PUSH32");
            uint256 p = q + 1;
            require(p + 32 <= live.length, "operand overruns code");
            uint256 word;
            for (uint256 k; k < 32; ++k) {
                require(ref[p + k] == 0, "operand not zeroed in ref");
                word = (word << 8) | uint8(live[p + k]);
                live[p + k] = 0;
            }
            require(word >> 160 == 0, "immutable is not an address");
            if (!_has(_slice(found, n), address(uint160(word)))) found[n++] = address(uint160(word));
            i = p + 32;
        }
        assertEq(keccak256(live), keccak256(ref), string.concat(label, " masked runtime"));
        imms = _slice(found, n);
    }

    function _slice(address[] memory a, uint256 n) internal pure returns (address[] memory out) {
        out = new address[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = a[i];
        }
    }

    function _has(address[] memory a, address x) internal pure returns (bool) {
        for (uint256 i; i < a.length; ++i) {
            if (a[i] == x) return true;
        }
        return false;
    }
}
