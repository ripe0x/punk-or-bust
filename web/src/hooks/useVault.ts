import { useMemo } from 'react';
import { useBalance, useReadContract, useReadContracts } from 'wagmi';
import { decodeEventLog, zeroAddress, type Address } from 'viem';
import { factoryAbi } from '../abi/VaultFactory';
import { vaultAbi } from '../abi/Vault';
import { fwaAbi } from '../abi/IFWA';
import { factoryAddress } from '../config';
import { decodeVaultLogs, replaySettings, toFeed, type VaultEvent } from '../lib/events';
import type { RunParams } from '../lib/runParams';
import { useLogScan } from './useLogScan';
import { VAULT_CREATED, VAULT_EVENTS } from './abiEvents';

const POLL = 12_000;

/** The owner's vault, if any, and the address it would get. */
export function useOwnerVault(owner: Address | undefined) {
  const res = useReadContracts({
    contracts: owner && factoryAddress
      ? [
          { address: factoryAddress, abi: factoryAbi, functionName: 'vaultOf', args: [owner] },
          { address: factoryAddress, abi: factoryAbi, functionName: 'predictVault', args: [owner] },
        ]
      : [],
    query: { enabled: !!owner && !!factoryAddress, refetchInterval: POLL },
  });
  const vault = res.data?.[0]?.result as Address | undefined;
  return {
    vault: vault && vault !== zeroAddress ? vault : undefined,
    predicted: res.data?.[1]?.result as Address | undefined,
    loading: res.isLoading,
    refetch: res.refetch,
  };
}

export interface VaultState {
  owner: Address;
  status: number;
  idle: bigint;
  balance: bigint;
  runValue: bigint;
  runFloor: bigint;
  runStartValue: bigint;
  run: RunParams;
  pullsRequested: bigint;
  keeps: bigint;
  outstanding: bigint;
  openAuctions: bigint;
  autoReturn: boolean;
  rewardsRegistered: boolean;
  gasCeiling: bigint;
  feeOwed: bigint;
  bidEscrow: bigint;
  keptValue: bigint;
  fwa: Address;
}

const FIELDS = [
  'OWNER',
  'status',
  'idle',
  'runValue',
  'runFloor',
  'runStartValue',
  'run',
  'pullsRequested',
  'keeps',
  'outstandingCount',
  'openAuctions',
  'autoReturn',
  'rewardsRegistered',
  'gasCeiling',
  'feeOwed',
  'bidEscrow',
  'keptValue',
  'FWA',
] as const;

/** Every vault view the dashboard shows, polled together. */
export function useVaultState(vault: Address | undefined) {
  const reads = useReadContracts({
    contracts: vault ? FIELDS.map((functionName) => ({ address: vault, abi: vaultAbi, functionName })) : [],
    query: { enabled: !!vault, refetchInterval: POLL },
  });
  const bal = useBalance({ address: vault, query: { enabled: !!vault, refetchInterval: POLL } });

  const state = useMemo<VaultState | undefined>(() => {
    const d = reads.data;
    if (!d || d.some((r) => r.status !== 'success')) return undefined;
    const v = Object.fromEntries(FIELDS.map((f, i) => [f, d[i].result])) as Record<(typeof FIELDS)[number], unknown>;
    const run = v.run as readonly [bigint, bigint, bigint, bigint, bigint];
    return {
      owner: v.OWNER as Address,
      status: Number(v.status),
      idle: v.idle as bigint,
      balance: bal.data?.value ?? 0n,
      runValue: v.runValue as bigint,
      runFloor: v.runFloor as bigint,
      runStartValue: v.runStartValue as bigint,
      run: { maxDrawdownBps: run[0], maxPullCostWei: run[1], stopAfterKeeps: run[2], deadline: run[3], maxPulls: run[4] },
      pullsRequested: v.pullsRequested as bigint,
      keeps: v.keeps as bigint,
      outstanding: v.outstandingCount as bigint,
      openAuctions: v.openAuctions as bigint,
      autoReturn: v.autoReturn as boolean,
      rewardsRegistered: v.rewardsRegistered as boolean,
      gasCeiling: v.gasCeiling as bigint,
      feeOwed: v.feeOwed as bigint,
      bidEscrow: v.bidEscrow as bigint,
      keptValue: v.keptValue as bigint,
      fwa: v.FWA as Address,
    };
  }, [reads.data, bal.data]);

  const failed = reads.data?.find((r) => r.status === 'failure');
  return { state, loading: reads.isLoading, error: reads.error?.message ?? failed?.error?.message };
}

/** Decoded events of one vault, plus what they imply (feed, keep list, keepers, fees paid). */
export function useVaultEvents(vault: Address | undefined) {
  const scan = useLogScan(vault, VAULT_EVENTS);
  return useMemo(() => {
    const events: VaultEvent[] = decodeVaultLogs(scan.logs);
    return {
      events,
      feed: toFeed(events),
      settings: replaySettings(events),
      loading: scan.loading,
      error: scan.error,
    };
  }, [scan]);
}

/** Every vault the factory created, oldest first. */
export function useAllVaults() {
  const scan = useLogScan(factoryAddress, VAULT_CREATED);
  const vaults = useMemo(() => {
    const out: { owner: Address; vault: Address }[] = [];
    for (const log of scan.logs) {
      try {
        const d = decodeEventLog({ abi: factoryAbi, data: log.data, topics: log.topics, eventName: 'VaultCreated' });
        out.push({ owner: d.args.owner, vault: d.args.vault });
      } catch {
        // skip
      }
    }
    return out;
  }, [scan.logs]);
  return { vaults, loading: scan.loading, error: scan.error };
}

/** The live FWA quote for one pull: fee, VRF, total. */
export function useQuote(fwa: Address | undefined) {
  const q = useReadContract({
    address: fwa,
    abi: fwaAbi,
    functionName: 'quoteAcquisitionPrice',
    query: { enabled: !!fwa, refetchInterval: 30_000 },
  });
  const d = q.data as readonly [bigint, bigint, bigint] | undefined;
  return d ? { fee: d[0], vrf: d[1], total: d[2] } : undefined;
}

/** FWA pool address, read from the factory. */
export function useFactoryFwa() {
  const q = useReadContract({
    address: factoryAddress,
    abi: factoryAbi,
    functionName: 'FWA',
    query: { enabled: !!factoryAddress, staleTime: Infinity },
  });
  return q.data as Address | undefined;
}
