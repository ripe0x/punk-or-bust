import { useState } from 'react';
import { useAccount } from 'wagmi';
import type { Address } from 'viem';
import { vaultAbi } from '../abi/Vault';
import { useOpenAuctions, type OpenAuction } from '../hooks/useAuctions';
import { useNftImage } from '../hooks/useNftImage';
import { useNow } from '../hooks/useNow';
import { useTx } from '../hooks/useTx';
import { bidExtends, secondsLeft } from '../lib/auction';
import { formatDuration, formatEth, parseEthInput } from '../lib/format';
import { collectionName } from './Run';
import { TxStatus } from './ui';

export function Auctions() {
  const { address } = useAccount();
  const { auctions, credits, loading, error } = useOpenAuctions(address);

  return (
    <>
      <section className="section">
        <h1 className="big">Auctions</h1>
        <p className="lede">Pulls likely worth more than their sell-back price. Each one runs up to an hour.</p>
      </section>
      {credits.map((c) => (
        <section key={c.vault} style={{ padding: '0 12px 16px' }}>
          <OutbidBanner vault={c.vault} amount={c.amount} me={address} />
        </section>
      ))}
      {error ? (
        <p className="field-error" style={{ padding: '0 20px' }}>
          {error}
        </p>
      ) : null}
      {loading && !auctions.length ? <p className="empty">Loading auctions.</p> : null}
      {!loading && !auctions.length ? <p className="empty">No open auctions right now.</p> : null}
      <div className="lots" aria-label="Open auctions">
        {auctions.map((a) => (
          <Lot key={`${a.vault}:${a.requestId}`} a={a} me={address} />
        ))}
      </div>
    </>
  );
}

function OutbidBanner({ vault, amount, me }: { vault: Address; amount: bigint; me?: Address }) {
  const tx = useTx();
  return (
    <div className="outbid-banner">
      <div>
        <div className="title">You were outbid</div>
        <div className="sub">
          <span className="mono" style={{ color: '#f4f2ec' }}>
            {formatEth(amount, 4)} ETH
          </span>{' '}
          is ready to claim
        </div>
      </div>
      <button disabled={!me || tx.busy} onClick={() => tx.send('Claim refund', { address: vault, abi: vaultAbi, functionName: 'claimBidRefund', args: [me!] })}>
        Claim
      </button>
    </div>
  );
}

function Lot({ a, me }: { a: OpenAuction; me?: Address }) {
  const tx = useTx();
  const now = useNow(1000);
  const { image, bg } = useNftImage(a.collection, a.tokenId);
  const [text, setText] = useState('');
  const value = text ? parseEthInput(text) : a.minNextBid;
  const left = secondsLeft(a.deadline, now);
  const ended = left === 0;
  const leading = !!me && a.highBidder.toLowerCase() === me.toLowerCase();
  const tooLow = value !== null && value < a.minNextBid;
  const name = `${collectionName(a.collection)} #${a.tokenId.toString()}`;

  return (
    <div className="lot">
      <div className="lot-image">
        <div style={{ position: 'absolute', inset: 0, background: bg }}>{image ? <img src={image} alt={name} /> : null}</div>
        <div className="lot-timer">
          <span className="dot" />
          {ended ? 'ended' : formatDuration(left)}
        </div>
      </div>
      <div className="lot-body">
        <div className="lot-name">{name}</div>
        <div className="lot-next">
          <span className="cap">{leading ? 'You are leading' : 'Next bid'}</span>
          <span className="value num">{formatEth(a.minNextBid, 2)} ETH</span>
        </div>
        {ended ? (
          <button
            className="btn-small"
            disabled={!me || tx.busy}
            onClick={() => tx.send('Finalize', { address: a.vault, abi: vaultAbi, functionName: 'finalizeAuction', args: [a.requestId] })}
          >
            Finalize
          </button>
        ) : (
          <div className="lot-bid-form">
            <input aria-label="Bid in ETH" inputMode="decimal" placeholder={formatEth(a.minNextBid, 4)} value={text} onChange={(e) => setText(e.target.value)} />
            <button
              className="btn-small"
              disabled={!me || tx.busy || value === null || tooLow}
              onClick={() => tx.send('Bid', { address: a.vault, abi: vaultAbi, functionName: 'bid', args: [a.requestId], value: value! })}
            >
              {me ? 'Bid' : 'Connect to bid'}
            </button>
            {tooLow ? <span className="field-error">At least {formatEth(a.minNextBid, 4)} ETH.</span> : null}
            {bidExtends(a.deadline, now) ? <span className="hint-text">A bid now adds 5 minutes.</span> : null}
          </div>
        )}
        <TxStatus state={tx.state} />
      </div>
    </div>
  );
}
