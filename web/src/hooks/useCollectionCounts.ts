import { useEffect, useState } from 'react';
import { imageApi } from '../config';

export type CollectionCount = { count: number; sampleTokenId?: string };
type Result = { counts: Record<string, CollectionCount>; loaded: boolean; failed: boolean };

let cached: Result | null = null;
let inflight: Promise<Result> | null = null;

function load(): Promise<Result> {
  if (cached) return Promise.resolve(cached);
  if (!imageApi) return Promise.resolve({ counts: {}, loaded: false, failed: true });
  inflight ??= fetch(`${imageApi}/live/fwa/collections`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('bad status'))))
    .then((d: { collections?: { collection: string; count: number; sampleTokenId?: string }[] }) => {
      if (!Array.isArray(d?.collections)) throw new Error('bad shape');
      const counts: Record<string, CollectionCount> = {};
      for (const c of d.collections) counts[c.collection.toLowerCase()] = { count: Number(c.count) || 0, sampleTokenId: c.sampleTokenId };
      return (cached = { counts, loaded: true, failed: false });
    })
    .catch(() => {
      inflight = null;
      return { counts: {}, loaded: false, failed: true } as Result;
    });
  return inflight;
}

/** Active pool listings per collection from the image API, fetched once. Falls back to `failed` with no counts. */
export function useCollectionCounts(): Result {
  const [res, setRes] = useState<Result>(cached ?? { counts: {}, loaded: false, failed: !imageApi });
  useEffect(() => {
    if (cached) return;
    let live = true;
    void load().then((r) => live && setRes(r));
    return () => {
      live = false;
    };
  }, []);
  return res;
}

/** Collections to show: only those with listings once counts are loaded, all of them otherwise. */
export function visibleCollections<T extends { address: string }>(list: T[], res: Result): T[] {
  return res.loaded ? list.filter((c) => (res.counts[c.address.toLowerCase()]?.count ?? 0) > 0) : list;
}
