import { chain } from '../config';

const EXPLORER = 'https://evm.now';

export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}?chainId=${chain.id}`;
export const addressUrl = (addr: string) => `${EXPLORER}/address/${addr}?chainId=${chain.id}`;
