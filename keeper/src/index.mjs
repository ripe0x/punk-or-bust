// Entry point: node src/index.mjs (config from the environment, see README).

import { createChainAdapter } from './chain.mjs';
import { loadConfig, publicConfig } from './config.mjs';
import { Discovery } from './discovery.mjs';
import { startHealthServer } from './health.mjs';
import { Keeper, runLoop } from './keeper.mjs';
import { createAlerter, createLogger, errInfo } from './log.mjs';
import { TxManager } from './txmanager.mjs';

const log = createLogger();

async function main() {
  const cfg = loadConfig(process.env);
  delete process.env.KEEPER_PRIVATE_KEY;
  log.info('keeper starting', { config: publicConfig(cfg) });

  const adapter = await createChainAdapter({ rpcUrl: cfg.rpcUrl, privateKey: cfg.privateKey });
  cfg.privateKey = undefined;
  const fwa = await adapter.readFactoryFwa(cfg.factory);
  log.info('connected', { chainId: adapter.chainId, keeper: adapter.address, factory: cfg.factory, fwa });

  const alerter = createAlerter({ log, webhook: cfg.webhook, cooldownMs: cfg.alertCooldownMs });
  const discovery = new Discovery({
    adapter,
    log,
    factory: cfg.factory,
    fromBlock: cfg.fromBlock,
    chunk: cfg.logChunk,
    cursorFile: cfg.cursorFile,
    chainId: adapter.chainId,
  });
  const txm = new TxManager({ adapter, log, cfg, keeper: adapter.address });
  const keeper = new Keeper({ adapter, log, alerter, cfg, discovery, txm, fwa });

  const controller = new AbortController();
  const server = startHealthServer({ port: cfg.port, getHealth: () => keeper.health, pollMs: cfg.pollMs, log });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log.info('shutting down', { signal: sig });
      controller.abort();
      server.close();
      setTimeout(() => process.exit(0), 100).unref();
    });
  }
  await runLoop(keeper, { pollMs: cfg.pollMs, log, signal: controller.signal });
}

process.on('unhandledRejection', (e) => log.error('unhandled rejection', { err: errInfo(e) }));

main().catch((e) => {
  log.error('fatal startup error', { err: errInfo(e) });
  process.exit(1);
});
