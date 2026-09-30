import { useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import { useAccount, useReadContract } from 'wagmi';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { fwaAbi } from '../abi/IFWA';
import { useFactoryFwa, useQuote } from '../hooks/useVault';
import { useNftImage } from '../hooks/useNftImage';
import { imageApi } from '../config';
import { formatEth } from '../lib/format';

type PoolItem = { collection: Address; tokenId: bigint };

/** A few NFTs that are in the pool right now, CryptoPunks first. Empty when no image API is set or it fails. */
function usePoolSample(count: number): PoolItem[] {
  const [items, setItems] = useState<PoolItem[]>([]);
  useEffect(() => {
    if (!imageApi) return;
    let cancelled = false;
    fetch(`${imageApi}/live/fwa/mosaic`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { items?: { collection: string; tokenId: string; punk: boolean }[] } | null) => {
        if (cancelled || !d?.items) return;
        const sorted = [...d.items.filter((i) => i.punk), ...d.items.filter((i) => !i.punk)];
        setItems(sorted.slice(0, count).map((i) => ({ collection: i.collection as Address, tokenId: BigInt(i.tokenId) })));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [count]);
  return items;
}

export function Home() {
  const fwa = useFactoryFwa();
  const { data: quote } = useQuote(fwa);
  const pool = usePoolSample(4);
  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const wantsSetup = useRef(false);
  useEffect(() => {
    if (isConnected && wantsSetup.current) {
      wantsSetup.current = false;
      window.location.hash = '#/setup';
    }
  }, [isConnected]);
  const count = useReadContract({
    address: fwa,
    abi: fwaAbi,
    functionName: 'activeListingCount',
    query: { enabled: !!fwa, refetchInterval: 30_000 },
  });

  return (
    <>
      <section className="hero">
        <h1>Pick collections. Pull from the pool. Keep your picks. Sell back the rest.</h1>
        <p>Put in some ETH and your run makes the pulls for you. Anything you don&apos;t keep is sold back, and that ETH goes into more pulls.</p>
        <a
          className="btn"
          href="#/setup"
          onClick={(e) => {
            if (isConnected || !openConnectModal) return;
            e.preventDefault();
            wantsSetup.current = true;
            openConnectModal();
          }}
        >
          Start a run
          <ArrowRight />
        </a>
      </section>
      <section aria-label="The pool" className="strip">
        {pool.length ? (
          <div aria-hidden="true" className="strip-row">
            {pool.map((item) => (
              <PoolTile key={`${item.collection}:${item.tokenId}`} item={item} />
            ))}
          </div>
        ) : null}
        <div className="strip-stats">
          <div className="strip-stat">
            <div className="value num">{count.data !== undefined ? (count.data as bigint).toLocaleString() : '...'}</div>
            <div className="label">NFTs in the pool</div>
          </div>
          <div className="strip-divider" />
          <div className="strip-stat">
            <div className="value num">{quote ? `${formatEth(quote.total)} ETH` : '...'}</div>
            <div className="label">a pull right now</div>
          </div>
        </div>
      </section>
      <section className="howitworks" aria-label="How it works">
        <h2>How it works</h2>
        <Step n={1} title="Pick what to keep" text="Choose the collections you'd actually want to own." />
        <Step n={2} title="Put in ETH" text="Set how much, and how far down you're willing to go." />
        <Step n={3} title="Pulls run on their own" text="Keeps go to your wallet. The rest sell back. Leftover ETH comes back to you." />
      </section>
    </>
  );
}

function PoolTile({ item }: { item: PoolItem }) {
  const { image, bg } = useNftImage(item.collection, item.tokenId);
  return (
    <div className="strip-tile" style={{ background: bg }}>
      {image ? <img src={image} alt="" /> : null}
    </div>
  );
}

function Step({ n, title, text }: { n: number; title: string; text: string }) {
  return (
    <div className="step">
      <div className="step-num">{n}</div>
      <div className="step-body">
        <div className="step-title">{title}</div>
        <div className="step-text">{text}</div>
      </div>
    </div>
  );
}

function ArrowRight() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}
