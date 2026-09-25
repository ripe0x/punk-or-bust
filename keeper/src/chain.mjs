// Thin viem adapter. Everything that touches the RPC lives here; the rest of the keeper takes this
// object (or a fake with the same methods in tests).

import { createPublicClient, defineChain, encodeFunctionData, getAbiItem, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const abiDir = join(dirname(fileURLToPath(import.meta.url)), 'abi');
const loadAbi = (name) => JSON.parse(readFileSync(join(abiDir, `${name}.json`), 'utf8'));

export const VAULT_ABI = loadAbi('Vault');
export const FACTORY_ABI = loadAbi('VaultFactory');
export const FWA_ABI = loadAbi('IFWA');

const VAULT_CREATED = getAbiItem({ abi: FACTORY_ABI, name: 'VaultCreated' });

/** Per-action gas limit ceilings: a little above the vault's own reimbursement caps. */
const GAS_LIMIT = { request: 2_000_000n, sync: 3_500_000n, finalize: 1_200_000n };

/** Builds the call for an action. */
export function callFor(action) {
  switch (action.kind) {
    case 'finalize':
      return { to: action.vault, abi: VAULT_ABI, functionName: 'finalizeAuction', args: [action.requestId] };
    case 'sync':
      return { to: action.vault, abi: VAULT_ABI, functionName: 'sync', args: [BigInt(action.maxCount)] };
    case 'request':
      return { to: action.vault, abi: VAULT_ABI, functionName: 'requestPulls', args: [BigInt(action.count)] };
    default:
      throw new Error(`unknown action ${action.kind}`);
  }
}

/**
 * Reads go to `rpcUrl`. Signed transactions go to `sendRpcUrl` when set (for example a private relay),
 * else to `rpcUrl`.
 * @param {{rpcUrl:string, sendRpcUrl?:string|null, privateKey:`0x${string}`}} o
 */
export async function createChainAdapter({ rpcUrl, sendRpcUrl = null, privateKey }) {
  const transport = http(rpcUrl, { batch: { batchSize: 100, wait: 5 }, retryCount: 3, retryDelay: 250, timeout: 15_000 });
  const sendTransport = sendRpcUrl ? http(sendRpcUrl, { retryCount: 1, timeout: 15_000 }) : transport;
  const probe = createPublicClient({ transport });
  const chainId = await probe.getChainId();
  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['http://localhost'] } },
  });
  const pub = createPublicClient({ chain, transport });
  const account = privateKeyToAccount(privateKey);
  const sender = createPublicClient({ chain, transport: sendTransport });

  const read = (address, abi, functionName, args, blockNumber) =>
    pub.readContract({ address, abi, functionName, args, blockNumber });

  return {
    chainId,
    address: account.address,

    async getBlock() {
      const b = await pub.getBlock({ blockTag: 'latest' });
      return { number: b.number, timestamp: Number(b.timestamp), baseFeePerGas: b.baseFeePerGas ?? 0n };
    },
    getBalance: (address) => pub.getBalance({ address }),
    getNonce: (blockTag) => pub.getTransactionCount({ address: account.address, blockTag }),

    async getReceipt(hash) {
      try {
        const r = await pub.getTransactionReceipt({ hash });
        return { status: r.status, blockNumber: r.blockNumber, gasUsed: r.gasUsed };
      } catch (e) {
        if (e?.name === 'TransactionReceiptNotFoundError') return null;
        throw e;
      }
    },

    readFactoryFwa: (factory) => read(factory, FACTORY_ABI, 'FWA', []),

    async readFwaParams(fwa) {
      return { settlementWindow: Number(await read(fwa, FWA_ABI, 'settlementWindow', [])) };
    },

    /** The vault fields the planner needs, all at one block. `syncStatus` reads FWA for us. */
    async readVault(vault, keeper, blockNumber) {
      const r = (fn, args = []) => read(vault, VAULT_ABI, fn, args, blockNumber);
      const [
        owner,
        approved,
        privateMode,
        status,
        gasCeiling,
        idle,
        bountyWei,
        syncBountyMaxWei,
        outstanding,
        openAuctionIds,
        run,
        pullsRequested,
        syncStatus,
      ] = await Promise.all([
        r('OWNER'),
        r('isKeeper', [keeper]),
        r('privateMode'),
        r('status'),
        r('gasCeiling'),
        r('idle'),
        r('bountyWei'),
        r('syncBountyMaxWei'),
        r('outstandingCount'),
        r('openAuctionIds'),
        r('run'),
        r('pullsRequested'),
        r('syncStatus'),
      ]);
      // `run` is the RunParams tuple: maxDrawdownBps, maxPullCostWei, stopAfterKeeps, deadline, maxPulls.
      return {
        isOwner: owner.toLowerCase() === keeper.toLowerCase(),
        approved,
        privateMode,
        status: Number(status),
        gasCeiling,
        idle,
        bountyWei,
        syncBountyMaxWei,
        outstanding,
        openAuctionIds: [...openAuctionIds],
        runDeadline: run[3],
        maxPulls: run[4],
        pullsRequested,
        resolvable: syncStatus[0],
        oldestAllocatedAt: syncStatus[1],
        auctionsPastDeadline: syncStatus[2],
      };
    },

    /** `auctionInfo` for each open auction. */
    async readAuctions(vault, requestIds, blockNumber) {
      return Promise.all(
        requestIds.map(async (requestId) => {
          const a = await read(vault, VAULT_ABI, 'auctionInfo', [requestId], blockNumber);
          return { requestId, highBid: a[4], deadline: a[6], hardDeadline: a[7] };
        }),
      );
    },

    async getVaultCreated(factory, fromBlock, toBlock) {
      const logs = await pub.getLogs({ address: factory, event: VAULT_CREATED, fromBlock, toBlock, strict: true });
      return logs.map((l) => ({ vault: l.args.vault, owner: l.args.owner, blockNumber: l.blockNumber }));
    },

    /**
     * Simulates an action at the fees it will be sent with (the FWA quote's VRF leg and the vault's
     * ceiling check both read `tx.gasprice`), at the latest block. Returns the call's result, the gas
     * estimate and a request with a gas limit, or the revert.
     */
    async simulate(action, fees) {
      const c = callFor(action);
      const params = {
        account,
        address: c.to,
        abi: c.abi,
        functionName: c.functionName,
        args: c.args,
        blockTag: 'latest',
        ...fees,
      };
      try {
        const { result } = await pub.simulateContract(params);
        const est = await pub.estimateContractGas(params);
        let gas = (est * 13n) / 10n;
        if (gas > GAS_LIMIT[action.kind]) gas = GAS_LIMIT[action.kind];
        if (gas < est) gas = est;
        const data = encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args });
        return { ok: true, result, gasEstimate: est, req: { to: c.to, data, value: 0n, gas } };
      } catch (e) {
        return { ok: false, error: e };
      }
    },

    /** Signs locally and sends the raw transaction to the send RPC. */
    async sendTx({ to, data, value, gas, nonce, maxFeePerGas, maxPriorityFeePerGas }) {
      const serializedTransaction = await account.signTransaction({
        chainId,
        type: 'eip1559',
        to,
        data,
        value,
        gas,
        nonce,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
      return sender.sendRawTransaction({ serializedTransaction });
    },
  };
}
