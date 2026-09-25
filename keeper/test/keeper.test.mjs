import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Discovery } from '../src/discovery.mjs';
import { backoffMs, Keeper } from '../src/keeper.mjs';
import { ACQ, PULL_AUCTIONING, VAULT } from '../src/logic.mjs';
import { TxManager } from '../src/txmanager.mjs';
import { fakeTxAdapter, recordingAlerter, silentLog } from './helpers.mjs';

const GWEI = 1_000_000_000n;
const NOW = 2_000_000;
const cfg = {
  priorityFee: GWEI,
  urgentPriorityFee: 3n * GWEI,
  permissionlessMaxFee: 2n * GWEI,
  rbfBlocks: 3,
  rbfBumpBps: 1500,
  cancelAfterBlocks: 20,
  urgentAfterSec: 1800,
  finalizeGraceSec: 300,
  syncMaxCount: 10,
  maxSimsPerTick: 8,
  minBalanceWei: 10n ** 17n,
};

/** A chain with vaults keyed by address; `sim` decides each simulated action's outcome. */
function fakeChain({ vaults, pulls = {}, auctions = {}, sim = () => ({ ok: true, result: 1n }), balance = 10n ** 18n, basefee = GWEI / 10n }) {
  const a = fakeTxAdapter();
  Object.assign(a, {
    simulated: [],
    async getBlock() {
      return { number: 500n, timestamp: NOW, baseFeePerGas: basefee };
    },
    async getBalance() {
      return balance;
    },
    async readFwaParams() {
      return { settlementWindow: 3600, selectionTimeoutBlocks: 50n };
    },
    async readVault(v) {
      if (vaults[v] === 'boom') throw new Error('rpc error at https://rpc.example/secretkey');
      return vaults[v];
    },
    async readPulls(_fwa, ids) {
      return ids.map((id) => ({ requestId: id, ...pulls[id] }));
    },
    async readAuctions(_v, ids) {
      return ids.map((id) => ({ requestId: id, ...auctions[id] }));
    },
    async getVaultCreated(_f, from) {
      return from <= 10n ? Object.keys(vaults).map((vault) => ({ vault, blockNumber: 10n })) : [];
    },
    async getAuctionStarted(vs, from) {
      if (from > 10n) return [];
      return Object.entries(auctions).map(([id, x]) => ({ vault: x.vault, requestId: BigInt(id), blockNumber: 10n }));
    },
    async simulate(action, fees) {
      a.simulated.push({ key: action.key, fees });
      const r = sim(action);
      return r.ok ? { ...r, req: { to: action.vault, data: '0x01', value: 0n, gas: 300_000n } } : r;
    },
  });
  return a;
}

function build(chain) {
  const log = silentLog();
  const alerter = recordingAlerter();
  const discovery = new Discovery({ adapter: chain, log, factory: '0xf', fromBlock: 0n, chunk: 1000 });
  const txm = new TxManager({ adapter: chain, log, cfg, keeper: chain.address });
  const keeper = new Keeper({ adapter: chain, log, alerter, cfg, discovery, txm, fwa: '0xfwa', now: () => NOW * 1000 });
  return { keeper, txm, alerter, log };
}

const running = (over = {}) => ({
  approved: true,
  status: VAULT.Running,
  gasCeiling: 12n * GWEI / 10n,
  outstanding: [],
  openAuctions: 0n,
  maxPulls: 100n,
  pullsRequested: 0n,
  ...over,
});

test('tick sends the most urgent action first: finalize before sync before request', async () => {
  const chain = fakeChain({
    vaults: { '0xa': running({ outstanding: [11n], openAuctions: 1n }), '0xb': running() },
    pulls: { 11: { acqStatus: ACQ.Fulfilled, requestBlock: 400n, listingStatus: 2, allocatedAt: NOW - 60 } },
    auctions: { 21: { vault: '0xa', status: PULL_AUCTIONING, deadline: BigInt(NOW - 5), hardDeadline: BigInt(NOW + 600) } },
  });
  const { keeper, txm } = build(chain);
  await keeper.tick();
  assert.equal(chain.sent.length, 1);
  assert.equal(txm.inflight.action.key, '0xa:finalize:21');
  assert.equal(keeper.health.vaults, 2);
  assert.equal(keeper.health.outstandingPulls, 1);
  // While it is pending nothing else goes out.
  await keeper.tick();
  assert.equal(chain.sent.length, 1);
  chain.mine('0xh0', 500n);
  await keeper.tick();
  // The finalize key was mined at the read block, so the next action is the sync.
  assert.equal(txm.inflight.action.key, '0xa:sync');
});

test('a reverting simulation is skipped and the next action goes out', async () => {
  const chain = fakeChain({
    vaults: { '0xa': running(), '0xb': running() },
    sim: (a) => (a.vault === '0xa' ? { ok: false, error: Object.assign(new Error('x'), { shortMessage: 'reverted: PurchaseBlackout' }) } : { ok: true, result: 5n }),
  });
  const { keeper, txm, log } = build(chain);
  await keeper.tick();
  assert.deepEqual(chain.simulated.map((s) => s.key), ['0xa:request', '0xb:request']);
  assert.equal(txm.inflight.action.key, '0xb:request');
  assert.ok(log.lines.some((l) => l.msg === 'simulation reverted, skipping'));
  // requestPulls fees are capped at the vault's ceiling.
  assert.equal(chain.sent[0].maxFeePerGas <= 12n * GWEI / 10n, true);
});

test('sync that resolves nothing is not sent', async () => {
  const chain = fakeChain({
    vaults: { '0xa': running({ status: VAULT.WindingDown, outstanding: [11n] }) },
    pulls: { 11: { acqStatus: ACQ.Expired, requestBlock: 1n } },
    sim: () => ({ ok: true, result: 0n }),
  });
  const { keeper } = build(chain);
  await keeper.tick();
  assert.equal(chain.sent.length, 0);
});

test('an allocated pull past 30 minutes escalates and syncs at urgent fees above the ceiling', async () => {
  const chain = fakeChain({
    vaults: { '0xa': running({ outstanding: [11n] }) },
    pulls: { 11: { acqStatus: ACQ.Fulfilled, requestBlock: 1n, listingStatus: 2, allocatedAt: NOW - 1850 } },
    basefee: 30n * GWEI,
  });
  const { keeper, alerter, txm } = build(chain);
  await keeper.tick();
  assert.ok(alerter.alerts.some((a) => a.key === 'urgent:0xa:11'));
  assert.equal(txm.inflight.action.key, '0xa:sync');
  assert.equal(chain.sent[0].maxPriorityFeePerGas, 3n * GWEI);
  assert.equal(chain.sent[0].maxFeePerGas, 93n * GWEI);
  assert.equal(keeper.health.urgent, 1);
});

test('a pending request is preempted by a protective action', async () => {
  const vaults = { '0xa': running() };
  const chain = fakeChain({ vaults, pulls: { 11: { acqStatus: ACQ.Refunded, requestBlock: 1n } } });
  const { keeper, txm } = build(chain);
  await keeper.tick();
  assert.equal(txm.inflight.action.key, '0xa:request');
  vaults['0xa'] = running({ outstanding: [11n] });
  await keeper.tick();
  assert.equal(chain.sent.length, 2);
  assert.equal(chain.sent[1].nonce, chain.sent[0].nonce);
  assert.equal(txm.inflight.action.key, '0xa:sync');
});

test('one vault failing does not stop the others; errors are scrubbed of URLs', async () => {
  const chain = fakeChain({ vaults: { '0xa': 'boom', '0xb': running() } });
  const { keeper, txm, log } = build(chain);
  await keeper.tick();
  assert.equal(txm.inflight.action.key, '0xb:request');
  assert.equal(keeper.health.vaultErrors, 1);
  const line = log.lines.find((l) => l.msg === 'vault read failed');
  assert.ok(!JSON.stringify(line).includes('secretkey'));
});

test('unapproved vaults: no requests; closed auctions are forgotten', async () => {
  const chain = fakeChain({
    vaults: { '0xa': running({ approved: false, openAuctions: 0n }) },
    auctions: { 21: { vault: '0xa', status: 3, deadline: 0n, hardDeadline: 0n } },
  });
  const { keeper } = build(chain);
  await keeper.tick();
  assert.equal(chain.sent.length, 0);
  assert.deepEqual(keeper.discovery.auctionIds('0xa'), []);
});

test('low balance raises an alert', async () => {
  const chain = fakeChain({ vaults: {}, balance: 1n });
  const { keeper, alerter } = build(chain);
  await keeper.tick();
  assert.deepEqual(alerter.alerts.map((a) => a.key), ['low-balance']);
});

test('backoff doubles per failure up to a minute', () => {
  assert.equal(backoffMs(4000, 0), 4000);
  assert.equal(backoffMs(4000, 1), 8000);
  assert.equal(backoffMs(4000, 3), 32000);
  assert.equal(backoffMs(4000, 9), 60000);
});
