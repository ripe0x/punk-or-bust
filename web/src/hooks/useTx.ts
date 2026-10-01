import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, useCapabilities, useConfig, usePublicClient, useSendCalls, useSwitchChain, useWriteContract } from 'wagmi';
import { waitForCallsStatus } from '@wagmi/core';
import { encodeFunctionData, type Abi, type Address, type ContractFunctionArgs, type ContractFunctionName, type Hex } from 'viem';
import { chain, rpcUrl } from '../config';
import { errorMessage } from '../lib/errors';
import { requestRefresh } from './refresh';

export type TxPhase = 'idle' | 'wallet' | 'pending' | 'done' | 'error';

export interface TxState {
  phase: TxPhase;
  label?: string;
  hash?: Hex;
  error?: string;
  /** Set during a multi-step sequential flow so the UI can show "Step n of N". */
  step?: { n: number; of: number };
}

type Mut = 'nonpayable' | 'payable';

/** A typed contract write: arguments are checked against the ABI. */
export interface Call<abi extends Abi, fn extends ContractFunctionName<abi, Mut>> {
  address: Address;
  abi: abi;
  functionName: fn;
  args?: ContractFunctionArgs<abi, Mut, fn>;
  value?: bigint;
}

/** One labeled write in a batch flow. The call is untyped here; callers build it from a typed Call. */
export interface BatchStep {
  label: string;
  call: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint };
}

type WriteArgs = Parameters<ReturnType<typeof useWriteContract>['writeContractAsync']>[0];

/** Sends contract writes, one at a time or as a single wallet batch, and refreshes reads and logs. */
export function useTx() {
  const [state, setState] = useState<TxState>({ phase: 'idle' });
  const { writeContractAsync } = useWriteContract();
  const { chainId, address } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { sendCallsAsync } = useSendCalls();
  const { data: capabilities } = useCapabilities({ account: address, query: { enabled: !!address } });
  const config = useConfig();
  const client = usePublicClient();
  const qc = useQueryClient();

  const ensureChain = useCallback(async () => {
    if (chainId !== chain.id) await switchChainAsync({ chainId: chain.id });
  }, [chainId, switchChainAsync]);

  const afterSuccess = useCallback(async () => {
    await qc.invalidateQueries();
    requestRefresh();
  }, [qc]);

  // One write, waits for the receipt. `step` is set only inside a sequential multi-step flow.
  const runOne = useCallback(
    async (label: string, call: BatchStep['call'], step?: TxState['step']): Promise<boolean> => {
      setState({ phase: 'wallet', label, step });
      try {
        await ensureChain();
        const hash = await writeContractAsync({ ...call, chainId: chain.id } as unknown as WriteArgs);
        setState({ phase: 'pending', label, hash, step });
        const receipt = await client!.waitForTransactionReceipt({
          hash,
          ...(chain.id === 31337 || chain.id === 31338 ? { timeout: 20_000 } : {}),
        });
        if (receipt.status !== 'success') {
          setState({ phase: 'error', label, hash, step, error: 'Transaction reverted.' });
          return false;
        }
        setState({ phase: 'done', label, hash, step });
        await afterSuccess();
        return true;
      } catch (err) {
        const timedOut = err instanceof Error && /timed out|timeout/i.test(err.message);
        setState((s) => ({
          phase: 'error',
          label,
          hash: s.hash,
          step,
          error: timedOut
            ? `Sent, but not seen on ${rpcUrl ?? 'this network'}. Point your wallet's network at the same RPC (chain ${chain.id}), and if you restarted a local chain, reset the account's nonce in your wallet.`
            : errorMessage(err),
        }));
        return false;
      }
    },
    [ensureChain, writeContractAsync, client, afterSuccess],
  );

  const send = useCallback(
    <const abi extends Abi, fn extends ContractFunctionName<abi, Mut>>(label: string, call: Call<abi, fn>): Promise<boolean> =>
      runOne(label, call as unknown as BatchStep['call']),
    [runOne],
  );

  // Whether the wallet can run several calls in one prompt. Reads the EIP-5792 atomic capability,
  // tolerating both the current (`atomic.status`) and older (`atomicBatch.supported`) shapes.
  const caps = (capabilities as Record<number, Record<string, { status?: string; supported?: boolean }>> | undefined)?.[chain.id];
  const canBatch = caps?.atomic?.status === 'supported' || caps?.atomic?.status === 'ready' || caps?.atomicBatch?.supported === true;

  // Several writes as one atomic wallet prompt when the wallet supports batching, otherwise each in
  // turn with a step label. Any failure stops the flow. A one-step flow is just a single write.
  const sendBatch = useCallback(
    async (steps: BatchStep[], batchLabel = 'Start run'): Promise<boolean> => {
      if (steps.length === 0) return true;
      if (steps.length === 1) return runOne(steps[0].label, steps[0].call);

      if (canBatch) {
        setState({ phase: 'wallet', label: batchLabel });
        try {
          await ensureChain();
          const { id } = await sendCallsAsync({
            chainId: chain.id,
            calls: steps.map((s) => ({
              to: s.call.address,
              data: encodeFunctionData({ abi: s.call.abi, functionName: s.call.functionName, args: s.call.args as readonly unknown[] } as never),
              value: s.call.value,
            })),
          } as never);
          setState({ phase: 'pending', label: batchLabel });
          const result = await waitForCallsStatus(config, { id });
          if (result.status !== 'success') {
            setState({ phase: 'error', label: batchLabel, error: 'The batch did not complete. Nothing was applied.' });
            return false;
          }
          setState({ phase: 'done', label: batchLabel });
          await afterSuccess();
          return true;
        } catch (err) {
          // A user rejection stops here rather than re-prompting once per call. Any other error
          // (the wallet cannot batch after all) falls through to the sequential path below.
          if (err instanceof Error && /reject|denied|cancell?ed/i.test(err.message)) {
            setState({ phase: 'error', label: batchLabel, error: errorMessage(err) });
            return false;
          }
        }
      }

      for (let i = 0; i < steps.length; i++) {
        if (!(await runOne(steps[i].label, steps[i].call, { n: i + 1, of: steps.length }))) return false;
      }
      return true;
    },
    [canBatch, ensureChain, sendCallsAsync, config, runOne, afterSuccess],
  );

  const busy = state.phase === 'wallet' || state.phase === 'pending';
  return { send, sendBatch, state, busy, reset: () => setState({ phase: 'idle' }) };
}
