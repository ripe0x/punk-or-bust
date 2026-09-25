// Thin viem adapter. Everything that touches the RPC lives here; the rest of the keeper takes this
// object (or a fake with the same methods in tests).

import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, getAbiItem, http } from 'viem';
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
const AUCTION_STARTED = getAbiItem({ abi: VAULT_ABI, name: 'AuctionStarted' });

/** Per-action gas limit ceilings: a little above the vault's own reimbursement caps. */
const GAS_LIMIT = { request: 2_000_000n, sync: 3_500_000n, finalize: 1_200_000n, process: 3_000_000n };

/** Builds the call for an action. */
export function callFor(action, fwa) {
  switch (action.kind) {
    case 'finalize':
      return { to: action.vault, abi: VAULT_ABI, functionName: 'finalizeAuction', args: [action.requestId] };
    case 'sync':
      return { to: action.vault, abi: VAULT_ABI, functionName: 'sync', args: [BigInt(action.maxCount)] };
    case 'request':
      return { to: action.vault, abi: VAULT_ABI, functionName: 'requestPulls', args: [BigInt(action.count)] };
    case 'process':
      return { to: fwa, abi: FWA_ABI, functionName: 'processAcquisitions', args: [10n] };
    default:
      throw new Error(`unknown action ${action.kind}`);
  }
}

/**
 * @param {{rpcUrl:string, privateKey:`0x${string}`}} o
 */
export async function createChainAdapter({ rpcUrl, privateKey }) {
  const transport = http(rpcUrl, { batch: { batchSize: 100, wait: 5 }, retryCount: 3, retryDelay: 250, timeout: 15_000 });
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
  const wallet = createWalletClient({ chain, transport, account });

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
      const [settlementWindow, selectionTimeoutBlocks] = await Promise.all([
        read(fwa, FWA_ABI, 'settlementWindow', []),
        read(fwa, FWA_ABI, 'selectionTimeoutBlocks', []),
      ]);
      return { settlementWindow: Number(settlementWindow), selectionTimeoutBlocks };
    },

    /** The vault fields the planner needs, all at one block. */
    async readVault(vault, keeper, blockNumber) {
      const r = (fn, args = []) => read(vault, VAULT_ABI, fn, args, blockNumber);
      const [approved, status, gasCeiling, outstanding, openAuctions, run, pullsRequested] = await Promise.all([
        r('isKeeper', [keeper]),
        r('status'),
        r('gasCeiling'),
        r('outstanding'),
        r('openAuctions'),
        r('run'),
        r('pullsRequested'),
      ]);
      // `run` is the RunParams tuple: maxDrawdownBps, maxPullCostWei, stopAfterKeeps, deadline, maxPulls.
      return {
        approved,
        status: Number(status),
        gasCeiling,
        outstanding: [...outstanding],
        openAuctions,
        runDeadline: run[3],
        maxPulls: run[4],
        pullsRequested,
      };
    },

    /** FWA's acquisition record for each request and, once fulfilled, its listing. */
    async readPulls(fwa, requestIds, blockNumber) {
      return Promise.all(
        requestIds.map(async (requestId) => {
          const [, requestBlock, , listingId, acqStatus] = await read(fwa, FWA_ABI, 'acquisitions', [requestId], blockNumber);
          const p = { requestId, requestBlock, listingId, acqStatus: Number(acqStatus) };
          if (p.acqStatus === 2) {
            const l = await read(fwa, FWA_ABI, 'listings', [listingId], blockNumber);
            p.allocatedAt = Number(l[9]);
            p.listingStatus = Number(l[10]);
          }
          return p;
        }),
      );
    },

    async readAuctions(vault, requestIds, blockNumber) {
      return Promise.all(
        requestIds.map(async (requestId) => {
          const [pull, a] = await Promise.all([
            read(vault, VAULT_ABI, 'pulls', [requestId], blockNumber),
            read(vault, VAULT_ABI, 'auctions', [requestId], blockNumber),
          ]);
          return { requestId, status: Number(pull[1]), deadline: a[4], hardDeadline: a[5] };
        }),
      );
    },

    async getVaultCreated(factory, fromBlock, toBlock) {
      const logs = await pub.getLogs({ address: factory, event: VAULT_CREATED, fromBlock, toBlock, strict: true });
      return logs.map((l) => ({ vault: l.args.vault, owner: l.args.owner, blockNumber: l.blockNumber }));
    },

    async getAuctionStarted(vaults, fromBlock, toBlock) {
      if (vaults.length === 0) return [];
      const logs = await pub.getLogs({ address: vaults, event: AUCTION_STARTED, fromBlock, toBlock, strict: true });
      return logs.map((l) => ({ vault: l.address, requestId: l.args.requestId, blockNumber: l.blockNumber }));
    },

    /**
     * Simulates an action at the fees it will be sent with (the FWA quote's VRF leg and the vault's
     * ceiling check both read `tx.gasprice`). Returns the call's result and a gas limit, or the revert.
     */
    async simulate(action, fees, fwa) {
      const c = callFor(action, fwa);
      const params = { account, address: c.to, abi: c.abi, functionName: c.functionName, args: c.args, ...fees };
      try {
        const { result } = await pub.simulateContract(params);
        const est = await pub.estimateContractGas(params);
        let gas = (est * 13n) / 10n;
        if (gas > GAS_LIMIT[action.kind]) gas = GAS_LIMIT[action.kind];
        if (gas < est) gas = est;
        const data = encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args });
        return { ok: true, result, req: { to: c.to, data, value: 0n, gas } };
      } catch (e) {
        return { ok: false, error: e };
      }
    },

    async sendTx({ to, data, value, gas, nonce, maxFeePerGas, maxPriorityFeePerGas }) {
      return wallet.sendTransaction({ to, data, value, gas, nonce, maxFeePerGas, maxPriorityFeePerGas, type: 'eip1559' });
    },
  };
}
