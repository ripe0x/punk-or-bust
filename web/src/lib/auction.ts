import type { Address } from 'viem';
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

export interface OpenAuction {
  vault: Address;
  requestId: bigint;
  listingId: bigint;
  collection: Address;
  tokenId: bigint;
  backstop: bigint;
  highBid: bigint;
  highBidder: Address;
  deadline: bigint;
  hardDeadline: bigint;
  minNextBid: bigint;
}

/** `auctionInfo(requestId)` result: the auction record plus the minimum next bid. */
export type AuctionInfo = readonly [bigint, Address, bigint, bigint, bigint, Address, bigint, bigint, bigint];

/** `auctionInfo(requestId)` as an `OpenAuction`. */
export function toOpenAuction(vault: Address, requestId: bigint, r: AuctionInfo): OpenAuction {
  return {
    vault,
    requestId,
    listingId: r[0],
    collection: r[1],
    tokenId: r[2],
    backstop: r[3],
    highBid: r[4],
    highBidder: r[5],
    deadline: r[6],
    hardDeadline: r[7],
    minNextBid: r[8],
  };
}
