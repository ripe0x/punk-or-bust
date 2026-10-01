// FWA selects a listing by weight, so a collection's pull odds are its summed listing weight over
// the pool's total weight. Expressed as a 1-in-N ratio rather than a percent, since the per-pull
// chance for a small high-backing collection rounds to <0.01% and carries no information.

/** Reciprocal weighted probability as a full comma-grouped ratio, e.g. "1 of 50,142". Undefined when
 *  weights are unavailable or the collection has no listings. */
export function formatOddsRatio(targetWeight: bigint | undefined, totalWeight: bigint | undefined): string | undefined {
  if (targetWeight === undefined || totalWeight === undefined || targetWeight === 0n || totalWeight === 0n) return undefined;
  const pulls = (totalWeight + targetWeight / 2n) / targetWeight;
  return `1 of ${(pulls < 1n ? 1n : pulls).toLocaleString('en-US')}`;
}
