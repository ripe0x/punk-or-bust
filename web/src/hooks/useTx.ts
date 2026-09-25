import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from 'wagmi';
import type { Hex } from 'viem';
import { chain } from '../config';
import { errorMessage } from '../lib/errors';
import { requestRefresh } from './refresh';

export type TxPhase = 'idle' | 'wallet' | 'pending' | 'done' | 'error';

export interface TxState {
  phase: TxPhase;
  label?: string;
  hash?: Hex;
  error?: string;
}

type WriteArgs = Parameters<ReturnType<typeof useWriteContract>['writeContractAsync']>[0];

/** Sends one contract write, waits for the receipt, and refreshes reads and logs. */
export function useTx() {
  const [state, setState] = useState<TxState>({ phase: 'idle' });
  const { writeContractAsync } = useWriteContract();
  const { chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const client = usePublicClient();
  const qc = useQueryClient();

  const send = useCallback(
    async (label: string, args: WriteArgs): Promise<boolean> => {
      setState({ phase: 'wallet', label });
      try {
        if (chainId !== chain.id) await switchChainAsync({ chainId: chain.id });
        const hash = await writeContractAsync({ ...args, chainId: chain.id } as WriteArgs);
        setState({ phase: 'pending', label, hash });
        const receipt = await client!.waitForTransactionReceipt({ hash });
        if (receipt.status !== 'success') {
          setState({ phase: 'error', label, hash, error: 'Transaction reverted.' });
          return false;
        }
        setState({ phase: 'done', label, hash });
        await qc.invalidateQueries();
        requestRefresh();
        return true;
      } catch (err) {
        setState((s) => ({ phase: 'error', label, hash: s.hash, error: errorMessage(err) }));
        return false;
      }
    },
    [chainId, switchChainAsync, writeContractAsync, client, qc],
  );

  const busy = state.phase === 'wallet' || state.phase === 'pending';
  return { send, state, busy, reset: () => setState({ phase: 'idle' }) };
}
