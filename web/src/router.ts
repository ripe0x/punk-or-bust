import { useEffect, useState } from 'react';
import { getAddress, isAddress, type Address } from 'viem';

export type Route =
  | { page: 'home' }
  | { page: 'setup' }
  | { page: 'run' }
  | { page: 'auctions' }
  | { page: 'faq' }
  | { page: 'view'; vault: Address };

export function parsePath(pathname: string): Route {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/setup') return { page: 'setup' };
  if (p === '/run') return { page: 'run' };
  if (p === '/faq') return { page: 'faq' };
  if (p === '/auctions') return { page: 'auctions' };
  const m = p.match(/^\/vault\/(0x[0-9a-fA-F]{40})$/);
  if (m && isAddress(m[1], { strict: false })) return { page: 'view', vault: getAddress(m[1]) };
  return { page: 'home' };
}

/** Client-side navigation: push the path and let listeners re-read the route. */
export function navigate(to: string): void {
  if (to !== window.location.pathname) window.history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parsePath(window.location.pathname));
  useEffect(() => {
    const on = () => setRoute(parsePath(window.location.pathname));
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return route;
}
