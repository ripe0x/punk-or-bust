import { useState } from 'react';
import type { Address } from 'viem';
import { vaultAbi } from '../abi/Vault';
import { useTx } from '../hooks/useTx';
import type { VaultState } from '../hooks/useVault';
import type { VaultSettings } from '../lib/events';
import { formatEth, formatGwei } from '../lib/format';
import { diffKeepList, formatKeepList, isEmptyDiff, parseKeepList } from '../lib/keepList';
import { checkBounties, checkGasCeiling, parseAddresses } from '../lib/runParams';
import { DEFAULT_BOUNTY, DEFAULT_SYNC_BOUNTY_MAX, MAX_BOUNTY, MAX_SYNC_BOUNTY } from '../lib/constants';
import { Addr, Field, Section, TxStatus } from './ui';

export function Settings({ vault, state, settings }: { vault: Address; state: VaultState; settings: VaultSettings }) {
  return (
    <Section title="Settings">
      <p className="muted small">These apply right away, even mid-run. Keep list changes only affect reveals after the change.</p>
      <AutoReturn vault={vault} enabled={state.autoReturn} />
      <GasCeiling vault={vault} current={state.gasCeiling} />
      <PrivateMode vault={vault} enabled={state.privateMode} />
      <Bounties vault={vault} bounty={state.bountyWei} syncMax={state.syncBountyMaxWei} />
      <KeepListEditor vault={vault} settings={settings} />
      <Keepers vault={vault} keepers={settings.keepers} privateMode={state.privateMode} />
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

function PrivateMode({ vault, enabled }: { vault: Address; enabled: boolean }) {
  const tx = useTx();
  return (
    <div className="subsection">
      <h3>Private mode</h3>
      <p className="small">
        {enabled
          ? 'On: only you and approved keepers can request pulls, and only approved keepers are paid. Anyone can still sync and finalize auctions.'
          : 'Off: anyone can request pulls, sync and finalize auctions within your run limits, paid gas plus the bounty from the vault.'}
      </p>
      <button
        className="btn-small"
        disabled={tx.busy}
        onClick={() => tx.send('Private mode', { address: vault, abi: vaultAbi, functionName: 'setPrivateMode', args: [!enabled] })}
      >
        Turn {enabled ? 'off' : 'on'}
      </button>
      <TxStatus state={tx.state} />
    </div>
  );
}

function Bounties({ vault, bounty, syncMax }: { vault: Address; bounty: bigint; syncMax: bigint }) {
  const tx = useTx();
  const [bountyText, setBountyText] = useState('');
  const [syncText, setSyncText] = useState('');
  const edited = bountyText !== '' || syncText !== '';
  const check = checkBounties(bountyText || formatEth(bounty, 18), syncText || formatEth(syncMax, 18));
  return (
    <div className="subsection">
      <h3>Bounties</h3>
      <p className="small">
        Paid from idle ETH on top of gas to whoever does the work. Pull requests and auction finalizes pay {formatEth(bounty, 5)} ETH. A sync
        pays from that up to {formatEth(syncMax, 5)} ETH as the oldest pull it settles ages to 30 minutes, so a late sync pays more.
      </p>
      <div className="grid">
        <Field
          label="Pull and finalize bounty (ETH)"
          hint={`${formatEth(DEFAULT_BOUNTY)} to ${formatEth(MAX_BOUNTY)}`}
          error={edited ? check.errors.bounty : undefined}
        >
          <input inputMode="decimal" value={bountyText} placeholder={formatEth(bounty, 6)} onChange={(e) => setBountyText(e.target.value)} />
        </Field>
        <Field
          label="Sync bounty max (ETH)"
          hint={`${formatEth(DEFAULT_SYNC_BOUNTY_MAX)} to ${formatEth(MAX_SYNC_BOUNTY)}, at least the bounty`}
          error={edited ? check.errors.syncMax : undefined}
        >
          <input inputMode="decimal" value={syncText} placeholder={formatEth(syncMax, 6)} onChange={(e) => setSyncText(e.target.value)} />
        </Field>
      </div>
      <button
        className="btn-small"
        disabled={tx.busy || !edited || check.bounty === null}
        onClick={async () => {
          const ok = await tx.send('Bounties', {
            address: vault,
            abi: vaultAbi,
            functionName: 'setBounties',
            args: [check.bounty!, check.syncMax!],
          });
          if (ok) {
            setBountyText('');
            setSyncText('');
          }
        }}
      >
        Save
      </button>
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

function Keepers({ vault, keepers, privateMode }: { vault: Address; keepers: Address[]; privateMode: boolean }) {
  const tx = useTx();
  const [text, setText] = useState('');
  const parsed = parseAddresses(text);
  return (
    <div className="subsection">
      <h3>Keepers</h3>
      <p className="small">
        In private mode, approved keepers are the only callers who can request pulls with vault ETH (within your run limits and gas ceiling) and
        the only ones paid. In public mode the list has no effect.
      </p>
      {keepers.length === 0 ? (
        <p className="small muted">{privateMode ? 'None. Only you can request pulls.' : 'None.'}</p>
      ) : null}
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
