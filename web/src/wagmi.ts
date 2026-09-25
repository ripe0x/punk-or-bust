import { createConfig, http } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { chain, rpcUrl } from './config';

// Injected wallets only. EIP-6963 discovery adds each installed wallet as its own connector.
export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: [injected()],
  multiInjectedProviderDiscovery: true,
  transports: { [chain.id]: http(rpcUrl) },
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
