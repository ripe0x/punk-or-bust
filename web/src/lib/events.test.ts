import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseEther, type Address, type Hex } from 'viem';
import { vaultAbi } from '../abi/Vault';
import { decodeVaultLogs, forcedNfts, lastWindDownReason, replaySettings, toFeed } from './events';

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
    expect(feed.every((f) => !/[\u2013\u2014]/.test(f.title + f.detail))).toBe(true);
  });
  it('shows bounties, the wind-down reason and the new settings', () => {
    const feed = toFeed(
      decodeVaultLogs([
        log('BountyPaid', { caller: K, amount: parseEther('0.0003') }),
        log('RunWindingDown', { reason: 1 }),
        log('PrivateModeSet', { enabled: true }),
        log('BountiesSet', { bountyWei: parseEther('0.001'), syncBountyMaxWei: parseEther('0.01') }),
      ]),
    );
    expect(feed.map((f) => f.title)).toEqual(['Bounties set', 'Private mode on', 'Run winding down', 'Bounty paid']);
    expect(feed[0].detail).toBe('Pull and finalize 0.001 ETH, sync up to 0.01 ETH');
    expect(feed[2].detail).toBe('The drawdown floor is reached. No new pulls; open items are resolving.');
    expect(feed[3].detail).toBe('0.0003 ETH to 0x4444...4444');
    expect(feed.every((f) => !/[\u2013\u2014]/.test(f.title + f.detail))).toBe(true);
  });
});

describe('lastWindDownReason', () => {
  it('takes the latest RunWindingDown', () => {
    expect(lastWindDownReason([])).toBeNull();
    expect(lastWindDownReason(decodeVaultLogs([log('RunWindingDown', { reason: 2 }), log('RunWindingDown', { reason: 5 })]))).toBe(5);
  });
});

describe('replaySettings', () => {
  it('replays keep list and keepers', () => {
    const s = replaySettings(
      decodeVaultLogs([
        log('KeepCollectionSet', { collection: C, keep: true }),
        log('KeepTokenSet', { collection: C, tokenId: 5n, keep: true }),
        log('KeepTokenSet', { collection: C, tokenId: 6n, keep: true }),
        log('KeepTokenSet', { collection: C, tokenId: 5n, keep: false }),
        log('KeeperSet', { keeper: K, approved: true }),
        log('KeeperSet', { keeper: OTHER, approved: true }),
        log('KeeperSet', { keeper: OTHER, approved: false }),
      ]),
    );
    expect(s.collections).toEqual([C]);
    expect(s.tokens).toEqual([{ collection: C, tokenId: 6n }]);
    expect(s.keepers).toEqual([K]);
  });
});

describe('forced tracking', () => {
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
