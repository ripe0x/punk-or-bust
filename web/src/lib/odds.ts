// Ported from the MegaRip web app (web/src/lib/fwairOdds.ts). FWA selects a listing by weight, so a
// collection's pull odds are its summed listing weight over the pool's total weight, not its count.

/** Weighted probability as a percent, e.g. "2.54%". */
export function formatOddsPercent(targetWeight: bigint | undefined, totalWeight: bigint | undefined): string | undefined {
  if (targetWeight === undefined || totalWeight === undefined || totalWeight === 0n) return undefined;
  if (targetWeight === 0n) return '0%';
  const hundredths = (targetWeight * 10_000n + totalWeight / 2n) / totalWeight;
  if (hundredths === 0n) return '<0.01%';
  const whole = hundredths / 100n;
  const fraction = (hundredths % 100n).toString().padStart(2, '0');
  return `${whole}.${fraction}%`;
}

/** The reciprocal weighted probability, rounded to the nearest whole pull, e.g. "1 in 40" or "1 in 12K". */
export function formatOneInOdds(targetWeight: bigint | undefined, totalWeight: bigint | undefined): string | undefined {
  if (targetWeight === undefined || totalWeight === undefined || targetWeight === 0n || totalWeight === 0n) return undefined;
  const pulls = (totalWeight + targetWeight / 2n) / targetWeight;
  const units = [
    [1_000_000_000_000n, 'T'],
    [1_000_000_000n, 'B'],
    [1_000_000n, 'M'],
    [1_000n, 'K'],
  ] as const;
  const unit = units.find(([threshold]) => pulls >= threshold);
  if (unit) {
    const [threshold, suffix] = unit;
    const decimals = pulls >= threshold * 100n ? 0 : pulls >= threshold * 10n ? 1 : 2;
    const scale = 10n ** BigInt(decimals);
    const rounded = (pulls * scale + threshold / 2n) / threshold;
    const whole = rounded / scale;
    const fraction = decimals === 0 ? '' : `.${(rounded % scale).toString().padStart(decimals, '0').replace(/0+$/, '')}`;
    return `1 in ${whole}${fraction === '.' ? '' : fraction}${suffix}`;
  }
  return `1 in ${pulls.toString()}`;
}
