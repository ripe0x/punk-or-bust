// Test doubles: a silent logger, a recording alerter, and a scriptable chain adapter.

export function silentLog() {
  const lines = [];
  const rec = (level) => (msg, f) => lines.push({ level, msg, ...f });
  return { lines, debug: () => {}, info: rec('info'), warn: rec('warn'), error: rec('error') };
}

export function recordingAlerter() {
  const alerts = [];
  return { alerts, alert: async (key, msg, fields) => void alerts.push({ key, msg, fields }) };
}

/** Nonce stream and receipts: `mine(hash)` includes a sent tx and advances the latest nonce. */
export function fakeTxAdapter() {
  const a = {
    address: '0xkeeper',
    latestNonce: 7,
    sent: [],
    receipts: new Map(),
    failNext: null,
    async getNonce(tag) {
      if (tag === 'latest') return a.latestNonce;
      const pending = a.sent.filter((s) => s.nonce >= a.latestNonce).map((s) => s.nonce + 1);
      return Math.max(a.latestNonce, ...pending);
    },
    async sendTx(tx) {
      if (a.failNext) {
        const e = new Error(a.failNext);
        a.failNext = null;
        throw e;
      }
      const hash = `0xh${a.sent.length}`;
      a.sent.push({ hash, ...tx });
      return hash;
    },
    async getReceipt(hash) {
      return a.receipts.get(hash) ?? null;
    },
    mine(hash, blockNumber, status = 'success') {
      const tx = a.sent.find((s) => s.hash === hash);
      a.receipts.set(hash, { status, blockNumber, gasUsed: 100_000n });
      a.latestNonce = tx.nonce + 1;
    },
  };
  return a;
}
