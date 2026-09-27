import { useEffect, useMemo, useRef, useState } from 'react';
import { useReadContracts } from 'wagmi';
import type { Address } from 'viem';
import { factoryAbi } from '../abi/VaultFactory';
import { vaultAbi } from '../abi/Vault';
import { fwaAbi } from '../abi/IFWA';
import { defaultKeeper, factoryAddress } from '../config';
import { useCollectionPrices } from '../hooks/useCollectionPrices';
import { useNow } from '../hooks/useNow';
import { useTx } from '../hooks/useTx';
import { useFactoryFwa, useQuote, useVaultEvents, useVaultState } from '../hooks/useVault';
import { useNftImage } from '../hooks/useNftImage';
import { COLLECTIONS, isPunks, sortCollections } from '../lib/collections';
import { DEFAULT_BOUNTY, DEFAULT_SYNC_BOUNTY_MAX } from '../lib/constants';
import { costPerPull, estimatePullRange, expectedSellBack } from '../lib/estimate';
import { formatEth, formatGwei, parseEthInput } from '../lib/format';
import { diffKeepList, type KeepToken } from '../lib/keepList';
import { checkGasCeiling, checkRunForm, defaultRunForm, parseAddresses, type RunForm } from '../lib/runParams';
import { Picker } from './Picker';
import { defaultMoreForm, SetupMore, type MoreForm } from './SetupMore';
import { TxStatus } from './ui';

const TOP_N = 6;

export function Setup({
  isConnected,
  vault,
  predicted,
  loading,
  onDone,
}: {
  isConnected: boolean;
  vault?: Address;
  predicted?: Address;
  loading: boolean;
  onDone: () => void;
}) {
  const { state: vaultState, loading: vaultLoading } = useVaultState(vault);
  const events = useVaultEvents(vault);
  const factoryFwa = useFactoryFwa();
  const fwa = vaultState?.fwa ?? factoryFwa;
  const now = useNow(30_000);
  const quote = useQuote(fwa);
  const tx = useTx();
  const { askWei } = useCollectionPrices(fwa);

  const poolStats = useReadContracts({
    contracts: fwa
      ? ([
          { address: fwa, abi: fwaAbi, functionName: 'weightedBackingTotal' },
          { address: fwa, abi: fwaAbi, functionName: 'totalWeight' },
          { address: fwa, abi: fwaAbi, functionName: 'settlementDiscountBps' },
        ] as const)
      : [],
    query: { enabled: !!fwa, refetchInterval: 30_000 },
  });

  const mode: 'create' | 'start' | 'blocked' = !vault ? 'create' : vaultState?.status === 0 ? 'start' : 'blocked';

  const [selected, setSelected] = useState<Map<string, Address>>(new Map());
  const [keepTokens, setKeepTokens] = useState<KeepToken[]>([]);
  const [keeperText, setKeeperText] = useState(defaultKeeper ?? '');
  const [run, setRun] = useState<RunForm>(() => defaultRunForm(Date.now() / 1000));
  const [more, setMore] = useState<MoreForm>(defaultMoreForm());
  const [spendEth, setSpendEth] = useState('1.00');
  const [stopPct, setStopPct] = useState(30);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [tried, setTried] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  // Hydrate from the existing vault's settings once, for the "start a new run" flow.
  const hydrated = useRef(false);
  useEffect(() => {
    if (mode !== 'start' || hydrated.current || !vaultState) return;
    hydrated.current = true;
    setSelected(new Map(events.settings.collections.map((c) => [c.toLowerCase(), c])));
    setKeepTokens(events.settings.tokens);
    if (events.settings.keepers.length) setKeeperText(events.settings.keepers.join(', '));
    setMore({
      gasCeilingGwei: formatGwei(vaultState.gasCeiling),
      bountyEth: formatEth(vaultState.bountyWei, 6),
      autoReturn: vaultState.autoReturn,
      privateMode: vaultState.privateMode,
    });
  }, [mode, vaultState, events.settings]);

  const sortedTop = useMemo(() => sortCollections(COLLECTIONS, askWei).slice(0, TOP_N), [askWei]);

  const weightedBackingTotal = (poolStats.data?.[0]?.result as bigint | undefined) ?? 0n;
  const totalWeight = (poolStats.data?.[1]?.result as bigint | undefined) ?? 0n;
  const settlementDiscountBps = (poolStats.data?.[2]?.result as bigint | undefined) ?? 0n;
  const sellBack = expectedSellBack(weightedBackingTotal, totalWeight, settlementDiscountBps);
  const cost = quote ? costPerPull(quote.total, sellBack, 0n) : 0n;
  const spendWei = parseEthInput(spendEth) ?? 0n;
  const range = estimatePullRange(spendWei, BigInt(Math.round(stopPct * 100)), cost);
  const stopAt = (spendWei * BigInt(100 - stopPct)) / 100n;

  function toggle(addr: Address) {
    setSelected((prev) => {
      const next = new Map(prev);
      const key = addr.toLowerCase();
      if (next.has(key)) next.delete(key);
      else next.set(key, addr);
      return next;
    });
  }

  const runForm: RunForm = { ...run, amountEth: spendEth, drawdownPct: stopPct };
  const checkedRun = checkRunForm(runForm, now, mode === 'create');
  const gasCheck = checkGasCeiling(more.gasCeilingGwei);

  async function submit() {
    setTried(true);
    if (!checkedRun.params || gasCheck.wei === null) return;
    const collections = [...selected.values()];
    const keepers = keeperText.trim() ? parseAddresses(keeperText).addresses : [];
    const bountyWei = parseEthInput(more.bountyEth) ?? DEFAULT_BOUNTY;
    const syncMaxWei = bountyWei > DEFAULT_SYNC_BOUNTY_MAX ? bountyWei : DEFAULT_SYNC_BOUNTY_MAX;

    if (mode === 'create') {
      if (!factoryAddress) return;
      const value = checkedRun.value ?? 0n;
      const ok = await tx.send('Start run', {
        address: factoryAddress,
        abi: factoryAbi,
        functionName: 'createVault',
        args: [collections, keepTokens, keepers, checkedRun.params, gasCheck.wei, more.autoReturn],
        value,
      });
      if (!ok || !predicted) return;
      let settingsFailed = false;
      if (more.privateMode) {
        if (!(await tx.send('Private mode', { address: predicted, abi: vaultAbi, functionName: 'setPrivateMode', args: [true] }))) {
          settingsFailed = true;
        }
      }
      if (bountyWei !== DEFAULT_BOUNTY || syncMaxWei !== DEFAULT_SYNC_BOUNTY_MAX) {
        if (!(await tx.send('Bounties', { address: predicted, abi: vaultAbi, functionName: 'setBounties', args: [bountyWei, syncMaxWei] }))) {
          settingsFailed = true;
        }
      }
      if (settingsFailed) {
        setSettingsError('Your run started, but some settings weren\'t saved. You can set them again under More on your run.');
      }
      onDone();
      return;
    }

    if (mode === 'start' && vault && vaultState) {
      const diff = diffKeepList({ collections: events.settings.collections, tokens: events.settings.tokens }, { collections, tokens: keepTokens });
      const steps = [
        ['Remove keep collections', 'setKeepCollections', diff.removeCollections, false],
        ['Remove keep tokens', 'setKeepTokens', diff.removeTokens, false],
        ['Add keep collections', 'setKeepCollections', diff.addCollections, true],
        ['Add keep tokens', 'setKeepTokens', diff.addTokens, true],
      ] as const;
      for (const [label, fn, list, keep] of steps) {
        if (!list.length) continue;
        if (!(await tx.send(label, { address: vault, abi: vaultAbi, functionName: fn, args: [list as never, keep] }))) return;
      }
      const newKeepers = keepers.filter((k) => !events.settings.keepers.some((e) => e.toLowerCase() === k.toLowerCase()));
      if (newKeepers.length) {
        if (!(await tx.send('Add keeper', { address: vault, abi: vaultAbi, functionName: 'setKeepers', args: [newKeepers, true] }))) return;
      }
      if (gasCheck.wei !== vaultState.gasCeiling) {
        if (!(await tx.send('Gas ceiling', { address: vault, abi: vaultAbi, functionName: 'setGasCeiling', args: [gasCheck.wei] }))) return;
      }
      if (more.autoReturn !== vaultState.autoReturn) {
        if (!(await tx.send('Auto-return', { address: vault, abi: vaultAbi, functionName: 'setAutoReturn', args: [more.autoReturn] }))) return;
      }
      if (more.privateMode !== vaultState.privateMode) {
        if (!(await tx.send('Private mode', { address: vault, abi: vaultAbi, functionName: 'setPrivateMode', args: [more.privateMode] })))
          return;
      }
      if (bountyWei !== vaultState.bountyWei || syncMaxWei !== vaultState.syncBountyMaxWei) {
        if (!(await tx.send('Bounties', { address: vault, abi: vaultAbi, functionName: 'setBounties', args: [bountyWei, syncMaxWei] })))
          return;
      }
      const value = checkedRun.value ?? 0n;
      if (value === 0n && vaultState.idle === 0n) {
        setTried(true);
        return;
      }
      const ok = await tx.send('Start run', { address: vault, abi: vaultAbi, functionName: 'startRun', args: [checkedRun.params], value });
      if (ok) onDone();
    }
  }

  if (!isConnected) {
    return (
      <div className="section" style={{ paddingTop: 40 }}>
        <p className="lede">Connect a wallet to set up a run.</p>
      </div>
    );
  }
  if (loading || (vault && vaultLoading)) return <p className="empty">Looking up your run.</p>;
  if (mode === 'blocked') {
    return (
      <div className="section" style={{ paddingTop: 40 }}>
        <h1 className="form-heading">Your run is already going</h1>
        <p className="lede">Stop it, or wait for it to wind down, before starting a new one.</p>
        <a className="btn-link" href="#/run">
          Go to your run
        </a>
      </div>
    );
  }

  const errs = tried ? checkedRun.errors : {};

  return (
    <>
      <header className="top with-back">
        <a className="icon-btn" aria-label="Back" href="#/">
          <BackIcon />
        </a>
        <div className="page-title">Set up a run</div>
      </header>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset className="fieldset" style={{ border: 0, margin: 0, padding: 0 }}>
          <legend className="form-heading" style={{ padding: 0 }}>
            What do you want to keep?
          </legend>
          <p className="form-lede">Pull one of these and it goes to your wallet. Everything else is sold back to pay for more pulls.</p>
          <button type="button" className="search" onClick={() => setPickerOpen(true)} aria-label={`Search ${COLLECTIONS.length} collections`}>
            <SearchIcon />
            <span style={{ color: 'var(--text-3)', fontSize: 16 }}>Search {COLLECTIONS.length} collections</span>
          </button>
          <div className="list-card">
            {sortedTop.map((c) => (
              <TopRow key={c.address} address={c.address} name={c.name} price={askWei[c.address.toLowerCase()]} on={selected.has(c.address.toLowerCase())} onToggle={() => toggle(c.address)} />
            ))}
          </div>
          <div className="row-between">
            <button type="button" className="btn-link" onClick={() => setPickerOpen(true)}>
              Show all {COLLECTIONS.length} collections
            </button>
            <span className="count-pill">{selected.size} picked</span>
          </div>
        </fieldset>

        <div className="fieldset" style={{ paddingTop: 28, borderTop: '1px solid var(--line)' }}>
          <div className="budget-heading heading">Your budget</div>
          <div className="budget-grid">
            <label className="budget-card">
              <span className="cap">Spend</span>
              <span className="budget-input-row">
                <input inputMode="decimal" aria-label="ETH to spend" value={spendEth} onChange={(e) => setSpendEth(e.target.value)} />
                <span className="unit">ETH</span>
              </span>
            </label>
            <label className="budget-card">
              <span className="cap">Stop if I&apos;m down</span>
              <span className="budget-input-row">
                <input
                  inputMode="numeric"
                  aria-label="Stop when down by, percent"
                  value={stopPct}
                  onChange={(e) => setStopPct(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                />
                <span className="unit">%</span>
              </span>
            </label>
          </div>
          {errs.amountEth ? <span className="field-error">{errs.amountEth}</span> : null}
        </div>

        <section aria-label="What to expect" className="expect">
          <div className="eyebrow">What to expect</div>
          <div className="headline">{range ? `About ${range.low} to ${range.high} pulls` : 'Add ETH to see an estimate'}</div>
          {quote ? (
            <div className="body">
              A pull costs about <span className="mono">{formatEth(quote.total, 3)} ETH</span> right now. One you don&apos;t keep sells back for
              about <span className="mono">{formatEth(sellBack, 3)} ETH</span>, so each pull uses about{' '}
              <span className="mono">{formatEth(cost > 0n ? cost : 0n, 3)} ETH</span> of your <span className="mono">{formatEth(spendWei, 3)} ETH</span>{' '}
              limit.
            </div>
          ) : (
            <div className="body">Reading the pool price.</div>
          )}
          <hr />
          <div className="fine">
            Each keep shortens the run, since it isn&apos;t sold back. The run stops at{' '}
            <span className="mono" style={{ color: '#f4f2ec' }}>
              {formatEth(stopAt, 3)} ETH
            </span>{' '}
            and the rest goes back to your wallet.
          </div>
        </section>

        <button type="button" className="nav-row" onClick={() => setMoreOpen(true)}>
          <span className="nav-row-text">
            <span className="nav-row-title">More settings</span>
            <span className="nav-row-sub">Single NFTs, price limit, end date, gas</span>
          </span>
          <ChevronRight />
        </button>

        <div className="cta-block">
          <button className="btn" type="submit" disabled={tx.busy}>
            Start run with {formatEth(spendWei, 3)} ETH
          </button>
          <div className="cta-note">You can stop anytime and get the rest back.</div>
        </div>
        <TxStatus state={tx.state} />
        {settingsError ? (
          <p className="field-error">{settingsError}</p>
        ) : null}
        {tried && Object.keys(errs).length ? (
          <ul className="plain">
            {Object.entries(errs).map(([k, v]) => (
              <li key={k} className="field-error">
                {v}
              </li>
            ))}
          </ul>
        ) : null}
      </form>

      {pickerOpen ? (
        <Picker collections={COLLECTIONS} askWei={askWei} selected={new Set(selected.keys())} onToggle={toggle} onClose={() => setPickerOpen(false)} />
      ) : null}
      {moreOpen ? (
        <SetupMore
          run={run}
          onRun={setRun}
          more={more}
          onMore={setMore}
          keepTokens={keepTokens}
          onAddToken={(t) => setKeepTokens((prev) => [...prev, t])}
          onRemoveToken={(t) => setKeepTokens((prev) => prev.filter((x) => !(x.collection === t.collection && x.tokenId === t.tokenId)))}
          onClose={() => setMoreOpen(false)}
        />
      ) : null}
    </>
  );
}

function TopRow({ address, name, price, on, onToggle }: { address: Address; name: string; price: bigint | undefined; on: boolean; onToggle: () => void }) {
  const { image, bg } = useNftImage(address, isPunks(address) ? 1042n : undefined);
  return (
    <label className="coll-row">
      <div className="coll-thumb" style={{ background: bg }}>
        {image ? <img src={image} alt="" /> : null}
      </div>
      <div className="coll-info">
        <div className="coll-name">{name}</div>
        <div className="coll-meta mono">{price !== undefined ? `${formatEth(price, 2)} ETH` : ''}</div>
      </div>
      <input type="checkbox" className="checkbox" checked={on} onChange={onToggle} />
    </label>
  );
}

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}
