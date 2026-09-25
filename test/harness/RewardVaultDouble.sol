// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

import {IFWAToken} from "../../src/interfaces/IFWAToken.sol";

interface IRewardSeries {
    function isRound(address round) external view returns (bool);
}

interface IRewardSource {
    function series() external view returns (address);
    function collectRewards(uint256[] calldata epochs, bool accrued, uint256 minOut) external;
}

/// @title RewardVaultDouble
/// @notice Test double for the shared reward vault, built from the Sourcify-verified source of
///         mainnet 0xEa20a110ad3Dfc483977d14f80203994E65D34FB (match 51606642).
/// @dev Mirrors the verified state changes and reverts of `setSeries`, `registerRound`, `updateShare`,
///      `lockShares`, `harvest`, `claimable` and `claim`. Omitted: canonical NFT bookkeeping in
///      `setSeries`, surplus attribution, stray-asset rescue, ownership transfer.
///      A mainnet fork conformance test against the deployed vault is required before this double is
///      relied on beyond these tests.
contract RewardVaultDouble is ReentrancyGuard {
    address public immutable token;
    address public owner;
    mapping(address => bool) public seriesAllowed;
    mapping(address => address) public seriesOf;
    mapping(address => mapping(address => uint256)) public shareOf;
    mapping(address => uint256) public shareTotal;
    mapping(address => uint256) public lockedTotal;
    mapping(address => uint256) public totalReceived;
    mapping(address => uint256) public totalPaid;
    mapping(address => mapping(address => uint256)) public claimed;
    uint256 public totalAttributed;

    error Unauthorized();
    error InvalidAddress();
    error AlreadyRegistered();
    error SharesFrozen();
    error InvalidShares();
    error NotLocked();
    error NothingToClaim();
    error NoRewards();

    constructor(address token_, address owner_) {
        if (token_.code.length == 0 || owner_ == address(0)) revert InvalidAddress();
        token = token_;
        owner = owner_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyRound() {
        if (seriesOf[msg.sender] == address(0)) revert Unauthorized();
        _;
    }

    function setSeries(address series_, bool allowed) external onlyOwner {
        if (series_.code.length == 0) revert InvalidAddress();
        seriesAllowed[series_] = allowed;
    }

    function registerRound(address round) external {
        if (!seriesAllowed[msg.sender]) revert Unauthorized();
        if (seriesOf[round] != address(0)) revert AlreadyRegistered();
        if (round.code.length == 0) revert InvalidAddress();
        if (!IRewardSeries(msg.sender).isRound(round) || IRewardSource(round).series() != msg.sender) {
            revert Unauthorized();
        }
        seriesOf[round] = msg.sender;
    }

    function updateShare(address account, uint256 amount) external onlyRound {
        if (lockedTotal[msg.sender] != 0) revert SharesFrozen();
        if (account == address(0)) revert InvalidAddress();
        shareTotal[msg.sender] = shareTotal[msg.sender] - shareOf[msg.sender][account] + amount;
        shareOf[msg.sender][account] = amount;
    }

    function lockShares(uint256 total) external onlyRound {
        if (lockedTotal[msg.sender] != 0) revert SharesFrozen();
        if (total == 0 || shareTotal[msg.sender] != total) revert InvalidShares();
        lockedTotal[msg.sender] = total;
    }

    function harvest(uint256[] calldata epochs, bool accrued, uint256 minOut)
        external
        nonReentrant
        onlyRound
        returns (uint256 amount)
    {
        if (lockedTotal[msg.sender] == 0) revert NotLocked();
        uint256 beforeBalance = IFWAToken(token).balanceOf(address(this));
        IRewardSource(msg.sender).collectRewards(epochs, accrued, minOut);
        amount = IFWAToken(token).balanceOf(address(this)) - beforeBalance;
        if (amount == 0) revert NoRewards();
        totalReceived[msg.sender] += amount;
        totalAttributed += amount;
    }

    function claimable(address round, address account) public view returns (uint256) {
        uint256 total = lockedTotal[round];
        if (total == 0) return 0;
        return
            FixedPointMathLib.fullMulDiv(totalReceived[round], shareOf[round][account], total) - claimed[round][account];
    }

    function claim(address round, address account) external nonReentrant {
        uint256 amount = claimable(round, account);
        if (amount == 0) revert NothingToClaim();
        claimed[round][account] += amount;
        totalPaid[round] += amount;
        totalAttributed -= amount;
        SafeTransferLib.safeTransfer(token, account, amount);
    }
}
