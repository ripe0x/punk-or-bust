import { useMemo } from 'react';
import { useReadContract, useReadContracts } from 'wagmi';
import type { Address } from 'viem';
import { COLLECTIONS } from '../lib/collections';

// Not in the generated FWA ABI; small fragments for the floor oracle pointer and its range read.
const fwaFloorOracleAbi = [
  { type: 'function', name: 'floorOracle', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
] as const;

const floorOracleAbi = [
  {
    type: 'function',
    name: 'getFloorRange',
    inputs: [{ name: 'collection', type: 'address' }],
    outputs: [
      { name: 'bidPrice', type: 'uint256' },
      { name: 'askPrice', type: 'uint256' },
      { name: 'observedAt', type: 'uint48' },
      { name: 'periodUsed', type: 'uint48' },
    ],
    stateMutability: 'view',
  },
] as const;

/** Pool ask price (wei) for one collection, read from the FWA floor oracle. */
export function useCollectionPrice(fwa: Address | undefined, collection: Address | undefined) {
  const oracleRead = useReadContract({
    address: fwa,
    abi: fwaFloorOracleAbi,
    functionName: 'floorOracle',
    query: { enabled: !!fwa, staleTime: Infinity },
  });
  const oracle = oracleRead.data as Address | undefined;
  const range = useReadContract({
    address: oracle,
    abi: floorOracleAbi,
    functionName: 'getFloorRange',
    args: collection ? [collection] : undefined,
    query: { enabled: !!oracle && !!collection, refetchInterval: 60_000 },
  });
  const r = range.data as readonly [bigint, bigint, number, number] | undefined;
  return r ? { bidWei: r[0], askWei: r[1] } : undefined;
}

/** Pool ask price (wei) per collection address (lowercased), read from the FWA floor oracle in one multicall. */
export function useCollectionPrices(fwa: Address | undefined) {
  const oracleRead = useReadContract({
    address: fwa,
    abi: fwaFloorOracleAbi,
    functionName: 'floorOracle',
    query: { enabled: !!fwa, staleTime: Infinity },
  });
  const oracle = oracleRead.data as Address | undefined;

  const ranges = useReadContracts({
    contracts: oracle
      ? COLLECTIONS.map(
          (c) => ({ address: oracle, abi: floorOracleAbi, functionName: 'getFloorRange', args: [c.address] }) as const,
        )
      : [],
    query: { enabled: !!oracle, refetchInterval: 60_000 },
  });

  return useMemo(() => {
    const askWei: Record<string, bigint | undefined> = {};
    COLLECTIONS.forEach((c, i) => {
      const r = ranges.data?.[i]?.result as readonly [bigint, bigint, number, number] | undefined;
      askWei[c.address.toLowerCase()] = r ? r[1] : undefined;
    });
    return { askWei, loading: oracleRead.isLoading || (!!oracle && ranges.isLoading) };
  }, [ranges.data, ranges.isLoading, oracleRead.isLoading, oracle]);
}
