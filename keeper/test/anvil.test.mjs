// Adapter smoke test against a local anvil. Skipped when anvil is not on PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createChainAdapter } from '../src/chain.mjs';

const hasAnvil = spawnSync('anvil', ['--version']).status === 0;
// anvil's first default dev account; a public test key with no value anywhere.
const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

test('chain adapter: block, nonce, send, receipt, empty logs, simulate revert', { skip: !hasAnvil }, async (t) => {
  const port = 18545 + Math.floor(Math.random() * 1000);
  const anvil = spawn('anvil', ['--port', String(port), '--silent']);
  t.after(() => anvil.kill());
  const rpcUrl = `http://127.0.0.1:${port}`;
  let adapter;
  for (let i = 0; i < 50 && !adapter; i++) {
    try {
      adapter = await createChainAdapter({ rpcUrl, privateKey: DEV_KEY });
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.ok(adapter, 'anvil did not start');
  const block = await adapter.getBlock();
  assert.equal(typeof block.timestamp, 'number');
  const nonce = await adapter.getNonce('latest');
  const hash = await adapter.sendTx({
    to: adapter.address,
    data: '0x',
    value: 0n,
    gas: 21_000n,
    nonce,
    maxFeePerGas: 2n * block.baseFeePerGas + 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  let receipt = null;
  for (let i = 0; i < 50 && !receipt; i++) {
    receipt = await adapter.getReceipt(hash);
    if (!receipt) await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(receipt.status, 'success');
  assert.equal(await adapter.getNonce('latest'), nonce + 1);
  assert.equal(await adapter.getReceipt('0x' + '00'.repeat(32)), null);
  assert.deepEqual(await adapter.getVaultCreated('0x' + '22'.repeat(20), 0n, 1n), []);
  const sim = await adapter.simulate({ kind: 'sync', vault: '0x' + '33'.repeat(20), maxCount: 1 }, {}, '0x' + '44'.repeat(20));
  assert.equal(sim.ok, false);
});
