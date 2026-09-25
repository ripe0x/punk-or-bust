import { BID_STEP_BPS, BPS } from './constants';

/** Smallest bid the vault accepts: 5% over the high bid, or over the backstop before any bid. */
export function minNextBid(backstop: bigint, highBid: bigint): bigint {
  const base = highBid === 0n ? backstop : highBid;
  return (base * BID_STEP_BPS) / BPS;
}

/** Seconds left before `deadline`, never negative. */
export function secondsLeft(deadline: bigint, nowSec: number): number {
  const left = Number(deadline) - Math.floor(nowSec);
  return left > 0 ? left : 0;
}

/** True when a bid now would push the deadline out (less than 5 minutes left). */
export function bidExtends(deadline: bigint, nowSec: number): boolean {
  const left = secondsLeft(deadline, nowSec);
  return left > 0 && left < 300;
}
