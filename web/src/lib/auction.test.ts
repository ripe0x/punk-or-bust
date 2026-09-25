import { describe, expect, it } from 'vitest';
import { parseEther, type Address } from 'viem';
import { bidExtends, minNextBid, secondsLeft, toOpenAuction } from './auction';

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

describe('toOpenAuction', () => {
  it('maps the auctionInfo tuple, NFT and min next bid included', () => {
    const vault = '0x1111111111111111111111111111111111111111' as Address;
    const coll = '0x3333333333333333333333333333333333333333' as Address;
    const bidder = '0x4444444444444444444444444444444444444444' as Address;
    const a = toOpenAuction(vault, 7n, [11n, coll, 42n, parseEther('1'), parseEther('1.2'), bidder, 1_000n, 2_000n, parseEther('1.26')]);
    expect(a).toEqual({
      vault,
      requestId: 7n,
      listingId: 11n,
      collection: coll,
      tokenId: 42n,
      backstop: parseEther('1'),
      highBid: parseEther('1.2'),
      highBidder: bidder,
      deadline: 1_000n,
      hardDeadline: 2_000n,
      minNextBid: parseEther('1.26'),
    });
    expect(a.minNextBid).toBe(minNextBid(a.backstop, a.highBid));
  });
});
