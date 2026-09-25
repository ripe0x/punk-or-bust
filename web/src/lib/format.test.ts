import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { formatBps, formatDuration, formatEth, formatGwei, parseEthInput, parseGweiInput, shortAddr } from './format';

describe('formatEth', () => {
  it('trims and truncates', () => {
    expect(formatEth(0n)).toBe('0');
    expect(formatEth(parseEther('1'))).toBe('1');
    expect(formatEth(parseEther('1.23456789'))).toBe('1.2345');
    expect(formatEth(parseEther('0.5'), 2)).toBe('0.5');
  });
  it('marks dust', () => {
    expect(formatEth(1n)).toBe('<0.0001');
  });
});

describe('formatGwei', () => {
  it('formats the default ceiling', () => {
    expect(formatGwei(1_200_000_000n)).toBe('1.2');
    expect(formatGwei(100_000_000_000n)).toBe('100');
  });
});

describe('parse inputs', () => {
  it('parses eth', () => {
    expect(parseEthInput('1.5')).toBe(parseEther('1.5'));
    expect(parseEthInput(' .25 ')).toBe(parseEther('0.25'));
    expect(parseEthInput('0')).toBe(0n);
  });
  it('rejects junk', () => {
    expect(parseEthInput('')).toBeNull();
    expect(parseEthInput('.')).toBeNull();
    expect(parseEthInput('-1')).toBeNull();
    expect(parseEthInput('1e18')).toBeNull();
    expect(parseEthInput('1,5')).toBeNull();
    expect(parseEthInput('0.' + '1'.repeat(19))).toBeNull();
  });
  it('parses gwei', () => {
    expect(parseGweiInput('1.2')).toBe(1_200_000_000n);
    expect(parseGweiInput('0.0000000001')).toBeNull();
  });
});

describe('misc', () => {
  it('bps', () => {
    expect(formatBps(1234n)).toBe('12.34%');
    expect(formatBps(10_000)).toBe('100%');
    expect(formatBps(0)).toBe('0%');
  });
  it('duration', () => {
    expect(formatDuration(0)).toBe('ended');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(750)).toBe('12m 30s');
    expect(formatDuration(3900)).toBe('1h 5m');
    expect(formatDuration(90000n)).toBe('1d 1h');
  });
  it('short address', () => {
    expect(shortAddr('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234...5678');
  });
});
