// Pure decision logic. No I/O: every input is a plain value, so this file is tested without an RPC.
// All amounts are bigint wei; all times are seconds (number) unless named otherwise.

/** Vault `Status`. */
export const VAULT = Object.freeze({ Idle: 0, Running: 1, WindingDown: 2 });

export const MAX_BATCH = 5;
export const MAX_OUTSTANDING = 32;

/** Vault reimbursement constants (Vault.sol). */
export const PRIORITY_CAP = 2_000_000_000n;
export const MAX_GAS_CEILING = 100_000_000_000n;
export const GAS_CAP = Object.freeze({ request: 1_500_000n, sync: 3_000_000n, finalize: 1_000_000n });
export const SYNC_BOUNTY_RAMP = 1800;

/** Action classes, most urgent first. Lower rank sorts first. */
export const RANK = Object.freeze({ finalize: 0, syncUrgent: 1, sync: 2, probe: 3, request: 4 });

/** A vault with outstanding pulls but none resolvable is probed with a simulated sync at most this often. */
export const PROBE_EVERY_BLOCKS = 10n;

const min = (a, b) => (a < b ? a : b);
const max = (a, b) => (a > b ? a : b);

/**
 * Whether the vault pays this keeper: anyone but the owner in public mode, approved keepers in
 * private mode.
 */
export function isPaid({ isOwner, privateMode, approved }) {
  return !isOwner && (!privateMode || approved);
}

/**
 * Pulls to request in one call: at most 5, never past the 32 in-flight cap, and never more than the
 * run has left (at least 1, since a zero count reverts and a call at the limit ends the run instead).
 */
export function requestBatchSize({ outstanding, openAuctions, pullsRequested, maxPulls }) {
  const inFlight = BigInt(outstanding) + BigInt(openAuctions);
  const room = BigInt(MAX_OUTSTANDING) - inFlight;
  if (room <= 0n) return 0;
  const left = BigInt(maxPulls) - BigInt(pullsRequested);
  let n = BigInt(MAX_BATCH);
  if (room < n) n = room;
  if (left > 0n && left < n) n = left;
  return Number(n);
}

/**
 * The sync bounty: `bountyWei` rising linearly to `syncBountyMaxWei` as the oldest allocated pull ages
 * from 0 to 30 minutes since FWA allocated it. `oldestAllocatedAt` 0 means none allocated.
 */
export function syncBounty({ bountyWei, syncBountyMaxWei, oldestAllocatedAt }, now) {
  const oldest = Number(oldestAllocatedAt);
  if (oldest === 0 || oldest >= now) return bountyWei;
  const age = BigInt(Math.min(now - oldest, SYNC_BOUNTY_RAMP));
  return bountyWei + ((syncBountyMaxWei - bountyWei) * age) / BigInt(SYNC_BOUNTY_RAMP);
}

/**
 * EIP-1559 fees for a protective call (sync, finalize). The vault reimburses these up to 100 gwei
 * regardless of the owner's ceiling. Urgent calls use the urgent tip and more fee headroom.
 */
export function protectiveFees(basefee, { priorityFee, urgentPriorityFee }, urgent = false) {
  const tip = urgent ? urgentPriorityFee : priorityFee;
  return { maxFeePerGas: (urgent ? 3n : 2n) * basefee + tip, maxPriorityFeePerGas: tip };
}

/**
 * EIP-1559 fees for `requestPulls`, or null when the vault's ceiling rules it out. The contract reverts a
 * non-owner call with `tx.gasprice > gasCeiling`, and `tx.gasprice = min(maxFee, basefee + tip)`, so
 * capping `maxFee` at the ceiling makes the gate hold in whatever block includes the tx.
 */
export function pullFees(basefee, priorityFee, ceiling) {
  if (basefee >= ceiling) return null;
  const tip = min(priorityFee, ceiling - basefee);
  if (tip <= 0n) return null;
  return { maxFeePerGas: min(2n * basefee + tip, ceiling), maxPriorityFeePerGas: tip };
}

/** The gas price a tx pays at this basefee: `min(maxFee, basefee + tip)`. */
export function effectiveGasPrice(basefee, fees) {
  return min(fees.maxFeePerGas, basefee + fees.maxPriorityFeePerGas);
}

/**
 * What the vault pays for this action if it does useful work: gas at
 * `min(basefee + 2 gwei, tx.gasprice, ceiling)` (100 gwei for protective calls), gas capped per
 * function, plus the bounty, never more than idle ETH. Zero when this keeper is not paid.
 * `gas` is the estimated gas of the call; the vault measures its own gas plus a 40,000 overhead,
 * which covers the intrinsic cost, so the estimate is a lower bound of what it reimburses.
 */
export function expectedPayout(action, gas, basefee, fees) {
  const p = action.pay;
  if (!p || !p.paid) return 0n;
  const ceiling = action.protective ? MAX_GAS_CEILING : p.gasCeiling;
  const price = min(min(basefee + PRIORITY_CAP, effectiveGasPrice(basefee, fees)), ceiling);
  const gasPay = min(min(gas, GAS_CAP[action.kind] ?? gas) * price, p.idle);
  return gasPay + min(p.bounty, p.idle - gasPay);
}

/** What sending costs this keeper at the current basefee. */
export function expectedCost(gas, basefee, fees) {
  return gas * effectiveGasPrice(basefee, fees);
}

/**
 * The send gate: an urgent protective call always goes; anything else only when the vault's payout
 * covers its cost.
 */
export function worthSending(action, gas, basefee, fees) {
  if (action.urgent && action.protective) return true;
  return expectedPayout(action, gas, basefee, fees) >= expectedCost(gas, basefee, fees);
}

/**
 * Replacement fees: both fields up by `bumpBps` (rounded up) and at least `fresh` when given. Returns null
 * when the bump would pass `cap` (a `requestPulls` tx is capped at the vault's gas ceiling).
 */
export function bumpFees(prev, bumpBps, { cap = null, fresh = null } = {}) {
  const up = (v) => (v * (10_000n + BigInt(bumpBps)) + 9_999n) / 10_000n;
  let maxPriorityFeePerGas = up(prev.maxPriorityFeePerGas);
  let maxFeePerGas = up(prev.maxFeePerGas);
  if (fresh) {
    maxPriorityFeePerGas = max(maxPriorityFeePerGas, fresh.maxPriorityFeePerGas);
    maxFeePerGas = max(maxFeePerGas, fresh.maxFeePerGas);
  }
  if (maxFeePerGas < maxPriorityFeePerGas) maxFeePerGas = maxPriorityFeePerGas;
  if (cap !== null && maxFeePerGas > cap) return null;
  return { maxFeePerGas, maxPriorityFeePerGas };
}

/** Replace-by-fee is due after `blocks` blocks without inclusion. */
export function shouldBump(sentBlock, currentBlock, blocks) {
  return currentBlock - sentBlock >= BigInt(blocks);
}

/**
 * A pending `requestPulls` gives way to a protective action: the nonce is replaced with the protective
 * call so a pull capped at a low gas ceiling never blocks a sync or finalize behind it.
 */
export function shouldPreempt(inflightAction, topAction) {
  return !!inflightAction && !!topAction && inflightAction.kind === 'request' && topAction.protective;
}

/**
 * Actions for one vault this tick. The keeper is a backstop: a non-urgent action becomes due only once
 * it is overdue by its threshold (`syncAfterSec`, `finalizeAfterSec`, `requestAfterSec`; 0 acts at
 * once, like a public bot). An action carries either `readyAt` (chain seconds, when the chain says
 * how long the work has waited) or `avail` plus `afterSec` (a signature of the work, timed locally by
 * `applyThresholds`).
 * @param {object} v vault view: {address, isOwner, approved, privateMode, status, gasCeiling, idle,
 *   bountyWei, syncBountyMaxWei, outstanding (count), resolvable, oldestAllocatedAt, openAuctions,
 *   auctions:[{requestId, deadline, hardDeadline}], pullsRequested, maxPulls}
 * @param {object} ctx {now, basefee, cfg}
 */
export function planVault(v, ctx) {
  const { now, basefee, cfg } = ctx;
  const out = [];
  const paid = isPaid(v);
  const pay = (bounty) => ({ paid, gasCeiling: v.gasCeiling, idle: v.idle, bounty });

  for (const a of v.auctions) {
    const deadline = Number(a.deadline);
    if (now < deadline) continue;
    out.push({
      kind: 'finalize',
      key: `${v.address}:finalize:${a.requestId}`,
      vault: v.address,
      requestId: a.requestId,
      readyAt: deadline + cfg.finalizeAfterSec,
      protective: true,
      pay: pay(v.bountyWei),
      urgent: now >= deadline + cfg.finalizeGraceSec,
      rank: RANK.finalize,
      order: Number(a.hardDeadline),
    });
  }

  const outstanding = Number(v.outstanding);
  const oldest = Number(v.oldestAllocatedAt);
  const maxCount = Math.min(outstanding, cfg.syncMaxCount);
  if (v.resolvable > 0n) {
    const urgent = oldest !== 0 && now - oldest >= cfg.urgentAfterSec;
    const sync = {
      kind: 'sync',
      key: `${v.address}:sync`,
      vault: v.address,
      maxCount,
      protective: true,
      pay: pay(syncBounty(v, now)),
      urgent,
      rank: urgent ? RANK.syncUrgent : RANK.sync,
      order: oldest || now,
    };
    // An allocated pull is timed by FWA's allocatedAt; refunds and processing only by local sight.
    if (oldest !== 0) sync.readyAt = oldest + cfg.syncAfterSec;
    else Object.assign(sync, { avail: `refund:${v.resolvable}:${outstanding}`, afterSec: cfg.syncAfterSec });
    out.push(sync);
  } else if (outstanding > 0) {
    // Every outstanding pull is `Pending` in FWA. A sync advances FWA's sequence and resolves what that
    // settles (for example a request past its word deadline); the simulation decides if it does, and
    // the keeper simulates a probe at most once per PROBE_EVERY_BLOCKS per vault.
    out.push({
      kind: 'sync',
      key: `${v.address}:sync`,
      vault: v.address,
      maxCount,
      avail: `probe:${outstanding}`,
      afterSec: cfg.syncAfterSec,
      probe: true,
      protective: true,
      pay: pay(v.bountyWei),
      urgent: false,
      rank: RANK.probe,
      order: now,
    });
  }

  // Private mode: only approved keepers (and the owner) may request pulls.
  const mayRequest = v.isOwner || !v.privateMode || v.approved;
  if (mayRequest && v.status === VAULT.Running) {
    const count = requestBatchSize({
      outstanding,
      openAuctions: v.openAuctions,
      pullsRequested: v.pullsRequested,
      maxPulls: v.maxPulls,
    });
    const fees = count > 0 ? (v.isOwner ? protectiveFees(basefee, cfg) : pullFees(basefee, cfg.priorityFee, v.gasCeiling)) : null;
    if (fees) {
      out.push({
        kind: 'request',
        key: `${v.address}:request`,
        vault: v.address,
        count,
        fees,
        cap: v.isOwner ? null : v.gasCeiling,
        // A changed pull count means someone requested: the quiet period starts over.
        avail: `pulls:${v.pullsRequested}`,
        afterSec: cfg.requestAfterSec,
        protective: false,
        pay: pay(v.bountyWei),
        urgent: false,
        rank: RANK.request,
        order: 0,
      });
    }
  }
  return out;
}

/** Most urgent first; within a class the earliest deadline or oldest allocation first. */
export function prioritize(actions) {
  return [...actions].sort((a, b) => a.rank - b.rank || a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * One action per key, and nothing for a key whose tx was included at or after the block the state was
 * read at (the read may predate it).
 */
export function dedupe(actions, minedAtByKey, readBlock) {
  const seen = new Set();
  const out = [];
  for (const a of actions) {
    if (seen.has(a.key)) continue;
    const mined = minedAtByKey.get(a.key);
    if (mined !== undefined && mined >= readBlock) continue;
    seen.add(a.key);
    out.push(a);
  }
  return out;
}

/**
 * Backstop thresholds. Urgent actions always pass. An action with `readyAt` passes once the chain time
 * reaches it. An action with `avail` passes once the same signature has been planned for `afterSec`:
 * `firstSeen` maps a key to `{avail, atMs}` and is updated in place; keys not planned this tick are
 * dropped, so work that disappears and comes back waits again.
 */
export function applyThresholds(actions, firstSeen, now, nowMs) {
  const live = new Set();
  const out = [];
  for (const a of actions) {
    live.add(a.key);
    if (a.avail !== undefined) {
      const seen = firstSeen.get(a.key);
      if (!seen || seen.avail !== a.avail) firstSeen.set(a.key, { avail: a.avail, atMs: nowMs });
    }
    if (a.urgent) {
      out.push(a);
    } else if (a.readyAt !== undefined) {
      if (now >= a.readyAt) out.push(a);
    } else if (a.avail !== undefined) {
      if (nowMs - firstSeen.get(a.key).atMs >= (a.afterSec ?? 0) * 1000) out.push(a);
    } else {
      out.push(a);
    }
  }
  for (const k of [...firstSeen.keys()]) if (!live.has(k)) firstSeen.delete(k);
  return out;
}

/** Fees for an action about to be sent. */
export function feesFor(action, basefee, cfg) {
  if (action.kind === 'request') return action.fees;
  return protectiveFees(basefee, cfg, action.urgent);
}

/**
 * Escalations for this tick: an allocated pull past the urgency age, and auctions left unfinalized past
 * their deadline plus the grace period.
 */
export function escalations(views, now, cfg, settlementWindow) {
  const out = [];
  for (const v of views) {
    const oldest = Number(v.oldestAllocatedAt ?? 0);
    if (oldest !== 0 && now - oldest >= cfg.urgentAfterSec) {
      const ageSec = now - oldest;
      out.push({
        key: `urgent:${v.address}`,
        vault: v.address,
        ageSec,
        windowLeftSec: settlementWindow - ageSec,
        msg: 'allocated pull unsettled past urgency age',
      });
    }
    for (const a of v.auctions) {
      if (now >= Number(a.deadline) + cfg.finalizeGraceSec) {
        out.push({
          key: `finalize:${v.address}:${a.requestId}`,
          vault: v.address,
          requestId: a.requestId,
          overdueSec: now - Number(a.deadline),
          msg: 'auction past deadline and not finalized',
        });
      }
    }
  }
  return out;
}
