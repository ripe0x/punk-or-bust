import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { bidExtends, minNextBid, secondsLeft } from './auction';

describe('minNextBid', () => {
  it('opens at backstop plus 5%', () => {
    expect(minNextBid(parseEther('1'), 0n)).toBe(parseEther('1.05'));
  });
  it('steps 5% over the high bid', () => {
    expect(minNextBid(parseEther('1'), parseEther('2'))).toBe(parseEther('2.1'));
  });
  it('rounds down like the contract check', () => {
    // contract reverts when msg.value < base * 10500 / 10000
    expect(minNextBid(3n, 0n)).toBe(3n);
    expect(minNextBid(21n, 0n)).toBe(22n);
  });
});

describe('time', () => {
  it('counts down and clamps', () => {
    expect(secondsLeft(1_000n, 900)).toBe(100);
    expect(secondsLeft(1_000n, 1_200)).toBe(0);
  });
  it('knows when a bid extends', () => {
    expect(bidExtends(1_000n, 800)).toBe(true);
    expect(bidExtends(1_000n, 600)).toBe(false);
    expect(bidExtends(1_000n, 1_000)).toBe(false);
  });
});
