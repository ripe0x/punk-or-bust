import { useSyncExternalStore, type ReactNode } from 'react';
import { RainbowKitProvider, darkTheme, lightTheme } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';

const query = '(prefers-color-scheme: dark)';
const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query) : undefined;

function subscribe(onChange: () => void) {
  media?.addEventListener('change', onChange);
  return () => media?.removeEventListener('change', onChange);
}

const isDark = () => media?.matches ?? false;

// Accent colors match --accent in styles.css.
const light = lightTheme({ accentColor: '#3355dd', accentColorForeground: '#ffffff', borderRadius: 'small' });
const dark = darkTheme({ accentColor: '#7d95ff', accentColorForeground: '#0d0e10', borderRadius: 'small' });

export function WalletUi({ children }: { children: ReactNode }) {
  const dark_ = useSyncExternalStore(subscribe, isDark, () => false);
  return (
    <RainbowKitProvider theme={dark_ ? dark : light} modalSize="compact">
      {children}
    </RainbowKitProvider>
  );
}
