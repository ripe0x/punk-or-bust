import { useState } from 'react';
import { useAccount } from 'wagmi';
import type { Address } from 'viem';
import { vaultAbi } from '../abi/Vault';
import { useOpenAuctions, type OpenAuction } from '../hooks/useAuctions';
import { useNow } from '../hooks/useNow';
import { useTx } from '../hooks/useTx';
import { bidExtends, minNextBid, secondsLeft } from '../lib/auction';
import { formatDuration, formatEth, parseEthInput, shortId } from '../lib/format';
import { Addr, Eth, Section, TxStatus } from './ui';

export function Auctions() {
  const { address } = useAccount();
  const { auctions, credits, vaultCount, loading, error } = useOpenAuctions(address);
  const now = useNow(1000);

  return (
    <>
      <Section title="Open auctions">
        <p className="muted small">
          A pull the oracle says is clearly under-backed goes to a short auction instead of selling back. The opening bid is the FWA backstop plus
          5%, each bid at least 5% over the last. A bid in the last 5 minutes adds 5 minutes, up to a hard cap. Outbid ETH is refunded.
        </p>
        {error ? <p className="field-error">{error}</p> : null}
        {loading && !auctions.length ? <p className="muted">Loading auctions across {vaultCount} vaults.</p> : null}
        {!loading && !auctions.length ? <p className="muted">No open auctions across {vaultCount} vaults.</p> : null}
        <div className="auctions">
          {auctions.map((a) => (
            <AuctionCard key={`${a.vault}:${a.requestId}`} a={a} now={now} me={address} />
          ))}
        </div>
      </Section>
      {credits.length ? (
        <Section title="Your bid refunds">
          {credits.map((c) => (
            <RefundRow key={c.vault} vault={c.vault} amount={c.amount} me={address!} />
          ))}
        </Section>
      ) : null}
    </>
  );
}

function AuctionCard({ a, now, me }: { a: OpenAuction; now: number; me?: Address }) {
  const tx = useTx();
  const min = minNextBid(a.backstop, a.highBid);
  const [text, setText] = useState('');
  const value = text ? parseEthInput(text) : min;
  const left = secondsLeft(a.deadline, now);
  const ended = left === 0;
  const leading = !!me && a.highBidder.toLowerCase() === me.toLowerCase();
  const tooLow = value !== null && value < min;

  return (
    <article className="auction">
      <div className="auction-head">
        <div>
          {a.collection ? <Addr address={a.collection} /> : <span className="muted">Listing {shortId(a.listingId)}</span>}
          {a.tokenId !== undefined ? <span className="mono"> #{a.tokenId.toString()}</span> : null}
        </div>
        <span className={`pill ${ended ? 'pill-idle' : left < 300 ? 'pill-warn' : 'pill-good'}`}>{ended ? 'Ended' : formatDuration(left)}</span>
      </div>
      <dl className="kv small">
        <dt>Backstop</dt>
        <dd>
          <Eth wei={a.backstop} />
        </dd>
        <dt>High bid</dt>
        <dd>
          {a.highBid > 0n ? (
            <>
              <Eth wei={a.highBid} /> {leading ? <span className="pill pill-good">You</span> : <Addr address={a.highBidder} />}
            </>
          ) : (
            'None'
          )}
        </dd>
        <dt>Min next bid</dt>
        <dd>
          <Eth wei={min} />
        </dd>
        <dt>Vault</dt>
        <dd>
          <Addr address={a.vault} /> request {shortId(a.requestId)}
        </dd>
      </dl>
      {ended ? (
        <>
          <p className="small">Bidding closed. Anyone can finalize: the winner gets the NFT, or it sells back.</p>
          <button
            className="btn-small"
            disabled={!me || tx.busy}
            onClick={() => tx.send('Finalize', { address: a.vault, abi: vaultAbi, functionName: 'finalizeAuction', args: [a.requestId] })}
          >
            Finalize
          </button>
        </>
      ) : (
        <div className="row">
          <input
            aria-label="Bid in ETH"
            inputMode="decimal"
            placeholder={formatEth(min, 6)}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button
            disabled={!me || tx.busy || value === null || tooLow}
            onClick={() =>
              tx.send('Bid', { address: a.vault, abi: vaultAbi, functionName: 'bid', args: [a.requestId], value: value! })
            }
          >
            {me ? 'Bid' : 'Connect to bid'}
          </button>
        </div>
      )}
      {tooLow ? <p className="field-error">At least {formatEth(min, 6)} ETH.</p> : null}
      {!ended && bidExtends(a.deadline, now) ? <p className="small muted">A bid now adds 5 minutes.</p> : null}
      <TxStatus state={tx.state} />
    </article>
  );
}

function RefundRow({ vault, amount, me }: { vault: Address; amount: bigint; me: Address }) {
  const tx = useTx();
  return (
    <div className="row wrap">
      <span>
        <Eth wei={amount} /> from vault <Addr address={vault} />
      </span>
      <button
        className="btn-small"
        disabled={tx.busy}
        onClick={() => tx.send('Claim refund', { address: vault, abi: vaultAbi, functionName: 'claimBidRefund', args: [me] })}
      >
        Claim to my wallet
      </button>
      <TxStatus state={tx.state} />
    </div>
  );
}
