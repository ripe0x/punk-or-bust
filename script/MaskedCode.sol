// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Compares deployed runtime code against a verified artifact whose immutables are zeroed.
library MaskedCode {
    /// @dev Walks both codes; every difference must sit in a zeroed PUSH32 operand of `ref` (an
    ///      immutable), which is masked. Returns the distinct immutable values as addresses and the
    ///      keccak of the masked live code, which equals `keccak256(ref)` on a match.
    function mask(bytes memory live, bytes memory ref)
        internal
        pure
        returns (address[] memory imms, bytes32 maskedHash)
    {
        require(live.length == ref.length, "code length");
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
            // casting to 'uint160' is safe because the upper 96 bits are checked zero above
            // forge-lint: disable-next-line(unsafe-typecast)
            address imm = address(uint160(word));
            if (!has(slice(found, n), imm)) {
                require(n < found.length, "too many immutables");
                found[n++] = imm;
            }
            i = p + 32;
        }
        imms = slice(found, n);
        maskedHash = keccak256(live);
    }

    function slice(address[] memory a, uint256 n) internal pure returns (address[] memory out) {
        out = new address[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = a[i];
        }
    }

    function has(address[] memory a, address x) internal pure returns (bool) {
        for (uint256 i; i < a.length; ++i) {
            if (a[i] == x) return true;
        }
        return false;
    }
}
