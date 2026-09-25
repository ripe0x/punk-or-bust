// The tick: read chain state, plan, simulate, send at most one tx. Chain I/O goes through the adapter.

import {
  classifyPull,
  dedupe,
  escalations,
  feesFor,
  planVault,
  prioritize,
  PULL_AUCTIONING,
  shouldPreempt,
  VAULT,
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
      outstandingPulls: 0,
      openAuctions: 0,
      urgent: 0,
      actionsPlanned: 0,
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

  /** One vault's planner view. Idle vaults stop after the first read. */
  async readView(vault, block, fwaParams) {
    const s = await this.adapter.readVault(vault, this.keeperAddress, block.number);
    const view = {
      address: vault,
      approved: s.approved,
      status: s.status,
      gasCeiling: s.gasCeiling,
      openAuctions: s.openAuctions,
      pullsRequested: s.pullsRequested,
      maxPulls: s.maxPulls,
      pulls: [],
      auctions: [],
    };
    const auctionIds = this.discovery.auctionIds(vault);
    if (s.status === VAULT.Idle && s.outstanding.length === 0 && s.openAuctions === 0n) {
      for (const id of auctionIds) this.discovery.forgetAuction(vault, id);
      return view;
    }
    const ctx = {
      now: block.timestamp,
      blockNumber: block.number,
      selectionTimeoutBlocks: fwaParams.selectionTimeoutBlocks,
      settlementWindow: fwaParams.settlementWindow,
      urgentAfterSec: this.cfg.urgentAfterSec,
    };
    const [pulls, auctions] = await Promise.all([
      this.adapter.readPulls(this.fwa, s.outstanding, block.number),
      this.adapter.readAuctions(vault, auctionIds, block.number),
    ]);
    view.pulls = pulls.map((p) => ({ ...p, c: classifyPull(p, ctx) }));
    for (const a of auctions) {
      if (a.status === PULL_AUCTIONING) view.auctions.push(a);
      else this.discovery.forgetAuction(vault, a.requestId);
    }
    if (BigInt(view.auctions.length) < s.openAuctions) {
      this.log.warn('vault reports more open auctions than discovered', {
        vault,
        openAuctions: s.openAuctions,
        tracked: view.auctions.length,
      });
    }
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
    const fwaParams = await this._fwaParams();

    const views = [];
    const all = [...this.discovery.vaults];
    for (let i = 0; i < all.length; i += READ_CONCURRENCY) {
      const results = await Promise.allSettled(all.slice(i, i + READ_CONCURRENCY).map((v) => this.readView(v, block, fwaParams)));
      results.forEach((r, j) => {
        if (r.status === 'fulfilled') return void views.push(r.value);
        this.health.vaultErrors++;
        this.log.warn('vault read failed', { vault: all[i + j], err: errInfo(r.reason) });
      });
    }

    for (const e of escalations(views, block.timestamp, this.cfg)) {
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
    const actions = dedupe(prioritize(planned), this.txm.minedAtByKey, block.number);

    await this.act(actions, block);
    await this.checkBalance();

    const approved = views.filter((v) => v.approved);
    Object.assign(this.health, {
      lastTickAt: new Date(this.now()).toISOString(),
      lastTickMs: this.now() - t0,
      lastBlock: block.number.toString(),
      vaults: this.discovery.vaults.size,
      approvedVaults: approved.length,
      outstandingPulls: views.reduce((n, v) => n + v.pulls.length, 0),
      openAuctions: views.reduce((n, v) => n + v.auctions.length, 0),
      urgent: views.reduce((n, v) => n + v.pulls.filter((p) => p.c.urgent).length, 0),
      actionsPlanned: actions.length,
      inflight: this.txm.inflight ? { key: this.txm.inflight.action.key, nonce: this.txm.inflight.nonce } : null,
    });
    this.health.ticks++;
    this.log.debug('tick', { block: block.number, actions: actions.map((a) => a.key) });
  }

  /** Simulates actions in priority order and sends the first that does something. */
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
      if (sims++ >= this.cfg.maxSimsPerTick) break;
      const prepared = await this.prepare(action, block);
      if (!prepared) continue;
      await this.txm.send(action, prepared.req, prepared.fees, block);
      return;
    }
  }

  /** Simulation gate. Null when the call would revert or do nothing. */
  async prepare(action, block) {
    const fees = feesFor(action, block.baseFeePerGas, this.cfg);
    const sim = await this.adapter.simulate(action, fees, this.fwa);
    if (!sim.ok) {
      const err = errInfo(sim.error);
      this.log.info('simulation reverted, skipping', { action: action.key, err });
      if (action.urgent) await this.alerter.alert(`sim:${action.key}`, 'urgent action does not simulate', { action: action.key, err });
      return null;
    }
    const n = typeof sim.result === 'bigint' ? sim.result : null;
    if ((action.kind === 'sync' || action.kind === 'process') && n === 0n) {
      this.log.info('simulation resolves nothing, skipping', { action: action.key });
      if (action.urgent) await this.alerter.alert(`stuck:${action.key}`, 'urgent sync resolves nothing', { action: action.key });
      return null;
    }
    if (action.kind === 'request' && n === 0n) this.log.info('requestPulls will end the run', { vault: action.vault });
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
