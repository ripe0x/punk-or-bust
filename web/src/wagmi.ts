import { connectorsForWallets, getDefaultWallets, type WalletList } from '@rainbow-me/rainbowkit';
import {
  braveWallet,
  coinbaseWallet,
  injectedWallet,
  rabbyWallet,
  safeWallet,
} from '@rainbow-me/rainbowkit/wallets';
import { createConfig, http } from 'wagmi';
import { chain, rpcUrl, walletConnectProjectId } from './config';

const appName = 'Punk or Bust';

// Without a WalletConnect project id, list only wallets that connect without one. Installed
// wallets that announce themselves over EIP-6963 are added to the modal either way.
const noProjectIdWallets: WalletList = [
  { groupName: 'Installed', wallets: [injectedWallet, rabbyWallet, braveWallet, safeWallet, coinbaseWallet] },
];

if (!walletConnectProjectId) {
  console.warn('VITE_WALLETCONNECT_PROJECT_ID is not set: WalletConnect and mobile wallets are disabled.');
}

const connectors = connectorsForWallets(
  walletConnectProjectId ? getDefaultWallets().wallets : noProjectIdWallets,
  { appName, projectId: walletConnectProjectId ?? '' },
);

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors,
  multiInjectedProviderDiscovery: true,
  transports: { [chain.id]: http(rpcUrl) },
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
