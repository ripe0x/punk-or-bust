import type { ReactNode } from 'react';
import { RainbowKitProvider, lightTheme } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';

// Light mode only, matching the design tokens in styles.css (--ink, radius). Orange (--accent) is
// reserved for live states, so the connect button uses the same ink as other primary buttons.
const theme = lightTheme({ accentColor: '#15140f', accentColorForeground: '#f4f2ec', borderRadius: 'medium' });

export function WalletUi({ children }: { children: ReactNode }) {
  return (
    <RainbowKitProvider theme={theme} modalSize="compact">
      {children}
    </RainbowKitProvider>
  );
}
