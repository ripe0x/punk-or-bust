import type { RunForm } from '../lib/runParams';
import { unixToLocalInput } from '../lib/runParams';
import { formatEth } from '../lib/format';
import { Field } from './ui';

export function defaultRunForm(nowSec: number): RunForm {
  return {
    amountEth: '',
    drawdownPct: 25,
    maxPullCostEth: '',
    deadline: unixToLocalInput(nowSec + 7 * 86400),
    maxPulls: '100',
    stopAfterKeeps: '0',
  };
}

/** The run parameter inputs shared by vault creation and start run. */
export function RunFields({
  form,
  onChange,
  errors,
  amountLabel,
  amountHint,
  quote,
}: {
  form: RunForm;
  onChange: (f: RunForm) => void;
  errors: Record<string, string>;
  amountLabel: string;
  amountHint?: string;
  quote?: bigint;
}) {
  const set = <K extends keyof RunForm>(k: K, v: RunForm[K]) => onChange({ ...form, [k]: v });
  return (
    <div className="grid">
      <Field label={amountLabel} hint={amountHint} error={errors.amountEth}>
        <input inputMode="decimal" placeholder="0.5" value={form.amountEth} onChange={(e) => set('amountEth', e.target.value)} />
      </Field>

      <Field label={`Max drawdown: ${form.drawdownPct}%`} error={errors.drawdownPct}>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={form.drawdownPct}
          onChange={(e) => set('drawdownPct', Number(e.target.value))}
        />
        {form.drawdownPct === 0 ? (
          <span className="warn">
            0% means the run never pulls. Pulls in flight count as a total loss, so no pull fits above a 0% floor.
          </span>
        ) : (
          <span className="field-hint">The run stops pulling once it could lose more than this share of its start value.</span>
        )}
      </Field>

      <Field
        label="Max pull cost (ETH)"
        hint={quote ? `FWA price now: ${formatEth(quote, 5)} ETH per pull. The run ends if the price goes above your max.` : 'The run ends if FWA prices a pull above this.'}
        error={errors.maxPullCostEth}
      >
        <input
          inputMode="decimal"
          placeholder={quote ? formatEth((quote * 12n) / 10n, 5) : '0.1'}
          value={form.maxPullCostEth}
          onChange={(e) => set('maxPullCostEth', e.target.value)}
        />
      </Field>

      <Field label="Deadline" hint="No new pulls after this time." error={errors.deadline}>
        <input type="datetime-local" value={form.deadline} onChange={(e) => set('deadline', e.target.value)} />
      </Field>

      <Field label="Max pulls" error={errors.maxPulls}>
        <input inputMode="numeric" value={form.maxPulls} onChange={(e) => set('maxPulls', e.target.value)} />
      </Field>

      <Field label="Stop after keeps" hint="0 means no limit." error={errors.stopAfterKeeps}>
        <input inputMode="numeric" value={form.stopAfterKeeps} onChange={(e) => set('stopAfterKeeps', e.target.value)} />
      </Field>
    </div>
  );
}
