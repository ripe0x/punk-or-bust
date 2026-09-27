import type { ReactNode } from 'react';
import { RainbowKitProvider, lightTheme } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';

// Light mode only, matching the design tokens in styles.css (--accent, radius).
const theme = lightTheme({ accentColor: '#e8531f', accentColorForeground: '#f4f2ec', borderRadius: 'medium' });

export function WalletUi({ children }: { children: ReactNode }) {
  return (
    <RainbowKitProvider theme={theme} modalSize="compact">
      {children}
    </RainbowKitProvider>
  );
}
