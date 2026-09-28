import { describe, expect, it } from 'vitest';
import { collectionMeta } from './collections';
import { defaultMaxPullCostWei } from './runParams';

const eth = (s: string) => BigInt(Math.round(Number(s) * 1e6)) * 10n ** 12n;

describe('defaultMaxPullCostWei', () => {
  it('is 0.15 ETH when the pull price is low', () => {
    expect(defaultMaxPullCostWei(eth('0.03'))).toBe(eth('0.15'));
  });
  it('is twice the price, rounded up to 0.01 ETH, when that is larger', () => {
    expect(defaultMaxPullCostWei(eth('0.111'))).toBe(eth('0.23'));
    expect(defaultMaxPullCostWei(eth('0.2'))).toBe(eth('0.4'));
  });
});

describe('collectionMeta', () => {
  it('joins count and floor, dropping unknown parts', () => {
    expect(collectionMeta(4, eth('30'))).toBe('4 in the pool · floor ~30 ETH');
    expect(collectionMeta(undefined, eth('59.73'))).toBe('floor ~59.7 ETH');
    expect(collectionMeta(2, eth('0.123'))).toBe('2 in the pool · floor ~0.12 ETH');
    expect(collectionMeta(1, undefined)).toBe('1 in the pool');
  });
});
