import { useMemo, useState, type ReactNode } from 'react';
import { useReadContract } from 'wagmi';
import type { Address } from 'viem';
import { fwaAbi } from '../abi/IFWA';
import { vaultAbi } from '../abi/Vault';
import { useTx } from '../hooks/useTx';
import { useAcquisitionStatus, useListings, useVaultAuctions, useVaultEvents, useVaultState, type ListingInfo, type VaultState } from '../hooks/useVault';
import { useNftImage } from '../hooks/useNftImage';
import { useNow } from '../hooks/useNow';
import { COLLECTIONS, isPunks } from '../lib/collections';
import { pullCardsFromEvents, type PullCard, type VaultEvent, type VaultSettings } from '../lib/events';
import { friendlyLoadError } from '../lib/errors';
import { floorBar } from '../lib/floor';
import { formatDuration, formatEth, parseEthInput, windDownReasonLabel } from '../lib/format';
import { secondsLeft, type OpenAuction } from '../lib/auction';
import { PullDetail } from './PullDetail';
import { Section, TxStatus } from './ui';
import { Settings } from './Settings';
import { Sweep } from './Sweep';

export function Run({ vault, viewer }: { vault: Address; viewer?: Address }) {
  const { state, loading, error } = useVaultState(vault);
  const events = useVaultEvents(vault);
  const [openDetail, setOpenDetail] = useState<bigint | null>(null);
  const [sortKey, setSortKey] = useState<'time' | 'price'>('time');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');
  const toggleSort = (key: 'time' | 'price') => {
    if (key === sortKey) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const discount = useReadContract({
    address: state?.fwa,
    abi: fwaAbi,
    functionName: 'settlementDiscountBps',
    query: { enabled: !!state?.fwa, staleTime: 60_000 },
  });

  const pulls = pullCardsFromEvents(events.events);
  const listingIds = [...new Set(pulls.filter((p) => p.listingId !== undefined).map((p) => p.listingId!))];
  const listings = useListings(state?.fwa, listingIds);
  const pendingIds = [...new Set(pulls.filter((p) => p.status === 'pending').map((p) => p.requestId))];
  const pullStages = useAcquisitionStatus(state?.fwa, pendingIds);
  const auctions = useVaultAuctions(vault);

  // Price = the pull's value (its listing), falling back to what was paid for it.
  const priceOf = (p: PullCard): bigint =>
    (p.listingId !== undefined ? listings[p.listingId.toString()]?.value : undefined) ?? p.spentPerPull ?? 0n;
  const sortedPulls = useMemo(() => {
    const arr = [...pulls];
    arr.sort((a, b) => {
      let d = 0;
      if (sortKey === 'time') d = a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0;
      else {
        const pa = priceOf(a);
        const pb = priceOf(b);
        d = pa < pb ? -1 : pa > pb ? 1 : 0;
      }
      return sortDir === 'desc' ? -d : d;
    });
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pulls, sortKey, sortDir, listings]);

  if (!state) {
    return <p className="empty">{loading ? 'Loading your run.' : (friendlyLoadError(error) ?? 'No run found here.')}</p>;
  }
  const isOwner = !!viewer && viewer.toLowerCase() === state.owner.toLowerCase();
  const discountBps = (discount.data as bigint | undefined) ?? 9_000n;

  const sold = pulls.filter((p) => p.status === 'sold').length;
  const detailCard = openDetail !== null ? pulls.find((p) => p.requestId === openDetail) : undefined;
  const rounds = [...new Set(sortedPulls.map((p) => p.round))].sort((a, b) => b - a);
  const row = (p: PullCard) => (
    <PullRow
      key={p.requestId.toString()}
      card={p}
      listing={p.listingId !== undefined ? listings[p.listingId.toString()] : undefined}
      auction={auctions[p.requestId.toString()]}
      stage={pullStages[p.requestId.toString()]}
      discountBps={discountBps}
      onOpen={() => setOpenDetail(p.requestId)}
    />
  );

  return (
    <>
      <RunCard vault={vault} state={state} isOwner={isOwner} windDownReason={events.windDownReason} />
      <section className="pulls-section" aria-label="Your pulls">
        <div className="pulls-head">
          <h2>Your pulls</h2>
          <div className="pull-sort" role="group" aria-label="Sort pulls">
            <button type="button" className={sortKey === 'time' ? 'on' : ''} onClick={() => toggleSort('time')}>
              Time{sortKey === 'time' ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}
            </button>
            <button type="button" className={sortKey === 'price' ? 'on' : ''} onClick={() => toggleSort('price')}>
              Price{sortKey === 'price' ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}
            </button>
          </div>
        </div>
        {pulls.length === 0 ? <p className="empty">No pulls yet.</p> : null}
        {rounds.length <= 1
          ? sortedPulls.map(row)
          : rounds.map((rn) => (
              <div key={rn} className="pull-round">
                <div className="pull-round-head">Round {rn}</div>
                {sortedPulls.filter((p) => p.round === rn).map(row)}
              </div>
            ))}
      </section>
      {isOwner ? (
        <MoreSection vault={vault} state={state} settings={events.settings} rawEvents={events.events} sold={sold} />
      ) : null}
      {detailCard ? (
        <PullDetail
          card={detailCard}
          listing={detailCard.listingId !== undefined ? listings[detailCard.listingId.toString()] : undefined}
          auction={auctions[detailCard.requestId.toString()]}
          discountBps={discountBps}
          owner={state.owner}
          onClose={() => setOpenDetail(null)}
        />
      ) : null}
    </>
  );
}

function RunCard({
  vault,
  state,
  isOwner,
  windDownReason,
}: {
  vault: Address;
  state: VaultState;
  isOwner: boolean;
  windDownReason: number | null;
}) {
  const tx = useTx();
  const [depositText, setDepositText] = useState('');
  const [showDeposit, setShowDeposit] = useState(false);
  const running = state.status === 1;
  const windingDown = state.status === 2;
  const deposit = parseEthInput(depositText);

  return (
    <section className="run-card">
      <div className="status-line">
        <span className="status-badge">
          <span className={`status-dot ${running ? '' : 'idle'}`} />
          {running ? 'Running' : windingDown ? 'Winding down' : 'Idle'}
        </span>
        <span className="small muted">{state.pullsRequested.toString()} pulls so far</span>
      </div>
      <div className="run-value">
        <div className="amount num">
          {formatEth(state.idle, 3)}
          <span className="unit"> ETH</span>
        </div>
        <div className="caption">{running || windingDown ? 'left to pull with' : 'in your vault'}</div>
      </div>
      {running || windingDown ? <RunFloorBar value={state.runValue} floor={state.runFloor} start={state.runStartValue} /> : null}
      <div className="stat-trio">
        <div className="stat-tile">
          <div className="value">{state.keeps.toString()}</div>
          <div className="label">Kept</div>
        </div>
        <div className="stat-tile">
          <div className="value">{state.outstanding.toString()}</div>
          <div className="label">In flight</div>
        </div>
        <div className="stat-tile">
          <div className="value">{state.openAuctions.toString()}</div>
          <div className="label">At auction</div>
        </div>
      </div>
      {windingDown ? (
        <p className="small muted">
          No new pulls{windDownReason !== null ? `: ${windDownReasonLabel(windDownReason)}` : ''}. Open pulls and auctions are still resolving.
        </p>
      ) : null}
      {isOwner && running ? (
        <div className="btn-row">
          <button className="btn" onClick={() => setShowDeposit((s) => !s)}>
            Add ETH
          </button>
          <button className="btn btn-secondary" disabled={tx.busy} onClick={() => tx.send('Stop run', { address: vault, abi: vaultAbi, functionName: 'stop' })}>
            Stop run
          </button>
        </div>
      ) : null}
      {isOwner && state.status === 0 ? (
        <div className="btn-row">
          <a className="btn" href="#/setup">
            Start a run
          </a>
          {state.idle > 0n ? (
            <button className="btn btn-secondary" disabled={tx.busy} onClick={() => tx.send('Withdraw', { address: vault, abi: vaultAbi, functionName: 'withdraw' })}>
              Withdraw
            </button>
          ) : null}
        </div>
      ) : null}
      {isOwner && showDeposit ? (
        <div className="row wrap">
          <input inputMode="decimal" placeholder="0.1" aria-label="ETH to add" value={depositText} onChange={(e) => setDepositText(e.target.value)} />
          <button
            className="btn-small"
            disabled={tx.busy || !deposit}
            onClick={async () => {
              if (await tx.send('Deposit', { address: vault, abi: vaultAbi, functionName: 'deposit', value: deposit! })) {
                setDepositText('');
                setShowDeposit(false);
              }
            }}
          >
            Add
          </button>
        </div>
      ) : null}
      <TxStatus state={tx.state} />
    </section>
  );
}

function RunFloorBar({ value, floor, start }: { value: bigint; floor: bigint; start: bigint }) {
  const b = floorBar(value, floor, start);
  return (
    <div className="floorbar-wrap" role="img" aria-label={`${formatEth(value)} ETH left. The run stops at ${formatEth(floor)} ETH.`}>
      <div className="floorbar">
        <div className="floorbar-fill" style={{ width: `${b.value * 100}%` }} />
        <div className="floorbar-mark" style={{ left: `calc(${b.floor * 100}% - 1px)` }} />
      </div>
      <div className="floorbar-legend">
        <span>Started with {formatEth(start, 2)}</span>
        <span className="stop">Stops at {formatEth(floor, 2)}</span>
      </div>
    </div>
  );
}

export function collectionName(address?: Address): string {
  if (!address) return 'Unknown collection';
  if (isPunks(address)) return 'CryptoPunk';
  return COLLECTIONS.find((c) => c.address.toLowerCase() === address.toLowerCase())?.name ?? `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function PullRow({
  card,
  listing,
  auction,
  stage,
  discountBps,
  onOpen,
}: {
  card: PullCard;
  listing?: ListingInfo;
  auction?: OpenAuction;
  stage?: number;
  discountBps: bigint;
  onOpen: () => void;
}) {
  const now = useNow(1000);
  const { image, bg } = useNftImage(listing?.collection, listing?.tokenId);
  const name = listing ? `${collectionName(listing.collection)} #${listing.tokenId.toString()}` : 'Pull';
  const paid = card.spentPerPull;

  if (card.status === 'pending') {
    // FWA acquisition status: 2 or 5 mean the draw landed and it is being settled; anything else is
    // still waiting for the draw. Show that as steps on a progress bar (requested, draw, settle).
    const drawn = stage === 2 || stage === 5;
    return (
      <div className="pull-row">
        <div className="pull-thumb pending" />
        <div className="pull-body">
          <div className="pull-name">{drawn ? 'Drawn' : 'Pulling now'}</div>
          <div className="pull-status pending-status">
            {drawn ? 'Settling the result' : 'Waiting for the draw'}
            <span className="dots" aria-hidden="true" />
          </div>
          <div className="pull-progress" role="progressbar" aria-valuemin={0} aria-valuemax={3} aria-valuenow={drawn ? 2 : 1}>
            <div className="pull-progress-fill" style={{ width: drawn ? '66%' : '33%' }} />
          </div>
        </div>
        {paid !== undefined ? <div className="pull-figures"><div className="pull-sub">Paid {formatEth(paid, 3)} ETH</div></div> : null}
      </div>
    );
  }

  // Value the pull ended at, and profit or loss against what was paid.
  let statusEl: ReactNode;
  let valueLabel: string | undefined;
  let value: bigint | undefined;
  if (card.status === 'kept') {
    statusEl = (
      <span className="pull-status kept">
        <StarIcon /> Kept &middot; in your wallet
      </span>
    );
    value = listing?.value;
    valueLabel = 'Value';
  } else if (card.status === 'sold') {
    statusEl = <span className="pull-status">Sold back</span>;
    if (listing) value = (listing.value * discountBps) / 10_000n;
    valueLabel = 'Proceeds';
  } else if (card.status === 'auctioning') {
    const left = auction ? secondsLeft(auction.deadline, now) : 0;
    statusEl = <span className="pull-status auctioning">At auction &middot; ends in {left > 0 ? formatDuration(left) : 'soon'}</span>;
    if (auction) value = auction.highBid > 0n ? auction.highBid : auction.backstop;
    valueLabel = 'Bid';
  } else if (card.status === 'forced') {
    statusEl = <span className="pull-status">Handled by FWA</span>;
    value = listing?.value;
    valueLabel = 'Value';
  } else {
    statusEl = <span className="pull-status">Refunded</span>;
    value = paid;
    valueLabel = 'Refunded';
  }
  const pnl = paid !== undefined && value !== undefined ? value - paid : undefined;

  return (
    <button className="pull-row" onClick={onOpen}>
      <div className="pull-thumb" style={{ background: bg }}>
        {image ? <img src={image} alt="" /> : null}
      </div>
      <div className="pull-body">
        <div className="pull-name">{name}</div>
        {statusEl}
        {paid !== undefined ? <div className="pull-sub">Paid {formatEth(paid, 3)} ETH</div> : null}
      </div>
      <div className="pull-figures">
        {value !== undefined ? (
          <div className="pull-val">
            {valueLabel} {formatEth(value, 3)} ETH
          </div>
        ) : null}
        {pnl !== undefined ? (
          <div className={`pull-pnl ${pnl >= 0n ? 'pos' : 'neg'}`}>
            {pnl >= 0n ? '+' : '−'}
            {formatEth(pnl < 0n ? -pnl : pnl, 3)} ETH
          </div>
        ) : null}
      </div>
    </button>
  );
}

function StarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />
    </svg>
  );
}

function MoreSection({
  vault,
  state,
  settings,
  rawEvents,
  sold,
}: {
  vault: Address;
  state: VaultState;
  settings: VaultSettings;
  rawEvents: VaultEvent[];
  sold: number;
}) {
  const [open, setOpen] = useState(false);
  const tx = useTx();
  return (
    <div className="more-section">
      <button className="more-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="title">More</span>
        <ChevronDown open={open} />
      </button>
      {open ? (
        <div className="more-body">
          <p className="small muted">
            {sold} sold back so far. Fees paid: {formatEth(state.feesPaid, 6)} ETH.
          </p>
          <Settings vault={vault} state={state} settings={settings} />
          <Sweep vault={vault} fwa={state.fwa} events={rawEvents} />
          {!state.rewardsRegistered ? (
            <Section title="Rewards">
              <p className="small">Not registered for FWA epoch rewards yet. Anyone can send this once the reward vault allows this factory.</p>
              <button
                className="btn-small"
                disabled={tx.busy}
                onClick={() => tx.send('Register rewards', { address: vault, abi: vaultAbi, functionName: 'registerRewards' })}
              >
                Register rewards
              </button>
              <TxStatus state={tx.state} />
            </Section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ChevronDown({ open }: { open: boolean }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      style={{ transform: open ? 'rotate(180deg)' : undefined }}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
