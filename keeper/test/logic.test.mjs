import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyThresholds,
  bumpFees,
  dedupe,
  escalations,
  expectedCost,
  expectedPayout,
  feesFor,
  isPaid,
  planVault,
  prioritize,
  protectiveFees,
  pullFees,
  requestBatchSize,
  shouldBump,
  shouldPreempt,
  syncBounty,
  VAULT,
  worthSending,
} from '../src/logic.mjs';

const GWEI = 1_000_000_000n;
const ETH = 10n ** 18n;
const cfg = {
  priorityFee: 1n * GWEI,
  urgentPriorityFee: 3n * GWEI,
  urgentAfterSec: 1800,
  finalizeGraceSec: 900,
  syncAfterSec: 900,
  finalizeAfterSec: 600,
  requestAfterSec: 600,
  syncMaxCount: 10,
};
const eager = { ...cfg, syncAfterSec: 0, finalizeAfterSec: 0, requestAfterSec: 0 };
const NOW = 1_000_000;

function vault(over = {}) {
  return {
    address: '0xv1',
    isOwner: false,
    approved: false,
    privateMode: false,
    status: VAULT.Running,
    gasCeiling: 12n * GWEI / 10n,
    idle: ETH,
    bountyWei: 3n * 10n ** 14n,
    syncBountyMaxWei: 3n * 10n ** 15n,
    outstanding: 0n,
    resolvable: 0n,
    oldestAllocatedAt: 0n,
    openAuctions: 0n,
    auctions: [],
    pullsRequested: 0n,
    maxPulls: 100n,
    ...over,
  };
}

const auction = (requestId, deadline, hardDeadline = deadline + 600) => ({
  requestId,
  deadline: BigInt(deadline),
  hardDeadline: BigInt(hardDeadline),
});

test('isPaid: anyone but the owner in public mode, approved keepers in private mode', () => {
  assert.equal(isPaid({ isOwner: false, privateMode: false, approved: false }), true);
  assert.equal(isPaid({ isOwner: true, privateMode: false, approved: true }), false);
  assert.equal(isPaid({ isOwner: false, privateMode: true, approved: false }), false);
  assert.equal(isPaid({ isOwner: false, privateMode: true, approved: true }), true);
});

test('requestBatchSize: max 5, 32 in-flight cap, run limit', () => {
  assert.equal(requestBatchSize({ outstanding: 0, openAuctions: 0n, pullsRequested: 0n, maxPulls: 100n }), 5);
  assert.equal(requestBatchSize({ outstanding: 29, openAuctions: 0n, pullsRequested: 0n, maxPulls: 100n }), 3);
  assert.equal(requestBatchSize({ outstanding: 25, openAuctions: 5n, pullsRequested: 0n, maxPulls: 100n }), 2);
  assert.equal(requestBatchSize({ outstanding: 30, openAuctions: 2n, pullsRequested: 0n, maxPulls: 100n }), 0);
  assert.equal(requestBatchSize({ outstanding: 0, openAuctions: 0n, pullsRequested: 98n, maxPulls: 100n }), 2);
  assert.equal(requestBatchSize({ outstanding: 0, openAuctions: 0n, pullsRequested: 100n, maxPulls: 100n }), 5);
});

test('syncBounty: bountyWei rising to the max over 30 minutes after allocation', () => {
  const v = vault();
  assert.equal(syncBounty(v, NOW), v.bountyWei);
  assert.equal(syncBounty({ ...v, oldestAllocatedAt: BigInt(NOW) }, NOW), v.bountyWei);
  assert.equal(syncBounty({ ...v, oldestAllocatedAt: BigInt(NOW - 900) }, NOW), 3n * 10n ** 14n + (27n * 10n ** 14n) / 2n);
  assert.equal(syncBounty({ ...v, oldestAllocatedAt: BigInt(NOW - 5000) }, NOW), v.syncBountyMaxWei);
});

test('pullFees: gated by the ceiling, maxFee capped at it', () => {
  const ceiling = 12n * GWEI / 10n;
  assert.deepEqual(pullFees(1n * GWEI / 10n, 1n * GWEI, ceiling), { maxFeePerGas: ceiling, maxPriorityFeePerGas: 1n * GWEI });
  const f = pullFees(5n * GWEI / 10n, 1n * GWEI, ceiling);
  assert.equal(f.maxPriorityFeePerGas, 7n * GWEI / 10n);
  assert.equal(f.maxFeePerGas, ceiling);
  assert.deepEqual(pullFees(1n, 1n * GWEI, 100n * GWEI), { maxFeePerGas: 2n + GWEI, maxPriorityFeePerGas: GWEI });
  assert.equal(pullFees(ceiling, 1n * GWEI, ceiling), null);
  assert.equal(pullFees(2n * GWEI, 1n * GWEI, ceiling), null);
});

test('protectiveFees: 2x basefee + tip, urgent uses the urgent tip and 3x', () => {
  assert.deepEqual(protectiveFees(10n * GWEI, cfg), { maxFeePerGas: 21n * GWEI, maxPriorityFeePerGas: GWEI });
  assert.deepEqual(protectiveFees(10n * GWEI, cfg, true), { maxFeePerGas: 33n * GWEI, maxPriorityFeePerGas: 3n * GWEI });
});

test('expectedPayout: gas at the vault price plus bounty, capped by gas cap and idle', () => {
  const basefee = GWEI;
  const fees = protectiveFees(basefee, cfg);
  const sync = { kind: 'sync', protective: true, pay: { paid: true, gasCeiling: GWEI, idle: ETH, bounty: 10n ** 15n } };
  // Protective: price min(basefee + 2 gwei, basefee + tip, 100 gwei) = 2 gwei; the owner's 1 gwei ceiling is ignored.
  assert.equal(expectedPayout(sync, 200_000n, basefee, fees), 200_000n * 2n * GWEI + 10n ** 15n);
  assert.equal(expectedCost(200_000n, basefee, fees), 200_000n * 2n * GWEI);
  // Gas capped per function.
  assert.equal(expectedPayout(sync, 4_000_000n, basefee, fees), 3_000_000n * 2n * GWEI + 10n ** 15n);
  // Never more than idle: gas first, then bounty.
  const poor = { ...sync, pay: { ...sync.pay, idle: 200_000n * 2n * GWEI + 5n } };
  assert.equal(expectedPayout(poor, 200_000n, basefee, fees), 200_000n * 2n * GWEI + 5n);
  // Not paid: nothing.
  assert.equal(expectedPayout({ ...sync, pay: { ...sync.pay, paid: false } }, 200_000n, basefee, fees), 0n);
  // A request is paid at most the owner's ceiling.
  const req = { kind: 'request', protective: false, pay: { paid: true, gasCeiling: GWEI / 2n, idle: ETH, bounty: 0n } };
  assert.equal(expectedPayout(req, 100_000n, basefee, fees), 100_000n * (GWEI / 2n));
});

test('worthSending: payout covers cost, or urgent and protective', () => {
  const basefee = GWEI;
  const fees = protectiveFees(basefee, cfg);
  const pay = { paid: true, gasCeiling: GWEI, idle: ETH, bounty: 10n ** 14n };
  assert.equal(worthSending({ kind: 'sync', protective: true, pay }, 200_000n, basefee, fees), true);
  const unpaid = { ...pay, paid: false };
  assert.equal(worthSending({ kind: 'sync', protective: true, pay: unpaid }, 200_000n, basefee, fees), false);
  assert.equal(worthSending({ kind: 'sync', protective: true, urgent: true, pay: unpaid }, 200_000n, basefee, fees), true);
  assert.equal(worthSending({ kind: 'request', protective: false, urgent: true, pay: unpaid }, 200_000n, basefee, fees), false);
  // Above 2 gwei of tip the vault pays less than the tx costs; the bounty has to cover the gap.
  const hot = { maxFeePerGas: 10n * GWEI, maxPriorityFeePerGas: 5n * GWEI };
  const noBounty = { ...pay, bounty: 0n };
  assert.equal(worthSending({ kind: 'sync', protective: true, pay: noBounty }, 200_000n, basefee, hot), false);
});

test('bumpFees: +15% rounded up, respects fresh floor and cap', () => {
  const prev = { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n };
  assert.deepEqual(bumpFees(prev, 1500), { maxFeePerGas: 115n, maxPriorityFeePerGas: 12n });
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

test('planVault: priority order finalize > urgent sync > sync > probe > request', () => {
  const ctx = { now: NOW, basefee: GWEI / 10n, cfg: eager };
  const v1 = vault({
    address: '0xv1',
    outstanding: 1n,
    resolvable: 1n,
    oldestAllocatedAt: BigInt(NOW - 100),
    auctions: [auction(7n, NOW - 1)],
    openAuctions: 1n,
  });
  const v2 = vault({ address: '0xv2', outstanding: 2n, resolvable: 2n, oldestAllocatedAt: BigInt(NOW - 2000) });
  const v3 = vault({ address: '0xv3', outstanding: 1n });
  const actions = prioritize([v3, v2, v1].flatMap((v) => planVault(v, ctx)));
  assert.deepEqual(
    actions.map((a) => a.key),
    ['0xv1:finalize:7', '0xv2:sync', '0xv1:sync', '0xv3:sync', '0xv1:request', '0xv2:request', '0xv3:request'],
  );
  assert.equal(actions[1].urgent, true);
  assert.equal(actions[2].urgent, false);
  assert.equal(actions[3].probe, true);
  // The sync bounty follows the oldest allocation.
  assert.equal(actions[1].pay.bounty, v2.syncBountyMaxWei);
});

test('planVault: backstop thresholds come from the chain where it knows the wait', () => {
  const v = vault({
    status: VAULT.WindingDown,
    outstanding: 1n,
    resolvable: 1n,
    oldestAllocatedAt: BigInt(NOW - 100),
    auctions: [auction(1n, NOW - 10, NOW + 900), auction(2n, NOW - 10, NOW + 100), auction(3n, NOW + 10, NOW + 50)],
  });
  const actions = prioritize(planVault(v, { now: NOW, basefee: GWEI, cfg }));
  assert.deepEqual(actions.map((a) => a.key), ['0xv1:finalize:2', '0xv1:finalize:1', '0xv1:sync']);
  assert.equal(actions[0].readyAt, NOW - 10 + 600);
  assert.equal(actions[2].readyAt, NOW - 100 + 900);
  // A refund-only sync has no chain time: it is timed locally.
  const refunds = planVault(vault({ outstanding: 2n, resolvable: 1n, status: VAULT.WindingDown }), { now: NOW, basefee: GWEI, cfg });
  assert.equal(refunds[0].readyAt, undefined);
  assert.equal(refunds[0].afterSec, 900);
});

test('planVault: finalize is urgent past the grace period', () => {
  const v = vault({ status: VAULT.WindingDown, auctions: [auction(1n, NOW - 900), auction(2n, NOW - 899)] });
  const a = planVault(v, { now: NOW, basefee: GWEI, cfg });
  assert.deepEqual(a.map((x) => x.urgent), [true, false]);
});

test('planVault: request gated by the vault ceiling and private mode; protective calls are not', () => {
  const v = vault({ outstanding: 1n, resolvable: 1n, oldestAllocatedAt: BigInt(NOW - 100) });
  const high = planVault(v, { now: NOW, basefee: 50n * GWEI, cfg });
  assert.deepEqual(high.map((a) => a.kind), ['sync']);
  assert.deepEqual(feesFor(high[0], 50n * GWEI, cfg), { maxFeePerGas: 101n * GWEI, maxPriorityFeePerGas: GWEI });
  const low = planVault(v, { now: NOW, basefee: GWEI / 10n, cfg });
  assert.deepEqual(low.map((a) => a.kind), ['sync', 'request']);
  assert.equal(low[1].count, 5);
  assert.equal(low[1].pay.paid, true);

  const ctx = { now: NOW, basefee: GWEI / 10n, cfg };
  // Private mode: syncs stay open, requests only for approved keepers.
  const priv = vault({ privateMode: true, outstanding: 1n, resolvable: 1n, oldestAllocatedAt: BigInt(NOW - 100) });
  const p = planVault(priv, ctx);
  assert.deepEqual(p.map((a) => a.kind), ['sync']);
  assert.equal(p[0].pay.paid, false);
  assert.deepEqual(planVault({ ...priv, approved: true }, ctx).map((a) => [a.kind, a.pay.paid]), [['sync', true], ['request', true]]);
  assert.equal(planVault(vault({ status: VAULT.WindingDown }), ctx).length, 0);
  assert.equal(planVault(vault({ status: VAULT.Idle }), ctx).length, 0);
  assert.equal(planVault(vault({ outstanding: 30n, openAuctions: 2n, resolvable: 0n }), ctx).map((a) => a.kind).join(), 'sync');
});

test('planVault: sync batch capped by syncMaxCount', () => {
  const [s] = planVault(vault({ status: VAULT.WindingDown, outstanding: 14n, resolvable: 14n }), { now: NOW, basefee: GWEI, cfg });
  assert.equal(s.kind, 'sync');
  assert.equal(s.maxCount, 10);
});

test('applyThresholds: chain time, local first sight, urgency, and reset on new work', () => {
  const seen = new Map();
  const finalize = { key: 'f', readyAt: NOW + 10 };
  const request = { key: 'r', avail: 'pulls:3', afterSec: 600 };
  const urgent = { key: 'u', readyAt: NOW + 5000, urgent: true };
  const t0 = 5_000_000;
  assert.deepEqual(applyThresholds([finalize, request, urgent], seen, NOW, t0).map((a) => a.key), ['u']);
  assert.deepEqual(applyThresholds([finalize, request], seen, NOW + 10, t0 + 599_000).map((a) => a.key), ['f']);
  assert.deepEqual(applyThresholds([request], seen, NOW, t0 + 600_000).map((a) => a.key), ['r']);
  // Another caller requested: the quiet period starts over.
  assert.deepEqual(applyThresholds([{ ...request, avail: 'pulls:8' }], seen, NOW, t0 + 700_000), []);
  // Work that disappears is forgotten.
  applyThresholds([], seen, NOW, t0 + 800_000);
  assert.equal(seen.size, 0);
  // Zero thresholds act at once.
  assert.equal(applyThresholds([{ key: 'r', avail: 'x', afterSec: 0 }], new Map(), NOW, t0).length, 1);
});

test('dedupe: one action per key, none for a key mined at or after the read block', () => {
  const a = [{ key: 'x:sync' }, { key: 'x:sync' }, { key: 'y:sync' }, { key: 'z:sync' }];
  const mined = new Map([['x:sync', 50n], ['y:sync', 40n]]);
  assert.deepEqual(dedupe(a, mined, 50n).map((x) => x.key), ['y:sync', 'z:sync']);
});

test('escalations: an allocated pull past the urgency age and overdue auctions', () => {
  const v = vault({ oldestAllocatedAt: BigInt(NOW - 1900), auctions: [auction(5n, NOW - 900), auction(6n, NOW - 899)] });
  const e = escalations([v, vault({ address: '0xv2', oldestAllocatedAt: BigInt(NOW - 1799) })], NOW, cfg, 3600);
  assert.deepEqual(e.map((x) => x.key), ['urgent:0xv1', 'finalize:0xv1:5']);
  assert.equal(e[0].windowLeftSec, 1700);
});

test('shouldPreempt: only a pending request gives way, only to a protective action', () => {
  assert.equal(shouldPreempt({ kind: 'request' }, { protective: true }), true);
  assert.equal(shouldPreempt({ kind: 'request' }, { protective: false }), false);
  assert.equal(shouldPreempt({ kind: 'sync' }, { protective: true }), false);
  assert.equal(shouldPreempt(null, { protective: true }), false);
});
