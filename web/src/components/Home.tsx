import { useReadContract } from 'wagmi';
import { fwaAbi } from '../abi/IFWA';
import { useFactoryFwa, useQuote } from '../hooks/useVault';
import { useNftImage } from '../hooks/useNftImage';
import { PUNKS_721 } from '../lib/collections';
import { formatEth } from '../lib/format';

const DECORATIVE_PUNKS = [1042n, 7804n];

export function Home() {
  const fwa = useFactoryFwa();
  const quote = useQuote(fwa);
  const count = useReadContract({
    address: fwa,
    abi: fwaAbi,
    functionName: 'activeListingCount',
    query: { enabled: !!fwa, refetchInterval: 30_000 },
  });

  return (
    <>
      <section className="hero">
        <h1>Pull from the pool. Keep what you love. Sell back the rest.</h1>
        <p>Put in some ETH and your run makes the pulls for you. Anything you don&apos;t keep is sold back, and that ETH goes into more pulls.</p>
        <a className="btn" href="#/setup">
          Start a run
          <ArrowRight />
        </a>
      </section>
      <section aria-label="A few NFTs from the pool" className="strip">
        <div role="img" aria-label="A few NFTs in the pool right now" className="strip-row">
          <PunkTile id={DECORATIVE_PUNKS[0]} />
          <div className="strip-tile" style={{ background: '#e9d8b4', display: 'flex', alignItems: 'flex-end', padding: 10, fontSize: 11, color: '#6b5a36' }}>
            Autoglyphs
          </div>
          <PunkTile id={DECORATIVE_PUNKS[1]} />
          <div className="strip-tile" style={{ background: '#c9d6c1' }} />
        </div>
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

function PunkTile({ id }: { id: bigint }) {
  const { image, bg } = useNftImage(PUNKS_721, id);
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
