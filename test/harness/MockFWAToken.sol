// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "solady/tokens/ERC20.sol";

/// @notice Minimal FWAToken stand-in: a plain ERC20 with open minting and the `isDistributor` flag the
///         client library reads before forwarding claimed tokens. It does not enforce FWAToken's
///         transfer lock and has no Uniswap v4 pool. A mainnet fork conformance test is required before
///         any test relies on the real token's lock or swap behavior.
contract MockFWAToken is ERC20 {
    mapping(address account => bool) public isDistributor;

    function name() public pure override returns (string memory) {
        return "FWA Token";
    }

    function symbol() public pure override returns (string memory) {
        return "FWAT";
    }

    /// @notice The canonical Permit2 address the real token reports. Solady's ERC20 already gives it
    ///         an infinite allowance.
    function permit2() external pure returns (address) {
        return 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setDistributor(address account, bool enabled) external {
        isDistributor[account] = enabled;
    }
}
