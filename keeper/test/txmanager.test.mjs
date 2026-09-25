import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TxManager } from '../src/txmanager.mjs';
import { fakeTxAdapter, silentLog } from './helpers.mjs';

const GWEI = 1_000_000_000n;
const cfg = {
  priorityFee: GWEI,
  urgentPriorityFee: 3n * GWEI,
  rbfBlocks: 3,
  rbfBumpBps: 1500,
  cancelAfterBlocks: 20,
};
const block = (number, baseFeePerGas = GWEI / 10n) => ({ number: BigInt(number), baseFeePerGas });
const req = { to: '0xv1', data: '0xabcd', value: 0n, gas: 500_000n };
const sync = { kind: 'sync', key: '0xv1:sync', urgent: false, protective: true };

function setup() {
  const adapter = fakeTxAdapter();
  const txm = new TxManager({ adapter, log: silentLog(), cfg, keeper: adapter.address });
  return { adapter, txm };
}

test('one tx in flight; cleared when included; key remembered', async () => {
  const { adapter, txm } = setup();
  await txm.send(sync, req, { maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: GWEI }, block(100));
  assert.equal(txm.busy, true);
  assert.equal(adapter.sent[0].nonce, 7);
  await assert.rejects(txm.send(sync, req, { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, block(100)));
  assert.equal(await txm.poll(block(101)), 'waiting');
  adapter.mine('0xh0', 101n);
  assert.equal(await txm.poll(block(102)), 'cleared');
  assert.equal(txm.busy, false);
  assert.equal(txm.minedAtByKey.get('0xv1:sync'), 101n);
  assert.equal(txm.stats.mined, 1);
});

test('replace-by-fee after 3 blocks, +15% on the same nonce and calldata', async () => {
  const { adapter, txm } = setup();
  await txm.send(sync, req, { maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: GWEI }, block(100));
  assert.equal(await txm.poll(block(102)), 'waiting');
  assert.equal(await txm.poll(block(103)), 'bumped');
  const r = adapter.sent[1];
  assert.equal(r.nonce, 7);
  assert.equal(r.data, '0xabcd');
  assert.equal(r.maxFeePerGas, 2_300_000_000n);
  assert.equal(r.maxPriorityFeePerGas, 1_150_000_000n);
  // The replacement was the one included.
  adapter.mine('0xh1', 104n);
  assert.equal(await txm.poll(block(105)), 'cleared');
  assert.equal(txm.stats.replaced, 1);
});

test('a bump never undercuts current network fees', async () => {
  const { adapter, txm } = setup();
  await txm.send(sync, req, { maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: GWEI }, block(100));
  await txm.poll(block(103, 10n * GWEI));
  assert.equal(adapter.sent[1].maxFeePerGas, 21n * GWEI);
});

test('a request capped at the ceiling waits, then is cancelled with a self-transfer', async () => {
  const { adapter, txm } = setup();
  const cap = 12n * GWEI / 10n;
  const request = { kind: 'request', key: '0xv1:request', cap, protective: false };
  await txm.send(request, req, { maxFeePerGas: cap, maxPriorityFeePerGas: GWEI }, block(100));
  assert.equal(await txm.poll(block(103, 2n * GWEI)), 'waiting');
  assert.equal(adapter.sent.length, 1);
  assert.equal(await txm.poll(block(120, 2n * GWEI)), 'cancelled');
  const c = adapter.sent[1];
  assert.equal(c.to, '0xkeeper');
  assert.equal(c.data, '0x');
  assert.equal(c.nonce, 7);
  assert.ok(c.maxFeePerGas > cap);
});

test('preempt replaces a pending request with a protective call on the same nonce', async () => {
  const { adapter, txm } = setup();
  const cap = 12n * GWEI / 10n;
  await txm.send({ kind: 'request', key: '0xv1:request', cap }, req, { maxFeePerGas: cap, maxPriorityFeePerGas: GWEI }, block(100));
  await txm.preempt(sync, { ...req, data: '0x5555' }, { maxFeePerGas: GWEI / 2n, maxPriorityFeePerGas: GWEI / 4n }, block(101));
  const r = adapter.sent[1];
  assert.equal(r.nonce, 7);
  assert.equal(r.data, '0x5555');
  assert.equal(r.maxFeePerGas, 1_380_000_000n);
  assert.equal(txm.inflight.action.key, '0xv1:sync');
  assert.equal(txm.inflight.cap, null);
});

test('a failed first send leaves nothing in flight', async () => {
  const { adapter, txm } = setup();
  adapter.failNext = 'nonce too low';
  assert.equal(await txm.send(sync, req, { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }, block(100)), false);
  assert.equal(txm.busy, false);
  assert.equal(txm.stats.sendErrors, 1);
});

test('a nonce used by an untracked tx clears the slot', async () => {
  const { adapter, txm } = setup();
  await txm.send(sync, req, { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }, block(100));
  adapter.latestNonce = 8;
  assert.equal(await txm.poll(block(101)), 'cleared');
  assert.equal(txm.minedAtByKey.size, 0);
});
