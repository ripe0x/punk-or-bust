import { BPS, PPM, PULL_FEE_PPM } from './constants';

/** floor = runStartValue * (10_000 - maxDrawdownBps) / 10_000, as in Vault.runFloor. */
export function runFloor(runStartValue: bigint, maxDrawdownBps: bigint): bigint {
  if (maxDrawdownBps > BPS) throw new Error('maxDrawdownBps above 10000');
  return (runStartValue * (BPS - maxDrawdownBps)) / BPS;
}

/** Pull fee owed on a completed pull at `price` (VRF excluded): 250 ppm. */
export function pullFee(price: bigint): bigint {
  return (price * PULL_FEE_PPM) / PPM;
}

/**
 * Pulls the owner could open now under the floor rule: each pull costs its quote plus its fee
 * against value above the floor, and the quote against idle ETH. Mirrors Vault._affordable for
 * an owner call (no keeper reserve).
 */
export function affordablePulls(args: {
  value: bigint;
  floor: bigint;
  idle: bigint;
  quoteTotal: bigint;
  quoteFee: bigint;
}): bigint {
  const { value, floor, idle, quoteTotal, quoteFee } = args;
  if (quoteTotal === 0n) return 0n;
  const unit = quoteTotal + pullFee(quoteFee);
  const byFloor = value > floor ? (value - floor) / unit : 0n;
  const byIdle = idle / quoteTotal;
  return byFloor < byIdle ? byFloor : byIdle;
}

export interface FloorBar {
  /** Position of the current value, 0 to 1, on a scale from 0 to max(start, value). */
  value: number;
  /** Position of the floor on the same scale. */
  floor: number;
  /** Value above the floor in wei, zero when at or below. */
  headroom: bigint;
  /** True when value is at or under the floor. */
  atFloor: boolean;
}

/** Positions for a simple value versus floor bar. */
export function floorBar(value: bigint, floor: bigint, start: bigint): FloorBar {
  const scale = value > start ? value : start;
  const ratio = (x: bigint) => (scale === 0n ? 0 : Number((x * 10_000n) / scale) / 10_000);
  return {
    value: ratio(value),
    floor: ratio(floor),
    headroom: value > floor ? value - floor : 0n,
    atFloor: value <= floor,
  };
}
