// Vault and auction discovery from logs: paged from FROM_BLOCK, then incremental. The chain stays the
// source of truth; the optional cursor file only saves the rescan on restart.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { errInfo } from './log.mjs';

/** Re-scan this many blocks behind the head each pass so a shallow reorg cannot hide a log. */
const OVERLAP = 5n;
const ADDRESS_CHUNK = 200;

export class Discovery {
  constructor({ adapter, log, factory, fromBlock, chunk, cursorFile = null, chainId = 0 }) {
    this.adapter = adapter;
    this.log = log;
    this.factory = factory.toLowerCase();
    this.chunk = BigInt(Math.max(1, chunk));
    this.maxChunk = this.chunk;
    this.okStreak = 0;
    this.cursorFile = cursorFile;
    this.chainId = chainId;
    /** Next block to scan. */
    this.next = fromBlock;
    /** @type {Set<string>} lowercased vault addresses */
    this.vaults = new Set();
    /** @type {Map<string, Set<bigint>>} vault -> auction request ids that may still be open */
    this.auctions = new Map();
    this._load();
  }

  _load() {
    if (!this.cursorFile) return;
    try {
      const c = JSON.parse(readFileSync(this.cursorFile, 'utf8'));
      if (c.factory !== this.factory || c.chainId !== this.chainId) return;
      if (BigInt(c.next) > this.next) this.next = BigInt(c.next);
      for (const v of c.vaults) this.vaults.add(v);
      for (const [v, ids] of Object.entries(c.auctions)) this.auctions.set(v, new Set(ids.map(BigInt)));
      this.log.info('cursor loaded', { next: this.next, vaults: this.vaults.size });
    } catch (e) {
      if (e?.code !== 'ENOENT') this.log.warn('cursor unreadable, rescanning', { err: errInfo(e) });
    }
  }

  _save() {
    if (!this.cursorFile) return;
    const c = {
      chainId: this.chainId,
      factory: this.factory,
      next: this.next.toString(),
      vaults: [...this.vaults],
      auctions: Object.fromEntries([...this.auctions].map(([v, ids]) => [v, [...ids].map(String)])),
    };
    try {
      writeFileSync(this.cursorFile + '.tmp', JSON.stringify(c));
      renameSync(this.cursorFile + '.tmp', this.cursorFile);
    } catch (e) {
      this.log.warn('cursor write failed', { err: errInfo(e) });
    }
  }

  /** Scans up to `head`. A failing range halves the page and is retried on the next call. */
  async scan(head) {
    let from = this.next > OVERLAP ? this.next - OVERLAP : 0n;
    if (from > head) return;
    while (from <= head) {
      const to = from + this.chunk - 1n < head ? from + this.chunk - 1n : head;
      try {
        await this._scanRange(from, to);
      } catch (e) {
        this.okStreak = 0;
        if (this.chunk > 1n) this.chunk = this.chunk / 2n;
        this.log.warn('log scan failed, shrinking page', { from, to, chunk: this.chunk, err: errInfo(e) });
        this._save();
        throw e;
      }
      if (to + 1n > this.next) this.next = to + 1n;
      from = to + 1n;
      // Grow the page back slowly after a run of successes.
      if (this.chunk < this.maxChunk && ++this.okStreak >= 20) {
        this.okStreak = 0;
        this.chunk = this.chunk * 2n > this.maxChunk ? this.maxChunk : this.chunk * 2n;
      }
    }
    this._save();
  }

  async _scanRange(from, to) {
    for (const l of await this.adapter.getVaultCreated(this.factory, from, to)) {
      const v = l.vault.toLowerCase();
      if (!this.vaults.has(v)) {
        this.vaults.add(v);
        this.log.info('vault discovered', { vault: v, block: l.blockNumber });
      }
    }
    const all = [...this.vaults];
    for (let i = 0; i < all.length; i += ADDRESS_CHUNK) {
      for (const l of await this.adapter.getAuctionStarted(all.slice(i, i + ADDRESS_CHUNK), from, to)) {
        const v = l.vault.toLowerCase();
        if (!this.vaults.has(v)) continue;
        if (!this.auctions.has(v)) this.auctions.set(v, new Set());
        this.auctions.get(v).add(BigInt(l.requestId));
      }
    }
  }

  auctionIds(vault) {
    return [...(this.auctions.get(vault) ?? [])];
  }

  /** Forgets auctions no longer open (the chain said so). */
  forgetAuction(vault, requestId) {
    const s = this.auctions.get(vault);
    if (!s) return;
    s.delete(BigInt(requestId));
    if (s.size === 0) this.auctions.delete(vault);
  }
}
