import { formatUnits, parseUnits } from 'viem';

/** Trims a decimal string to at most `max` fraction digits, without rounding up. */
function trimDecimals(s: string, max: number): string {
  const [whole, frac = ''] = s.split('.');
  const cut = frac.slice(0, max).replace(/0+$/, '');
  return cut ? `${whole}.${cut}` : whole;
}

/** Formats wei as ETH with up to `max` decimals. Tiny nonzero amounts show as "<0.0001". */
export function formatEth(wei: bigint, max = 4): string {
  if (wei === 0n) return '0';
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const out = trimDecimals(formatUnits(abs, 18), max);
  if (out === '0') return `${neg ? '>-' : '<'}0.${'0'.repeat(max - 1)}1`;
  return neg ? `-${out}` : out;
}

/** Formats wei as gwei with up to `max` decimals. */
export function formatGwei(wei: bigint, max = 3): string {
  return trimDecimals(formatUnits(wei, 9), max);
}

function parseDecimal(input: string, decimals: number): bigint | null {
  const s = input.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
  const [, frac = ''] = s.split('.');
  if (frac.length > decimals) return null;
  try {
    return parseUnits(s, decimals);
  } catch {
    return null;
  }
}

/** Parses a user-typed ETH amount. Null when it is not a plain non-negative decimal. */
export function parseEthInput(input: string): bigint | null {
  return parseDecimal(input, 18);
}

/** Parses a user-typed gwei amount into wei. */
export function parseGweiInput(input: string): bigint | null {
  return parseDecimal(input, 9);
}

/** 1234 bps to "12.34%". */
export function formatBps(bps: bigint | number): string {
  const n = Number(bps);
  return `${trimDecimals((n / 100).toFixed(2), 2)}%`;
}

export function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;
}

/** Seconds to a short countdown: "1h 5m", "12m 30s", "45s". Zero or less is "ended". */
export function formatDuration(seconds: number | bigint): string {
  let s = Math.floor(Number(seconds));
  if (s <= 0) return 'ended';
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatTimestamp(seconds: bigint | number): string {
  return new Date(Number(seconds) * 1000).toLocaleString();
}

export const VAULT_STATUS = ['Idle', 'Running', 'Winding down'] as const;

export const PULL_STATUS = ['None', 'Pending', 'Kept', 'Sold', 'Forced', 'Refunded', 'Auctioning'] as const;

export const FORCED_KIND = ['None', 'Stuck NFT', 'Forced NFT', 'Forced ETH', 'Forced, unknown'] as const;

/** Vault `WindDownReason`, as a sentence fragment after "Winding down: ". */
export const WIND_DOWN_REASON = [
  'stopped by the owner',
  'the drawdown floor is reached',
  'the run deadline passed',
  'the keep target is reached',
  'the pull cap is reached',
  'the FWA pull price is above the max pull cost',
] as const;

export function windDownReasonLabel(n: number): string {
  return WIND_DOWN_REASON[n] ?? `unknown reason (${n})`;
}

export function vaultStatusLabel(n: number): string {
  return VAULT_STATUS[n] ?? `Unknown (${n})`;
}

export function pullStatusLabel(n: number): string {
  return PULL_STATUS[n] ?? `Unknown (${n})`;
}

/** Request and listing ids can be 77 digit hashes; long ones show as "#123456...7890". */
export function shortId(id: bigint | number | string): string {
  const s = String(id);
  return s.length > 12 ? `#${s.slice(0, 6)}...${s.slice(-4)}` : `#${s}`;
}
