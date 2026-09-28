import { useState, type ReactNode } from 'react';
import { useReadContract } from 'wagmi';
import type { Address } from 'viem';
import { fwaAbi } from '../abi/IFWA';
import { vaultAbi } from '../abi/Vault';
import { useTx } from '../hooks/useTx';
import { useListings, useVaultAuctions, useVaultEvents, useVaultState, type ListingInfo, type VaultState } from '../hooks/useVault';
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

const PAGE = 6;

export function Run({ vault, viewer }: { vault: Address; viewer?: Address }) {
  const { state, loading, error } = useVaultState(vault);
  const events = useVaultEvents(vault);
  const [shown, setShown] = useState(PAGE);
  const [openDetail, setOpenDetail] = useState<bigint | null>(null);

  const discount = useReadContract({
    address: state?.fwa,
    abi: fwaAbi,
    functionName: 'settlementDiscountBps',
    query: { enabled: !!state?.fwa, staleTime: 60_000 },
  });

  const pulls = pullCardsFromEvents(events.events);
  const listingIds = [...new Set(pulls.filter((p) => p.listingId !== undefined).map((p) => p.listingId!))];
  const listings = useListings(state?.fwa, listingIds);
  const auctions = useVaultAuctions(vault);

  if (!state) {
    return <p className="empty">{loading ? 'Loading your run.' : (friendlyLoadError(error) ?? 'No run found here.')}</p>;
  }
  const isOwner = !!viewer && viewer.toLowerCase() === state.owner.toLowerCase();
  const discountBps = (discount.data as bigint | undefined) ?? 9_000n;

  const sold = pulls.filter((p) => p.status === 'sold').length;
  const detailCard = openDetail !== null ? pulls.find((p) => p.requestId === openDetail) : undefined;

  return (
    <>
      <RunCard vault={vault} state={state} isOwner={isOwner} windDownReason={events.windDownReason} />
      <section className="pulls-section" aria-label="Your pulls">
        <div className="pulls-head">
          <h2>Your pulls</h2>
          <span className="note">Newest first</span>
        </div>
        {pulls.length === 0 ? <p className="empty">No pulls yet.</p> : null}
        {pulls.slice(0, shown).map((p) => (
          <PullRow
            key={p.requestId.toString()}
            card={p}
            listing={p.listingId !== undefined ? listings[p.listingId.toString()] : undefined}
            auction={auctions[p.requestId.toString()]}
            discountBps={discountBps}
            onOpen={() => setOpenDetail(p.requestId)}
          />
        ))}
        {pulls.length > shown ? (
          <button className="btn-link" style={{ alignSelf: 'center' }} onClick={() => setShown((s) => s + PAGE)}>
            Show older pulls
          </button>
        ) : null}
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
          {formatEth(running || windingDown ? state.runValue : state.idle, 3)}
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
  discountBps,
  onOpen,
}: {
  card: PullCard;
  listing?: ListingInfo;
  auction?: OpenAuction;
  discountBps: bigint;
  onOpen: () => void;
}) {
  const now = useNow(1000);
  const { image, bg } = useNftImage(listing?.collection, listing?.tokenId);
  const name = listing ? `${collectionName(listing.collection)} #${listing.tokenId.toString()}` : 'Pull';

  if (card.status === 'pending') {
    return (
      <div className="pull-row">
        <div className="pull-thumb pending" />
        <div className="pull-body">
          <div className="pull-name">Pulling now</div>
          <div className="pull-status">Waiting for the draw</div>
        </div>
      </div>
    );
  }

  let statusEl: ReactNode;
  let amount: string | undefined;
  if (card.status === 'kept') {
    statusEl = (
      <span className="pull-status kept">
        <StarIcon /> Kept &middot; in your wallet
      </span>
    );
  } else if (card.status === 'sold') {
    statusEl = <span className="pull-status">Sold back</span>;
    if (listing) amount = `+${formatEth((listing.value * discountBps) / 10_000n, 3)}`;
  } else if (card.status === 'auctioning') {
    const left = auction ? secondsLeft(auction.deadline, now) : 0;
    statusEl = <span className="pull-status auctioning">At auction &middot; ends in {left > 0 ? formatDuration(left) : 'soon'}</span>;
    if (auction) amount = `bid ${formatEth(auction.highBid > 0n ? auction.highBid : auction.backstop, 2)}`;
  } else if (card.status === 'forced') {
    statusEl = <span className="pull-status">Handled by FWA</span>;
  } else {
    statusEl = <span className="pull-status">Refunded</span>;
  }

  return (
    <button className="pull-row" onClick={onOpen}>
      <div className="pull-thumb" style={{ background: bg }}>
        {image ? <img src={image} alt="" /> : null}
      </div>
      <div className="pull-body">
        <div className="pull-name">{name}</div>
        {statusEl}
      </div>
      {amount ? <div className="pull-amount">{amount}</div> : null}
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
