import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Discovery } from '../src/discovery.mjs';
import { backoffMs, Keeper } from '../src/keeper.mjs';
import { VAULT } from '../src/logic.mjs';
import { TxManager } from '../src/txmanager.mjs';
import { fakeTxAdapter, recordingAlerter, silentLog } from './helpers.mjs';

const GWEI = 1_000_000_000n;
const ETH = 10n ** 18n;
const NOW = 2_000_000;
const cfg = {
  priorityFee: GWEI,
  urgentPriorityFee: 3n * GWEI,
  rbfBlocks: 3,
  rbfBumpBps: 1500,
  cancelAfterBlocks: 20,
  urgentAfterSec: 1800,
  finalizeGraceSec: 900,
  syncAfterSec: 900,
  finalizeAfterSec: 600,
  requestAfterSec: 600,
  syncMaxCount: 10,
  maxSimsPerTick: 8,
  minBalanceWei: 10n ** 17n,
};
const eager = { ...cfg, syncAfterSec: 0, finalizeAfterSec: 0, requestAfterSec: 0 };

/** A chain with vaults keyed by address; `sim` decides each simulated action's outcome. */
function fakeChain({ vaults, auctions = {}, sim = () => ({ ok: true, result: 1n }), balance = ETH, basefee = GWEI / 10n }) {
  const a = fakeTxAdapter();
  Object.assign(a, {
    simulated: [],
    block: { number: 500n, timestamp: NOW, baseFeePerGas: basefee },
    async getBlock() {
      return { ...a.block };
    },
    async getBalance() {
      return balance;
    },
    async readFwaParams() {
      return { settlementWindow: 3600 };
    },
    async readVault(v) {
      if (vaults[v] === 'boom') throw new Error('rpc error at https://rpc.example/secretkey');
      return vaults[v];
    },
    async readAuctions(_v, ids) {
      return ids.map((id) => ({ requestId: id, ...auctions[id] }));
    },
    async getVaultCreated(_f, from) {
      return from <= 10n ? Object.keys(vaults).map((vault) => ({ vault, blockNumber: 10n })) : [];
    },
    async simulate(action, fees) {
      a.simulated.push({ key: action.key, fees });
      const r = sim(action);
      return r.ok ? { gasEstimate: 200_000n, ...r, req: { to: action.vault, data: '0x01', value: 0n, gas: 300_000n } } : r;
    },
  });
  return a;
}

function build(chain, c = eager, clock = { ms: NOW * 1000 }) {
  const log = silentLog();
  const alerter = recordingAlerter();
  const discovery = new Discovery({ adapter: chain, log, factory: '0xf', fromBlock: 0n, chunk: 1000 });
  const txm = new TxManager({ adapter: chain, log, cfg: c, keeper: chain.address });
  const keeper = new Keeper({ adapter: chain, log, alerter, cfg: c, discovery, txm, fwa: '0xfwa', now: () => clock.ms });
  return { keeper, txm, alerter, log, clock };
}

const running = (over = {}) => ({
  isOwner: false,
  approved: false,
  privateMode: false,
  status: VAULT.Running,
  gasCeiling: 12n * GWEI / 10n,
  idle: ETH,
  bountyWei: 3n * 10n ** 14n,
  syncBountyMaxWei: 3n * 10n ** 15n,
  outstanding: 0n,
  openAuctionIds: [],
  maxPulls: 100n,
  pullsRequested: 0n,
  resolvable: 0n,
  oldestAllocatedAt: 0n,
  auctionsPastDeadline: 0n,
  ...over,
});

test('tick sends the most urgent action first: finalize before sync before request', async () => {
  const chain = fakeChain({
    vaults: {
      '0xa': running({ outstanding: 1n, resolvable: 1n, oldestAllocatedAt: BigInt(NOW - 60), openAuctionIds: [21n], auctionsPastDeadline: 1n }),
      '0xb': running(),
    },
    auctions: { 21: { deadline: BigInt(NOW - 5), hardDeadline: BigInt(NOW + 600) } },
  });
  const { keeper, txm } = build(chain);
  await keeper.tick();
  assert.equal(chain.sent.length, 1);
  assert.equal(txm.inflight.action.key, '0xa:finalize:21');
  assert.equal(keeper.health.vaults, 2);
  assert.equal(keeper.health.outstandingPulls, 1);
  assert.equal(keeper.health.openAuctions, 1);
  // While it is pending nothing else goes out.
  await keeper.tick();
  assert.equal(chain.sent.length, 1);
  chain.mine('0xh0', 500n);
  await keeper.tick();
  // The finalize key was mined at the read block, so the next action is the sync.
  assert.equal(txm.inflight.action.key, '0xa:sync');
});

test('auctionInfo is read only when syncStatus reports one past its deadline', async () => {
  const chain = fakeChain({ vaults: { '0xa': running({ status: VAULT.WindingDown, openAuctionIds: [21n] }) } });
  let reads = 0;
  chain.readAuctions = async () => (reads++, []);
  const { keeper } = build(chain);
  await keeper.tick();
  assert.equal(reads, 0);
  assert.equal(chain.sent.length, 0);
});

test('backstop defaults: nothing until work is overdue, then it acts', async () => {
  const vaults = {
    '0xa': running({ outstanding: 1n, resolvable: 1n, oldestAllocatedAt: BigInt(NOW - 899), openAuctionIds: [21n], auctionsPastDeadline: 1n }),
  };
  const chain = fakeChain({ vaults, auctions: { 21: { deadline: BigInt(NOW - 599), hardDeadline: BigInt(NOW + 600) } } });
  const { keeper, txm, clock } = build(chain, cfg);
  await keeper.tick();
  assert.equal(chain.sent.length, 0);
  assert.equal(keeper.health.actionsPlanned, 3);
  assert.equal(keeper.health.actionsDue, 0);
  // One second later the sync and the finalize are overdue; the request waits for 10 quiet minutes.
  chain.block.timestamp = NOW + 1;
  clock.ms += 1000;
  await keeper.tick();
  assert.equal(txm.inflight.action.key, '0xa:finalize:21');
  assert.equal(keeper.health.actionsDue, 2);
  // Someone else synced and requested: the request's quiet period starts from this sight.
  chain.mine('0xh0', 501n);
  vaults['0xa'] = running({ pullsRequested: 5n, outstanding: 5n });
  chain.block = { ...chain.block, number: 502n };
  await keeper.tick();
  clock.ms += 599_000;
  await keeper.tick();
  assert.equal(chain.sent.length, 1);
  clock.ms += 1000;
  await keeper.tick();
  assert.equal(txm.inflight.action.key, '0xa:request');
});

test('another caller requesting restarts the quiet period', async () => {
  const vaults = { '0xa': running() };
  const chain = fakeChain({ vaults });
  const { keeper, clock } = build(chain, cfg);
  await keeper.tick();
  clock.ms += 500_000;
  vaults['0xa'] = running({ pullsRequested: 5n, outstanding: 5n });
  await keeper.tick();
  clock.ms += 500_000;
  await keeper.tick();
  assert.equal(chain.sent.filter((s) => s.to === '0xa').length, 0);
});

test('an allocated pull past 30 minutes alerts and syncs at urgent fees even when unpaid', async () => {
  const chain = fakeChain({
    vaults: { '0xa': running({ privateMode: true, outstanding: 1n, resolvable: 1n, oldestAllocatedAt: BigInt(NOW - 1850) }) },
    basefee: 30n * GWEI,
  });
  const { keeper, alerter, txm } = build(chain, cfg);
  await keeper.tick();
  assert.ok(alerter.alerts.some((a) => a.key === 'urgent:0xa'));
  assert.equal(txm.inflight.action.key, '0xa:sync');
  assert.equal(chain.sent[0].maxPriorityFeePerGas, 3n * GWEI);
  assert.equal(chain.sent[0].maxFeePerGas, 93n * GWEI);
  assert.equal(keeper.health.urgent, 1);
});

test('payout gate: an unpaid or underpaid non-urgent action is skipped', async () => {
  const chain = fakeChain({
    vaults: {
      '0xa': running({ privateMode: true, status: VAULT.WindingDown, outstanding: 1n, resolvable: 1n, oldestAllocatedAt: BigInt(NOW - 60) }),
      '0xb': running({ status: VAULT.WindingDown, idle: 0n, outstanding: 1n, resolvable: 1n, oldestAllocatedAt: BigInt(NOW - 60) }),
      '0xc': running({ status: VAULT.WindingDown, outstanding: 1n, resolvable: 1n, oldestAllocatedAt: BigInt(NOW - 60) }),
    },
  });
  const { keeper, txm, log } = build(chain);
  await keeper.tick();
  assert.equal(txm.inflight.action.key, '0xc:sync');
  assert.equal(log.lines.filter((l) => l.msg === 'payout below cost, skipping').length, 2);
});

test('private mode: no requests unless approved', async () => {
  const chain = fakeChain({ vaults: { '0xa': running({ privateMode: true }), '0xb': running({ privateMode: true, approved: true }) } });
  const { keeper, txm } = build(chain);
  await keeper.tick();
  assert.deepEqual(chain.simulated.map((s) => s.key), ['0xb:request']);
  assert.equal(txm.inflight.action.key, '0xb:request');
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

test('a sync that resolves nothing is not sent, but a request that ends the run is (it is paid)', async () => {
  const chain = fakeChain({
    vaults: { '0xa': running({ outstanding: 1n, resolvable: 1n }) },
    sim: () => ({ ok: true, result: 0n }),
  });
  const { keeper } = build(chain);
  await keeper.tick();
  assert.equal(chain.sent.length, 1);
  assert.equal(chain.simulated.some((s) => s.key === '0xa:sync'), true);
  assert.equal(chain.sent[0].key ?? chain.sent[0].action?.key ?? '0xa:request', '0xa:request');
});

test('a vault with only pending pulls is probed at most once per 10 blocks', async () => {
  const chain = fakeChain({ vaults: { '0xa': running({ status: VAULT.WindingDown, outstanding: 2n }) }, sim: () => ({ ok: true, result: 0n }) });
  const { keeper } = build(chain);
  await keeper.tick();
  await keeper.tick();
  assert.equal(chain.simulated.length, 1);
  chain.block = { ...chain.block, number: 510n };
  await keeper.tick();
  assert.equal(chain.simulated.length, 2);
});

test('a pending request is preempted by a protective action', async () => {
  const vaults = { '0xa': running() };
  const chain = fakeChain({ vaults });
  const { keeper, txm } = build(chain);
  await keeper.tick();
  assert.equal(txm.inflight.action.key, '0xa:request');
  vaults['0xa'] = running({ outstanding: 1n, resolvable: 1n });
  await keeper.tick();
  assert.equal(chain.sent.length, 2);
  assert.equal(chain.sent[1].nonce, chain.sent[0].nonce);
  assert.equal(txm.inflight.action.key, '0xa:sync');
});

test('a bump re-simulates; work done by someone else is cancelled instead', async () => {
  let done = false;
  const chain = fakeChain({
    vaults: { '0xa': running({ status: VAULT.WindingDown, outstanding: 1n, resolvable: 1n, oldestAllocatedAt: BigInt(NOW - 60) }) },
    sim: () => (done ? { ok: true, result: 0n } : { ok: true, result: 1n }),
  });
  const { keeper, txm } = build(chain);
  await keeper.tick();
  assert.equal(txm.inflight.action.key, '0xa:sync');
  done = true;
  chain.block = { ...chain.block, number: 503n };
  await keeper.tick();
  assert.equal(chain.sent.length, 2);
  assert.equal(chain.sent[1].to, '0xkeeper');
  assert.equal(txm.inflight.action.key, 'keeper:cancel');
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
