import { defineChain, isAddress, getAddress, type Address, type Chain } from 'viem';
import { foundry, mainnet, sepolia } from 'viem/chains';

const env = import.meta.env;

export const chainId = Number(env.VITE_CHAIN_ID || 1);
export const rpcUrl = env.VITE_RPC_URL || undefined;

const known = [mainnet, sepolia, foundry].find((c) => c.id === chainId);

export const chain: Chain =
  known ??
  defineChain({
    id: chainId,
    name: `Chain ${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: rpcUrl ? [rpcUrl] : [] } },
  });

const addr = (v?: string): Address | undefined => (v && isAddress(v) ? getAddress(v) : undefined);

export const factoryAddress = addr(env.VITE_FACTORY);
export const defaultKeeper = addr(env.VITE_DEFAULT_KEEPER);

/** First block to scan for factory and vault events. Set it to the factory deploy block. */
export const fromBlock = /^\d+$/.test(env.VITE_FROM_BLOCK ?? '') ? BigInt(env.VITE_FROM_BLOCK!) : 0n;

export const configProblems: string[] = [
  ...(factoryAddress ? [] : ['VITE_FACTORY is not set to a valid address.']),
  ...(rpcUrl || known ? [] : ['VITE_RPC_URL is not set.']),
];
