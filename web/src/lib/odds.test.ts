import { describe, expect, it } from 'vitest';
import { formatOddsRatio } from './odds';

describe('formatOddsRatio', () => {
  it('is a comma-grouped 1-in-N ratio', () => {
    // 1/50000 of the weight -> 1 of 50,000
    expect(formatOddsRatio(1n, 50_000n)).toBe('1 of 50,000');
    expect(formatOddsRatio(2n, 2_469_134n)).toBe('1 of 1,234,567');
  });

  it('rounds to the nearest whole pull', () => {
    expect(formatOddsRatio(3n, 10n)).toBe('1 of 3'); // 10/3 = 3.33 -> 3
    expect(formatOddsRatio(3n, 8n)).toBe('1 of 3'); // 8/3 = 2.67 -> 3
  });

  it('clamps a sole or dominant collection to at least 1', () => {
    expect(formatOddsRatio(10n, 10n)).toBe('1 of 1');
  });

  it('is undefined when weights are missing or zero', () => {
    expect(formatOddsRatio(undefined, 10n)).toBeUndefined();
    expect(formatOddsRatio(10n, undefined)).toBeUndefined();
    expect(formatOddsRatio(0n, 10n)).toBeUndefined();
    expect(formatOddsRatio(10n, 0n)).toBeUndefined();
  });
});
