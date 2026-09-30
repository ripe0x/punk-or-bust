import { useState } from 'react';

const W = 320;
const H = 120;
const PAD = 8;

/**
 * Run value over the session: one line of the vault's value after each resolved pull, with the
 * drawdown floor marked. Single series, so no legend; hover reads the value at a pull.
 */
export function SessionChart({ values, floor, start }: { values: number[]; floor: number; start: number }) {
  const [hover, setHover] = useState<number | null>(null);
  if (values.length < 2) return null;

  const lo = Math.min(floor, ...values);
  const hi = Math.max(start, ...values);
  const span = hi - lo || 1;
  const x = (i: number) => PAD + (i / (values.length - 1)) * (W - 2 * PAD);
  const y = (v: number) => PAD + (1 - (v - lo) / span) * (H - 2 * PAD);

  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(values.length - 1).toFixed(1)} ${(H - PAD).toFixed(1)} L${x(0).toFixed(1)} ${(H - PAD).toFixed(1)} Z`;
  const floorY = y(floor);
  const cur = hover ?? values.length - 1;
  const ending = values[values.length - 1];
  const down = ending < start;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - rect.left) / rect.width;
    setHover(Math.max(0, Math.min(values.length - 1, Math.round(rel * (values.length - 1)))));
  };

  return (
    <div className="session-chart">
      <div className="session-chart-head">
        <span>This run, {values.length} pulls</span>
        <span className={`mono ${down ? 'neg' : 'pos'}`}>{values[cur].toFixed(3)} ETH</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Run value over ${values.length} pulls, now ${ending.toFixed(3)} ETH, floor ${floor.toFixed(3)} ETH`} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <path d={area} className="session-area" />
        <line x1={PAD} y1={floorY} x2={W - PAD} y2={floorY} className="session-floor" />
        <path d={line} className="session-line" />
        <line x1={x(cur)} y1={PAD} x2={x(cur)} y2={H - PAD} className="session-cross" />
        <circle cx={x(cur)} cy={y(values[cur])} r={3.5} className="session-dot" />
      </svg>
      <div className="session-chart-foot">
        <span>Start {start.toFixed(2)}</span>
        <span className="stop">Floor {floor.toFixed(2)}</span>
      </div>
    </div>
  );
}
