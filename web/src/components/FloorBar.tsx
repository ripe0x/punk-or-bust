import { floorBar } from '../lib/floor';
import { formatEth } from '../lib/format';

export function FloorBar({ value, floor, start }: { value: bigint; floor: bigint; start: bigint }) {
  const b = floorBar(value, floor, start);
  return (
    <div className="floorbar-wrap">
      <div
        className={`floorbar ${b.atFloor ? 'floorbar-low' : ''}`}
        role="img"
        aria-label={`Run value ${formatEth(value)} ETH, floor ${formatEth(floor)} ETH`}
      >
        <div className="floorbar-fill" style={{ width: `${b.value * 100}%` }} />
        <div className="floorbar-mark" style={{ left: `${b.floor * 100}%` }} />
      </div>
      <div className="floorbar-legend small">
        <span>Value {formatEth(value)} ETH</span>
        <span>Floor {formatEth(floor)} ETH</span>
        <span>{b.atFloor ? 'At floor' : `${formatEth(b.headroom)} ETH above floor`}</span>
      </div>
    </div>
  );
}
