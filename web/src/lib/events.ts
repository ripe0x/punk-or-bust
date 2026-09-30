import { decodeEventLog, type Address, type Hex, type Log } from 'viem';
import { vaultAbi } from '../abi/Vault';
import {
  FORCED_KIND,
  formatBps,
  shortId,
  formatEth,
  formatGwei,
  formatTimestamp,
  pullStatusLabel,
  shortAddr,
  windDownReasonLabel,
} from './format';
import type { KeepList, KeepToken } from './keepList';

export interface VaultEvent {
  name: string;
  args: Record<string, unknown>;
  address: Address;
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
}

export type FeedTone = 'good' | 'bad' | 'neutral' | 'info';

export interface FeedItem {
  key: string;
  title: string;
  detail: string;
  tone: FeedTone;
  txHash: Hex;
  address: Address;
  blockNumber: bigint;
}

type RawLog = Pick<Log, 'data' | 'topics' | 'address' | 'transactionHash' | 'blockNumber' | 'logIndex'>;

/** Decodes raw logs against the Vault ABI. Logs that are not Vault events are skipped. */
export function decodeVaultLogs(logs: readonly RawLog[]): VaultEvent[] {
  const out: VaultEvent[] = [];
  for (const log of logs) {
    if (!log.transactionHash || log.blockNumber == null || log.logIndex == null) continue;
    try {
      const d = decodeEventLog({ abi: vaultAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      out.push({
        name: d.eventName,
        args: (d.args ?? {}) as Record<string, unknown>,
        address: log.address,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
      });
    } catch {
      // Not a Vault event.
    }
  }
  return out;
}

/** Oldest first by block, then log index. */
export function sortEvents<T extends { blockNumber: bigint; logIndex: number }>(events: T[]): T[] {
  return [...events].sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
  );
}

const eth = (v: unknown) => `${formatEth(v as bigint)} ETH`;
const id = (v: unknown) => shortId(v as bigint);

/** One readable line per vault event. Null for events the feed does not show. */
export function describeEvent(e: VaultEvent): Omit<FeedItem, 'key' | 'txHash' | 'address' | 'blockNumber'> | null {
  const a = e.args;
  switch (e.name) {
    case 'RunStarted': {
      const p = a.params as { maxDrawdownBps: bigint; maxPulls: bigint; deadline: bigint };
      return {
        title: 'Run started',
        detail: `Start value ${eth(a.runStartValue)}, max drawdown ${formatBps(p.maxDrawdownBps)}, up to ${p.maxPulls} pulls until ${formatTimestamp(p.deadline)}`,
        tone: 'info',
      };
    }
    case 'RunWindingDown': {
      const reason = windDownReasonLabel(Number(a.reason));
      return { title: 'Run winding down', detail: `${reason[0].toUpperCase()}${reason.slice(1)}. No new pulls; open items are resolving.`, tone: 'neutral' };
    }
    case 'RunEnded':
      return { title: 'Run ended', detail: `Returned ${eth(a.returned)} to the owner`, tone: 'info' };
    case 'Deposited':
      return { title: 'Deposit', detail: eth(a.amount), tone: 'neutral' };
    case 'Withdrawn':
      return { title: 'Withdrawal', detail: eth(a.amount), tone: 'neutral' };
    case 'PullsRequested': {
      const ids = a.requestIds as readonly bigint[];
      return {
        title: `${ids.length} pull${ids.length === 1 ? '' : 's'} requested`,
        detail: `${eth(a.spentPerPull)} each. Requests ${ids.map(id).join(', ')}`,
        tone: 'neutral',
      };
    }
    case 'PullResolved': {
      const outcome = Number(a.outcome);
      const label = pullStatusLabel(outcome);
      const tone: FeedTone = outcome === 2 ? 'good' : outcome === 4 ? 'bad' : outcome === 6 ? 'info' : 'neutral';
      const titles: Record<number, string> = {
        2: 'Kept, sent to owner',
        3: 'Sold back',
        4: 'Forced outcome',
        5: 'Refunded',
        6: 'Auction opened',
      };
      return {
        title: titles[outcome] ?? label,
        detail: `Request ${id(a.requestId)}, listing ${id(a.listingId)}`,
        tone,
      };
    }
    case 'PullForced':
      return {
        title: 'Forced by FWA',
        detail: `${FORCED_KIND[Number(a.kind)] ?? 'Unknown'}. Request ${id(a.requestId)}, listing ${id(a.listingId)}`,
        tone: 'bad',
      };
    case 'FeePaid':
      return { title: 'Pull fee paid', detail: eth(a.amount), tone: 'neutral' };
    case 'KeeperReimbursed':
      return {
        title: 'Keeper reimbursed',
        detail: `${eth(a.amount)} to ${shortAddr(a.keeper as string)} (${String(a.gasUsed)} gas at ${formatGwei(a.gasPrice as bigint)} gwei)`,
        tone: 'neutral',
      };
    case 'BountyPaid':
      return { title: 'Bounty paid', detail: `${eth(a.amount)} to ${shortAddr(a.caller as string)}`, tone: 'neutral' };
    case 'AuctionStarted':
      return {
        title: 'Auction started',
        detail: `Request ${id(a.requestId)}, backstop ${eth(a.backstop)}, ends ${formatTimestamp(a.deadline as bigint)}`,
        tone: 'info',
      };
    case 'BidPlaced':
      return {
        title: 'Bid placed',
        detail: `${eth(a.amount)} by ${shortAddr(a.bidder as string)} on request ${id(a.requestId)}`,
        tone: 'info',
      };
    case 'BidRefunded':
      return {
        title: a.credited ? 'Bid refund credited' : 'Bid refunded',
        detail: `${eth(a.amount)} to ${shortAddr(a.bidder as string)}${a.credited ? '. Claim it on the auctions page.' : ''}`,
        tone: 'neutral',
      };
    case 'BidRefundClaimed':
      return { title: 'Bid refund claimed', detail: `${eth(a.amount)} by ${shortAddr(a.bidder as string)}`, tone: 'neutral' };
    case 'AuctionFinalized': {
      const winner = a.winner as Address;
      const none = /^0x0{40}$/i.test(winner);
      return {
        title: none ? 'Auction closed, no winner' : 'Auction won',
        detail: none
          ? `Request ${id(a.requestId)} sold back`
          : `Request ${id(a.requestId)} to ${shortAddr(winner)} for ${eth(a.amount)}`,
        tone: none ? 'neutral' : 'good',
      };
    }
    case 'KeepCollectionSet':
      return {
        title: a.keep ? 'Keep collection added' : 'Keep collection removed',
        detail: shortAddr(a.collection as string),
        tone: 'neutral',
      };
    case 'KeepTokenSet':
      return {
        title: a.keep ? 'Keep token added' : 'Keep token removed',
        detail: `${shortAddr(a.collection as string)} ${id(a.tokenId)}`,
        tone: 'neutral',
      };
    case 'KeeperSet':
      return {
        title: a.approved ? 'Keeper approved' : 'Keeper removed',
        detail: shortAddr(a.keeper as string),
        tone: 'neutral',
      };
    case 'AutoReturnSet':
      return { title: `Auto-return ${a.enabled ? 'on' : 'off'}`, detail: '', tone: 'neutral' };
    case 'GasCeilingSet':
      return { title: 'Gas ceiling set', detail: `${formatGwei(a.ceiling as bigint)} gwei`, tone: 'neutral' };
    case 'PrivateModeSet':
      return {
        title: `Private mode ${a.enabled ? 'on' : 'off'}`,
        detail: a.enabled ? 'Only approved keepers may request pulls.' : 'Anyone may request pulls within the run limits.',
        tone: 'neutral',
      };
    case 'BountiesSet':
      return {
        title: 'Bounties set',
        detail: `Pull and finalize ${eth(a.bountyWei)}, sync up to ${eth(a.syncBountyMaxWei)}`,
        tone: 'neutral',
      };
    case 'RewardsRegistered':
      return { title: 'Rewards registered', detail: 'Epoch rewards now accrue to the owner.', tone: 'good' };
    default:
      return null;
  }
}

/** Feed items, newest first. */
export function toFeed(events: VaultEvent[]): FeedItem[] {
  const items: FeedItem[] = [];
  for (const e of sortEvents(events).reverse()) {
    const d = describeEvent(e);
    if (!d) continue;
    items.push({
      ...d,
      key: `${e.txHash}:${e.logIndex}`,
      txHash: e.txHash,
      address: e.address,
      blockNumber: e.blockNumber,
    });
  }
  return items;
}

export interface VaultSettings extends KeepList {
  keepers: Address[];
}

/**
 * Rebuilds the keep list and the approved keepers from a vault's events. The contract stores these
 * as mappings, so events are the only way to list them.
 */
export function replaySettings(events: VaultEvent[]): VaultSettings {
  const collections = new Map<string, Address>();
  const tokens = new Map<string, KeepToken>();
  const keepers = new Map<string, Address>();
  for (const e of sortEvents(events)) {
    const a = e.args;
    if (e.name === 'KeepCollectionSet') {
      const c = a.collection as Address;
      if (a.keep) collections.set(c.toLowerCase(), c);
      else collections.delete(c.toLowerCase());
    } else if (e.name === 'KeepTokenSet') {
      const t = { collection: a.collection as Address, tokenId: a.tokenId as bigint };
      const k = `${t.collection.toLowerCase()}:${t.tokenId}`;
      if (a.keep) tokens.set(k, t);
      else tokens.delete(k);
    } else if (e.name === 'KeeperSet') {
      const k = a.keeper as Address;
      if (a.approved) keepers.set(k.toLowerCase(), k);
      else keepers.delete(k.toLowerCase());
    }
  }
  return {
    collections: [...collections.values()],
    tokens: [...tokens.values()],
    keepers: [...keepers.values()],
  };
}

export type PullCardStatus = 'pending' | 'kept' | 'sold' | 'forced' | 'refunded' | 'auctioning';

const PULL_CARD_STATUS: Record<number, PullCardStatus> = {
  1: 'pending',
  2: 'kept',
  3: 'sold',
  4: 'forced',
  5: 'refunded',
  6: 'auctioning',
};

export interface PullCard {
  requestId: bigint;
  listingId?: bigint;
  spentPerPull?: bigint;
  status: PullCardStatus;
  blockNumber: bigint;
  txHash: Hex;
  /** 1-based run this pull belongs to (a vault runs many times over its life). */
  round: number;
}

/**
 * One card per pull request, newest first: pending until a `PullResolved` lands (a completed
 * auction re-emits `PullResolved` with the final outcome, so the latest one wins), carrying the
 * per-pull price from the `PullsRequested` batch it belongs to.
 */
export function pullCardsFromEvents(events: VaultEvent[]): PullCard[] {
  const sorted = sortEvents(events);
  // Each RunStarted opens a run; a pull's round is how many runs had started by its request block.
  const runStartBlocks = sorted.filter((e) => e.name === 'RunStarted').map((e) => e.blockNumber);
  const roundAt = (block: bigint): number => {
    let n = 0;
    for (const b of runStartBlocks) if (b <= block) n++;
    return Math.max(1, n);
  };
  const cards = new Map<string, PullCard>();
  for (const e of sorted) {
    if (e.name === 'PullsRequested') {
      const ids = e.args.requestIds as readonly bigint[];
      const spentPerPull = e.args.spentPerPull as bigint;
      const round = roundAt(e.blockNumber);
      for (const requestId of ids) {
        cards.set(requestId.toString(), { requestId, spentPerPull, status: 'pending', blockNumber: e.blockNumber, txHash: e.txHash, round });
      }
    } else if (e.name === 'PullResolved') {
      const requestId = e.args.requestId as bigint;
      const key = requestId.toString();
      const prev = cards.get(key);
      cards.set(key, {
        requestId,
        listingId: e.args.listingId as bigint,
        spentPerPull: prev?.spentPerPull,
        status: PULL_CARD_STATUS[Number(e.args.outcome)] ?? 'pending',
        blockNumber: e.blockNumber,
        txHash: e.txHash,
        // Keep the round of the request; a resolve can land in a later run.
        round: prev?.round ?? roundAt(e.blockNumber),
      });
    }
  }
  return [...cards.values()].sort((a, b) => (a.blockNumber === b.blockNumber ? 0 : a.blockNumber < b.blockNumber ? 1 : -1));
}

/** Why the latest run is winding down, from its last `RunWindingDown` event. Null when none. */
export function lastWindDownReason(events: VaultEvent[]): number | null {
  const sorted = sortEvents(events);
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].name === 'RunWindingDown') return Number(sorted[i].args.reason);
  }
  return null;
}

export interface ForcedRef {
  requestId: bigint;
  listingId: bigint;
  kind: number;
  txHash: Hex;
}

/** Forced outcomes that may have left an NFT for the owner to recover or sweep. */
export function forcedNfts(events: VaultEvent[]): ForcedRef[] {
  return sortEvents(events)
    .filter((e) => e.name === 'PullForced' && [1, 2, 4].includes(Number(e.args.kind)))
    .map((e) => ({
      requestId: e.args.requestId as bigint,
      listingId: e.args.listingId as bigint,
      kind: Number(e.args.kind),
      txHash: e.txHash,
    }));
}
