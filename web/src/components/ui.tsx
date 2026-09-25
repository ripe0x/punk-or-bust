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

export function Stat({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{children}</div>
      {hint ? <div className="stat-hint">{hint}</div> : null}
    </div>
  );
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

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}
