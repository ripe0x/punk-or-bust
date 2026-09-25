import { useMemo } from 'react';
import { useReadContracts } from 'wagmi';
import type { Address } from 'viem';
import { vaultAbi } from '../abi/Vault';
import { toOpenAuction, type AuctionInfo, type OpenAuction } from '../lib/auction';
import { useAllVaults } from './useVault';

export type { OpenAuction };

/**
 * Open miss auctions across every factory vault. Vaults come from factory events; each vault lists
 * its open auctions (`openAuctionIds`) and describes each one (`auctionInfo`: the NFT, the bids and
 * the minimum next bid). Bid refund credits are read per vault from `bidRefunds`.
 */
export function useOpenAuctions(bidder: Address | undefined) {
  const all = useAllVaults();
  const vaults = useMemo(() => all.vaults.map((v) => v.vault), [all.vaults]);

  const ids = useReadContracts({
    contracts: vaults.map((v) => ({ address: v, abi: vaultAbi, functionName: 'openAuctionIds' }) as const),
    query: { enabled: vaults.length > 0, refetchInterval: 10_000 },
  });

  const refs = useMemo(() => {
    const out: { vault: Address; requestId: bigint }[] = [];
    vaults.forEach((vault, i) => {
      const r = ids.data?.[i]?.result as readonly bigint[] | undefined;
      for (const requestId of r ?? []) out.push({ vault, requestId });
    });
    return out;
  }, [vaults, ids.data]);

  const infos = useReadContracts({
    contracts: refs.map((r) => ({ address: r.vault, abi: vaultAbi, functionName: 'auctionInfo', args: [r.requestId] }) as const),
    query: { enabled: refs.length > 0, refetchInterval: 10_000 },
  });

  const refunds = useReadContracts({
    contracts: bidder ? vaults.map((v) => ({ address: v, abi: vaultAbi, functionName: 'bidRefunds', args: [bidder] }) as const) : [],
    query: { enabled: !!bidder && vaults.length > 0, refetchInterval: 20_000 },
  });

  const auctions = useMemo<OpenAuction[]>(() => {
    const out: OpenAuction[] = [];
    refs.forEach((r, i) => {
      const info = infos.data?.[i]?.result as AuctionInfo | undefined;
      // `auctionInfo` answers zeros for an unknown id.
      if (!info || info[6] === 0n) return;
      out.push(toOpenAuction(r.vault, r.requestId, info));
    });
    return out.sort((x, y) => (x.deadline < y.deadline ? -1 : x.deadline > y.deadline ? 1 : 0));
  }, [infos.data, refs]);

  const credits = useMemo(
    () =>
      bidder
        ? vaults
            .map((vault, i) => ({ vault, amount: (refunds.data?.[i]?.result as bigint | undefined) ?? 0n }))
            .filter((c) => c.amount > 0n)
        : [],
    [bidder, vaults, refunds.data],
  );

  return {
    auctions,
    credits,
    vaultCount: vaults.length,
    loading: all.loading || ids.isLoading || infos.isLoading,
    error: all.error ?? ids.error?.message ?? infos.error?.message,
  };
}
