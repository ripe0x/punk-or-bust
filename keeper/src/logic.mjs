// Pure decision logic. No I/O: every input is a plain value, so this file is tested without an RPC.
// All amounts are bigint wei; all times are seconds (number) unless named otherwise.

/** FWA `AcquisitionStatus` (IFWA.sol). */
export const ACQ = Object.freeze({ None: 0, Pending: 1, Fulfilled: 2, Expired: 3, Refunded: 4, Ready: 5, TimedOut: 6 });
/** FWA `ListingStatus.Allocated`. */
export const LISTING_ALLOCATED = 2;
/** Vault `Status`. */
export const VAULT = Object.freeze({ Idle: 0, Running: 1, WindingDown: 2 });
/** Vault `PullStatus.Auctioning`. */
export const PULL_AUCTIONING = 6;

export const MAX_BATCH = 5;
export const MAX_OUTSTANDING = 32;

/** Action classes, most urgent first. Lower rank sorts first. */
export const RANK = Object.freeze({ finalize: 0, syncUrgent: 1, sync: 2, process: 3, request: 4 });

/**
 * Where one outstanding pull stands, from FWA's acquisition and listing records.
 * @param {{acqStatus:number, requestBlock:bigint, listingStatus?:number, allocatedAt?:number}} p
 * @param {{now:number, blockNumber:bigint, selectionTimeoutBlocks:bigint, settlementWindow:number, urgentAfterSec:number}} ctx
 * @returns {{state:'waiting'|'needsProcess'|'allocated'|'forced'|'refunded', ageSec:number, windowLeftSec:number, urgent:boolean}}
 */
export function classifyPull(p, ctx) {
  const base = { ageSec: 0, windowLeftSec: Infinity, urgent: false };
  switch (p.acqStatus) {
    case ACQ.Fulfilled: {
      if (p.listingStatus !== LISTING_ALLOCATED) return { ...base, state: 'forced' };
      const ageSec = Math.max(0, ctx.now - Number(p.allocatedAt ?? 0));
      return {
        state: 'allocated',
        ageSec,
        windowLeftSec: ctx.settlementWindow - ageSec,
        urgent: ageSec >= ctx.urgentAfterSec,
      };
    }
    case ACQ.Expired:
    case ACQ.Refunded:
      return { ...base, state: 'refunded' };
    case ACQ.Ready:
    case ACQ.TimedOut:
      return { ...base, state: 'needsProcess' };
    case ACQ.Pending:
      // FWA only expires a pending head inside `processAcquisitions`, once its word deadline passed.
      if (ctx.blockNumber > p.requestBlock + ctx.selectionTimeoutBlocks) return { ...base, state: 'needsProcess' };
      return { ...base, state: 'waiting' };
    default:
      return { ...base, state: 'waiting' };
  }
}

/** Pulls a `sync` would resolve right now. */
export function isResolvable(c) {
  return c.state === 'allocated' || c.state === 'forced' || c.state === 'refunded';
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

const min = (a, b) => (a < b ? a : b);
const max = (a, b) => (a > b ? a : b);

/**
 * EIP-1559 fees for a protective call (sync, finalize, FWA processing). The vault reimburses these up
 * to 100 gwei regardless of the owner's ceiling. Urgent calls use the urgent tip and more fee headroom.
 */
export function protectiveFees(basefee, { priorityFee, urgentPriorityFee }, urgent = false) {
  const tip = urgent ? urgentPriorityFee : priorityFee;
  return { maxFeePerGas: (urgent ? 3n : 2n) * basefee + tip, maxPriorityFeePerGas: tip };
}

/**
 * EIP-1559 fees for `requestPulls`, or null when the vault's ceiling rules it out. The contract reverts a
 * keeper call with `tx.gasprice > gasCeiling`, and `tx.gasprice = min(maxFee, basefee + tip)`, so capping
 * `maxFee` at the ceiling makes the gate hold in whatever block includes the tx.
 */
export function pullFees(basefee, priorityFee, ceiling) {
  if (basefee >= ceiling) return null;
  const tip = min(priorityFee, ceiling - basefee);
  if (tip <= 0n) return null;
  return { maxFeePerGas: min(2n * basefee + tip, ceiling), maxPriorityFeePerGas: tip };
}

/** Whether a permissionless, unreimbursed call is cheap enough to send. `limit` 0 disables them. */
export function cheapEnough(basefee, priorityFee, limit) {
  return limit > 0n && basefee + priorityFee <= limit;
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
 * Actions for one vault this tick.
 * @param {object} v vault view: {address, approved, status, gasCeiling, pulls:[{requestId, c}], openAuctions,
 *   auctions:[{requestId, status, deadline, hardDeadline}], pullsRequested, maxPulls}
 * @param {object} ctx {now, basefee, cfg}
 */
export function planVault(v, ctx) {
  const { now, basefee, cfg } = ctx;
  const out = [];
  const permissionlessOk = cheapEnough(basefee, cfg.priorityFee, cfg.permissionlessMaxFee);
  const protectiveAllowed = v.approved || permissionlessOk;

  if (protectiveAllowed) {
    for (const a of v.auctions) {
      if (a.status !== PULL_AUCTIONING || now < Number(a.deadline)) continue;
      out.push({
        kind: 'finalize',
        key: `${v.address}:finalize:${a.requestId}`,
        vault: v.address,
        requestId: a.requestId,
        protective: true,
        reimbursed: v.approved,
        urgent: now >= Number(a.deadline) + cfg.finalizeGraceSec,
        rank: RANK.finalize,
        order: Number(a.hardDeadline),
      });
    }

    const resolvable = v.pulls.filter((p) => isResolvable(p.c));
    if (resolvable.length) {
      const urgent = resolvable.some((p) => p.c.urgent);
      const oldest = Math.min(...resolvable.map((p) => (p.c.state === 'allocated' ? now - p.c.ageSec : now)));
      out.push({
        kind: 'sync',
        key: `${v.address}:sync`,
        vault: v.address,
        maxCount: Math.min(resolvable.length, cfg.syncMaxCount),
        protective: true,
        reimbursed: v.approved,
        urgent,
        rank: urgent ? RANK.syncUrgent : RANK.sync,
        order: oldest,
      });
    }
  }

  // FWA-level, permissionless and never reimbursed: only when cheap.
  if (permissionlessOk && v.pulls.some((p) => p.c.state === 'needsProcess')) {
    out.push({
      kind: 'process',
      key: 'fwa:process',
      vault: v.address,
      protective: true,
      reimbursed: false,
      urgent: false,
      rank: RANK.process,
      order: 0,
    });
  }

  if (v.approved && v.status === VAULT.Running) {
    const count = requestBatchSize({
      outstanding: v.pulls.length,
      openAuctions: v.openAuctions,
      pullsRequested: v.pullsRequested,
      maxPulls: v.maxPulls,
    });
    const fees = count > 0 ? pullFees(basefee, cfg.priorityFee, v.gasCeiling) : null;
    if (fees) {
      out.push({
        kind: 'request',
        key: `${v.address}:request`,
        vault: v.address,
        count,
        fees,
        cap: v.gasCeiling,
        protective: false,
        reimbursed: true,
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
 * One action per key (the FWA processing action is global), and nothing for a key whose tx was included
 * at or after the block the state was read at (the read may predate it).
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

/** Fees for an action about to be sent. */
export function feesFor(action, basefee, cfg) {
  if (action.kind === 'request') return action.fees;
  return protectiveFees(basefee, cfg, action.urgent);
}

/**
 * Escalations for this tick: allocated pulls past the urgency age, and auctions left unfinalized past
 * their deadline plus the grace period.
 */
export function escalations(views, now, cfg) {
  const out = [];
  for (const v of views) {
    for (const p of v.pulls) {
      if (p.c.state === 'allocated' && p.c.urgent) {
        out.push({
          key: `urgent:${v.address}:${p.requestId}`,
          vault: v.address,
          requestId: p.requestId,
          ageSec: p.c.ageSec,
          windowLeftSec: p.c.windowLeftSec,
          msg: 'allocated pull unsettled past urgency age',
        });
      }
    }
    for (const a of v.auctions) {
      if (a.status === PULL_AUCTIONING && now >= Number(a.deadline) + cfg.finalizeGraceSec) {
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
