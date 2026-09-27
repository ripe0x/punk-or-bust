import type { ReactNode } from 'react';
import type { Hex } from 'viem';
import { addressUrl, txUrl } from '../lib/links';
import { formatEth, shortAddr } from '../lib/format';
import type { TxState } from '../hooks/useTx';

export function Addr({ address, label }: { address: string; label?: string }) {
  return (
    <a className="mono" href={addressUrl(address)} target="_blank" rel="noreferrer" title={address}>
      {label ?? shortAddr(address)}
    </a>
  );
}

export function TxLink({ hash, label }: { hash: Hex; label?: string }) {
  return (
    <a className="mono" href={txUrl(hash)} target="_blank" rel="noreferrer">
      {label ?? shortAddr(hash)}
    </a>
  );
}

export function Eth({ wei }: { wei: bigint }) {
  return <span className="num">{formatEth(wei)} ETH</span>;
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function TxStatus({ state }: { state: TxState }) {
  if (state.phase === 'idle') return null;
  const text =
    state.phase === 'wallet'
      ? 'Confirm in your wallet.'
      : state.phase === 'pending'
        ? 'Waiting for confirmation.'
        : state.phase === 'done'
          ? 'Confirmed.'
          : state.error ?? 'Failed.';
  return (
    <p className={`tx tx-${state.phase}`} role="status">
      {state.label ? <strong>{state.label}: </strong> : null}
      {text} {state.hash ? <TxLink hash={state.hash} label="View tx" /> : null}
    </p>
  );
}

/** A plain titled block, used inside the "More" panel on Run (owner settings, sweep) and for read-only vault views. */
export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="subsection">
      <div className="row-between">
        <h3>{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}
