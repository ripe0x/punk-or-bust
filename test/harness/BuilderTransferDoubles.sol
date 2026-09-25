// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

struct TokenPermissions {
    address token;
    uint256 amount;
}

struct PermitTransferFrom {
    TokenPermissions permitted;
    uint256 nonce;
    uint256 deadline;
}

struct SignatureTransferDetails {
    address to;
    uint256 requestedAmount;
}

/// @notice Permit2 `permitTransferFrom` double for contract signers: the permit digest follows
///         Permit2's SignatureTransfer layout with `msg.sender` as spender, and the owner is checked by
///         ERC-1271. Etched at the canonical Permit2 address. Nonces are a plain used set.
contract Permit2Double {
    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 internal constant PERMIT_TRANSFER_TYPEHASH = keccak256(
        "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
    );

    mapping(address owner => mapping(uint256 nonce => bool)) public nonceUsed;

    function DOMAIN_SEPARATOR() public pure returns (bytes32) {
        return keccak256("Permit2Double");
    }

    function permitTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata details,
        address owner,
        bytes calldata signature
    ) external {
        require(block.timestamp <= permit.deadline, "expired");
        require(details.requestedAmount <= permit.permitted.amount, "amount");
        require(!nonceUsed[owner][permit.nonce], "nonce");
        nonceUsed[owner][permit.nonce] = true;
        bytes32 permissionsHash =
            keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, permit.permitted.token, permit.permitted.amount));
        bytes32 hash = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(PERMIT_TRANSFER_TYPEHASH, permissionsHash, msg.sender, permit.nonce, permit.deadline)
                )
            )
        );
        require(IERC1271(owner).isValidSignature(hash, signature) == IERC1271.isValidSignature.selector, "sig");
        SafeTransferLib.safeTransferFrom(permit.permitted.token, owner, details.to, details.requestedAmount);
    }
}

/// @notice FWAT transfer helper double: takes deposits through Permit2 and pays each recipient's
///         pending total on `claim`.
contract TransferHelperDouble {
    address public immutable token;
    address public constant permit2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    mapping(address recipient => uint256) public pending;

    constructor(address token_) {
        token = token_;
    }

    function depositWithPermit2(PermitTransferFrom calldata permit, bytes calldata signature, address recipient)
        external
        returns (uint256 totalPending)
    {
        require(permit.permitted.token == token, "token");
        Permit2Double(permit2)
            .permitTransferFrom(
                permit, SignatureTransferDetails(address(this), permit.permitted.amount), msg.sender, signature
            );
        totalPending = pending[recipient] += permit.permitted.amount;
    }

    function claim(address recipient) external returns (uint256 amount) {
        amount = pending[recipient];
        pending[recipient] = 0;
        SafeTransferLib.safeTransfer(token, recipient, amount);
    }
}
