import { useMemo } from 'react';
import { useReadContracts } from 'wagmi';
import type { AbiEvent, Address } from 'viem';
import { vaultAbi } from '../abi/Vault';
import { fwaAbi } from '../abi/IFWA';
import { decodeVaultLogs, openAuctionsFromEvents } from '../lib/events';
import { AUCTION_EVENTS, REFUND_EVENTS } from './abiEvents';
import { useLogScan } from './useLogScan';
import { useAllVaults, useFactoryFwa } from './useVault';

const SCAN_EVENTS: readonly AbiEvent[] = [...AUCTION_EVENTS, ...REFUND_EVENTS];

export interface OpenAuction {
  vault: Address;
  requestId: bigint;
  listingId: bigint;
  collection?: Address;
  tokenId?: bigint;
  backstop: bigint;
  highBid: bigint;
  highBidder: Address;
  deadline: bigint;
  hardDeadline: bigint;
}

/**
 * Open miss auctions across every factory vault. Vaults come from factory events, open auctions
 * from vault events, and the live numbers from `auctions(requestId)`; the NFT comes from the FWA
 * listing because the auction record only stores the listing id.
 */
export function useOpenAuctions(bidder: Address | undefined) {
  const all = useAllVaults();
  const vaults = useMemo(() => all.vaults.map((v) => v.vault), [all.vaults]);
  const fwa = useFactoryFwa();
  const scan = useLogScan(all.loading ? undefined : vaults, SCAN_EVENTS);

  const { refs, refundVaults } = useMemo(() => {
    const events = decodeVaultLogs(scan.logs);
    const refundVaults = new Set<Address>();
    if (bidder) {
      for (const e of events) {
        if (e.name === 'BidRefunded' && e.args.credited && (e.args.bidder as string).toLowerCase() === bidder.toLowerCase()) {
          refundVaults.add(e.address);
        }
      }
    }
    return { refs: openAuctionsFromEvents(events), refundVaults: [...refundVaults] };
  }, [scan.logs, bidder]);

  const reads = useReadContracts({
    contracts: refs.flatMap((r) => [
      { address: r.vault, abi: vaultAbi, functionName: 'auctions', args: [r.requestId] } as const,
      { address: r.vault, abi: vaultAbi, functionName: 'pulls', args: [r.requestId] } as const,
      ...(fwa ? [{ address: fwa, abi: fwaAbi, functionName: 'listings', args: [r.listingId] } as const] : []),
    ]),
    query: { enabled: refs.length > 0, refetchInterval: 10_000 },
  });

  const refunds = useReadContracts({
    contracts: bidder
      ? refundVaults.map((v) => ({ address: v, abi: vaultAbi, functionName: 'bidRefunds', args: [bidder] }) as const)
      : [],
    query: { enabled: !!bidder && refundVaults.length > 0, refetchInterval: 20_000 },
  });

  const auctions = useMemo<OpenAuction[]>(() => {
    const d = reads.data;
    if (!d) return [];
    const step = fwa ? 3 : 2;
    const out: OpenAuction[] = [];
    refs.forEach((r, i) => {
      const a = d[i * step]?.result as readonly [bigint, bigint, bigint, Address, bigint, bigint] | undefined;
      const p = d[i * step + 1]?.result as readonly [bigint, number] | undefined;
      const l = fwa ? (d[i * step + 2]?.result as readonly unknown[] | undefined) : undefined;
      // Status 6 is Auctioning; anything else was finalized after the last log poll.
      if (!a || !p || Number(p[1]) !== 6) return;
      out.push({
        vault: r.vault,
        requestId: r.requestId,
        listingId: a[0],
        backstop: a[1],
        highBid: a[2],
        highBidder: a[3],
        deadline: a[4],
        hardDeadline: a[5],
        collection: l?.[0] as Address | undefined,
        tokenId: l?.[3] as bigint | undefined,
      });
    });
    return out.sort((x, y) => (x.deadline < y.deadline ? -1 : 1));
  }, [reads.data, refs, fwa]);

  const credits = useMemo(
    () =>
      refundVaults
        .map((vault, i) => ({ vault, amount: (refunds.data?.[i]?.result as bigint | undefined) ?? 0n }))
        .filter((c) => c.amount > 0n),
    [refundVaults, refunds.data],
  );

  return {
    auctions,
    credits,
    vaultCount: vaults.length,
    loading: all.loading || scan.loading || reads.isLoading,
    error: all.error ?? scan.error ?? reads.error?.message,
  };
}
