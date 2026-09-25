import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { explainRevert } from './errors';
import { planRanges } from './ranges';
import { checkGasCeiling, checkRunForm, parseAddresses, unixToLocalInput } from './runParams';

describe('planRanges', () => {
  it('splits inclusive ranges', () => {
    expect(planRanges(0n, 9n, 4n)).toEqual([
      [0n, 3n],
      [4n, 7n],
      [8n, 9n],
    ]);
    expect(planRanges(5n, 5n, 100n)).toEqual([[5n, 5n]]);
    expect(planRanges(6n, 5n, 100n)).toEqual([]);
  });
});

describe('checkRunForm', () => {
  const now = 1_700_000_000;
  const good = {
    amountEth: '1',
    drawdownPct: 25,
    maxPullCostEth: '0.2',
    deadline: unixToLocalInput(now + 3600),
    maxPulls: '10',
    stopAfterKeeps: '',
  };
  it('builds params', () => {
    const r = checkRunForm(good, now, true);
    expect(r.errors).toEqual({});
    expect(r.value).toBe(parseEther('1'));
    expect(r.params).toMatchObject({ maxDrawdownBps: 2500n, maxPullCostWei: parseEther('0.2'), stopAfterKeeps: 0n, maxPulls: 10n });
    expect(Number(r.params!.deadline)).toBeGreaterThan(now);
  });
  it('allows 0% drawdown', () => {
    expect(checkRunForm({ ...good, drawdownPct: 0 }, now, true).params?.maxDrawdownBps).toBe(0n);
  });
  it('rejects bad values', () => {
    const r = checkRunForm(
      { amountEth: '0', drawdownPct: 101, maxPullCostEth: '0', deadline: unixToLocalInput(now - 60), maxPulls: '0', stopAfterKeeps: 'x' },
      now,
      true,
    );
    expect(Object.keys(r.errors).sort()).toEqual(['amountEth', 'deadline', 'drawdownPct', 'maxPullCostEth', 'maxPulls', 'stopAfterKeeps']);
    expect(r.params).toBeNull();
  });
  it('treats an empty amount as zero when optional', () => {
    expect(checkRunForm({ ...good, amountEth: '' }, now, false).value).toBe(0n);
  });
});

describe('checkGasCeiling', () => {
  it('bounds the ceiling', () => {
    expect(checkGasCeiling('1.2').wei).toBe(1_200_000_000n);
    expect(checkGasCeiling('100').wei).toBe(100_000_000_000n);
    expect(checkGasCeiling('0').error).toBeTruthy();
    expect(checkGasCeiling('100.1').error).toBeTruthy();
  });
});

describe('parseAddresses', () => {
  it('reads a list', () => {
    const r = parseAddresses('0x4444444444444444444444444444444444444444, nope\n0x4444444444444444444444444444444444444444');
    expect(r.addresses).toHaveLength(1);
    expect(r.errors).toEqual(['Not an address: nope']);
  });
});

describe('explainRevert', () => {
  it('maps known errors and passes others through', () => {
    expect(explainRevert('BidTooLow')).toContain('minimum');
    expect(explainRevert('Mystery')).toBe('Reverted: Mystery');
  });
});
