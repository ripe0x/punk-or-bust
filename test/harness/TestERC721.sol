// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC721} from "solady/tokens/ERC721.sol";

/// @notice Plain ERC721 with open minting, used as a listed collection.
contract TestERC721 is ERC721 {
    function name() public pure override returns (string memory) {
        return "Test NFT";
    }

    function symbol() public pure override returns (string memory) {
        return "TNFT";
    }

    function tokenURI(uint256) public pure override returns (string memory) {
        return "";
    }

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }
}
