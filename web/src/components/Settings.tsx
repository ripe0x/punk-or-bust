import { useState } from 'react';
import type { Address } from 'viem';
import { vaultAbi } from '../abi/Vault';
import { useTx } from '../hooks/useTx';
import type { VaultState } from '../hooks/useVault';
import type { VaultSettings } from '../lib/events';
import { formatGwei } from '../lib/format';
import { diffKeepList, formatKeepList, isEmptyDiff, parseKeepList } from '../lib/keepList';
import { checkGasCeiling, parseAddresses } from '../lib/runParams';
import { Addr, Field, Section, TxStatus } from './ui';

export function Settings({ vault, state, settings }: { vault: Address; state: VaultState; settings: VaultSettings }) {
  return (
    <Section title="Settings">
      <p className="muted small">These apply right away, even mid-run. Keep list changes only affect reveals after the change.</p>
      <AutoReturn vault={vault} enabled={state.autoReturn} />
      <GasCeiling vault={vault} current={state.gasCeiling} />
      <KeepListEditor vault={vault} settings={settings} />
      <Keepers vault={vault} keepers={settings.keepers} />
    </Section>
  );
}

function AutoReturn({ vault, enabled }: { vault: Address; enabled: boolean }) {
  const tx = useTx();
  return (
    <div className="subsection">
      <h3>Auto-return</h3>
      <p className="small">
        {enabled ? 'On: when a run finishes, idle ETH goes back to your wallet.' : 'Off: ETH stays in the vault after a run.'}
      </p>
      <button
        className="btn-small"
        disabled={tx.busy}
        onClick={() => tx.send('Auto-return', { address: vault, abi: vaultAbi, functionName: 'setAutoReturn', args: [!enabled] })}
      >
        Turn {enabled ? 'off' : 'on'}
      </button>
      <TxStatus state={tx.state} />
    </div>
  );
}

function GasCeiling({ vault, current }: { vault: Address; current: bigint }) {
  const tx = useTx();
  const [text, setText] = useState('');
  const check = checkGasCeiling(text);
  return (
    <div className="subsection">
      <h3>Gas ceiling</h3>
      <p className="small">Now {formatGwei(current)} gwei. Keepers do not request pulls above it.</p>
      <div className="row">
        <Field label="New ceiling (gwei)" error={text ? check.error : undefined}>
          <input inputMode="decimal" value={text} placeholder={formatGwei(current)} onChange={(e) => setText(e.target.value)} />
        </Field>
        <button
          className="btn-small"
          disabled={tx.busy || check.wei === null}
          onClick={() => tx.send('Gas ceiling', { address: vault, abi: vaultAbi, functionName: 'setGasCeiling', args: [check.wei!] })}
        >
          Save
        </button>
      </div>
      <TxStatus state={tx.state} />
    </div>
  );
}

function KeepListEditor({ vault, settings }: { vault: Address; settings: VaultSettings }) {
  const tx = useTx();
  const [text, setText] = useState<string | null>(null);
  const current = { collections: settings.collections, tokens: settings.tokens };
  const parsed = text === null ? null : parseKeepList(text);
  const diff = parsed ? diffKeepList(current, parsed) : null;

  async function save() {
    if (!diff) return;
    // One transaction per kind of change; the contract takes a list and a flag.
    const steps = [
      ['Remove collections', 'setKeepCollections', diff.removeCollections, false],
      ['Remove tokens', 'setKeepTokens', diff.removeTokens, false],
      ['Add collections', 'setKeepCollections', diff.addCollections, true],
      ['Add tokens', 'setKeepTokens', diff.addTokens, true],
    ] as const;
    for (const [label, fn, list, keep] of steps) {
      if (!list.length) continue;
      const ok = await tx.send(label, { address: vault, abi: vaultAbi, functionName: fn, args: [list as never, keep] });
      if (!ok) return;
    }
    setText(null);
  }

  const count = settings.collections.length + settings.tokens.length;
  return (
    <div className="subsection">
      <h3>Keep list</h3>
      {text === null ? (
        <>
          {count === 0 ? <p className="small">Empty. Every pull sells back or goes to auction.</p> : null}
          <ul className="plain">
            {settings.collections.map((c) => (
              <li key={c}>
                <Addr address={c} /> <span className="muted">whole collection</span>
              </li>
            ))}
            {settings.tokens.map((t) => (
              <li key={`${t.collection}:${t.tokenId}`}>
                <Addr address={t.collection} /> <span className="mono">#{t.tokenId.toString()}</span>
              </li>
            ))}
          </ul>
          <button className="btn-small" onClick={() => setText(formatKeepList(current))}>
            Edit keep list
          </button>
        </>
      ) : (
        <>
          <Field label="Keep list" hint="One per line. Address alone keeps the collection; add token ids to keep only those." error={parsed?.errors[0]}>
            <textarea rows={5} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          {diff && !isEmptyDiff(diff) ? (
            <p className="small">
              Adds {diff.addCollections.length} collections and {diff.addTokens.length} tokens. Removes {diff.removeCollections.length}{' '}
              collections and {diff.removeTokens.length} tokens. Up to 4 transactions.
            </p>
          ) : null}
          <div className="row">
            <button className="btn-small" disabled={tx.busy || !diff || isEmptyDiff(diff) || !!parsed?.errors.length} onClick={save}>
              Save
            </button>
            <button className="btn-small btn-ghost" onClick={() => setText(null)}>
              Cancel
            </button>
          </div>
        </>
      )}
      <TxStatus state={tx.state} />
    </div>
  );
}

function Keepers({ vault, keepers }: { vault: Address; keepers: Address[] }) {
  const tx = useTx();
  const [text, setText] = useState('');
  const parsed = parseAddresses(text);
  return (
    <div className="subsection">
      <h3>Keepers</h3>
      <p className="small">Approved keepers can request pulls with vault ETH, within your run limits and gas ceiling.</p>
      {keepers.length === 0 ? <p className="small muted">None. Only you can request pulls.</p> : null}
      <ul className="plain">
        {keepers.map((k) => (
          <li key={k} className="row">
            <Addr address={k} label={k} />
            <button
              className="btn-small btn-ghost"
              disabled={tx.busy}
              onClick={() => tx.send('Remove keeper', { address: vault, abi: vaultAbi, functionName: 'setKeepers', args: [[k], false] })}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="row">
        <Field label="Add keeper" error={text ? parsed.errors[0] : undefined}>
          <input spellCheck={false} placeholder="0x..." value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <button
          className="btn-small"
          disabled={tx.busy || !parsed.addresses.length || !!parsed.errors.length}
          onClick={async () => {
            if (await tx.send('Add keeper', { address: vault, abi: vaultAbi, functionName: 'setKeepers', args: [parsed.addresses, true] })) setText('');
          }}
        >
          Add
        </button>
      </div>
      <TxStatus state={tx.state} />
    </div>
  );
}
