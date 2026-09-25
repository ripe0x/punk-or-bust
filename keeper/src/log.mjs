// JSON-lines logging and rate-limited webhook alerts.

import { redactUrl } from './config.mjs';

/** Replaces every URL in a string by its redacted form: RPC errors quote the endpoint, key included. */
export function scrub(s) {
  return s.replace(/(?:https?|wss?):\/\/[^\s"'<>)]+/g, (m) => redactUrl(m));
}

/** A short, URL-free description of an error. */
export function errInfo(e) {
  if (!e) return { name: 'Error', message: 'unknown' };
  const name = e.cause?.data?.errorName || e.name || 'Error';
  return { name, message: scrub(String(e.shortMessage || e.message || e)).slice(0, 300) };
}

function jsonSafe(_k, v) {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Error) return errInfo(v);
  if (typeof v === 'string') return scrub(v);
  return v;
}

export function createLogger({ write = (line) => process.stdout.write(line + '\n'), now = () => Date.now() } = {}) {
  const emit = (level, msg, fields = {}) => {
    write(JSON.stringify({ t: new Date(now()).toISOString(), level, msg, ...fields }, jsonSafe));
  };
  return {
    debug: (msg, f) => (process.env.LOG_LEVEL === 'debug' ? emit('debug', msg, f) : undefined),
    info: (msg, f) => emit('info', msg, f),
    warn: (msg, f) => emit('warn', msg, f),
    error: (msg, f) => emit('error', msg, f),
  };
}

/**
 * Alerts log at error level at most once per key per minute and POST to the webhook at most once per key per cooldown.
 * The webhook URL is never logged.
 */
export function createAlerter({ log, webhook, cooldownMs, logCooldownMs = 60_000, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  const lastSent = new Map();
  const lastLogged = new Map();
  return {
    async alert(key, msg, fields = {}) {
      const t = now();
      const logged = lastLogged.get(key);
      if (logged === undefined || t - logged >= logCooldownMs) {
        lastLogged.set(key, t);
        log.error(msg, { alert: key, ...fields });
      }
      if (!webhook) return false;
      const prev = lastSent.get(key);
      if (prev !== undefined && t - prev < cooldownMs) return false;
      lastSent.set(key, t);
      try {
        const res = await fetchImpl(webhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: `[keeper] ${msg}`, alert: key, ...fields }, jsonSafe),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) log.warn('alert webhook rejected', { status: res.status });
        return true;
      } catch (e) {
        log.warn('alert webhook failed', { err: e?.name || 'error' });
        return false;
      }
    },
  };
}
