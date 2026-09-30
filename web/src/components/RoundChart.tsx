import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { formatEth } from '../lib/format';

export type DeltaPull = { cost: bigint; proceeds: bigint; hit: boolean };

const abs = (v: bigint) => (v < 0n ? -v : v);
const signed = (v: bigint) => `${v >= 0n ? '+' : '−'}${formatEth(abs(v), 3)} ETH`;

/**
 * One round's running profit and loss: cumulative proceeds minus cost after each resolved pull.
 * The zero line floats at its real position, up is above it and down below, so the curve fills the
 * height rather than sitting in a centered band. A kept item marks a hit dot, a pull whose proceeds
 * beat its own cost marks a win dot. The end point equals the round's net. The SVG is drawn at the
 * container's pixel size (measured, not scaled) so dots stay round at any width. Single series, so
 * no legend; the header names it and hover reads each pull.
 */
export function RoundChart({ pulls, label, compact = false }: { pulls: readonly DeltaPull[]; label: string; compact?: boolean }) {
  const gradId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(200, Math.round(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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

  const H = compact ? 96 : 132;
  const PX = 12;
  const PY = 14;
  const R = compact ? 3 : 3.5;

  // Include zero so the baseline is always in view; the curve fills the plot between the round's
  // own low and high.
  const deltas = points.map((p) => p.delta);
  const lo = deltas.reduce((m, d) => (d < m ? d : m), 0n);
  const hi = deltas.reduce((m, d) => (d > m ? d : m), 0n);
  const span = hi - lo || 1n;
  const x = (pull: number) => PX + (pull / (points.length - 1)) * (width - 2 * PX);
  const y = (delta: bigint) => PY + (1 - Number(delta - lo) / Number(span)) * (H - 2 * PY);
  const zeroY = y(0n);
  const zeroPct = (zeroY / H) * 100;

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.pull).toFixed(1)} ${y(p.delta).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)} ${zeroY.toFixed(1)} L${x(0).toFixed(1)} ${zeroY.toFixed(1)} Z`;

  const net = points[points.length - 1].delta;
  const point = hover !== null ? points[hover] : points[points.length - 1];

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - b.left) / b.width;
    setHover(Math.max(1, Math.min(points.length - 1, Math.round(rel * (points.length - 1)))));
  };

  const tipX = x(point.pull);
  const side = tipX > width * 0.62 ? ' is-right' : tipX < width * 0.38 ? ' is-left' : '';

  return (
    <div className={compact ? 'round-chart compact' : 'round-chart'} ref={wrapRef}>
      <div className="round-chart-head">
        <span>
          {label}, {points.length - 1} pull{points.length - 1 === 1 ? '' : 's'}
        </span>
        <span className={`mono ${net < 0n ? 'neg' : 'pos'}`}>{signed(net)}</span>
      </div>
      <div className="round-chart-plot">
        <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} role="img" aria-label={`${label} running profit and loss, now ${signed(net)}`}>
          <defs>
            <linearGradient id={gradId} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2={H}>
              <stop offset="0%" stopColor="var(--profit-text)" stopOpacity="0.24" />
              <stop offset={`${Math.max(0, zeroPct - 0.5)}%`} stopColor="var(--profit-text)" stopOpacity="0.03" />
              <stop offset={`${Math.min(100, zeroPct + 0.5)}%`} stopColor="var(--accent-text-strong)" stopOpacity="0.03" />
              <stop offset="100%" stopColor="var(--accent-text-strong)" stopOpacity="0.2" />
            </linearGradient>
          </defs>
          <line className="round-chart-zero" x1={PX} y1={zeroY} x2={width - PX} y2={zeroY} />
          <path className="round-chart-area" d={area} fill={`url(#${gradId})`} />
          <path className="round-chart-line" d={line} />
          {points.filter((p) => p.hit).map((p) => (
            <circle key={`hit-${p.pull}`} className="round-chart-hit" cx={x(p.pull)} cy={y(p.delta)} r={R + 0.5} />
          ))}
          {points.filter((p) => p.proceeds > p.cost).map((p) => (
            <circle key={`win-${p.pull}`} className="round-chart-win" cx={x(p.pull)} cy={y(p.delta)} r={R - 1.5} />
          ))}
          {hover !== null ? (
            <>
              <line className="round-chart-cross" x1={tipX} y1={PY} x2={tipX} y2={H - PY} />
              <circle className="round-chart-hover" cx={tipX} cy={y(point.delta)} r={R + 1.5} />
            </>
          ) : null}
          <circle className={`round-chart-end ${net < 0n ? 'neg' : 'pos'}`} cx={x(points.length - 1)} cy={y(net)} r={R} />
          <rect x="0" y="0" width={width} height={H} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
        {hover !== null ? (
          <div className={`round-chart-tip${side}`} style={{ left: `${(tipX / width) * 100}%` }}>
            <strong>
              Pull #{point.pull}
              {point.hit ? <span className="round-chart-tip-kept">kept</span> : null}
            </strong>
            <span>
              <small>Cost</small>
              <b className="mono">{formatEth(point.cost, 4)}</b>
            </span>
            <span>
              <small>Back</small>
              <b className="mono">{formatEth(point.proceeds, 4)}</b>
            </span>
            <span>
              <small>This pull</small>
              <b className={`mono ${point.pullDelta < 0n ? 'neg' : 'pos'}`}>{signed(point.pullDelta)}</b>
            </span>
            <span>
              <small>Running</small>
              <b className={`mono ${point.delta < 0n ? 'neg' : 'pos'}`}>{signed(point.delta)}</b>
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
