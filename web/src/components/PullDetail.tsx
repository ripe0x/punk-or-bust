import type { Address } from 'viem';
import { useCollectionPrice } from '../hooks/useCollectionPrices';
import { useFactoryFwa } from '../hooks/useVault';
import type { ListingInfo } from '../hooks/useVault';
import { useNftImage } from '../hooks/useNftImage';
import { useNow } from '../hooks/useNow';
import type { OpenAuction } from '../lib/auction';
import { secondsLeft } from '../lib/auction';
import type { PullCard } from '../lib/events';
import { pullFee } from '../lib/floor';
import { formatDuration, formatEth, shortAddr } from '../lib/format';
import { addressUrl, txUrl } from '../lib/links';
import { collectionName } from './Run';

export function PullDetail({
  card,
  listing,
  auction,
  discountBps,
  owner,
  onClose,
}: {
  card: PullCard;
  listing?: ListingInfo;
  auction?: OpenAuction;
  discountBps: bigint;
  owner: Address;
  onClose: () => void;
}) {
  const fwa = useFactoryFwa();
  const price = useCollectionPrice(fwa, listing?.collection);
  const { image, bg } = useNftImage(listing?.collection, listing?.tokenId);
  const now = useNow(1000);

  const name = listing ? `${collectionName(listing.collection)} #${listing.tokenId.toString()}` : 'Pull';
  const fee = card.spentPerPull !== undefined ? pullFee(card.spentPerPull) : undefined;

  const rows: { k: string; v: string }[] = [];
  if (card.spentPerPull !== undefined) rows.push({ k: 'Pull price', v: `${formatEth(card.spentPerPull, 5)} ETH` });
  if (card.status === 'kept') {
    if (price) rows.push({ k: 'Pool price', v: `${formatEth(price.askWei, 2)} ETH` });
    if (fee !== undefined) rows.push({ k: 'Fee', v: `${formatEth(fee, 6)} ETH` });
    rows.push({ k: 'Sent to', v: shortAddr(owner) });
  } else if (card.status === 'sold') {
    if (listing) rows.push({ k: 'Sold for', v: `${formatEth((listing.value * discountBps) / 10_000n, 4)} ETH` });
    if (fee !== undefined) rows.push({ k: 'Fee', v: `${formatEth(fee, 6)} ETH` });
  } else if (card.status === 'auctioning' && auction) {
    rows.push({ k: 'Backstop', v: `${formatEth(auction.backstop, 4)} ETH` });
    rows.push({ k: 'Current bid', v: auction.highBid > 0n ? `${formatEth(auction.highBid, 4)} ETH` : 'No bids yet' });
    const left = secondsLeft(auction.deadline, now);
    rows.push({ k: 'Ends in', v: left > 0 ? formatDuration(left) : 'Ended' });
  } else if (fee !== undefined) {
    rows.push({ k: 'Fee', v: `${formatEth(fee, 6)} ETH` });
  }

  const blurb =
    card.status === 'kept'
      ? `${collectionName(listing?.collection)} is on your keep list, so this one went straight to your wallet.`
      : card.status === 'sold'
        ? "This one wasn't on your keep list, so it sold back to the pool."
        : card.status === 'auctioning'
          ? "The pool price says this one is worth more than the sell-back price, so it's up for auction."
          : card.status === 'forced'
            ? 'FWA resolved this one on its own path. It is handled automatically.'
            : card.status === 'refunded'
              ? 'This pull was refunded; nothing was charged.'
              : 'Waiting for the draw.';

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div role="dialog" aria-label="Pull details" className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grab" />
        <div className="detail-head">
          <div className="detail-thumb" style={{ background: bg }}>
            {image ? <img src={image} alt={name} /> : null}
          </div>
          <div className="detail-info">
            <div className="detail-title">{name}</div>
            <span className={`tag ${card.status === 'kept' ? '' : 'neutral'}`}>
              {card.status === 'kept' ? (
                <>
                  <StarIcon /> Kept
                </>
              ) : (
                statusLabel(card.status)
              )}
            </span>
          </div>
        </div>
        <p className="detail-text">{blurb}</p>
        {rows.length ? (
          <dl className="detail-rows">
            {rows.map((r) => (
              <div className="detail-row" key={r.k}>
                <dt>{r.k}</dt>
                <dd className="mono">{r.v}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <div className="detail-links">
          <a href={txUrl(card.txHash)} target="_blank" rel="noreferrer">
            View on evm.now
            <ExternalIcon />
          </a>
          {listing ? (
            <a href={addressUrl(listing.collection)} target="_blank" rel="noreferrer">
              View collection
            </a>
          ) : null}
        </div>
        <button className="btn btn-secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

function statusLabel(status: PullCard['status']): string {
  switch (status) {
    case 'sold':
      return 'Sold back';
    case 'auctioning':
      return 'At auction';
    case 'forced':
      return 'Handled by FWA';
    case 'refunded':
      return 'Refunded';
    default:
      return 'Pending';
  }
}

function StarIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M7 17L17 7M9 7h8v8" />
    </svg>
  );
}
