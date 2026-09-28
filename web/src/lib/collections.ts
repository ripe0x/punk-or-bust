import list from '../data/collections.json';
import { formatEth } from './format';

export type Collection = { address: `0x${string}`; name: string; image?: string };

export const COLLECTIONS: Collection[] = list as Collection[];

export const PUNKS_721 = '0x000000000000003607FCe1aC9e043a86675C5C2F' as const;

export function isPunks(address: string): boolean {
  return address.toLowerCase() === PUNKS_721.toLowerCase();
}

/** Display name for a collection: "CryptoPunks" for the CryptoPunks 721 wrapper, its listed name otherwise. */
export function displayName(collection: { address: string; name: string }): string {
  return isPunks(collection.address) ? 'CryptoPunks' : collection.name;
}

/**
 * CryptoPunks first, then by oracle ask price (wei) descending, then collections with no price
 * (missing or 0n) by name. Stable, does not mutate input.
 */
export function sortCollections<T extends { address: string; name: string }>(
  list: T[],
  askWei: Record<string, bigint | undefined>
): T[] {
  return [...list].sort((a, b) => {
    // CryptoPunks first
    const aIsPunks = isPunks(a.address);
    const bIsPunks = isPunks(b.address);
    if (aIsPunks && !bIsPunks) return -1;
    if (!aIsPunks && bIsPunks) return 1;

    // Then by oracle ask price descending
    const aPrice = askWei[a.address.toLowerCase()] ?? 0n;
    const bPrice = askWei[b.address.toLowerCase()] ?? 0n;
    if (aPrice !== bPrice) {
      return bPrice > aPrice ? 1 : -1;
    }

    // Then by name (for collections with same/missing price)
    return a.name.localeCompare(b.name);
  });
}

/** Row meta line: "4 in the pool · floor ~30 ETH". Either part is left out when unknown. */
export function collectionMeta(count: number | undefined, askWei: bigint | undefined): string {
  const parts: string[] = [];
  if (count !== undefined) parts.push(`${count} in the pool`);
  if (askWei !== undefined && askWei > 0n) {
    const eth = formatEth(askWei, askWei >= 10n * 10n ** 18n ? 1 : 2);
    parts.push(`floor ${eth.startsWith('<') ? eth : `~${eth}`} ETH`);
  }
  return parts.join(' · ');
}
