// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC721} from "solady/tokens/ERC721.sol";

import {PurchaseRouter} from "../../src/PurchaseRouter.sol";
import {Vault} from "../../src/Vault.sol";
import {VaultFactory} from "../../src/VaultFactory.sol";
import {Permit2Double, TransferHelperDouble} from "./BuilderTransferDoubles.sol";
import {FwaV2Harness} from "./FwaV2Harness.sol";
import {RewardVaultDouble} from "./RewardVaultDouble.sol";

/// @notice ERC721 whose transfers can be paused, or blocked toward chosen receivers.
contract ControlledERC721 is ERC721 {
    bool public paused;
    mapping(address => bool) public blocked;

    function name() public pure override returns (string memory) {
        return "Controlled NFT";
    }

    function symbol() public pure override returns (string memory) {
        return "CNFT";
    }

    function tokenURI(uint256) public pure override returns (string memory) {
        return "";
    }

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    function setPaused(bool value) external {
        paused = value;
    }

    function setBlocked(address account, bool value) external {
        blocked[account] = value;
    }

    function _beforeTokenTransfer(address from, address to, uint256) internal view override {
        if (from != address(0) && (paused || blocked[to])) revert("transfer restricted");
    }
}

/// @notice Real FWA V2 pool, the factory with its router and vault implementation, a reward-vault
///         double and builder transfer doubles.
abstract contract VaultTestBase is FwaV2Harness {
    uint256 internal constant DISCOUNT_BPS = 9000;
    uint256 internal constant BPS = 10_000;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    VaultFactory internal factory;
    PurchaseRouter internal router;
    RewardVaultDouble internal rewardVault;
    TransferHelperDouble internal helper;
    Vault internal vault;

    address internal treasury;
    uint256 internal treasuryKey;
    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");
    address internal depositor = makeAddr("depositor");
    address internal rewardVaultOwner = makeAddr("rewardVaultOwner");
    address internal stranger = makeAddr("stranger");

    function setUp() public virtual {
        _deployFwaV2(DISCOUNT_BPS);
        (treasury, treasuryKey) = makeAddrAndKey("treasury");
        vm.etch(PERMIT2, address(new Permit2Double()).code);
        helper = new TransferHelperDouble(address(fwat));
        rewardVault = new RewardVaultDouble(address(fwat), rewardVaultOwner);
        factory = new VaultFactory(address(pool), address(rewardVault), treasury, address(helper));
        router = PurchaseRouter(payable(factory.ROUTER()));
    }

    function _params() internal view returns (Vault.RunParams memory) {
        return Vault.RunParams({
            maxDrawdownBps: BPS,
            maxPullCostWei: 2 ether,
            stopAfterKeeps: 0,
            deadline: block.timestamp + 7 days,
            maxPulls: 100
        });
    }

    function _createVault(uint256 value, Vault.RunParams memory params, address[] memory keepCollections)
        internal
        returns (Vault created)
    {
        address[] memory keepers = new address[](1);
        keepers[0] = keeper;
        vm.deal(owner, owner.balance + value);
        vm.prank(owner);
        created = Vault(
            payable(factory.createVault{value: value}(keepCollections, new Vault.KeepToken[](0), keepers, params))
        );
        vault = created;
    }

    function _createVault(uint256 value, Vault.RunParams memory params) internal returns (Vault) {
        return _createVault(value, params, new address[](0));
    }

    function _one(address a) internal pure returns (address[] memory list) {
        list = new address[](1);
        list[0] = a;
    }

    /// @notice Keeper opens one pull and returns its request id.
    function _requestOne() internal returns (uint256 requestId) {
        vm.prank(keeper);
        assertEq(vault.requestPulls(1), 1, "one pull requested");
        uint256[] memory ids = vault.outstanding();
        requestId = ids[ids.length - 1];
    }

    /// @notice Opens one pull, allocates `listingId` to it, and syncs.
    function _pullAndSync(uint256 listingId) internal returns (uint256 requestId) {
        requestId = _requestOne();
        _allocate(requestId, listingId);
        _ownerSync();
    }

    /// @notice Syncs as the owner, who is never paid, so accounting assertions stay exact.
    function _ownerSync() internal returns (uint256) {
        vm.prank(owner);
        return vault.sync(32);
    }

    /// @notice Lists `tokenId` of a custom collection.
    function _listCustom(ControlledERC721 collection, uint256 tokenId, uint256 backing)
        internal
        returns (uint256 listingId)
    {
        collection.mint(depositor, tokenId);
        vm.deal(depositor, depositor.balance + backing);
        vm.startPrank(depositor);
        collection.approve(address(pool), tokenId);
        listingId = pool.listNFT{value: backing}(address(collection), tokenId);
        vm.stopPrank();
    }

    function _price() internal view returns (uint256 fee, uint256 total) {
        (fee,, total) = pool.quoteAcquisitionPrice();
    }
}
