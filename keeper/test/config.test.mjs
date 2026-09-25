import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, publicConfig, redactUrl } from '../src/config.mjs';
import { createAlerter, createLogger, errInfo, scrub } from '../src/log.mjs';
import { healthPayload } from '../src/health.mjs';
import { silentLog } from './helpers.mjs';

const KEY = '0x' + '11'.repeat(32);
const base = { RPC_URL: 'https://rpc.example.org/v2/abcdef', KEEPER_PRIVATE_KEY: KEY, FACTORY: '0x' + '22'.repeat(20) };

test('redactUrl keeps scheme and host only', () => {
  assert.equal(redactUrl('https://rpc.example.org/v2/abcdef'), 'https://rpc.example.org/***');
  assert.equal(redactUrl('https://rpc.example.org/?apikey=abc'), 'https://rpc.example.org/***');
  assert.equal(redactUrl('https://user:pw@rpc.example.org'), 'https://rpc.example.org/***');
  assert.equal(redactUrl('http://127.0.0.1:8545'), 'http://127.0.0.1:8545');
  assert.equal(redactUrl('not a url'), '<invalid url>');
});

test('scrub and errInfo remove keys embedded in RPC error text', () => {
  assert.equal(scrub('failed: URL: https://rpc.example.org/v2/abcdef body'), 'failed: URL: https://rpc.example.org/*** body');
  const info = errInfo(Object.assign(new Error('long'), { shortMessage: 'HTTP 429 from wss://node.example/ws/key123' }));
  assert.equal(info.message, 'HTTP 429 from wss://node.example/***');
});

test('loadConfig: defaults and validation', () => {
  const cfg = loadConfig(base);
  assert.equal(cfg.pollMs, 4000);
  assert.equal(cfg.port, 8080);
  assert.equal(cfg.priorityFee, 1_000_000_000n);
  assert.equal(cfg.urgentAfterSec, 1800);
  assert.equal(cfg.syncAfterSec, 900);
  assert.equal(cfg.finalizeAfterSec, 600);
  assert.equal(cfg.requestAfterSec, 600);
  assert.equal(cfg.finalizeGraceSec, 900);
  assert.equal(cfg.sendRpcUrl, null);
  assert.equal(loadConfig({ ...base, SYNC_AFTER_S: '0', FINALIZE_AFTER_S: '0', REQUEST_AFTER_S: '0' }).requestAfterSec, 0);
  assert.throws(() => loadConfig({ ...base, SEND_RPC_URL: 'ws://relay' }), /SEND_RPC_URL/);
  assert.equal(cfg.fromBlock, 0n);
  assert.throws(() => loadConfig({ ...base, RPC_URL: '' }), /RPC_URL/);
  assert.throws(() => loadConfig({ ...base, KEEPER_PRIVATE_KEY: '0x12' }), /KEEPER_PRIVATE_KEY/);
  assert.throws(() => loadConfig({ ...base, FACTORY: 'nope' }), /FACTORY/);
  assert.throws(() => loadConfig({ ...base, POLL_MS: '-1' }), /POLL_MS/);
  assert.equal(loadConfig({ ...base, FROM_BLOCK: '123', MIN_BALANCE_WEI: '5' }).minBalanceWei, 5n);
});

test('publicConfig and the logger never print the key or the RPC path', () => {
  const lines = [];
  const log = createLogger({ write: (l) => lines.push(l) });
  const cfg = loadConfig({ ...base, ALERT_WEBHOOK_URL: 'https://hooks.example/T0/secret', SEND_RPC_URL: 'https://relay.example/fast?key=relaykey' });
  log.info('start', { config: publicConfig(cfg), url: base.RPC_URL });
  const out = lines.join('\n');
  assert.ok(!out.includes('11111111'));
  assert.ok(!out.includes('abcdef'));
  assert.ok(!out.includes('secret'));
  assert.ok(!out.includes('relaykey'));
  assert.ok(out.includes('https://relay.example/***'));
  assert.ok(out.includes('https://rpc.example.org/***'));
});

test('alerter: webhook at most once per key per cooldown', async () => {
  let t = 0;
  const calls = [];
  const alerter = createAlerter({
    log: silentLog(),
    webhook: 'https://hooks.example/x',
    cooldownMs: 1000,
    now: () => t,
    fetchImpl: async (url, init) => (calls.push(JSON.parse(init.body)), { ok: true }),
  });
  await alerter.alert('k', 'm', { n: 1n });
  await alerter.alert('k', 'm');
  t = 1000;
  await alerter.alert('k', 'm');
  await alerter.alert('other', 'm');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].n, '1');
});

test('health payload goes stale after 5 poll intervals (min 60s)', () => {
  const at = Date.parse('2026-01-01T00:00:00Z');
  const h = { lastTickAt: new Date(at).toISOString(), ticks: 3 };
  assert.equal(healthPayload(h, 4000, at + 59_000).ok, true);
  assert.equal(healthPayload(h, 4000, at + 61_000).ok, false);
  assert.equal(healthPayload({ lastTickAt: null }, 4000, at).ok, false);
});
