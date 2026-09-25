// The tick: read chain state, plan, simulate, send at most one tx. Chain I/O goes through the adapter.

import {
  applyThresholds,
  dedupe,
  escalations,
  expectedCost,
  expectedPayout,
  feesFor,
  planVault,
  prioritize,
  PROBE_EVERY_BLOCKS,
  shouldPreempt,
  worthSending,
} from './logic.mjs';
import { errInfo } from './log.mjs';

const FWA_PARAMS_TTL_MS = 10 * 60_000;
const READ_CONCURRENCY = 10;

export class Keeper {
  constructor({ adapter, log, alerter, cfg, discovery, txm, fwa, now = () => Date.now() }) {
    Object.assign(this, { adapter, log, alerter, cfg, discovery, txm, fwa, now });
    this.keeperAddress = adapter.address;
    this.fwaParams = null;
    this.fwaParamsAt = 0;
    /** Action key -> {avail, atMs}: when this keeper first saw that work (backstop thresholds). */
    this.firstSeen = new Map();
    /** Vault -> block of its last probe simulation. */
    this.lastProbe = new Map();
    // A bump re-simulates first: work another caller finished is cancelled, not re-sent.
    txm.recheck = async (action, block) => (await this.prepare(action, block)) !== null;
    this.health = {
      startedAt: new Date(now()).toISOString(),
      lastTickAt: null,
      lastTickMs: null,
      lastBlock: null,
      ticks: 0,
      tickErrors: 0,
      vaultErrors: 0,
      vaults: 0,
      approvedVaults: 0,
      privateVaults: 0,
      outstandingPulls: 0,
      openAuctions: 0,
      urgent: 0,
      actionsPlanned: 0,
      actionsDue: 0,
      balanceWei: null,
      inflight: null,
      tx: txm.stats,
    };
  }

  async _fwaParams() {
    if (!this.fwaParams || this.now() - this.fwaParamsAt > FWA_PARAMS_TTL_MS) {
      this.fwaParams = await this.adapter.readFwaParams(this.fwa);
      this.fwaParamsAt = this.now();
    }
    return this.fwaParams;
  }

  /** One vault's planner view, from its own views (`syncStatus`, `openAuctionIds`, `auctionInfo`). */
  async readView(vault, block) {
    const s = await this.adapter.readVault(vault, this.keeperAddress, block.number);
    const view = { address: vault, ...s, openAuctions: BigInt(s.openAuctionIds.length), auctions: [] };
    if (s.auctionsPastDeadline > 0n) view.auctions = await this.adapter.readAuctions(vault, s.openAuctionIds, block.number);
    return view;
  }

  async tick() {
    const t0 = this.now();
    const block = await this.adapter.getBlock();
    await this.txm.poll(block);
    try {
      await this.discovery.scan(block.number);
    } catch {
      // Logged by discovery; keep serving the vaults already known and retry the range next tick.
      this.health.scanErrors = (this.health.scanErrors ?? 0) + 1;
    }
    const { settlementWindow } = await this._fwaParams();

    const views = [];
    const all = [...this.discovery.vaults];
    for (let i = 0; i < all.length; i += READ_CONCURRENCY) {
      const results = await Promise.allSettled(all.slice(i, i + READ_CONCURRENCY).map((v) => this.readView(v, block)));
      results.forEach((r, j) => {
        if (r.status === 'fulfilled') return void views.push(r.value);
        this.health.vaultErrors++;
        this.log.warn('vault read failed', { vault: all[i + j], err: errInfo(r.reason) });
      });
    }

    for (const e of escalations(views, block.timestamp, this.cfg, settlementWindow)) {
      await this.alerter.alert(e.key, e.msg, { ...e, key: undefined });
    }

    const ctx = { now: block.timestamp, basefee: block.baseFeePerGas, cfg: this.cfg };
    const planned = [];
    for (const v of views) {
      try {
        planned.push(...planVault(v, ctx));
      } catch (e) {
        this.health.vaultErrors++;
        this.log.warn('vault plan failed', { vault: v.address, err: errInfo(e) });
      }
    }
    const deduped = dedupe(prioritize(planned), this.txm.minedAtByKey, block.number);
    const actions = applyThresholds(deduped, this.firstSeen, block.timestamp, this.now());

    await this.act(actions, block);
    await this.checkBalance();

    const approved = views.filter((v) => v.approved);
    Object.assign(this.health, {
      lastTickAt: new Date(this.now()).toISOString(),
      lastTickMs: this.now() - t0,
      lastBlock: block.number.toString(),
      vaults: this.discovery.vaults.size,
      approvedVaults: approved.length,
      privateVaults: views.filter((v) => v.privateMode).length,
      outstandingPulls: views.reduce((n, v) => n + Number(v.outstanding), 0),
      openAuctions: views.reduce((n, v) => n + v.openAuctionIds.length, 0),
      urgent: views.filter((v) => v.oldestAllocatedAt > 0n && block.timestamp - Number(v.oldestAllocatedAt) >= this.cfg.urgentAfterSec).length,
      actionsPlanned: deduped.length,
      actionsDue: actions.length,
      inflight: this.txm.inflight ? { key: this.txm.inflight.action.key, nonce: this.txm.inflight.nonce } : null,
    });
    this.health.ticks++;
    this.log.debug('tick', { block: block.number, actions: actions.map((a) => a.key) });
  }

  /** Simulates actions in priority order and sends the first that does something and pays for itself. */
  async act(actions, block) {
    if (actions.length === 0) return;
    if (this.txm.busy) {
      if (!shouldPreempt(this.txm.inflight.action, actions[0])) return;
      const prepared = await this.prepare(actions[0], block);
      if (prepared) await this.txm.preempt(actions[0], prepared.req, prepared.fees, block);
      return;
    }
    let sims = 0;
    for (const action of actions) {
      if (action.probe) {
        const last = this.lastProbe.get(action.vault);
        if (last !== undefined && block.number - last < PROBE_EVERY_BLOCKS) continue;
        this.lastProbe.set(action.vault, block.number);
      }
      if (sims++ >= this.cfg.maxSimsPerTick) break;
      const prepared = await this.prepare(action, block);
      if (!prepared) continue;
      await this.txm.send(action, prepared.req, prepared.fees, block);
      return;
    }
  }

  /**
   * Simulation and payout gate, at the latest block, immediately before every send and bump. Null when
   * the call would revert, do nothing, or cost more than the vault pays (urgent protective calls excepted).
   */
  async prepare(action, block) {
    const fees = feesFor(action, block.baseFeePerGas, this.cfg);
    const sim = await this.adapter.simulate(action, fees);
    if (!sim.ok) {
      const err = errInfo(sim.error);
      this.log.info('simulation reverted, skipping', { action: action.key, err });
      if (action.urgent) await this.alerter.alert(`sim:${action.key}`, 'urgent action does not simulate', { action: action.key, err });
      return null;
    }
    const n = typeof sim.result === 'bigint' ? sim.result : null;
    if (action.kind === 'sync' && n === 0n) {
      if (!action.probe) this.log.info('simulation resolves nothing, skipping', { action: action.key });
      if (action.urgent) await this.alerter.alert(`stuck:${action.key}`, 'urgent sync resolves nothing', { action: action.key });
      return null;
    }
    // A request that returns 0 without reverting ends the run; the vault pays it like a pull.
    const gas = sim.gasEstimate ?? sim.req.gas;
    const basefee = block.baseFeePerGas;
    if (!worthSending(action, gas, basefee, fees)) {
      this.log.info('payout below cost, skipping', {
        action: action.key,
        payoutWei: expectedPayout(action, gas, basefee, fees),
        costWei: expectedCost(gas, basefee, fees),
      });
      return null;
    }
    return { req: sim.req, fees };
  }

  async checkBalance() {
    try {
      const bal = await this.adapter.getBalance(this.keeperAddress);
      this.health.balanceWei = bal.toString();
      if (bal < this.cfg.minBalanceWei) {
        await this.alerter.alert('low-balance', 'keeper balance below threshold', {
          keeper: this.keeperAddress,
          balanceWei: bal,
          minBalanceWei: this.cfg.minBalanceWei,
        });
      }
    } catch (e) {
      this.log.warn('balance read failed', { err: errInfo(e) });
    }
  }
}

/** Runs ticks forever. A failed tick backs off exponentially up to a minute; the loop never exits. */
export async function runLoop(keeper, { pollMs, log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), signal }) {
  let failures = 0;
  while (!signal?.aborted) {
    try {
      await keeper.tick();
      failures = 0;
    } catch (e) {
      failures++;
      keeper.health.tickErrors++;
      log.error('tick failed', { failures, err: errInfo(e) });
    }
    await sleep(backoffMs(pollMs, failures));
  }
}

export function backoffMs(pollMs, failures) {
  if (failures === 0) return pollMs;
  return Math.min(pollMs * 2 ** Math.min(failures, 10), 60_000);
}
