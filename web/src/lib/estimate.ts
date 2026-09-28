import { BPS } from './constants';

/**
 * Expected backing of a random pull: weightedBackingTotal / totalWeight. Selection weight is
 * inversely proportional to backing (FWAV2.sol: `weight = NUM / value`), so a listing is picked
 * with probability weight_i / totalWeight, and E[backing] = sum(weight_i * backing_i) / totalWeight
 * = weightedBackingTotal / totalWeight. See FWAV2.sol.txt lines 1434-1439 (`_expectedValue`) for
 * the same ratio used internally.
 */
export function expectedBacking(weightedBackingTotal: bigint, totalWeight: bigint): bigint {
  if (totalWeight === 0n) return 0n;
  return weightedBackingTotal / totalWeight;
}

/** Expected sell-back proceeds of a random pull: E[backing] * settlementDiscountBps / 10000. */
export function expectedSellBack(weightedBackingTotal: bigint, totalWeight: bigint, settlementDiscountBps: bigint): bigint {
  return (expectedBacking(weightedBackingTotal, totalWeight) * settlementDiscountBps) / BPS;
}

/**
 * Net ETH a pull uses from the budget: the pull price, minus the expected sell-back for the share
 * that is not kept. `keepShareBps` is the rough share of pulls expected to be kept (0 to 10000);
 * pass 0 when it is not cheaply knowable, which shows the highest (most conservative) cost.
 */
export function costPerPull(pullPriceWei: bigint, sellBackWei: bigint, keepShareBps: bigint): bigint {
  const soldShareBps = BPS - (keepShareBps < 0n ? 0n : keepShareBps > BPS ? BPS : keepShareBps);
  return pullPriceWei - (sellBackWei * soldShareBps) / BPS;
}

export interface PullRange {
  low: number;
  high: number;
}

/**
 * About how many pulls a run can make: (spend * stop%) / cost per pull, shown as a range from
 * 80% to 120% of the point estimate. Null when the estimate would not be a sensible number
 * (no cost recovery, or a 0% stop that never spends).
 */
export function estimatePullRange(spendWei: bigint, stopBps: bigint, costPerPullWei: bigint): PullRange | null {
  if (costPerPullWei <= 0n || stopBps <= 0n || spendWei <= 0n) return null;
  const budgetWei = (spendWei * stopBps) / BPS;
  const n = Number(budgetWei) / Number(costPerPullWei);
  if (!Number.isFinite(n) || n <= 0) return null;
  const low = Math.max(1, Math.floor(n * 0.8));
  const high = Math.max(low, Math.ceil(n * 1.2));
  return { low, high };
}
