// Configuration from the environment. Secrets are read here and never logged.

const GWEI = 1_000_000_000n;

/** Scheme and host only; any path or query (where RPC keys live) is replaced by `/***`. */
export function redactUrl(raw) {
  try {
    const u = new URL(raw);
    const hidden = (u.pathname && u.pathname !== '/') || u.search || u.hash || u.username || u.password;
    return `${u.protocol}//${u.host}${hidden ? '/***' : ''}`;
  } catch {
    return '<invalid url>';
  }
}

function bigintEnv(env, name, fallback) {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be a non-negative integer (wei)`);
  return BigInt(v);
}

function intEnv(env, name, fallback) {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be a non-negative integer`);
  return Number(v);
}

/** Parses and validates the environment. Throws with a message naming the bad variable. */
export function loadConfig(env = process.env) {
  const rpcUrl = env.RPC_URL;
  if (!rpcUrl) throw new Error('RPC_URL is required');
  const privateKey = env.KEEPER_PRIVATE_KEY;
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('KEEPER_PRIVATE_KEY must be 0x plus 64 hex chars');
  const factory = env.FACTORY;
  if (!factory || !/^0x[0-9a-fA-F]{40}$/.test(factory)) throw new Error('FACTORY must be an address');
  const webhook = env.ALERT_WEBHOOK_URL || null;
  if (webhook && !/^https?:\/\//.test(webhook)) throw new Error('ALERT_WEBHOOK_URL must be http(s)');

  return {
    rpcUrl,
    privateKey,
    factory,
    webhook,
    fromBlock: bigintEnv(env, 'FROM_BLOCK', 0n),
    pollMs: intEnv(env, 'POLL_MS', 4000),
    port: intEnv(env, 'PORT', 8080),
    minBalanceWei: bigintEnv(env, 'MIN_BALANCE_WEI', 50_000_000_000_000_000n),
    cursorFile: env.CURSOR_FILE || null,
    // Fees.
    priorityFee: bigintEnv(env, 'PRIORITY_FEE_WEI', 1n * GWEI),
    urgentPriorityFee: bigintEnv(env, 'URGENT_PRIORITY_FEE_WEI', 3n * GWEI),
    // Unreimbursed permissionless calls (unapproved vaults, FWA processing) only at or below this
    // basefee + tip. 0 disables them.
    permissionlessMaxFee: bigintEnv(env, 'PERMISSIONLESS_MAX_FEE_WEI', 2n * GWEI),
    rbfBlocks: intEnv(env, 'RBF_BLOCKS', 3),
    rbfBumpBps: intEnv(env, 'RBF_BUMP_BPS', 1500),
    cancelAfterBlocks: intEnv(env, 'CANCEL_AFTER_BLOCKS', 20),
    // Timing. FWA's live settlementWindow is 1 hour; escalate at half of it.
    urgentAfterSec: intEnv(env, 'URGENT_AFTER_SEC', 1800),
    finalizeGraceSec: intEnv(env, 'FINALIZE_GRACE_SEC', 300),
    // Work sizes.
    syncMaxCount: intEnv(env, 'SYNC_MAX_COUNT', 10),
    maxSimsPerTick: intEnv(env, 'MAX_SIMS_PER_TICK', 8),
    logChunk: intEnv(env, 'LOG_CHUNK', 5000),
    alertCooldownMs: intEnv(env, 'ALERT_COOLDOWN_MS', 15 * 60_000),
  };
}

/** The config as safe to log: no key, no webhook, RPC reduced to its host. */
export function publicConfig(cfg) {
  const { privateKey, webhook, rpcUrl, ...rest } = cfg;
  const out = { ...rest, rpc: redactUrl(rpcUrl), webhook: webhook ? 'set' : 'unset' };
  for (const [k, v] of Object.entries(out)) if (typeof v === 'bigint') out[k] = v.toString();
  return out;
}
