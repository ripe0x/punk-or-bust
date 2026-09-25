import { isAddress, getAddress, type Address } from 'viem';
import { DEFAULT_BOUNTY, DEFAULT_SYNC_BOUNTY_MAX, MAX_BOUNTY, MAX_GAS_CEILING, MAX_SYNC_BOUNTY } from './constants';
import { formatEth, parseEthInput, parseGweiInput } from './format';

export interface RunForm {
  amountEth: string;
  drawdownPct: number;
  maxPullCostEth: string;
  deadline: string; // datetime-local value
  maxPulls: string;
  stopAfterKeeps: string;
}

export interface RunParams {
  maxDrawdownBps: bigint;
  maxPullCostWei: bigint;
  stopAfterKeeps: bigint;
  deadline: bigint;
  maxPulls: bigint;
}

export interface CheckedRun {
  params: RunParams | null;
  value: bigint | null;
  errors: Record<string, string>;
}

const wholeNumber = (s: string) => (/^\d+$/.test(s.trim()) ? BigInt(s.trim()) : null);

/** Local datetime-local string to unix seconds. */
export function deadlineToUnix(local: string): bigint | null {
  const ms = new Date(local).getTime();
  return Number.isFinite(ms) ? BigInt(Math.floor(ms / 1000)) : null;
}

/** Unix seconds to a datetime-local value in the browser's zone. */
export function unixToLocalInput(sec: number): string {
  const d = new Date(sec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Checks a run form against the contract rules: drawdown 0 to 100%, nonzero max pull cost and
 * max pulls, deadline in the future. `requireValue` asks for a nonzero ETH amount.
 */
export function checkRunForm(f: RunForm, nowSec: number, requireValue: boolean): CheckedRun {
  const errors: Record<string, string> = {};

  let value: bigint | null = 0n;
  if (f.amountEth.trim() !== '' || requireValue) {
    value = parseEthInput(f.amountEth);
    if (value === null) errors.amountEth = 'Enter an ETH amount.';
    else if (requireValue && value === 0n) errors.amountEth = 'A run needs some ETH.';
  }

  if (!Number.isInteger(f.drawdownPct) || f.drawdownPct < 0 || f.drawdownPct > 100) {
    errors.drawdownPct = 'Drawdown must be 0 to 100%.';
  }
  const maxPullCostWei = parseEthInput(f.maxPullCostEth);
  if (maxPullCostWei === null || maxPullCostWei === 0n) errors.maxPullCostEth = 'Enter a max pull cost above zero.';

  const deadline = deadlineToUnix(f.deadline);
  if (deadline === null) errors.deadline = 'Pick a deadline.';
  else if (deadline <= BigInt(Math.floor(nowSec))) errors.deadline = 'Deadline must be in the future.';

  const maxPulls = wholeNumber(f.maxPulls);
  if (maxPulls === null || maxPulls === 0n) errors.maxPulls = 'Max pulls must be at least 1.';

  const stopAfterKeeps = f.stopAfterKeeps.trim() === '' ? 0n : wholeNumber(f.stopAfterKeeps);
  if (stopAfterKeeps === null) errors.stopAfterKeeps = 'Use a whole number, or 0 for no limit.';

  if (Object.keys(errors).length) return { params: null, value: null, errors };
  return {
    params: {
      maxDrawdownBps: BigInt(f.drawdownPct * 100),
      maxPullCostWei: maxPullCostWei!,
      stopAfterKeeps: stopAfterKeeps!,
      deadline: deadline!,
      maxPulls: maxPulls!,
    },
    value,
    errors,
  };
}

/** Gas ceiling in gwei text to wei. Must be above 0 and at most 100 gwei. */
export function checkGasCeiling(input: string): { wei: bigint | null; error?: string } {
  const wei = parseGweiInput(input);
  if (wei === null || wei === 0n) return { wei: null, error: 'Enter a gas ceiling above 0 gwei.' };
  if (wei > MAX_GAS_CEILING) return { wei: null, error: 'Gas ceiling is at most 100 gwei.' };
  return { wei };
}

/**
 * Bounties in ETH text, checked like `setBounties`: each at or above its default, the pull and
 * finalize bounty at most 0.003 ETH, the sync max at most 0.03 ETH and at least the bounty.
 */
export function checkBounties(
  bountyText: string,
  syncMaxText: string,
): { bounty: bigint | null; syncMax: bigint | null; errors: { bounty?: string; syncMax?: string } } {
  const errors: { bounty?: string; syncMax?: string } = {};
  const bounty = parseEthInput(bountyText);
  const syncMax = parseEthInput(syncMaxText);
  if (bounty === null) errors.bounty = 'Enter an ETH amount.';
  else if (bounty < DEFAULT_BOUNTY) errors.bounty = `At least ${formatEth(DEFAULT_BOUNTY)} ETH.`;
  else if (bounty > MAX_BOUNTY) errors.bounty = `At most ${formatEth(MAX_BOUNTY)} ETH.`;
  if (syncMax === null) errors.syncMax = 'Enter an ETH amount.';
  else if (syncMax < DEFAULT_SYNC_BOUNTY_MAX) errors.syncMax = `At least ${formatEth(DEFAULT_SYNC_BOUNTY_MAX)} ETH.`;
  else if (syncMax > MAX_SYNC_BOUNTY) errors.syncMax = `At most ${formatEth(MAX_SYNC_BOUNTY)} ETH.`;
  else if (bounty !== null && syncMax < bounty) errors.syncMax = 'At least the pull and finalize bounty.';
  if (errors.bounty || errors.syncMax) return { bounty: null, syncMax: null, errors };
  return { bounty, syncMax, errors };
}

/** Parses keeper addresses separated by spaces, commas or new lines. */
export function parseAddresses(text: string): { addresses: Address[]; errors: string[] } {
  const seen = new Map<string, Address>();
  const errors: string[] = [];
  for (const part of text.split(/[\s,;]+/).filter(Boolean)) {
    if (isAddress(part, { strict: false })) seen.set(part.toLowerCase(), getAddress(part));
    else errors.push(`Not an address: ${part}`);
  }
  return { addresses: [...seen.values()], errors };
}
