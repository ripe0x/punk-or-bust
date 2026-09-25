import type { AbiEvent } from 'viem';
import { factoryAbi } from '../abi/VaultFactory';
import { vaultAbi } from '../abi/Vault';

const pick = (abi: readonly { type: string; name?: string }[], names?: string[]) =>
  abi.filter((x) => x.type === 'event' && (!names || names.includes(x.name!))) as unknown as AbiEvent[];

export const VAULT_EVENTS = pick(vaultAbi);
export const AUCTION_EVENTS = pick(vaultAbi, ['AuctionStarted', 'AuctionFinalized']);
export const REFUND_EVENTS = pick(vaultAbi, ['BidRefunded']);
export const VAULT_CREATED = pick(factoryAbi, ['VaultCreated']);
