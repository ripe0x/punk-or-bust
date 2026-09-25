// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {PurchaseRouter} from "../src/PurchaseRouter.sol";
import {Vault} from "../src/Vault.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {FwaClientLib} from "../src/fwa/FwaClientLib.sol";
import {MaskedCode} from "./MaskedCode.sol";

interface IDeployPool {
    function rewards() external view returns (address);
    function token() external view returns (address);
}

interface IDeployRewards {
    function fwa() external view returns (address);
    function token() external view returns (address);
}

interface IDeployToken {
    function permit2() external view returns (address);
    function isDistributor(address account) external view returns (bool);
}

interface IDeployHelper {
    function token() external view returns (address);
    function permit2() external view returns (address);
}

interface IDeployRewardVault {
    function owner() external view returns (address);
    function token() external view returns (address);
    function seriesAllowed(address series) external view returns (bool);
}

/// @notice Mainnet deployment of `VaultFactory`, which deploys the router and the vault
///         implementation from its constructor. `FwaClientLib` is an external library: forge
///         deploys it first through the CREATE2 deployer (a deterministic address) unless it already
///         has code, and links it.
///
///   run()          preflight, deploy, postflight, record. Chain 1 only.
///   smoke(factory) creates the sender's vault from `factory`, reads it back, then stops it and
///                  withdraws. Used by the dry run on a fork; never part of the mainnet deploy.
///
/// Env: FWA, REWARD_VAULT, FEE_RECIPIENT, TRANSFER_HELPER (default: SPEC mainnet values),
/// DEPLOY_COMMIT (recorded), DEPLOY_RECORD (where a broadcast writes the record; default
/// deployments/pending.json). deploy.sh promotes the pending record to deployments/mainnet.json
/// with the tx hashes and block once every transaction has a receipt, so a failed broadcast never
/// leaves a mainnet record behind.
contract Deploy is Script {
    address internal constant MAINNET_FWA = 0x958C41181182e76F221331b2755b77D9e1426A98;
    address internal constant MAINNET_REWARD_VAULT = 0xEa20a110ad3Dfc483977d14f80203994E65D34FB;
    address internal constant MAINNET_FEE_RECIPIENT = 0xea194A186EBe76A84E2B2027f5f23F81939c05AD;
    address internal constant MAINNET_HELPER = 0xcE6d5B618e034f87C7a8B6dCa65FB8669b8c301B;

    /// @dev What the pool must point at, from the fork conformance suite.
    address internal constant EXPECTED_REWARDS = 0xA54b44C7a894AA19C49734A753D01f9B8C5f6516;
    address internal constant EXPECTED_TOKEN = 0xa0Df17B5aC76ABaBA36E1450E2cbCd18A620C845;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    /// @dev The pool's two immutables: the VRF service and the purchase notifier.
    address internal constant VRF_SERVICE = 0xCACBd874e24B533935176154E990Bf710F56693A;
    address internal constant PURCHASE_NOTIFIER = 0x612dF3a344990F8E53499ec1bC79Be63cFa496D0;

    string internal constant POOL_REF = "refs/fwa-v2/FWAV2.json";
    string internal constant PENDING_RECORD = "deployments/pending.json";

    struct Config {
        address fwa;
        address rewardVault;
        address feeRecipient;
        address helper;
    }

    function run() external returns (VaultFactory factory) {
        require(block.chainid == 1, "chain id is not 1");
        Config memory c = _config();
        _preflight(c);

        address deployer = _sender();
        uint256 nonce = vm.getNonce(deployer);
        vm.startBroadcast(deployer);
        factory = new VaultFactory(c.fwa, c.rewardVault, c.feeRecipient, c.helper);
        vm.stopBroadcast();

        require(address(factory) == vm.computeCreateAddress(deployer, nonce), "factory address");
        _postflight(c, factory);
        _record(c, factory, deployer);
    }

    function smoke(VaultFactory factory) external returns (Vault vault) {
        require(block.chainid == 1, "chain id is not 1");
        address owner = _sender();
        require(factory.vaultOf(owner) == address(0), "sender already has a vault");
        Vault.RunParams memory params = Vault.RunParams({
            maxDrawdownBps: 1000,
            maxPullCostWei: 0.1 ether,
            stopAfterKeeps: 1,
            deadline: block.timestamp + 1 days,
            maxPulls: 1
        });
        uint256 value = 0.01 ether;
        uint256 ceiling = 1.2 gwei;
        address predicted = factory.predictVault(owner);

        vm.startBroadcast(owner);
        vault = Vault(
            payable(factory.createVault{value: value}(
                    new address[](0), new Vault.KeepToken[](0), new address[](0), params, ceiling, true
                ))
        );
        vm.stopBroadcast();

        require(address(vault) == predicted, "vault address");
        require(factory.vaultOf(owner) == address(vault) && factory.isVault(address(vault)), "registry");
        require(factory.isRound(address(vault)), "series view");
        require(vault.OWNER() == owner, "vault owner");
        require(vault.FACTORY() == address(factory) && vault.ROUTER() == factory.ROUTER(), "vault wiring");
        require(vault.status() == Vault.Status.Running, "run started");
        require(vault.gasCeiling() == ceiling && vault.autoReturn(), "settings");
        require(address(vault).balance == value, "funded");
        bool seriesAllowed = IDeployRewardVault(factory.REWARD_VAULT()).seriesAllowed(address(factory));
        require(vault.rewardsRegistered() == seriesAllowed, "registration follows the series allowlist");
        (,,,, uint256 maxPulls) = vault.run();
        require(maxPulls == 1, "run params");

        console2.log("smoke vault", address(vault));
        console2.log("smoke vault balance", address(vault).balance);
        console2.log("smoke rewards registered", vault.rewardsRegistered());

        // The rollback path: the owner stops the run and withdraws everything.
        uint256 before = owner.balance;
        vm.startBroadcast(owner);
        vault.stop();
        vault.withdraw();
        vm.stopBroadcast();
        require(vault.status() == Vault.Status.Idle, "stopped");
        require(address(vault).balance == 0, "emptied");
        console2.log("smoke withdrawn to owner", owner.balance - before);
    }

    function _config() internal view returns (Config memory c) {
        c.fwa = vm.envOr("FWA", MAINNET_FWA);
        c.rewardVault = vm.envOr("REWARD_VAULT", MAINNET_REWARD_VAULT);
        c.feeRecipient = vm.envOr("FEE_RECIPIENT", MAINNET_FEE_RECIPIENT);
        c.helper = vm.envOr("TRANSFER_HELPER", MAINNET_HELPER);
    }

    function _sender() internal view returns (address) {
        (, address sender,) = vm.readCallers();
        return sender;
    }

    function _preflight(Config memory c) internal view {
        // Pool: the verified FWA V2 runtime with only its two immutables differing.
        require(c.fwa.code.length != 0, "pool has no code");
        (address[] memory imms, bytes32 masked) = MaskedCode.mask(c.fwa.code, vm.getDeployedCode(POOL_REF));
        require(masked == keccak256(vm.getDeployedCode(POOL_REF)), "pool runtime differs from the verified ref");
        require(imms.length == 2, "pool immutable count");
        require(MaskedCode.has(imms, VRF_SERVICE) && MaskedCode.has(imms, PURCHASE_NOTIFIER), "pool immutables");
        require(IDeployPool(c.fwa).rewards() == EXPECTED_REWARDS, "pool rewards");
        require(IDeployPool(c.fwa).token() == EXPECTED_TOKEN, "pool token");
        require(IDeployRewards(EXPECTED_REWARDS).fwa() == c.fwa, "rewards fwa");
        require(IDeployRewards(EXPECTED_REWARDS).token() == EXPECTED_TOKEN, "rewards token");
        require(IDeployToken(EXPECTED_TOKEN).permit2() == PERMIT2, "token permit2");

        // Transfer helper.
        require(c.helper.code.length != 0, "helper has no code");
        require(IDeployHelper(c.helper).token() == IDeployPool(c.fwa).token(), "helper token");
        require(IDeployHelper(c.helper).permit2() == PERMIT2, "helper permit2");

        // Reward vault.
        require(c.rewardVault.code.length != 0, "reward vault has no code");
        require(IDeployRewardVault(c.rewardVault).token() == EXPECTED_TOKEN, "reward vault token");

        // Fee recipient.
        require(c.feeRecipient != address(0), "fee recipient is zero");

        console2.log("== preflight ok, block", block.number);
        console2.log("pool", c.fwa);
        console2.log("reward vault", c.rewardVault);
        console2.log("reward vault owner", IDeployRewardVault(c.rewardVault).owner());
        console2.log("reward vault distributor grant", IDeployToken(EXPECTED_TOKEN).isDistributor(c.rewardVault));
        console2.log("helper is distributor", IDeployToken(EXPECTED_TOKEN).isDistributor(c.helper));
        console2.log("fee recipient", c.feeRecipient);
        console2.log("fee recipient code size", c.feeRecipient.code.length);
    }

    function _postflight(Config memory c, VaultFactory factory) internal view {
        PurchaseRouter router = PurchaseRouter(payable(factory.ROUTER()));
        Vault impl = Vault(payable(factory.IMPLEMENTATION()));
        address f = address(factory);

        require(address(router) == vm.computeCreateAddress(f, 1), "router address");
        require(address(impl) == vm.computeCreateAddress(f, 2), "implementation address");
        require(f.code.length != 0 && address(router).code.length != 0 && address(impl).code.length != 0, "code");
        require(address(FwaClientLib).code.length != 0, "linked library has no code");

        require(factory.FWA() == c.fwa, "factory FWA");
        require(factory.REWARD_VAULT() == c.rewardVault, "factory REWARD_VAULT");
        require(factory.FEE_RECIPIENT() == c.feeRecipient, "factory FEE_RECIPIENT");

        require(router.FACTORY() == f, "router FACTORY");
        require(router.TREASURY() == c.feeRecipient, "router TREASURY");
        require(router.FWA() == c.fwa, "router FWA");
        require(router.HELPER() == c.helper, "router HELPER");
        require(router.REWARDS() == EXPECTED_REWARDS, "router REWARDS");
        require(router.TOKEN() == EXPECTED_TOKEN, "router TOKEN");

        require(impl.FACTORY() == f, "implementation FACTORY");
        require(impl.ROUTER() == address(router), "implementation ROUTER");
        require(impl.FWA() == c.fwa, "implementation FWA");
        require(impl.REWARD_VAULT() == c.rewardVault, "implementation REWARD_VAULT");
        require(impl.FEE_RECIPIENT() == c.feeRecipient, "implementation FEE_RECIPIENT");
        require(impl.OWNER() == address(0), "implementation is uninitialized");

        console2.log("== postflight ok");
        console2.log("factory", f);
        console2.log("router", address(router));
        console2.log("vault implementation", address(impl));
        console2.log("linked FwaClientLib", address(FwaClientLib));
        console2.log("series allowed", IDeployRewardVault(c.rewardVault).seriesAllowed(f));
    }

    function _record(Config memory c, VaultFactory factory, address deployer) internal {
        string memory k = "record";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeString(k, "commit", vm.envOr("DEPLOY_COMMIT", string("unknown")));
        vm.serializeAddress(k, "deployer", deployer);
        vm.serializeAddress(k, "factory", address(factory));
        vm.serializeAddress(k, "router", factory.ROUTER());
        vm.serializeAddress(k, "vaultImplementation", factory.IMPLEMENTATION());
        vm.serializeAddress(k, "fwaClientLib", address(FwaClientLib));
        vm.serializeAddress(k, "fwa", c.fwa);
        vm.serializeAddress(k, "rewardVault", c.rewardVault);
        vm.serializeAddress(k, "feeRecipient", c.feeRecipient);
        string memory json = vm.serializeAddress(k, "transferHelper", c.helper);

        console2.log("== record");
        console2.log(json);
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            string memory path = vm.envOr("DEPLOY_RECORD", PENDING_RECORD);
            vm.writeJson(json, path);
            console2.log("written to", path);
        }
    }
}
