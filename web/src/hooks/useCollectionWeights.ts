import { useEffect, useState } from 'react';
import { imageApi } from '../config';

export type CollectionWeight = { count: number; weight: bigint };
export type Weights = { totalWeight: bigint; byAddr: Record<string, CollectionWeight>; loaded: boolean };

const EMPTY: Weights = { totalWeight: 0n, byAddr: {}, loaded: false };
let cached: Weights | undefined;
let inflight: Promise<Weights> | undefined;

/** Per-collection active listing count and summed selection weight, plus the pool's total weight.
 *  Odds of pulling a collection are its weight over totalWeight. Fetched once; empty when no image
 *  API is set or the endpoint is unavailable (then odds are simply not shown). */
function fetchWeights(): Promise<Weights> {
  if (cached) return Promise.resolve(cached);
  if (!imageApi) return Promise.resolve(EMPTY);
  inflight ??= fetch(`${imageApi}/live/fwa/weights`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((d: { totalWeight?: string | null; collections?: Record<string, { count?: number; weight?: string }> }) => {
      const byAddr: Record<string, CollectionWeight> = {};
      for (const [addr, v] of Object.entries(d.collections ?? {})) {
        byAddr[addr.toLowerCase()] = { count: Number(v.count) || 0, weight: BigInt(v.weight ?? '0') };
      }
      return (cached = { totalWeight: d.totalWeight ? BigInt(d.totalWeight) : 0n, byAddr, loaded: true });
    })
    .catch(() => EMPTY);
  return inflight;
}

export function useCollectionWeights(): Weights {
  const [res, setRes] = useState<Weights>(cached ?? EMPTY);
  useEffect(() => {
    let on = true;
    void fetchWeights().then((w) => on && setRes(w));
    return () => {
      on = false;
    };
  }, []);
  return res;
}
