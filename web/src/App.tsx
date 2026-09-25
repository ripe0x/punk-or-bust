import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { getAddress, isAddress, type Address } from 'viem';
import { chain, configProblems } from './config';
import { useOwnerVault } from './hooks/useVault';
import { Auctions } from './components/Auctions';
import { Connect } from './components/Connect';
import { CreateVault } from './components/CreateVault';
import { Dashboard } from './components/Dashboard';
import { Section } from './components/ui';

type Route = { page: 'vault' } | { page: 'auctions' } | { page: 'view'; vault: Address };

function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, '');
  if (h.startsWith('auctions')) return { page: 'auctions' };
  const m = h.match(/^vault\/(0x[0-9a-fA-F]{40})$/);
  if (m && isAddress(m[1], { strict: false })) return { page: 'view', vault: getAddress(m[1]) };
  return { page: 'vault' };
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
  return (
    <>
      <header className="top">
        <div className="brand">Punk or Bust</div>
        <nav>
          <a href="#/" className={route.page !== 'auctions' ? 'active' : ''}>
            Vault
          </a>
          <a href="#/auctions" className={route.page === 'auctions' ? 'active' : ''}>
            Auctions
          </a>
        </nav>
        <Connect />
      </header>
      <main>
        {configProblems.length ? (
          <div className="banner">
            {configProblems.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>
        ) : null}
        {route.page === 'auctions' ? <Auctions /> : route.page === 'view' ? <ViewVault vault={route.vault} /> : <MyVault />}
      </main>
      <footer className="small muted">
        FWA V2 pull vaults on {chain.name}. Pull fee 0.025%. Contracts have no admin.
      </footer>
    </>
  );
}

function MyVault() {
  const { address, isConnected } = useAccount();
  const { vault, predicted, loading, refetch } = useOwnerVault(address);
  const [pendingCeiling, setPendingCeiling] = useState<bigint | null>(null);
  if (!isConnected || !address) {
    return (
      <Section title="Your vault">
        <p>Connect a wallet to see your vault or create one. You can browse open auctions without a wallet.</p>
      </Section>
    );
  }
  if (loading) return <p className="muted">Looking up your vault.</p>;
  if (vault) {
    return <Dashboard vault={vault} viewer={address} pendingCeiling={pendingCeiling} onCeilingDone={() => setPendingCeiling(null)} />;
  }
  return (
    <CreateVault
      predicted={predicted}
      onCreated={(ceiling) => {
        setPendingCeiling(ceiling);
        void refetch();
      }}
    />
  );
}

function ViewVault({ vault }: { vault: Address }) {
  const { address } = useAccount();
  return <Dashboard vault={vault} viewer={address} />;
}
