// One in-flight transaction on the keeper's nonce stream, with replace-by-fee.

import { bumpFees, protectiveFees, pullFees, shouldBump } from './logic.mjs';
import { errInfo } from './log.mjs';

const CANCEL_GAS = 21_000n;

export class TxManager {
  /**
   * @param {object} o
   * @param {object} o.adapter chain adapter: getNonce(tag), sendTx(req), getReceipt(hash)
   * @param {string} o.keeper keeper address (cancel target)
   */
  constructor({ adapter, log, cfg, keeper }) {
    this.adapter = adapter;
    this.log = log;
    this.cfg = cfg;
    this.keeper = keeper;
    /** @type {null | {nonce:number, action:object, req:object, fees:object, cap:bigint|null, hashes:string[], firstBlock:bigint, sentBlock:bigint}} */
    this.inflight = null;
    /** Block at which each action key's last tx was included. */
    this.minedAtByKey = new Map();
    this.stats = { sent: 0, replaced: 0, mined: 0, reverted: 0, cancelled: 0, sendErrors: 0 };
    /**
     * Optional `(action, block) => Promise<boolean>`: re-simulates before a bump. False (another caller
     * did the work, or it no longer pays) gives the nonce up with a cancel instead of re-sending.
     */
    this.recheck = null;
  }

  get busy() {
    return this.inflight !== null;
  }

  /** Clears an included tx, or bumps a stale one. Call once per tick before planning. */
  async poll(block) {
    const f = this.inflight;
    if (!f) return 'idle';
    const latestNonce = await this.adapter.getNonce('latest');
    if (latestNonce > f.nonce) {
      let receipt = null;
      let hash = null;
      for (let i = f.hashes.length - 1; i >= 0 && !receipt; i--) {
        receipt = await this.adapter.getReceipt(f.hashes[i]);
        hash = f.hashes[i];
      }
      this.inflight = null;
      if (!receipt) {
        this.log.warn('nonce consumed by a tx this keeper did not track', { nonce: f.nonce, action: f.action.key });
        return 'cleared';
      }
      this.minedAtByKey.set(f.action.key, receipt.blockNumber);
      if (receipt.status === 'success') {
        this.stats.mined++;
        this.log.info('tx included', { hash, action: f.action.key, block: receipt.blockNumber, gasUsed: receipt.gasUsed });
      } else {
        this.stats.reverted++;
        this.log.warn('tx reverted', { hash, action: f.action.key, block: receipt.blockNumber });
      }
      return 'cleared';
    }

    if (!shouldBump(f.sentBlock, block.number, this.cfg.rbfBlocks)) return 'waiting';

    if (this.recheck && f.action.kind !== 'cancel') {
      let still = true;
      try {
        still = await this.recheck(f.action, block);
      } catch (e) {
        this.log.warn('recheck failed, bumping as is', { action: f.action.key, err: errInfo(e) });
      }
      if (!still) {
        this.log.info('pending tx no longer useful, cancelling', { action: f.action.key, nonce: f.nonce });
        await this.cancel(block);
        return 'cancelled';
      }
    }

    const basefee = block.baseFeePerGas;
    const fresh =
      f.action.kind === 'request'
        ? pullFees(basefee, this.cfg.priorityFee, f.cap)
        : protectiveFees(basefee, this.cfg, f.action.urgent);
    const fees = bumpFees(f.fees, this.cfg.rbfBumpBps, { cap: f.cap, fresh });
    if (fees) {
      await this._broadcast(f, f.req, fees, block, 'replaced');
      return 'bumped';
    }
    // Capped at the vault's gas ceiling: wait, then give the nonce up with a self-transfer.
    if (block.number - f.firstBlock < BigInt(this.cfg.cancelAfterBlocks)) return 'waiting';
    await this.cancel(block);
    return 'cancelled';
  }

  /** Replaces the in-flight nonce with a zero-value self-transfer. */
  async cancel(block) {
    const f = this.inflight;
    if (!f) return;
    const fees = bumpFees(f.fees, this.cfg.rbfBumpBps, { fresh: protectiveFees(block.baseFeePerGas, this.cfg, true) });
    f.action = { kind: 'cancel', key: 'keeper:cancel', urgent: true };
    f.cap = null;
    const req = { to: this.keeper, data: '0x', value: 0n, gas: CANCEL_GAS };
    await this._broadcast(f, req, fees, block, 'cancelled');
  }

  /** Sends a new tx. Callers check `busy` first. */
  async send(action, req, fees, block) {
    if (this.inflight) throw new Error('tx already in flight');
    const nonce = await this.adapter.getNonce('pending');
    const f = {
      nonce,
      action,
      req,
      fees,
      cap: action.kind === 'request' ? action.cap : null,
      hashes: [],
      firstBlock: block.number,
      sentBlock: block.number,
    };
    this.inflight = f;
    const ok = await this._broadcast(f, req, fees, block, 'sent');
    if (!ok && f.hashes.length === 0) this.inflight = null;
    return ok;
  }

  /**
   * Replaces the in-flight tx with a different action on the same nonce (a pending pull request giving
   * way to a protective call). Fees are at least a full bump over the pending ones.
   */
  async preempt(action, req, fees, block) {
    const f = this.inflight;
    if (!f) return this.send(action, req, fees, block);
    const bumped = bumpFees(f.fees, this.cfg.rbfBumpBps, { fresh: fees });
    const prevKey = f.action.key;
    f.action = action;
    f.cap = null;
    f.req = req;
    f.firstBlock = block.number;
    this.log.info('preempting pending tx', { from: prevKey, to: action.key, nonce: f.nonce });
    return this._broadcast(f, req, bumped, block, 'replaced');
  }

  async _broadcast(f, req, fees, block, stat) {
    try {
      const hash = await this.adapter.sendTx({ ...req, nonce: f.nonce, ...fees });
      f.hashes.push(hash);
      f.fees = fees;
      f.req = req;
      f.sentBlock = block.number;
      this.stats[stat]++;
      this.log.info(`tx ${stat}`, {
        hash,
        action: f.action.key,
        nonce: f.nonce,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      return true;
    } catch (e) {
      this.stats.sendErrors++;
      const info = errInfo(e);
      const m = info.message.toLowerCase();
      if (m.includes('underpriced')) {
        // Remember the attempted fees so the next bump starts above them.
        f.fees = fees;
        f.sentBlock = block.number;
      }
      this.log.warn('tx send failed', { action: f.action.key, nonce: f.nonce, err: info });
      return false;
    }
  }
}
