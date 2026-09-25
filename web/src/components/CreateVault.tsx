import { useState } from 'react';
import type { Address } from 'viem';
import { factoryAbi } from '../abi/VaultFactory';
import { vaultAbi } from '../abi/Vault';
import { defaultKeeper, factoryAddress } from '../config';
import { useNow } from '../hooks/useNow';
import { useTx } from '../hooks/useTx';
import { useFactoryFwa, useQuote } from '../hooks/useVault';
import { DEFAULT_GAS_CEILING } from '../lib/constants';
import { parseKeepList } from '../lib/keepList';
import { checkGasCeiling, checkRunForm, parseAddresses, type RunForm } from '../lib/runParams';
import { formatGwei } from '../lib/format';
import { RunFields, defaultRunForm } from './RunFields';
import { Addr, Field, Section, TxStatus } from './ui';

export function CreateVault({ predicted, onCreated }: { predicted?: Address; onCreated: () => void }) {
  const now = useNow(10_000);
  const quote = useQuote(useFactoryFwa());
  const [form, setForm] = useState<RunForm>(() => defaultRunForm(Date.now() / 1000));
  const [keepText, setKeepText] = useState('');
  const [keeperText, setKeeperText] = useState(defaultKeeper ?? '');
  const [ceiling, setCeiling] = useState(formatGwei(DEFAULT_GAS_CEILING));
  const [tried, setTried] = useState(false);
  const [needsCeiling, setNeedsCeiling] = useState<bigint | null>(null);
  const tx = useTx();

  const run = checkRunForm(form, now, true);
  const keep = parseKeepList(keepText);
  const keepers = parseAddresses(keeperText);
  const gas = checkGasCeiling(ceiling);
  const valid = run.params && !keep.errors.length && !keepers.errors.length && gas.wei !== null;

  async function create() {
    setTried(true);
    if (!valid || !factoryAddress) return;
    const ok = await tx.send('Create vault', {
      address: factoryAddress,
      abi: factoryAbi,
      functionName: 'createVault',
      args: [keep.collections, keep.tokens, keepers.addresses, run.params!],
      value: run.value!,
    });
    if (!ok) return;
    // createVault always starts at the default ceiling; a different one is a second transaction.
    if (gas.wei !== DEFAULT_GAS_CEILING) setNeedsCeiling(gas.wei);
    else onCreated();
  }

  async function applyCeiling() {
    if (!predicted || needsCeiling === null) return;
    const ok = await tx.send('Set gas ceiling', {
      address: predicted,
      abi: vaultAbi,
      functionName: 'setGasCeiling',
      args: [needsCeiling],
    });
    if (ok) onCreated();
  }

  if (needsCeiling !== null) {
    return (
      <Section title="One more step">
        <p>Your vault is live. New vaults start at a 1.2 gwei gas ceiling. Send one more transaction to set it to {formatGwei(needsCeiling)} gwei.</p>
        <div className="row">
          <button onClick={applyCeiling} disabled={tx.busy}>
            Set gas ceiling
          </button>
          <button className="btn-ghost" onClick={onCreated}>
            Skip
          </button>
        </div>
        <TxStatus state={tx.state} />
      </Section>
    );
  }

  const errs = tried ? run.errors : {};
  return (
    <Section title="Create your vault">
      <p className="muted">
        Fund a vault, set a drawdown limit and a keep list. A keeper runs FWA pulls for you. Kept NFTs go to your wallet,
        the rest sell back or go to a short auction, and the ETH recycles into more pulls.
      </p>
      {predicted ? (
        <p>
          Your vault address will be <Addr address={predicted} label={predicted} />
        </p>
      ) : null}

      <RunFields form={form} onChange={setForm} errors={errs} amountLabel="ETH to fund" quote={quote?.total} />

      <Field
        label="Keep list"
        hint="One per line. A collection address keeps every token. Add token ids after the address to keep only those, like 0xabc... 12 345."
        error={keep.errors[0]}
      >
        <textarea rows={4} spellCheck={false} value={keepText} onChange={(e) => setKeepText(e.target.value)} placeholder="0x... (whole collection)&#10;0x... 1 2 3 (only these tokens)" />
      </Field>
      {keepText.trim() && !keep.errors.length ? (
        <p className="muted small">
          {keep.collections.length} collection{keep.collections.length === 1 ? '' : 's'}, {keep.tokens.length} token
          {keep.tokens.length === 1 ? '' : 's'}.
        </p>
      ) : null}

      <div className="grid">
        <Field label="Approved keeper" hint="Can spend vault ETH on pulls, within your limits. Leave empty to pull yourself." error={keepers.errors[0]}>
          <input spellCheck={false} value={keeperText} onChange={(e) => setKeeperText(e.target.value)} placeholder="0x..." />
        </Field>
        <Field label="Gas ceiling (gwei)" hint="Keepers do not pull above this gas price. 0 to 100." error={gas.error}>
          <input inputMode="decimal" value={ceiling} onChange={(e) => setCeiling(e.target.value)} />
        </Field>
      </div>

      <div className="row">
        <button onClick={create} disabled={tx.busy || !factoryAddress}>
          Create vault and start run
        </button>
      </div>
      <TxStatus state={tx.state} />
    </Section>
  );
}
