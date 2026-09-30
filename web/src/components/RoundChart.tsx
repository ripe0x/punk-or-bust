import { useId, useMemo, useState } from 'react';
import { formatEth } from '../lib/format';

export type DeltaPull = { cost: bigint; proceeds: bigint; hit: boolean };

const W = 320;
const H = 120;
const BASE = H / 2;
const PLOT = 46;

const abs = (v: bigint) => (v < 0n ? -v : v);
const signed = (v: bigint) => `${v >= 0n ? '+' : '−'}${formatEth(abs(v), 3)} ETH`;

/**
 * One round's running profit and loss: cumulative proceeds minus cost after each resolved pull,
 * plotted around a zero baseline. Above the line is up, below is down. A kept item marks a hit dot,
 * a pull whose proceeds beat its own cost marks a win dot. The end point equals the round's net.
 * Single series, so no legend; the header names it and hover reads each pull.
 */
export function RoundChart({ pulls, label, compact = false }: { pulls: readonly DeltaPull[]; label: string; compact?: boolean }) {
  const gradId = useId();
  const [hover, setHover] = useState<number | null>(null);

  const points = useMemo(() => {
    let cost = 0n;
    let proceeds = 0n;
    const pts = [{ pull: 0, delta: 0n, pullDelta: 0n, cost: 0n, proceeds: 0n, hit: false }];
    pulls.forEach((p, i) => {
      cost += p.cost;
      proceeds += p.proceeds;
      pts.push({ pull: i + 1, delta: proceeds - cost, pullDelta: p.proceeds - p.cost, cost: p.cost, proceeds: p.proceeds, hit: p.hit });
    });
    return pts;
  }, [pulls]);

  if (points.length <= 1) return null;

  const maxAbs = points.reduce((m, p) => (abs(p.delta) > m ? abs(p.delta) : m), 1n);
  const x = (pull: number) => (pull / (points.length - 1)) * W;
  const y = (delta: bigint) => BASE - (Number(delta) / Number(maxAbs)) * PLOT;
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.pull).toFixed(1)} ${y(p.delta).toFixed(1)}`).join(' ');
  const area = `${line} L${W} ${BASE} L0 ${BASE} Z`;

  const net = points[points.length - 1].delta;
  const cur = hover ?? points.length - 1;
  const point = points[cur];

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - b.left) / b.width;
    setHover(Math.max(1, Math.min(points.length - 1, Math.round(rel * (points.length - 1)))));
  };

  return (
    <div className={compact ? 'round-chart compact' : 'round-chart'}>
      <div className="round-chart-head">
        <span>
          {label}, {points.length - 1} pull{points.length - 1 === 1 ? '' : 's'}
        </span>
        <span className={`mono ${net < 0n ? 'neg' : 'pos'}`}>
          {hover !== null ? `#${point.pull} ` : ''}
          {signed(point.delta)}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label} running profit and loss, now ${signed(net)}`}>
        <defs>
          <linearGradient id={gradId} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2={H}>
            <stop offset="0%" stopColor="var(--profit-text)" stopOpacity="0.26" />
            <stop offset="49.5%" stopColor="var(--profit-text)" stopOpacity="0.03" />
            <stop offset="50.5%" stopColor="var(--accent-text-strong)" stopOpacity="0.03" />
            <stop offset="100%" stopColor="var(--accent-text-strong)" stopOpacity="0.22" />
          </linearGradient>
        </defs>
        <line className="round-chart-zero" x1="0" y1={BASE} x2={W} y2={BASE} />
        <path className="round-chart-area" d={area} fill={`url(#${gradId})`} />
        <path className="round-chart-line" d={line} />
        {points.filter((p) => p.hit).map((p) => (
          <circle key={`hit-${p.pull}`} className="round-chart-hit" cx={x(p.pull)} cy={y(p.delta)} r="3.5" />
        ))}
        {points.filter((p) => p.proceeds > p.cost).map((p) => (
          <circle key={`win-${p.pull}`} className="round-chart-win" cx={x(p.pull)} cy={y(p.delta)} r="2" />
        ))}
        {hover !== null ? <line className="round-chart-cross" x1={x(point.pull)} y1="0" x2={x(point.pull)} y2={H} /> : null}
        <circle className={`round-chart-end ${net < 0n ? 'neg' : 'pos'}`} cx={x(point.pull)} cy={y(point.delta)} r="3.5" />
        <rect x="0" y="0" width={W} height={H} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
    </div>
  );
}
