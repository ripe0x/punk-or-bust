import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Discovery } from '../src/discovery.mjs';
import { silentLog } from './helpers.mjs';

function adapter({ failAbove = 1e9 } = {}) {
  const a = {
    ranges: [],
    async getVaultCreated(_f, from, to) {
      if (to - from + 1n > BigInt(failAbove)) throw new Error('range too large');
      a.ranges.push([from, to]);
      return from <= 150n && 150n <= to ? [{ vault: '0xAAaa', blockNumber: 150n }] : [];
    },
    async getAuctionStarted(vaults, from, to) {
      const out = [];
      if (from <= 160n && 160n <= to) out.push({ vault: '0xaaaa', requestId: 9n, blockNumber: 160n });
      // A log from an address that is not a factory vault is ignored.
      if (from <= 170n && 170n <= to) out.push({ vault: '0xbbbb', requestId: 1n, blockNumber: 170n });
      return out;
    },
  };
  return a;
}

test('pages from FROM_BLOCK, then scans incrementally with a small overlap', async () => {
  const a = adapter();
  const d = new Discovery({ adapter: a, log: silentLog(), factory: '0xF', fromBlock: 100n, chunk: 50 });
  await d.scan(220n);
  assert.deepEqual(a.ranges, [[95n, 144n], [145n, 194n], [195n, 220n]]);
  assert.deepEqual([...d.vaults], ['0xaaaa']);
  assert.deepEqual(d.auctionIds('0xaaaa'), [9n]);
  assert.deepEqual(d.auctionIds('0xbbbb'), []);
  await d.scan(230n);
  assert.deepEqual(a.ranges.at(-1), [216n, 230n]);
  d.forgetAuction('0xaaaa', 9n);
  assert.deepEqual(d.auctionIds('0xaaaa'), []);
});

test('a failing range halves the page and resumes where it stopped', async () => {
  const a = adapter({ failAbove: 30 });
  const d = new Discovery({ adapter: a, log: silentLog(), factory: '0xf', fromBlock: 100n, chunk: 100 });
  await assert.rejects(d.scan(300n));
  await assert.rejects(d.scan(300n));
  await d.scan(300n);
  assert.equal(d.next, 301n);
  assert.deepEqual([...d.vaults], ['0xaaaa']);
});

test('cursor file restores vaults and auctions for the same factory and chain', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'keeper-')), 'cursor.json');
  const d = new Discovery({ adapter: adapter(), log: silentLog(), factory: '0xf', fromBlock: 100n, chunk: 500, cursorFile: file, chainId: 1 });
  await d.scan(300n);
  const r = new Discovery({ adapter: adapter(), log: silentLog(), factory: '0xf', fromBlock: 100n, chunk: 500, cursorFile: file, chainId: 1 });
  assert.equal(r.next, 301n);
  assert.deepEqual(r.auctionIds('0xaaaa'), [9n]);
  const other = new Discovery({ adapter: adapter(), log: silentLog(), factory: '0xf', fromBlock: 100n, chunk: 500, cursorFile: file, chainId: 5 });
  assert.equal(other.next, 100n);
});
