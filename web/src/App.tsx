import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { getAddress, isAddress, type Address } from 'viem';
import { configProblems } from './config';
import { useOwnerVault } from './hooks/useVault';
import { Auctions } from './components/Auctions';
import { Connect } from './components/Connect';
import { Faq } from './components/Faq';
import { Home } from './components/Home';
import { Run } from './components/Run';
import { Setup } from './components/Setup';
import { useNftImage } from './hooks/useNftImage';
import { PUNKS_721 } from './lib/collections';

type Route = { page: 'home' } | { page: 'setup' } | { page: 'run' } | { page: 'auctions' } | { page: 'faq' } | { page: 'view'; vault: Address };

function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, '');
  if (h === 'setup') return { page: 'setup' };
  if (h === 'run') return { page: 'run' };
  if (h === 'faq') return { page: 'faq' };
  if (h.startsWith('auctions')) return { page: 'auctions' };
  const m = h.match(/^vault\/(0x[0-9a-fA-F]{40})$/);
  if (m && isAddress(m[1], { strict: false })) return { page: 'view', vault: getAddress(m[1]) };
  return { page: 'home' };
}

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function App() {
  const route = useRoute();
  const [notice, setNotice] = useState<string | null>(null);
  const { address, isConnected } = useAccount();
  const { vault, predicted, loading, refetch } = useOwnerVault(address);

  const showHeader = route.page !== 'setup';

  return (
    <div className="shell">
      {showHeader ? (
        <header className="top">
          <a href="#/" className="brand">
            <BrandMark />
            <span className="brand-name">Punk or Bust</span>
          </a>
          <nav aria-label="Main">
            <a href="#/run" className={route.page === 'run' ? 'active' : ''}>
              My run
            </a>
            <a href="#/auctions" className={route.page === 'auctions' ? 'active' : ''}>
              Auctions
            </a>
          </nav>
          <Connect />
        </header>
      ) : null}
      <main className="page">
        {configProblems.length ? (
          <div className="banner">
            {configProblems.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>
        ) : null}
        {notice && route.page === 'run' ? (
          <div className="banner" role="status">
            <p>{notice}</p>
          </div>
        ) : null}
        {route.page === 'home' ? <Home /> : null}
        {route.page === 'setup' ? (
          <Setup
            isConnected={isConnected}
            vault={vault}
            predicted={predicted}
            loading={loading}
            onDone={(msg) => {
              setNotice(msg ?? null);
              void refetch();
              window.location.hash = '#/run';
            }}
          />
        ) : null}
        {route.page === 'run' ? (
          isConnected && address ? (
            loading ? (
              <p className="empty">Looking up your run.</p>
            ) : vault ? (
              <Run vault={vault} viewer={address} />
            ) : (
              <NoRunYet />
            )
          ) : (
            <p className="empty">Connect a wallet to see your run.</p>
          )
        ) : null}
        {route.page === 'auctions' ? <Auctions /> : null}
        {route.page === 'faq' ? <Faq /> : null}
        {route.page === 'view' ? <Run vault={route.vault} viewer={address} /> : null}
      </main>
      {route.page !== 'setup' ? (
        <footer className="site">
          <a href="#/faq">FAQ</a>
          <a href="#contracts">Contracts</a>
          <a href="#source">Source</a>
          <span>Built on FWA</span>
        </footer>
      ) : null}
    </div>
  );
}

function BrandMark() {
  const { image, bg } = useNftImage(PUNKS_721, 1042n);
  return (
    <span className="brand-mark" style={{ background: bg }} aria-hidden="true">
      {image ? <img src={image} alt="" /> : null}
    </span>
  );
}

function NoRunYet() {
  return (
    <div className="empty">
      <p>You do not have a run yet.</p>
      <a className="btn-link" href="#/setup">
        Start a run
      </a>
    </div>
  );
}
