import { useState, type ReactNode } from 'react';
import { getAddress, isAddress, type Address } from 'viem';
import type { KeepToken } from '../lib/keepList';
import type { RunForm } from '../lib/runParams';

export interface MoreForm {
  gasCeilingGwei: string;
  bountyEth: string;
  autoReturn: boolean;
  privateMode: boolean;
}

export function defaultMoreForm(): MoreForm {
  return { gasCeilingGwei: '1.2', bountyEth: '0.0003', autoReturn: true, privateMode: false };
}

export function SetupMore({
  run,
  onRun,
  more,
  onMore,
  keepTokens,
  onAddToken,
  onRemoveToken,
  onClose,
}: {
  run: RunForm;
  onRun: (f: RunForm) => void;
  more: MoreForm;
  onMore: (f: MoreForm) => void;
  keepTokens: KeepToken[];
  onAddToken: (t: KeepToken) => void;
  onRemoveToken: (t: KeepToken) => void;
  onClose: () => void;
}) {
  const setRun = <K extends keyof RunForm>(k: K, v: RunForm[K]) => onRun({ ...run, [k]: v });
  const setMore = <K extends keyof MoreForm>(k: K, v: MoreForm[K]) => onMore({ ...more, [k]: v });

  return (
    <div className="sheet-full" role="dialog" aria-label="More settings">
      <header className="top with-back">
        <button className="icon-btn" aria-label="Back" onClick={onClose}>
          <BackIcon />
        </button>
        <div className="page-title">More settings</div>
      </header>
      <div className="section" style={{ paddingBottom: 4 }}>
        <h1 className="form-heading md">Fine tune your run</h1>
        <p className="lede">The defaults work for most runs. You can change these any time, even mid-run.</p>
      </div>
      <form
        className="stack"
        style={{ paddingTop: 0 }}
        onSubmit={(e) => {
          e.preventDefault();
          onClose();
        }}
      >
        <div className="settings-card">
          <Row label="Most to pay per pull" help="Skip pulls priced above this.">
            <input
              className="settings-value-input"
              inputMode="decimal"
              aria-label="Most to pay per pull, ETH"
              value={run.maxPullCostEth}
              onChange={(e) => setRun('maxPullCostEth', e.target.value)}
              placeholder="0.15"
            />
          </Row>
          <Row label="End by" help="No new pulls after this date.">
            <input
              className="settings-value-input"
              type="datetime-local"
              aria-label="End by"
              value={run.deadline}
              onChange={(e) => setRun('deadline', e.target.value)}
            />
          </Row>
          <Row label="Stop after keeping" help="End once you have this many. 0 for no limit.">
            <input
              className="settings-value-input"
              inputMode="numeric"
              aria-label="Stop after keeping"
              value={run.stopAfterKeeps}
              onChange={(e) => setRun('stopAfterKeeps', e.target.value)}
            />
          </Row>
          <Row label="Most pulls" help="A hard cap on pulls.">
            <input
              className="settings-value-input"
              inputMode="numeric"
              aria-label="Most pulls"
              value={run.maxPulls}
              onChange={(e) => setRun('maxPulls', e.target.value)}
            />
          </Row>
          <Row label="Pause when gas is above" help="Pulls wait while the network is busy.">
            <input
              className="settings-value-input"
              inputMode="decimal"
              aria-label="Pause when gas is above, gwei"
              value={more.gasCeilingGwei}
              onChange={(e) => setMore('gasCeilingGwei', e.target.value)}
            />
          </Row>
          <Row label="Tip for helpers" help="Paid to whoever runs a pull for you.">
            <input
              className="settings-value-input"
              inputMode="decimal"
              aria-label="Tip for helpers, ETH"
              value={more.bountyEth}
              onChange={(e) => setMore('bountyEth', e.target.value)}
            />
          </Row>
        </div>

        <div className="settings-card">
          <label className="settings-row">
            <span className="settings-row-text">
              <span className="settings-row-label">Send ETH back when done</span>
              <span className="settings-row-help">What&apos;s left returns to your wallet on its own.</span>
            </span>
            <input type="checkbox" className="checkbox" checked={more.autoReturn} onChange={(e) => setMore('autoReturn', e.target.checked)} />
          </label>
          <label className="settings-row">
            <span className="settings-row-text">
              <span className="settings-row-label">Only my helpers can run pulls</span>
              <span className="settings-row-help">Off: anyone can run pulls for you and earn the tip. On: only addresses you add.</span>
            </span>
            <input type="checkbox" className="checkbox" checked={more.privateMode} onChange={(e) => setMore('privateMode', e.target.checked)} />
          </label>
        </div>

        <KeepTokens keepTokens={keepTokens} onAdd={onAddToken} onRemove={onRemoveToken} />

        <button type="submit" className="btn">
          Done
        </button>
      </form>
    </div>
  );
}

function Row({ label, help, children }: { label: string; help: string; children: ReactNode }) {
  return (
    <label className="settings-row">
      <span className="settings-row-text">
        <span className="settings-row-label">{label}</span>
        <span className="settings-row-help">{help}</span>
      </span>
      {children}
    </label>
  );
}

function KeepTokens({ keepTokens, onAdd, onRemove }: { keepTokens: KeepToken[]; onAdd: (t: KeepToken) => void; onRemove: (t: KeepToken) => void }) {
  const [adding, setAdding] = useState(false);
  const [addr, setAddr] = useState('');
  const [id, setId] = useState('');
  const validAddr = isAddress(addr.trim(), { strict: false });
  const validId = /^\d+$/.test(id.trim());

  return (
    <div className="settings-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="row-between">
        <span className="settings-row-text">
          <span className="settings-row-label">Keep single NFTs</span>
          <span className="settings-row-help">From a collection you didn&apos;t pick, by token number.</span>
        </span>
        {!adding ? (
          <button type="button" className="btn-outline" onClick={() => setAdding(true)}>
            Add
          </button>
        ) : null}
      </div>
      {keepTokens.length ? (
        <ul className="plain">
          {keepTokens.map((t) => (
            <li key={`${t.collection}:${t.tokenId}`} className="row wrap">
              <span className="mono small">
                {t.collection} #{t.tokenId.toString()}
              </span>
              <button type="button" className="btn-outline" onClick={() => onRemove(t)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {adding ? (
        <div className="row wrap">
          <input placeholder="0x collection address" value={addr} onChange={(e) => setAddr(e.target.value)} spellCheck={false} />
          <input placeholder="token id" inputMode="numeric" value={id} onChange={(e) => setId(e.target.value)} style={{ maxWidth: 120 }} />
          <button
            type="button"
            className="btn-outline"
            disabled={!validAddr || !validId}
            onClick={() => {
              onAdd({ collection: getAddress(addr.trim()) as Address, tokenId: BigInt(id.trim()) });
              setAddr('');
              setId('');
              setAdding(false);
            }}
          >
            Save
          </button>
        </div>
      ) : null}
    </div>
  );
}

function BackIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}
