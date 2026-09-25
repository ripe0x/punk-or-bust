import { useState } from 'react';
import type { Address } from 'viem';
import { vaultAbi } from '../abi/Vault';
import { useNow } from '../hooks/useNow';
import { useTx } from '../hooks/useTx';
import { useQuote, useVaultEvents, useVaultState, type VaultState } from '../hooks/useVault';
import { affordablePulls } from '../lib/floor';
import {
  formatBps,
  formatDuration,
  formatEth,
  formatGwei,
  formatTimestamp,
  parseEthInput,
  vaultStatusLabel,
  windDownReasonLabel,
} from '../lib/format';
import { checkRunForm, type RunForm } from '../lib/runParams';
import { Feed } from './Feed';
import { FloorBar } from './FloorBar';
import { RunFields, defaultRunForm } from './RunFields';
import { Settings } from './Settings';
import { Sweep } from './Sweep';
import { Addr, Eth, Field, Section, Stat, TxStatus } from './ui';

export function Dashboard({ vault, viewer }: { vault: Address; viewer?: Address }) {
  const { state, loading, error } = useVaultState(vault);
  const ev = useVaultEvents(vault);

  if (!state) {
    return <Section title="Vault">{loading ? <p className="muted">Loading vault.</p> : <p className="field-error">{error ?? 'Not a vault.'}</p>}</Section>;
  }
  const isOwner = !!viewer && viewer.toLowerCase() === state.owner.toLowerCase();

  return (
    <>
      <Overview vault={vault} state={state} windDownReason={ev.windDownReason} isOwner={isOwner} />
      {isOwner ? <OwnerActions vault={vault} state={state} /> : null}
      {!state.rewardsRegistered ? <RegisterRewards vault={vault} /> : null}
      {isOwner ? <Settings vault={vault} state={state} settings={ev.settings} /> : null}
      {isOwner ? <Sweep vault={vault} fwa={state.fwa} events={ev.events} /> : null}
      <Feed items={ev.feed} loading={ev.loading} error={ev.error} />
    </>
  );
}

function Overview({
  vault,
  state,
  windDownReason,
  isOwner,
}: {
  vault: Address;
  state: VaultState;
  windDownReason: number | null;
  isOwner: boolean;
}) {
  const now = useNow(1000);
  const quote = useQuote(state.fwa);
  const s = state;
  const running = s.status !== 0;
  const left = Number(s.run.deadline) - now;
  const canPull =
    quote && s.status === 1
      ? affordablePulls({ value: s.runValue, floor: s.runFloor, idle: s.idle, quoteTotal: quote.total, quoteFee: quote.fee })
      : undefined;

  return (
    <Section
      title={isOwner ? 'Your vault' : 'Vault'}
      actions={<span className={`pill pill-${['idle', 'good', 'warn'][s.status] ?? 'idle'}`}>{vaultStatusLabel(s.status)}</span>}
    >
      <p className="small">
        Vault <Addr address={vault} /> owned by <Addr address={s.owner} />
      </p>
      {running ? <FloorBar value={s.runValue} floor={s.runFloor} start={s.runStartValue} /> : null}
      <div className="stats">
        <Stat label="Idle ETH" hint={s.status === 0 ? 'Withdrawable now' : undefined}>
          <Eth wei={s.idle} />
        </Stat>
        {running ? (
          <>
            <Stat label="Run value" hint={`Started at ${formatEth(s.runStartValue)} ETH`}>
              <Eth wei={s.runValue} />
            </Stat>
            <Stat label="Floor" hint={`Max drawdown ${formatBps(s.run.maxDrawdownBps)}`}>
              <Eth wei={s.runFloor} />
            </Stat>
            <Stat label="Pulls requested" hint={`of ${s.run.maxPulls.toString()} max`}>
              {s.pullsRequested.toString()}
            </Stat>
          </>
        ) : null}
        <Stat label="In flight" hint="Awaiting reveal or routing">
          {s.outstanding.toString()}
        </Stat>
        <Stat label="Open auctions">{s.openAuctions.toString()}</Stat>
        <Stat label="Keeps" hint={running && s.run.stopAfterKeeps > 0n ? `Stops at ${s.run.stopAfterKeeps}` : undefined}>
          {s.keeps.toString()}
        </Stat>
        <Stat label="Fees paid" hint={s.feeOwed > 0n ? `${formatEth(s.feeOwed, 6)} ETH owed` : undefined}>
          <span className="num">{formatEth(s.feesPaid, 6)} ETH</span>
        </Stat>
        {running ? (
          <>
            <Stat label="Deadline" hint={formatTimestamp(s.run.deadline)}>
              {left > 0 ? formatDuration(left) : 'Passed'}
            </Stat>
            <Stat label="Max pull cost" hint={quote ? `FWA now ${formatEth(quote.total, 5)} ETH` : undefined}>
              <Eth wei={s.run.maxPullCostWei} />
            </Stat>
          </>
        ) : null}
        <Stat label="Gas ceiling">{formatGwei(s.gasCeiling)} gwei</Stat>
        <Stat label="Auto-return">{s.autoReturn ? 'On' : 'Off'}</Stat>
        <Stat label="Private mode" hint={s.privateMode ? 'Only approved keepers pull' : 'Anyone can pull'}>
          {s.privateMode ? 'On' : 'Off'}
        </Stat>
        <Stat label="Bounty" hint={`Sync up to ${formatEth(s.syncBountyMaxWei, 5)} ETH`}>
          <span className="num">{formatEth(s.bountyWei, 5)} ETH</span>
        </Stat>
      </div>
      {canPull !== undefined ? (
        <p className="small muted">About {canPull.toString()} more pulls fit above the floor at the current FWA price.</p>
      ) : null}
      {s.status === 1 && s.run.maxDrawdownBps === 0n ? <p className="warn">Max drawdown is 0%, so this run never pulls.</p> : null}
      {s.status === 2 ? (
        <p className="small">
          Winding down{windDownReason !== null ? `: ${windDownReasonLabel(windDownReason)}` : ''}. No new pulls; the run ends once in-flight
          pulls and auctions resolve.
        </p>
      ) : null}
    </Section>
  );
}

function OwnerActions({ vault, state }: { vault: Address; state: VaultState }) {
  const tx = useTx();
  const now = useNow(10_000);
  const quote = useQuote(state.fwa);
  const [depositText, setDepositText] = useState('');
  const [form, setForm] = useState<RunForm>(() => defaultRunForm(Date.now() / 1000));
  const [tried, setTried] = useState(false);
  const deposit = parseEthInput(depositText);
  const run = checkRunForm(form, now, false);
  const idle = state.status === 0;

  async function startRun() {
    setTried(true);
    if (!run.params) return;
    if (run.value === 0n && state.idle === 0n) return;
    await tx.send('Start run', { address: vault, abi: vaultAbi, functionName: 'startRun', args: [run.params], value: run.value ?? 0n });
  }

  return (
    <Section title="Actions">
      <div className="row wrap">
        <Field label="Deposit ETH" hint={idle ? undefined : 'Raises the run start value by the deposit.'}>
          <input inputMode="decimal" placeholder="0.1" value={depositText} onChange={(e) => setDepositText(e.target.value)} />
        </Field>
        <button
          className="btn-small"
          disabled={tx.busy || !deposit}
          onClick={async () => {
            if (await tx.send('Deposit', { address: vault, abi: vaultAbi, functionName: 'deposit', value: deposit! })) setDepositText('');
          }}
        >
          Deposit
        </button>
      </div>

      {state.status === 1 ? (
        <div className="row">
          <button className="btn-danger" disabled={tx.busy} onClick={() => tx.send('Stop', { address: vault, abi: vaultAbi, functionName: 'stop' })}>
            Stop run
          </button>
          <span className="small muted">No new pulls. In-flight pulls and auctions still resolve.</span>
        </div>
      ) : null}

      {idle ? (
        <>
          <div className="row">
            <button
              disabled={tx.busy || state.idle === 0n}
              onClick={() => tx.send('Withdraw', { address: vault, abi: vaultAbi, functionName: 'withdraw' })}
            >
              Withdraw {formatEth(state.idle)} ETH
            </button>
          </div>
          <div className="subsection">
            <h3>Start a new run</h3>
            <RunFields
              form={form}
              onChange={setForm}
              errors={tried ? run.errors : {}}
              amountLabel="Add ETH (optional)"
              amountHint={`Idle now: ${formatEth(state.idle)} ETH. The run starts with idle plus this.`}
              quote={quote?.total}
            />
            {tried && run.params && run.value === 0n && state.idle === 0n ? <p className="field-error">Add some ETH to start a run.</p> : null}
            <button disabled={tx.busy} onClick={startRun}>
              Start run
            </button>
          </div>
        </>
      ) : null}
      <TxStatus state={tx.state} />
    </Section>
  );
}

function RegisterRewards({ vault }: { vault: Address }) {
  const tx = useTx();
  return (
    <Section title="Rewards">
      <p className="small">
        This vault is not registered for FWA epoch rewards yet. Registration works once the reward vault allows this factory. Anyone can send it.
      </p>
      <button className="btn-small" disabled={tx.busy} onClick={() => tx.send('Register rewards', { address: vault, abi: vaultAbi, functionName: 'registerRewards' })}>
        Register rewards
      </button>
      <TxStatus state={tx.state} />
    </Section>
  );
}
