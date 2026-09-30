import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { configProblems } from './config';
import { navigate, useRoute } from './router';
import { useOwnerVault } from './hooks/useVault';
import { Auctions } from './components/Auctions';
import { Connect } from './components/Connect';
import { Faq } from './components/Faq';
import { Home } from './components/Home';
import { Run } from './components/Run';
import { Setup } from './components/Setup';
import { useNftImage } from './hooks/useNftImage';
import { PUNKS_721 } from './lib/collections';

// Intercept clicks on internal links so path-based hrefs navigate without a full page load.
function useLinkNavigation() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest('a');
      if (!a) return;
      const href = a.getAttribute('href');
      if (!href || !href.startsWith('/') || a.target === '_blank' || a.hasAttribute('download')) return;
      if (a.origin !== window.location.origin) return;
      e.preventDefault();
      navigate(href);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);
}

export function App() {
  const route = useRoute();
  useLinkNavigation();
  const [notice, setNotice] = useState<string | null>(null);
  const { address, isConnected } = useAccount();
  const { vault, predicted, loading, refetch } = useOwnerVault(address);

  const showHeader = route.page !== 'setup';

  return (
    <div className="shell">
      {showHeader ? (
        <header className="top">
          <a href="/" className="brand">
            <BrandMark />
            <span className="brand-name">Punk or Bust</span>
          </a>
          <nav aria-label="Main">
            <a href="/run" className={route.page === 'run' ? 'active' : ''}>
              My run
            </a>
            <a href="/auctions" className={route.page === 'auctions' ? 'active' : ''}>
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
              navigate('/run');
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
          <a href="/faq">FAQ</a>
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
      <a className="btn-link" href="/setup">
        Start a run
      </a>
    </div>
  );
}
