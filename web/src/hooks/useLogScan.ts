import { useCallback, useEffect, useRef, useState } from 'react';
import { usePublicClient } from 'wagmi';
import type { AbiEvent, Address, Log } from 'viem';
import { fromBlock } from '../config';
import { planRanges } from '../lib/ranges';
import { onRefresh } from './refresh';

const POLL_MS = 15_000;
const START_CHUNK = 50_000n;
const MIN_CHUNK = 500n;

export interface LogScan {
  logs: Log[];
  loading: boolean;
  error: string | null;
}

/**
 * Scans logs for `address` from the configured start block to head, then polls for new blocks.
 * Chunks the range and shrinks the chunk when the RPC refuses a wide query.
 */
export function useLogScan(address: Address | Address[] | undefined, events: readonly AbiEvent[]): LogScan {
  const client = usePublicClient();
  const key = address ? JSON.stringify([address, events.map((e) => e.name)]) : '';
  const [state, setState] = useState<LogScan>({ logs: [], loading: !!address, error: null });
  const cursor = useRef<{ key: string; next: bigint; chunk: bigint; logs: Log[]; busy: boolean; loaded: boolean }>({
    key: '',
    next: fromBlock,
    chunk: START_CHUNK,
    logs: [],
    busy: false,
    loaded: false,
  });

  const poll = useCallback(async () => {
    const c = cursor.current;
    if (!client || !address || c.busy || c.key !== key) return;
    if (Array.isArray(address) && address.length === 0) {
      setState({ logs: [], loading: false, error: null });
      return;
    }
    c.busy = true;
    try {
      const head = await client.getBlockNumber();
      if (c.key !== key) return;
      let found = false;
      for (;;) {
        const ranges = planRanges(c.next, head, c.chunk);
        if (ranges.length === 0) break;
        const [from, to] = ranges[0];
        try {
          const logs = await client.getLogs({ address, events, fromBlock: from, toBlock: to });
          if (c.key !== key) return;
          if (logs.length) {
            c.logs = [...c.logs, ...(logs as unknown as Log[])];
            found = true;
          }
          c.next = to + 1n;
        } catch (err) {
          if (c.chunk <= MIN_CHUNK) throw err;
          c.chunk = c.chunk / 4n > MIN_CHUNK ? c.chunk / 4n : MIN_CHUNK;
        }
      }
      if (found || !c.loaded) setState({ logs: c.logs, loading: false, error: null });
      c.loaded = true;
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: err instanceof Error ? err.message.split('\n')[0] : String(err) }));
    } finally {
      c.busy = false;
    }
    // `address` and `events` are captured through `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);

  useEffect(() => {
    cursor.current = { key, next: fromBlock, chunk: START_CHUNK, logs: [], busy: false, loaded: false };
    setState({ logs: [], loading: !!address, error: null });
    if (!address) return;
    void poll();
    const t = setInterval(() => void poll(), POLL_MS);
    const off = onRefresh(() => setTimeout(() => void poll(), 1500));
    return () => {
      clearInterval(t);
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, poll]);

  return state;
}
