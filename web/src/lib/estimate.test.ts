import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { costPerPull, estimatePullRange, expectedBacking, expectedSellBack } from './estimate';

describe('expectedBacking', () => {
  it('is the harmonic-mean-driving ratio weightedBackingTotal / totalWeight', () => {
    expect(expectedBacking(parseEther('300'), 100n)).toBe(parseEther('3'));
  });
  it('is zero with no active listings', () => {
    expect(expectedBacking(0n, 0n)).toBe(0n);
  });
});

describe('expectedSellBack', () => {
  it('applies the settlement discount to expected backing', () => {
    // E[backing] = 3 ETH, 90% discount -> 2.7 ETH
    expect(expectedSellBack(parseEther('300'), 100n, 9_000n)).toBe(parseEther('2.7'));
  });
});

describe('costPerPull', () => {
  it('with keepShare 0, cost is pull price minus the full sell-back', () => {
    expect(costPerPull(parseEther('0.08'), parseEther('0.055'), 0n)).toBe(parseEther('0.025'));
  });
  it('a higher keep share raises cost since less is sold back', () => {
    const withKeeps = costPerPull(parseEther('0.08'), parseEther('0.055'), 5_000n);
    const withoutKeeps = costPerPull(parseEther('0.08'), parseEther('0.055'), 0n);
    expect(withKeeps).toBeGreaterThan(withoutKeeps);
  });
  it('clamps keepShareBps to 0..10000', () => {
    expect(costPerPull(parseEther('0.08'), parseEther('0.055'), 20_000n)).toBe(parseEther('0.08'));
  });
});

describe('estimatePullRange', () => {
  it('gives a range around spend*stop% / cost', () => {
    // budget = 1 * 30% = 0.3 ETH, cost 0.025 ETH -> point estimate 12 pulls
    const r = estimatePullRange(parseEther('1'), 3_000n, parseEther('0.025'));
    expect(r).not.toBeNull();
    expect(r!.low).toBe(Math.floor(12 * 0.8));
    expect(r!.high).toBe(Math.ceil(12 * 1.2));
    expect(r!.low).toBeLessThanOrEqual(r!.high);
  });
  it('is null when cost per pull is zero or negative', () => {
    expect(estimatePullRange(parseEther('1'), 3_000n, 0n)).toBeNull();
    expect(estimatePullRange(parseEther('1'), 3_000n, -1n)).toBeNull();
  });
  it('is null when stop% is zero (a run that never pulls)', () => {
    expect(estimatePullRange(parseEther('1'), 0n, parseEther('0.025'))).toBeNull();
  });
});
