import { useEffect, useRef, useState } from 'react';
import { useAccount } from 'wagmi';
import { configProblems, factoryAddress } from './config';
import { addressUrl } from './lib/links';
import { navigate, useRoute, type Route } from './router';
import { useOwnerVault } from './hooks/useVault';
import { Auctions } from './components/Auctions';
import { Brand } from './components/Brand';
import { Connect } from './components/Connect';
import { Faq } from './components/Faq';
import { Home } from './components/Home';
import { Run } from './components/Run';
import { Setup } from './components/Setup';

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
          <Brand />
          <NavMenu page={route.page} />
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
          {factoryAddress ? (
            <a href={addressUrl(factoryAddress)} target="_blank" rel="noreferrer">
              Factory
            </a>
          ) : null}
          <a href="#source">Source</a>
          <span>Built on FWA</span>
        </footer>
      ) : null}
    </div>
  );
}

function NavMenu({ page }: { page: Route['page'] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);
  return (
    <div className="nav-menu" ref={ref}>
      <button type="button" className="nav-toggle" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
      {open ? (
        <nav className="nav-panel" aria-label="Main" onClick={() => setOpen(false)}>
          <a href="/run" className={page === 'run' ? 'active' : ''}>
            My run
          </a>
          <a href="/auctions" className={page === 'auctions' ? 'active' : ''}>
            Auctions
          </a>
          <a href="/faq" className={page === 'faq' ? 'active' : ''}>
            FAQ
          </a>
          <div className="nav-panel-connect">
            <Connect />
          </div>
        </nav>
      ) : null}
    </div>
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
