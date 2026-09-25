// GET /health: last tick time and counts. 503 when the loop has not ticked recently.

import { createServer } from 'node:http';

export function healthPayload(health, pollMs, nowMs) {
  const last = health.lastTickAt ? Date.parse(health.lastTickAt) : null;
  const stale = last === null || nowMs - last > Math.max(pollMs * 5, 60_000);
  return { ok: !stale, ...health };
}

export function startHealthServer({ port, getHealth, pollMs, log, now = () => Date.now() }) {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || (req.url !== '/health' && req.url !== '/')) {
      res.writeHead(404).end();
      return;
    }
    const body = healthPayload(getHealth(), pollMs, now());
    res.writeHead(body.ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  });
  server.listen(port, () => log.info('health server listening', { port }));
  return server;
}
