import { useEffect, useState } from 'react';
import { usePublicClient } from 'wagmi';
import type { Address } from 'viem';
import { isPunks } from '../lib/collections';
import { placeholderColor, resolveUri } from '../lib/nft';

/** CryptopunksData: on-chain SVGs for CryptoPunks, background per the design. */
const PUNKS_DATA = '0x16F5A35647D6F03D5D3da7b35409D65ba03aF3B2' as const;
const PUNKS_BG = '#638596';

const punksAbi = [
  { type: 'function', name: 'punkImageSvg', inputs: [{ name: 'index', type: 'uint16' }], outputs: [{ type: 'string' }], stateMutability: 'view' },
] as const;

const tokenUriAbi = [
  { type: 'function', name: 'tokenURI', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'string' }], stateMutability: 'view' },
] as const;

/** In-memory cache so the same NFT is not fetched twice in one session. */
const cache = new Map<string, string | null>();

/** One NFT's image, or null on any failure. Callers show a tinted placeholder (see `bg`) then. */
export function useNftImage(collection: Address | undefined, tokenId: bigint | undefined) {
  const client = usePublicClient();
  const key = collection && tokenId !== undefined ? `${collection.toLowerCase()}:${tokenId}` : undefined;
  const [image, setImage] = useState<string | null | undefined>(() => (key ? cache.get(key) : undefined));

  useEffect(() => {
    if (!key) {
      setImage(undefined);
      return;
    }
    if (cache.has(key)) {
      setImage(cache.get(key) ?? null);
      return;
    }
    if (!collection || tokenId === undefined || !client) return;
    let cancelled = false;
    (async () => {
      try {
        let url: string | null = null;
        if (isPunks(collection)) {
          const svg = await client.readContract({
            address: PUNKS_DATA,
            abi: punksAbi,
            functionName: 'punkImageSvg',
            args: [Number(tokenId)],
          });
          // The contract's own "data:image/svg+xml;utf8,<markup>" prefix (when present) leaves the
          // markup unescaped, which breaks as an <img src> the moment it contains a literal '#'
          // (used in every fill color): the browser reads that as a URL fragment and drops the
          // rest. Strip any such prefix and re-encode the raw markup properly.
          const dataUriPrefix = 'data:image/svg+xml;utf8,';
          const markup = svg.startsWith(dataUriPrefix) ? svg.slice(dataUriPrefix.length) : svg;
          url = `data:image/svg+xml;utf8,${encodeURIComponent(markup)}`;
        } else {
          const uri = await client.readContract({ address: collection, abi: tokenUriAbi, functionName: 'tokenURI', args: [tokenId] });
          const res = await fetch(resolveUri(uri));
          const json = (await res.json()) as { image?: string };
          url = json.image ? resolveUri(json.image) : null;
        }
        if (!cancelled) {
          cache.set(key, url);
          setImage(url);
        }
      } catch {
        if (!cancelled) {
          cache.set(key, null);
          setImage(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, collection, tokenId, client]);

  const bg = collection && isPunks(collection) ? PUNKS_BG : collection ? placeholderColor(collection) : '#e3dfd4';
  return { image: image ?? null, bg, loading: image === undefined };
}
