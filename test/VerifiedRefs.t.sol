// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

/// @notice The vendored FWA V2 artifacts load as forge artifacts. Their bytes are checked against
///         Sourcify provenance by `script/fwa_refs.py`.
contract VerifiedRefsTest is Test {
    function testPoolArtifactLoads() public view {
        assertGt(vm.getCode("refs/fwa-v2/FWAV2.json").length, 20_000, "FWA V2 creation code");
    }

    function testRewardsArtifactLoads() public view {
        assertGt(vm.getCode("refs/fwa-v2-rewards/FWAV2Rewards.json").length, 5000, "FWA V2 rewards creation code");
    }
}
