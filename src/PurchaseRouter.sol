// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {SignatureCheckerLib} from "solady/utils/SignatureCheckerLib.sol";

import {IFWA} from "./interfaces/IFWA.sol";
import {IFWAToken} from "./interfaces/IFWAToken.sol";
import {IFWAV2} from "./interfaces/IFWAV2.sol";

interface IRouterFactory {
    function isVault(address vault) external view returns (bool);
}

interface IRouterVault {
    function receivePurchaseRefund() external payable;
}

interface IBuilderPool {
    function rewards() external view returns (address);
}

interface IBuilderRewards {
    function fwa() external view returns (address);
    function token() external view returns (address);
    function claimAccruedTokens(uint256 minOut) external returns (uint256);
    function tokenBuyAllowance(address builder) external view returns (uint256);
    function withdrawTokenBuyAllowanceAsETH() external returns (uint256);
}

interface IBuilderToken {
    function permit2() external view returns (address);
}

interface IBuilderPermit2 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

interface IBuilderTransfer {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    function token() external view returns (address);
    function permit2() external view returns (address);
    function depositWithPermit2(PermitTransferFrom calldata permit, bytes calldata signature, address recipient)
        external
        returns (uint256 totalPending);
    function claim(address recipient) external returns (uint256 amount);
}

/// @dev Derived from the Sourcify-verified source of mainnet 0xd860d67119003E9F9d9139024C2fbC662278092c (match 52108276).
/// @title PurchaseRouter
/// @notice The only caller of FWA `acquire` for factory vaults. Each vault stays the purchaser of
///         record and owns every NFT, refund and epoch reward; FWA's builder reward accrues here and
///         goes only to the fixed treasury. No owner.
contract PurchaseRouter is ReentrancyGuard {
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint256 public constant MAX_DEADLINE_DELAY = 1 hours;
    uint256 public constant MAX_BATCH = 5;
    bytes32 private constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 private constant PERMIT_TRANSFER_TYPEHASH = keccak256(
        "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
    );
    bytes32 private constant SWAP_TYPEHASH =
        keccak256("BuilderSwap(uint256 allowance,uint256 minOut,uint256 deadline,uint256 nonce)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    address public immutable FWA;
    address public immutable FACTORY;
    address public immutable REWARDS;
    address public immutable TOKEN;
    address public immutable TREASURY;
    address public immutable HELPER;
    uint256 public nextTransferNonce;
    uint256 public nextSwapNonce;
    bytes32 private _activePermitHash;
    bool private _acquiring;
    bool private _recoveringAllowance;

    error BadConfig();
    error Unauthorized();
    error BadPurchase();
    error BadAmount();
    error BadDeadline();

    event Purchased(address indexed vault, uint256 indexed requestId, uint256 spent, uint256 refund);
    event BuilderRewardsQueued(uint256 amount, uint256 indexed nonce, uint256 totalPending);
    event BuilderSwapAuthorized(uint256 indexed nonce, uint256 allowance, uint256 minOut);
    event AssetRecovered(address indexed asset, address indexed recipient, uint256 amountOrId);

    /// @param factory The vault factory. It deploys this router from its own constructor, so its code
    ///        is not yet present here and is not checked.
    constructor(address fwaV2, address factory, address treasury, address transferHelper) {
        if (
            fwaV2.code.length == 0 || factory == address(0) || treasury == address(0) || treasury == address(this)
                || treasury == transferHelper || PERMIT2.code.length == 0
        ) revert BadConfig();
        address rewards = IBuilderPool(fwaV2).rewards();
        address token = IFWA(fwaV2).token();
        if (
            rewards.code.length == 0 || token.code.length == 0 || IBuilderRewards(rewards).fwa() != fwaV2
                || IBuilderRewards(rewards).token() != token || IBuilderToken(token).permit2() != PERMIT2
        ) revert BadConfig();
        if (
            transferHelper.code.length == 0 || IBuilderTransfer(transferHelper).token() != token
                || IBuilderTransfer(transferHelper).permit2() != PERMIT2
        ) revert BadConfig();
        FWA = fwaV2;
        FACTORY = factory;
        REWARDS = rewards;
        TOKEN = token;
        TREASURY = treasury;
        HELPER = transferHelper;
    }

    /// @notice One atomic native batch, with the calling vault owning every request. Overpayment
    ///         returns to the vault inside this call.
    function acquireBatch(uint256 count)
        external
        payable
        nonReentrant
        returns (uint256[] memory requestIds, uint256 spentPerPull)
    {
        if (!IRouterFactory(FACTORY).isVault(msg.sender)) revert Unauthorized();
        if (count == 0 || count > MAX_BATCH) revert BadAmount();
        (uint256 fee, uint256 vrf, uint256 quoted) = IFWA(FWA).quoteAcquisitionPrice();
        if (quoted == 0 || fee + vrf != quoted || msg.value < count * quoted) revert BadAmount();
        uint256 beforeBalance = address(this).balance - msg.value;
        _acquiring = true;
        requestIds =
            IFWAV2(FWA).acquire{value: msg.value}(msg.sender, count, fee, 0, IFWAV2(FWA).selectionSlippageBps());
        _acquiring = false;
        if (requestIds.length != count) revert BadPurchase();
        uint256 price;
        for (uint256 i; i < count; ++i) {
            if (requestIds[i] == 0) revert BadPurchase();
            for (uint256 j; j < i; ++j) {
                if (requestIds[j] == requestIds[i]) revert BadPurchase();
            }
            (address purchaser,, uint256 escrow,, uint8 status) = IFWA(FWA).acquisitions(requestIds[i]);
            if (
                purchaser != msg.sender || escrow == 0 || escrow > fee
                    || status != uint8(IFWA.AcquisitionStatus.Pending) || (i != 0 && escrow != price)
            ) revert BadPurchase();
            price = escrow;
        }
        uint256 refund = address(this).balance - beforeBalance;
        if (refund > msg.value) revert BadPurchase();
        spentPerPull = price + vrf;
        if (msg.value - refund != count * spentPerPull) revert BadPurchase();
        if (refund != 0) IRouterVault(msg.sender).receivePurchaseRefund{value: refund}();
        for (uint256 i; i < count; ++i) {
            emit Purchased(msg.sender, requestIds[i], spentPerPull, i == 0 ? refund : 0);
        }
    }

    /// @notice Buys FWAT with this router's accrued allowance and queues only the measured new tokens
    ///         for the treasury. Only the treasury may call, because the buy has no on-chain price floor.
    function claimAndQueueBuilderRewards(uint256 minOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 amount, uint256 totalPending)
    {
        if (msg.sender != TREASURY) revert Unauthorized();
        _checkDeadline(deadline);
        ++nextSwapNonce;
        return _claimAndQueue(minOut, deadline);
    }

    /// @notice Anyone may execute the treasury's exact, bounded full-allowance swap authorization.
    function claimAndQueueBuilderRewardsAuthorized(
        uint256 allowance,
        uint256 minOut,
        uint256 deadline,
        uint256 nonce,
        bytes calldata signature
    ) external nonReentrant returns (uint256 amount, uint256 totalPending) {
        _checkDeadline(deadline);
        if (
            minOut == 0 || allowance == 0 || nonce != nextSwapNonce
                || IBuilderRewards(REWARDS).tokenBuyAllowance(address(this)) != allowance
        ) revert BadAmount();
        if (!SignatureCheckerLib.isValidSignatureNowCalldata(
                TREASURY, swapAuthorizationDigest(allowance, minOut, deadline, nonce), signature
            )) revert Unauthorized();
        ++nextSwapNonce;
        emit BuilderSwapAuthorized(nonce, allowance, minOut);
        return _claimAndQueue(minOut, deadline);
    }

    function swapAuthorizationDigest(uint256 allowance, uint256 minOut, uint256 deadline, uint256 nonce)
        public
        view
        returns (bytes32)
    {
        bytes32 domain = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("PurchaseRouter"), keccak256("1"), block.chainid, address(this))
        );
        return keccak256(
            abi.encodePacked(
                "\x19\x01", domain, keccak256(abi.encode(SWAP_TYPEHASH, allowance, minOut, deadline, nonce))
            )
        );
    }

    function _claimAndQueue(uint256 minOut, uint256 deadline) private returns (uint256 amount, uint256 totalPending) {
        uint256 beforeBalance = IFWAToken(TOKEN).balanceOf(address(this));
        uint256 reported = IBuilderRewards(REWARDS).claimAccruedTokens(minOut);
        amount = IFWAToken(TOKEN).balanceOf(address(this)) - beforeBalance;
        if (amount == 0 || amount != reported || amount < minOut) revert BadAmount();
        totalPending = _queue(amount, deadline);
    }

    /// @notice Builder tokens already held here, including direct donations, go to the same treasury.
    function queueBuilderTokens(uint256 amount, uint256 deadline) external nonReentrant returns (uint256 totalPending) {
        _checkDeadline(deadline);
        return _queue(amount, deadline);
    }

    function claimTreasury() external nonReentrant returns (uint256 amount) {
        return IBuilderTransfer(HELPER).claim(TREASURY);
    }

    /// @notice Emergency exit. The rewards module itself enforces withdraw-only mode and no unsettled
    ///         requests.
    function recoverBuilderAllowanceAsETH() external nonReentrant returns (uint256 amount) {
        uint256 beforeBalance = address(this).balance;
        _recoveringAllowance = true;
        uint256 reported = IBuilderRewards(REWARDS).withdrawTokenBuyAllowanceAsETH();
        _recoveringAllowance = false;
        amount = address(this).balance - beforeBalance;
        if (amount == 0 || amount != reported) revert BadAmount();
        ++nextSwapNonce;
        SafeTransferLib.forceSafeTransferETH(TREASURY, amount);
        emit AssetRecovered(address(0), TREASURY, amount);
    }

    /// @notice Purchase refunds leave in the purchase transaction, so ETH here is never a vault liability.
    function sweepETH() external nonReentrant {
        uint256 amount = address(this).balance;
        SafeTransferLib.forceSafeTransferETH(TREASURY, amount);
        emit AssetRecovered(address(0), TREASURY, amount);
    }

    function rescueToken(address asset, uint256 amount) external nonReentrant {
        if (asset == TOKEN) revert BadConfig();
        SafeTransferLib.safeTransfer(asset, TREASURY, amount);
        emit AssetRecovered(asset, TREASURY, amount);
    }

    function rescueNFT(address asset, uint256 tokenId) external nonReentrant {
        if (asset == TOKEN) revert BadConfig();
        (bool ok,) = asset.call(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", address(this), TREASURY, tokenId)
        );
        if (!ok) revert BadConfig();
        emit AssetRecovered(asset, TREASURY, tokenId);
    }

    function _queue(uint256 amount, uint256 deadline) private returns (uint256 totalPending) {
        if (amount == 0 || amount > IFWAToken(TOKEN).balanceOf(address(this))) revert BadAmount();
        uint256 nonce = nextTransferNonce++;
        IBuilderTransfer.PermitTransferFrom memory permit =
            IBuilderTransfer.PermitTransferFrom(IBuilderTransfer.TokenPermissions(TOKEN, amount), nonce, deadline);
        bytes32 permissionsHash = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, TOKEN, amount));
        bytes32 permitHash = keccak256(abi.encode(PERMIT_TRANSFER_TYPEHASH, permissionsHash, HELPER, nonce, deadline));
        _activePermitHash =
            keccak256(abi.encodePacked("\x19\x01", IBuilderPermit2(PERMIT2).DOMAIN_SEPARATOR(), permitHash));
        totalPending = IBuilderTransfer(HELPER).depositWithPermit2(permit, "", TREASURY);
        delete _activePermitHash;
        emit BuilderRewardsQueued(amount, nonce, totalPending);
    }

    /// @notice ERC-1271 answer for Permit2, valid only for the permit this router is queueing.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (
            msg.sender == PERMIT2 && signature.length == 0 && _activePermitHash != bytes32(0)
                && hash == _activePermitHash
        ) {
            return this.isValidSignature.selector;
        }
        return bytes4(0xffffffff);
    }

    function _checkDeadline(uint256 deadline) private view {
        if (deadline < block.timestamp || deadline - block.timestamp > MAX_DEADLINE_DELAY) revert BadDeadline();
    }

    receive() external payable {
        if (!((msg.sender == FWA && _acquiring) || (msg.sender == REWARDS && _recoveringAllowance))) {
            revert Unauthorized();
        }
    }
}
