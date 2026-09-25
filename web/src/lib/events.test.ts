import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseEther, type Address, type Hex } from 'viem';
import { vaultAbi } from '../abi/Vault';
import { decodeVaultLogs, forcedNfts, openAuctionsFromEvents, replaySettings, toFeed } from './events';

const VAULT = '0x1111111111111111111111111111111111111111' as Address;
const OTHER = '0x2222222222222222222222222222222222222222' as Address;
const C = '0x3333333333333333333333333333333333333333' as Address;
const K = '0x4444444444444444444444444444444444444444' as Address;

let n = 0;
type EventName = Extract<(typeof vaultAbi)[number], { type: 'event' }>['name'];

/** Builds a raw log the way a node returns it: indexed args in topics, the rest ABI encoded in data. */
function log(eventName: EventName, args: Record<string, unknown>, address: Address = VAULT) {
  const ev = vaultAbi.find((x) => x.type === 'event' && x.name === eventName) as Extract<
    (typeof vaultAbi)[number],
    { type: 'event' }
  >;
  const topics = encodeEventTopics({ abi: vaultAbi, eventName, args } as never) as Hex[];
  const plain = ev.inputs.filter((i) => !('indexed' in i && i.indexed));
  const data = encodeAbiParameters(plain as never, plain.map((i) => args[i.name!]) as never);
  n += 1;
  return {
    address,
    topics: topics as [Hex, ...Hex[]],
    data,
    transactionHash: `0x${n.toString(16).padStart(64, '0')}` as Hex,
    blockNumber: BigInt(100 + n),
    logIndex: 0,
  };
}

describe('decodeVaultLogs', () => {
  it('decodes indexed and plain args', () => {
    const [e] = decodeVaultLogs([log('PullResolved', { requestId: 7n, listingId: 9n, outcome: 2 })]);
    expect(e.name).toBe('PullResolved');
    expect(e.args).toMatchObject({ requestId: 7n, listingId: 9n, outcome: 2 });
  });
  it('decodes array and struct args', () => {
    const [a, b] = decodeVaultLogs([
      log('PullsRequested', { requestIds: [1n, 2n], spentPerPull: parseEther('0.1') }),
      log('RunStarted', {
        runStartValue: parseEther('2'),
        params: { maxDrawdownBps: 2500n, maxPullCostWei: 1n, stopAfterKeeps: 0n, deadline: 2_000_000_000n, maxPulls: 10n },
      }),
    ]);
    expect(a.args.requestIds).toEqual([1n, 2n]);
    expect((b.args.params as { maxDrawdownBps: bigint }).maxDrawdownBps).toBe(2500n);
  });
  it('skips foreign logs', () => {
    const foreign = { ...log('Deposited', { amount: 1n }), topics: [`0x${'ab'.repeat(32)}`] as [Hex] };
    expect(decodeVaultLogs([foreign])).toEqual([]);
  });
});

describe('toFeed', () => {
  it('orders newest first and names outcomes', () => {
    const feed = toFeed(
      decodeVaultLogs([
        log('PullResolved', { requestId: 1n, listingId: 1n, outcome: 3 }),
        log('PullResolved', { requestId: 2n, listingId: 2n, outcome: 2 }),
        log('PullResolved', { requestId: 3n, listingId: 3n, outcome: 4 }),
        log('PullResolved', { requestId: 4n, listingId: 4n, outcome: 5 }),
        log('AuctionFinalized', { requestId: 5n, winner: K, amount: parseEther('1.2') }),
      ]),
    );
    expect(feed.map((f) => f.title)).toEqual([
      'Auction won',
      'Refunded',
      'Forced outcome',
      'Kept, sent to owner',
      'Sold back',
    ]);
    expect(feed[0].detail).toContain('1.2 ETH');
    expect(feed.every((f) => !/[–—]/.test(f.title + f.detail))).toBe(true);
  });
});

describe('replaySettings', () => {
  it('replays keep list, keepers and fees', () => {
    const s = replaySettings(
      decodeVaultLogs([
        log('KeepCollectionSet', { collection: C, keep: true }),
        log('KeepTokenSet', { collection: C, tokenId: 5n, keep: true }),
        log('KeepTokenSet', { collection: C, tokenId: 6n, keep: true }),
        log('KeepTokenSet', { collection: C, tokenId: 5n, keep: false }),
        log('KeeperSet', { keeper: K, approved: true }),
        log('KeeperSet', { keeper: OTHER, approved: true }),
        log('KeeperSet', { keeper: OTHER, approved: false }),
        log('FeePaid', { amount: 10n }),
        log('FeePaid', { amount: 15n }),
      ]),
    );
    expect(s.collections).toEqual([C]);
    expect(s.tokens).toEqual([{ collection: C, tokenId: 6n }]);
    expect(s.keepers).toEqual([K]);
    expect(s.feesPaid).toBe(25n);
  });
});

describe('auction and forced tracking', () => {
  it('keeps only unfinalized auctions per vault', () => {
    const open = openAuctionsFromEvents(
      decodeVaultLogs([
        log('AuctionStarted', { requestId: 1n, listingId: 11n, backstop: 1n, deadline: 1n, hardDeadline: 2n }),
        log('AuctionStarted', { requestId: 1n, listingId: 12n, backstop: 1n, deadline: 1n, hardDeadline: 2n }, OTHER),
        log('AuctionStarted', { requestId: 2n, listingId: 13n, backstop: 1n, deadline: 1n, hardDeadline: 2n }),
        log('AuctionFinalized', { requestId: 1n, winner: K, amount: 3n }),
      ]),
    );
    expect(open.map((a) => `${a.vault}:${a.requestId}:${a.listingId}`)).toEqual([`${OTHER}:1:12`, `${VAULT}:2:13`]);
  });
  it('lists forced NFT outcomes only', () => {
    const f = forcedNfts(
      decodeVaultLogs([
        log('PullForced', { requestId: 1n, listingId: 1n, kind: 1 }),
        log('PullForced', { requestId: 2n, listingId: 2n, kind: 3 }),
        log('PullForced', { requestId: 3n, listingId: 3n, kind: 2 }),
      ]),
    );
    expect(f.map((x) => x.kind)).toEqual([1, 2]);
  });
});
