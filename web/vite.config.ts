import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  // React, viem, wagmi and RainbowKit are about 725 kB before gzip in the entry chunk. Wallet SDKs
  // (WalletConnect, MetaMask, Coinbase) and RainbowKit locales load lazily as separate chunks.
  build: { chunkSizeWarningLimit: 800 },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
