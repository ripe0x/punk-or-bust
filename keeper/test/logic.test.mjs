import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACQ,
  bumpFees,
  cheapEnough,
  classifyPull,
  dedupe,
  escalations,
  feesFor,
  planVault,
  prioritize,
  protectiveFees,
  PULL_AUCTIONING,
  pullFees,
  requestBatchSize,
  shouldBump,
  shouldPreempt,
  VAULT,
} from '../src/logic.mjs';

const GWEI = 1_000_000_000n;
const cfg = {
  priorityFee: 1n * GWEI,
  urgentPriorityFee: 3n * GWEI,
  permissionlessMaxFee: 2n * GWEI,
  urgentAfterSec: 1800,
  finalizeGraceSec: 300,
  syncMaxCount: 10,
};
const NOW = 1_000_000;
const pctx = { now: NOW, blockNumber: 1000n, selectionTimeoutBlocks: 50n, settlementWindow: 3600, urgentAfterSec: 1800 };

const allocated = (age) => ({ acqStatus: ACQ.Fulfilled, requestBlock: 900n, listingStatus: 2, allocatedAt: NOW - age });
const pull = (requestId, raw) => ({ requestId, ...raw, c: classifyPull(raw, pctx) });

function vault(over = {}) {
  return {
    address: '0xv1',
    approved: true,
    status: VAULT.Running,
    gasCeiling: 12n * GWEI / 10n,
    pulls: [],
    openAuctions: 0n,
    auctions: [],
    pullsRequested: 0n,
    maxPulls: 100n,
    ...over,
  };
}

test('classifyPull: allocated, urgency and window left', () => {
  const fresh = classifyPull(allocated(600), pctx);
  assert.equal(fresh.state, 'allocated');
  assert.equal(fresh.urgent, false);
  assert.equal(fresh.windowLeftSec, 3000);
  const old = classifyPull(allocated(1800), pctx);
  assert.equal(old.urgent, true);
  assert.equal(old.ageSec, 1800);
});

test('classifyPull: forced, refunded, processing and waiting', () => {
  assert.equal(classifyPull({ acqStatus: ACQ.Fulfilled, listingStatus: 4, requestBlock: 0n }, pctx).state, 'forced');
  assert.equal(classifyPull({ acqStatus: ACQ.Expired, requestBlock: 0n }, pctx).state, 'refunded');
  assert.equal(classifyPull({ acqStatus: ACQ.Refunded, requestBlock: 0n }, pctx).state, 'refunded');
  assert.equal(classifyPull({ acqStatus: ACQ.Ready, requestBlock: 990n }, pctx).state, 'needsProcess');
  assert.equal(classifyPull({ acqStatus: ACQ.TimedOut, requestBlock: 990n }, pctx).state, 'needsProcess');
  assert.equal(classifyPull({ acqStatus: ACQ.Pending, requestBlock: 990n }, pctx).state, 'waiting');
  assert.equal(classifyPull({ acqStatus: ACQ.Pending, requestBlock: 949n }, pctx).state, 'needsProcess');
  assert.equal(classifyPull({ acqStatus: ACQ.Pending, requestBlock: 950n }, pctx).state, 'waiting');
});

test('requestBatchSize: max 5, 32 in-flight cap, run limit', () => {
  assert.equal(requestBatchSize({ outstanding: 0, openAuctions: 0n, pullsRequested: 0n, maxPulls: 100n }), 5);
  assert.equal(requestBatchSize({ outstanding: 29, openAuctions: 0n, pullsRequested: 0n, maxPulls: 100n }), 3);
  assert.equal(requestBatchSize({ outstanding: 25, openAuctions: 5n, pullsRequested: 0n, maxPulls: 100n }), 2);
  assert.equal(requestBatchSize({ outstanding: 30, openAuctions: 2n, pullsRequested: 0n, maxPulls: 100n }), 0);
  assert.equal(requestBatchSize({ outstanding: 0, openAuctions: 0n, pullsRequested: 98n, maxPulls: 100n }), 2);
  // At the run limit a call still goes out: the contract ends the run instead of pulling.
  assert.equal(requestBatchSize({ outstanding: 0, openAuctions: 0n, pullsRequested: 100n, maxPulls: 100n }), 5);
});

test('pullFees: gated by the ceiling, maxFee capped at it', () => {
  const ceiling = 12n * GWEI / 10n;
  assert.deepEqual(pullFees(1n * GWEI / 10n, 1n * GWEI, ceiling), {
    maxFeePerGas: ceiling,
    maxPriorityFeePerGas: 1n * GWEI,
  });
  // Tip shrinks to fit: basefee 0.5 gwei leaves 0.7 gwei under a 1.2 gwei ceiling.
  const f = pullFees(5n * GWEI / 10n, 1n * GWEI, ceiling);
  assert.equal(f.maxPriorityFeePerGas, 7n * GWEI / 10n);
  assert.equal(f.maxFeePerGas, ceiling);
  // Low basefee: 2x base + tip under the ceiling.
  assert.deepEqual(pullFees(1n, 1n * GWEI, 100n * GWEI), { maxFeePerGas: 2n + GWEI, maxPriorityFeePerGas: GWEI });
  assert.equal(pullFees(ceiling, 1n * GWEI, ceiling), null);
  assert.equal(pullFees(2n * GWEI, 1n * GWEI, ceiling), null);
});

test('protectiveFees: 2x basefee + tip, urgent uses the urgent tip and 3x', () => {
  assert.deepEqual(protectiveFees(10n * GWEI, cfg), { maxFeePerGas: 21n * GWEI, maxPriorityFeePerGas: GWEI });
  assert.deepEqual(protectiveFees(10n * GWEI, cfg, true), { maxFeePerGas: 33n * GWEI, maxPriorityFeePerGas: 3n * GWEI });
});

test('bumpFees: +15% rounded up, respects fresh floor and cap', () => {
  const prev = { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n };
  assert.deepEqual(bumpFees(prev, 1500), { maxFeePerGas: 115n, maxPriorityFeePerGas: 12n });
  assert.deepEqual(bumpFees({ maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: GWEI }, 1500), {
    maxFeePerGas: 2_300_000_000n,
    maxPriorityFeePerGas: 1_150_000_000n,
  });
  assert.deepEqual(bumpFees(prev, 1500, { fresh: { maxFeePerGas: 500n, maxPriorityFeePerGas: 5n } }), {
    maxFeePerGas: 500n,
    maxPriorityFeePerGas: 12n,
  });
  assert.equal(bumpFees(prev, 1500, { cap: 114n }), null);
  assert.deepEqual(bumpFees(prev, 1500, { cap: 115n }), { maxFeePerGas: 115n, maxPriorityFeePerGas: 12n });
});

test('shouldBump after 3 blocks without inclusion', () => {
  assert.equal(shouldBump(100n, 102n, 3), false);
  assert.equal(shouldBump(100n, 103n, 3), true);
});

test('planVault: priority order finalize > urgent sync > sync > process > request', () => {
  const basefee = GWEI / 10n;
  const v1 = vault({
    address: '0xv1',
    pulls: [pull(1n, allocated(100))],
    auctions: [{ requestId: 7n, status: PULL_AUCTIONING, deadline: BigInt(NOW - 1), hardDeadline: BigInt(NOW + 500) }],
    openAuctions: 1n,
  });
  const v2 = vault({ address: '0xv2', pulls: [pull(2n, allocated(2000)), pull(3n, { acqStatus: ACQ.Ready, requestBlock: 999n })] });
  const v3 = vault({ address: '0xv3' });
  const ctx = { now: NOW, basefee, cfg };
  const actions = prioritize([v3, v2, v1].flatMap((v) => planVault(v, ctx)));
  assert.deepEqual(
    actions.map((a) => a.key),
    ['0xv1:finalize:7', '0xv2:sync', '0xv1:sync', 'fwa:process', '0xv1:request', '0xv2:request', '0xv3:request'],
  );
  assert.equal(actions[1].urgent, true);
  assert.equal(actions[2].urgent, false);
});

test('planVault: finalize only after deadline; earliest hard deadline first', () => {
  const v = vault({
    auctions: [
      { requestId: 1n, status: PULL_AUCTIONING, deadline: BigInt(NOW - 10), hardDeadline: BigInt(NOW + 900) },
      { requestId: 2n, status: PULL_AUCTIONING, deadline: BigInt(NOW - 10), hardDeadline: BigInt(NOW + 100) },
      { requestId: 3n, status: PULL_AUCTIONING, deadline: BigInt(NOW + 10), hardDeadline: BigInt(NOW + 50) },
      { requestId: 4n, status: 3, deadline: BigInt(NOW - 10), hardDeadline: BigInt(NOW) },
    ],
    status: VAULT.WindingDown,
  });
  const keys = prioritize(planVault(v, { now: NOW, basefee: GWEI, cfg })).map((a) => a.key);
  assert.deepEqual(keys, ['0xv1:finalize:2', '0xv1:finalize:1']);
});

test('planVault: request gated by the vault ceiling, protective calls are not', () => {
  const v = vault({ pulls: [pull(1n, allocated(100))] });
  const high = planVault(v, { now: NOW, basefee: 50n * GWEI, cfg });
  assert.deepEqual(high.map((a) => a.kind), ['sync']);
  assert.deepEqual(feesFor(high[0], 50n * GWEI, cfg), { maxFeePerGas: 101n * GWEI, maxPriorityFeePerGas: GWEI });
  const low = planVault(v, { now: NOW, basefee: GWEI / 10n, cfg });
  assert.deepEqual(low.map((a) => a.kind), ['sync', 'request']);
  assert.equal(low[1].count, 5);
});

test('planVault: request needs approval, Running and room under 32', () => {
  const ctx = { now: NOW, basefee: GWEI / 10n, cfg };
  assert.equal(planVault(vault({ approved: false }), ctx).length, 0);
  assert.equal(planVault(vault({ status: VAULT.WindingDown }), ctx).length, 0);
  assert.equal(planVault(vault({ status: VAULT.Idle }), ctx).length, 0);
  const full = vault({ pulls: Array.from({ length: 30 }, (_, i) => pull(BigInt(i), { acqStatus: ACQ.Pending, requestBlock: 999n })), openAuctions: 2n });
  assert.equal(planVault(full, ctx).length, 0);
});

test('planVault: unapproved vault gets protective calls only when cheap', () => {
  const v = vault({ approved: false, pulls: [pull(1n, allocated(100))] });
  const cheap = planVault(v, { now: NOW, basefee: GWEI / 2n, cfg });
  assert.deepEqual(cheap.map((a) => [a.kind, a.reimbursed]), [['sync', false]]);
  assert.equal(planVault(v, { now: NOW, basefee: 5n * GWEI, cfg }).length, 0);
  assert.equal(planVault(v, { now: NOW, basefee: 0n, cfg: { ...cfg, permissionlessMaxFee: 0n } }).length, 0);
  assert.equal(cheapEnough(GWEI, GWEI, 2n * GWEI), true);
  assert.equal(cheapEnough(GWEI + 1n, GWEI, 2n * GWEI), false);
});

test('planVault: sync batch capped by syncMaxCount; waiting pulls do not trigger sync', () => {
  const waiting = vault({ pulls: [pull(1n, { acqStatus: ACQ.Pending, requestBlock: 999n })], status: VAULT.WindingDown });
  assert.equal(planVault(waiting, { now: NOW, basefee: GWEI, cfg }).length, 0);
  const many = vault({ status: VAULT.WindingDown, pulls: Array.from({ length: 14 }, (_, i) => pull(BigInt(i), { acqStatus: ACQ.Expired, requestBlock: 0n })) });
  const [s] = planVault(many, { now: NOW, basefee: GWEI, cfg });
  assert.equal(s.kind, 'sync');
  assert.equal(s.maxCount, 10);
});

test('dedupe: one action per key, none for a key mined at or after the read block', () => {
  const a = [{ key: 'fwa:process' }, { key: 'fwa:process' }, { key: 'x:sync' }, { key: 'y:sync' }];
  const mined = new Map([['x:sync', 50n], ['y:sync', 40n]]);
  assert.deepEqual(dedupe(a, mined, 50n).map((x) => x.key), ['fwa:process', 'y:sync']);
});

test('escalations: urgent allocated pulls and overdue auctions', () => {
  const v = vault({
    pulls: [pull(1n, allocated(1799)), pull(2n, allocated(1900))],
    auctions: [
      { requestId: 5n, status: PULL_AUCTIONING, deadline: BigInt(NOW - 300), hardDeadline: 0n },
      { requestId: 6n, status: PULL_AUCTIONING, deadline: BigInt(NOW - 299), hardDeadline: 0n },
    ],
  });
  const e = escalations([v], NOW, cfg);
  assert.deepEqual(e.map((x) => x.key), ['urgent:0xv1:2', 'finalize:0xv1:5']);
  assert.equal(e[0].windowLeftSec, 1700);
});

test('shouldPreempt: only a pending request gives way, only to a protective action', () => {
  assert.equal(shouldPreempt({ kind: 'request' }, { protective: true }), true);
  assert.equal(shouldPreempt({ kind: 'request' }, { protective: false }), false);
  assert.equal(shouldPreempt({ kind: 'sync' }, { protective: true }), false);
  assert.equal(shouldPreempt(null, { protective: true }), false);
});
