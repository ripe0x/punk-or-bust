import { useEffect, useMemo, useRef, useState } from 'react';
import { useReadContracts } from 'wagmi';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import type { Address } from 'viem';
import { factoryAbi } from '../abi/VaultFactory';
import { vaultAbi } from '../abi/Vault';
import { fwaAbi } from '../abi/IFWA';
import { defaultKeeper, factoryAddress } from '../config';
import { useCollectionPrices } from '../hooks/useCollectionPrices';
import { useNow } from '../hooks/useNow';
import { useTx } from '../hooks/useTx';
import { useFactoryFwa, useQuote, useVaultEvents, useVaultState } from '../hooks/useVault';
import { CollectionThumb } from './CollectionThumb';
import { useCollectionCounts, visibleCollections } from '../hooks/useCollectionCounts';
import { COLLECTIONS, collectionMeta, displayName, sortCollections } from '../lib/collections';
import { DEFAULT_BOUNTY, DEFAULT_SYNC_BOUNTY_MAX } from '../lib/constants';
import { costPerPull, estimatePullRange, expectedSellBack } from '../lib/estimate';
import { formatEth, formatEthFixed, formatGwei, parseEthInput } from '../lib/format';
import { diffKeepList, type KeepToken } from '../lib/keepList';
import { checkGasCeiling, checkRunForm, defaultMaxPullCostWei, defaultRunForm, parseAddresses, type RunForm } from '../lib/runParams';
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
  onDone: (notice?: string) => void;
}) {
  const { state: vaultState, loading: vaultLoading } = useVaultState(vault);
  const events = useVaultEvents(vault);
  const factoryFwa = useFactoryFwa();
  const fwa = vaultState?.fwa ?? factoryFwa;
  const now = useNow(30_000);
  const { data: quote, isLoading: quoteLoading, error: quoteError } = useQuote(fwa);
  const tx = useTx();
  const { askWei } = useCollectionPrices(fwa);
  const counts = useCollectionCounts();
  const { openConnectModal } = useConnectModal();

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
  const [amountError, setAmountError] = useState<string | null>(null);

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

  // Prefill the max pull cost once the pull price is known, unless the user already typed one.
  const maxPullTouched = useRef(false);
  const quoteTotal = quote?.total;
  useEffect(() => {
    if (quoteTotal === undefined || maxPullTouched.current) return;
    maxPullTouched.current = true;
    setRun((r) => (r.maxPullCostEth.trim() === '' ? { ...r, maxPullCostEth: formatEth(defaultMaxPullCostWei(quoteTotal), 2) } : r));
  }, [quoteTotal]);

  const shown = useMemo(() => visibleCollections(COLLECTIONS, counts), [counts]);
  const sortedTop = useMemo(() => sortCollections(shown, askWei).slice(0, TOP_N), [shown, askWei]);

  const weightedBackingTotal = (poolStats.data?.[0]?.result as bigint | undefined) ?? 0n;
  const totalWeight = (poolStats.data?.[1]?.result as bigint | undefined) ?? 0n;
  const settlementDiscountBps = (poolStats.data?.[2]?.result as bigint | undefined) ?? 0n;
  const sellBack = expectedSellBack(weightedBackingTotal, totalWeight, settlementDiscountBps);
  const cost = quote ? costPerPull(quote.total, sellBack, 0n) : 0n;
  const spendWei = parseEthInput(spendEth) ?? 0n;
  const range = estimatePullRange(spendWei, BigInt(Math.round(stopPct * 100)), cost);
  const stopAt = (spendWei * BigInt(100 - stopPct)) / 100n;
  const estimateLoading = quoteLoading || poolStats.isLoading;
  const estimateError = quoteError || poolStats.isError;

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
    if (!isConnected) {
      openConnectModal?.();
      return;
    }
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
      onDone(settingsFailed ? "Your run started, but some settings weren't saved. You can set them again under More on your run." : undefined);
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
        setAmountError('Add ETH to start a run.');
        return;
      }
      const ok = await tx.send('Start run', { address: vault, abi: vaultAbi, functionName: 'startRun', args: [checkedRun.params], value });
      if (ok) onDone();
    }
  }

  if (isConnected && (loading || (vault && vaultLoading))) return <p className="empty">Looking up your run.</p>;
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
  const finalErrs = { ...errs };
  if (amountError) finalErrs.amountEth = amountError;

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
          <button type="button" className="search" onClick={() => setPickerOpen(true)} aria-label={`Search ${shown.length} collections`}>
            <SearchIcon />
            <span style={{ color: 'var(--text-3)', fontSize: 16 }}>Search {shown.length} collections</span>
          </button>
          <div className="list-card">
            {sortedTop.map((c) => (
              <TopRow key={c.address} address={c.address} image={c.image} name={displayName(c)} count={counts.loaded ? counts.counts[c.address.toLowerCase()]?.count : undefined} sample={counts.counts[c.address.toLowerCase()]?.sampleTokenId} price={askWei[c.address.toLowerCase()]} on={selected.has(c.address.toLowerCase())} onToggle={() => toggle(c.address)} />
            ))}
          </div>
          <div className="row-between">
            <button type="button" className="btn-link" onClick={() => setPickerOpen(true)}>
              Show all {shown.length} collections
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
                <input inputMode="decimal" aria-label="ETH to spend" value={spendEth} onChange={(e) => {
                  setSpendEth(e.target.value);
                  setAmountError(null);
                }} />
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
          {finalErrs.amountEth ? <span className="field-error">{finalErrs.amountEth}</span> : null}
        </div>

        <section aria-label="What to expect" className="expect">
          <div className="eyebrow">What to expect</div>
          <div className="headline">
            {spendWei <= 0n
              ? 'Add ETH to see an estimate'
              : estimateError
                ? 'Estimate unavailable right now.'
                : estimateLoading || !quote || !range
                  ? 'Reading the pool.'
                  : `About ${range.low} to ${range.high} pulls`}
          </div>
          {spendWei > 0n && quote ? (
            <div className="body">
              A pull costs about <span className="mono">{formatEthFixed(quote.total, 3)} ETH</span> right now. One you don&apos;t keep sells back for
              about <span className="mono">{formatEthFixed(sellBack, 3)} ETH</span>, so each pull uses about{' '}
              <span className="mono">{formatEthFixed(cost > 0n ? cost : 0n, 3)} ETH</span> of your <span className="mono">{formatEthFixed(spendWei - stopAt, 2)} ETH</span>{' '}
              limit.
            </div>
          ) : null}
          <hr />
          <div className="fine">
            Each keep shortens the run, since it isn&apos;t sold back. The run stops at{' '}
            <span className="mono" style={{ color: '#f4f2ec' }}>
              {formatEthFixed(stopAt, 2)} ETH
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
            Start run with {formatEthFixed(spendWei, 2)} ETH
          </button>
          <div className="cta-note">You can stop anytime and get the rest back.</div>
        </div>
        <TxStatus state={tx.state} />
        {(tried || amountError) && Object.keys(finalErrs).length ? (
          <ul className="plain">
            {Object.entries(finalErrs).map(([k, v]) => (
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
          onRun={(f) => {
            maxPullTouched.current = true;
            setRun(f);
          }}
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

function TopRow({ address, image, name, count, sample, price, on, onToggle }: { address: Address; image?: string; name: string; count: number | undefined; sample?: string; price: bigint | undefined; on: boolean; onToggle: () => void }) {
  return (
    <label className="coll-row">
      <CollectionThumb address={address} image={image} sampleTokenId={sample} />
      <div className="coll-info">
        <div className="coll-name">{name}</div>
        <div className="coll-meta mono">{collectionMeta(count, price)}</div>
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
