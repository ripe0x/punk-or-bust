import { useMemo, useState } from 'react';
import type { Address } from 'viem';
import { useNftImage } from '../hooks/useNftImage';
import { isPunks, sortCollections, type Collection } from '../lib/collections';
import { formatEth } from '../lib/format';

export function Picker({
  collections,
  askWei,
  selected,
  onToggle,
  onClose,
}: {
  collections: Collection[];
  askWei: Record<string, bigint | undefined>;
  selected: Set<string>;
  onToggle: (address: Address) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'all' | 'picked'>('all');

  const sorted = useMemo(() => sortCollections(collections, askWei), [collections, askWei]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sorted
      .filter((c) => (tab === 'picked' ? selected.has(c.address.toLowerCase()) : true))
      .filter((c) => (q ? c.name.toLowerCase().includes(q) : true));
  }, [sorted, tab, selected, query]);

  return (
    <div className="sheet-full" role="dialog" aria-label="Pick what to keep">
      <div className="sheet-header">
        <div className="sheet-title">What to keep</div>
        <button className="icon-btn" aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <div className="sheet-search">
        <label className="search">
          <SearchIcon />
          <input
            type="search"
            placeholder={`Search ${collections.length} collections`}
            aria-label="Search collections"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div role="tablist" aria-label="Show" className="tabs">
          <button role="tab" aria-selected={tab === 'all'} className={`tab ${tab === 'all' ? 'active' : ''}`} onClick={() => setTab('all')}>
            All
          </button>
          <button
            role="tab"
            aria-selected={tab === 'picked'}
            className={`tab ${tab === 'picked' ? 'active' : ''}`}
            onClick={() => setTab('picked')}
          >
            Picked &middot; {selected.size}
          </button>
        </div>
        <div className="hint-text">CryptoPunks first, then highest pool price.</div>
      </div>
      <div className="sheet-list">
        <div className="list-card">
          {filtered.map((c) => (
            <CollectionRow key={c.address} collection={c} price={askWei[c.address.toLowerCase()]} on={selected.has(c.address.toLowerCase())} onToggle={() => onToggle(c.address)} />
          ))}
          {filtered.length === 0 ? <p className="empty">No collections match.</p> : null}
        </div>
      </div>
      <div className="sheet-footer">
        <button className="btn" onClick={onClose}>
          Keep {selected.size} collection{selected.size === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  );
}

function CollectionRow({ collection, price, on, onToggle }: { collection: Collection; price: bigint | undefined; on: boolean; onToggle: () => void }) {
  const { image, bg } = useNftImage(collection.address, isPunks(collection.address) ? 1042n : undefined);
  return (
    <label className="coll-row">
      <div className="coll-thumb" style={{ background: bg }}>
        {image ? <img src={image} alt="" /> : null}
      </div>
      <div className="coll-info">
        <div className="coll-name">{collection.name}</div>
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

function CloseIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
