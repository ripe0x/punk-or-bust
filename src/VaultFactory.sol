// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {LibClone} from "solady/utils/LibClone.sol";
import {ReentrancyGuardTransient} from "solady/utils/ReentrancyGuardTransient.sol";

import {IRewardVault} from "./interfaces/IRewardVault.sol";
import {PurchaseRouter} from "./PurchaseRouter.sol";
import {Vault} from "./Vault.sol";

/// @title VaultFactory
/// @notice Clones one `Vault` per owner, keeps the registry, and is the "series" the shared reward
///         vault registers vaults under. No admin.
/// @dev Deploys the shared `PurchaseRouter` and the vault implementation from its own constructor,
///      so the router's `FACTORY` and the implementation's `FACTORY` and `ROUTER` are fixed to this
///      contract without a precomputed address or a binding step.
contract VaultFactory is ReentrancyGuardTransient {
    address public immutable FWA;
    address public immutable ROUTER;
    address public immutable REWARD_VAULT;
    address public immutable FEE_RECIPIENT;
    address public immutable IMPLEMENTATION;

    mapping(address vault => bool) public isVault;
    mapping(address owner => address vault) public vaultOf;

    error BadConfig();
    error VaultExists();
    error Unauthorized();

    event VaultCreated(address indexed owner, address indexed vault);
    event RewardsRegistrationSkipped(address indexed vault);

    /// @param feeRecipient Pull fee recipient and the router's builder-reward treasury.
    /// @param transferHelper FWAT transfer helper the router queues builder rewards through.
    constructor(address fwa, address rewardVault, address feeRecipient, address transferHelper) {
        if (fwa.code.length == 0 || rewardVault.code.length == 0 || feeRecipient == address(0)) revert BadConfig();
        address router = address(new PurchaseRouter(fwa, address(this), feeRecipient, transferHelper));
        FWA = fwa;
        ROUTER = router;
        REWARD_VAULT = rewardVault;
        FEE_RECIPIENT = feeRecipient;
        IMPLEMENTATION = address(new Vault(fwa, address(this), router, rewardVault, feeRecipient));
    }

    /// @notice Creates the caller's vault, funds it with `msg.value`, applies its gas ceiling and
    ///         auto-return setting, starts its first run, and tries to
    ///         register it with the reward vault. Registration fails softly until the reward vault
    ///         allowlists this factory; `Vault.registerRewards` retries it later.
    function createVault(
        address[] calldata keepCollections,
        Vault.KeepToken[] calldata keepTokens,
        address[] calldata keepers,
        Vault.RunParams calldata params,
        uint256 gasCeiling,
        bool autoReturn
    ) external payable nonReentrant returns (address vault) {
        if (vaultOf[msg.sender] != address(0)) revert VaultExists();
        vault = LibClone.cloneDeterministic(IMPLEMENTATION, _salt(msg.sender));
        vaultOf[msg.sender] = vault;
        isVault[vault] = true;
        emit VaultCreated(msg.sender, vault);
        Vault(payable(vault)).initialize{value: msg.value}(
            msg.sender, keepCollections, keepTokens, keepers, params, gasCeiling, autoReturn
        );
        try Vault(payable(vault)).registerRewards() {}
        catch {
            emit RewardsRegistrationSkipped(vault);
        }
    }

    function predictVault(address owner) external view returns (address) {
        return LibClone.predictDeterministicAddress(IMPLEMENTATION, _salt(owner), address(this));
    }

    /// @notice Reward vault series interface. Same answer as `isVault`.
    function isRound(address round) external view returns (bool) {
        return isVault[round];
    }

    /// @notice Called by a vault's `registerRewards`: registers the calling vault as a round.
    function registerRound() external {
        if (!isVault[msg.sender]) revert Unauthorized();
        IRewardVault(REWARD_VAULT).registerRound(msg.sender);
    }

    function _salt(address owner) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(owner)));
    }

    function _useTransientReentrancyGuardOnlyOnMainnet() internal pure override returns (bool) {
        return false;
    }
}
