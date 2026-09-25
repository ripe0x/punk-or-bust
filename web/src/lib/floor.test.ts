import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { affordablePulls, floorBar, pullFee, runFloor } from './floor';

describe('runFloor', () => {
  it('matches the contract formula', () => {
    expect(runFloor(parseEther('10'), 2_500n)).toBe(parseEther('7.5'));
    expect(runFloor(parseEther('10'), 0n)).toBe(parseEther('10'));
    expect(runFloor(parseEther('10'), 10_000n)).toBe(0n);
    expect(runFloor(3n, 3_333n)).toBe(2n); // rounds down like Solidity
  });
  it('rejects out of range', () => {
    expect(() => runFloor(1n, 10_001n)).toThrow();
  });
});

describe('pullFee', () => {
  it('is 250 ppm', () => {
    expect(pullFee(parseEther('1'))).toBe(parseEther('0.00025'));
    expect(pullFee(3999n)).toBe(0n);
  });
});

describe('affordablePulls', () => {
  const base = { quoteTotal: parseEther('0.1'), quoteFee: parseEther('0.09') };
  it('is bounded by the floor', () => {
    // headroom 0.25, unit 0.1 + 0.0000225 -> 2
    expect(affordablePulls({ ...base, value: parseEther('1'), floor: parseEther('0.75'), idle: parseEther('1') })).toBe(2n);
  });
  it('is bounded by idle', () => {
    expect(affordablePulls({ ...base, value: parseEther('1'), floor: 0n, idle: parseEther('0.35') })).toBe(3n);
  });
  it('is zero at zero drawdown', () => {
    expect(affordablePulls({ ...base, value: parseEther('1'), floor: parseEther('1'), idle: parseEther('1') })).toBe(0n);
  });
  it('is zero with no price', () => {
    expect(affordablePulls({ value: 1n, floor: 0n, idle: 1n, quoteTotal: 0n, quoteFee: 0n })).toBe(0n);
  });
});

describe('floorBar', () => {
  it('positions value and floor', () => {
    const b = floorBar(parseEther('8'), parseEther('5'), parseEther('10'));
    expect(b.value).toBeCloseTo(0.8);
    expect(b.floor).toBeCloseTo(0.5);
    expect(b.headroom).toBe(parseEther('3'));
    expect(b.atFloor).toBe(false);
  });
  it('rescales when value is above start', () => {
    const b = floorBar(parseEther('20'), parseEther('5'), parseEther('10'));
    expect(b.value).toBe(1);
    expect(b.floor).toBeCloseTo(0.25);
  });
  it('flags the floor and handles empty', () => {
    expect(floorBar(1n, 1n, 1n).atFloor).toBe(true);
    expect(floorBar(0n, 0n, 0n)).toEqual({ value: 0, floor: 0, headroom: 0n, atFloor: true });
  });
});
