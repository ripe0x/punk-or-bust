import type { FeedItem } from '../lib/events';
import { Section, TxLink } from './ui';

const PAGE = 50;

export function Feed({ items, loading, error }: { items: FeedItem[]; loading: boolean; error: string | null }) {
  return (
    <Section title="Live feed">
      {error ? <p className="field-error">Could not load events: {error}</p> : null}
      {loading && !items.length ? <p className="muted">Loading events.</p> : null}
      {!loading && !items.length && !error ? <p className="muted">No events yet.</p> : null}
      <ol className="feed">
        {items.slice(0, PAGE).map((f) => (
          <li key={f.key} className={`feed-item tone-${f.tone}`}>
            <div className="feed-title">{f.title}</div>
            {f.detail ? <div className="feed-detail">{f.detail}</div> : null}
            <div className="feed-meta small">
              Block {f.blockNumber.toString()} <TxLink hash={f.txHash} label="tx" />
            </div>
          </li>
        ))}
      </ol>
      {items.length > PAGE ? <p className="small muted">Showing the latest {PAGE} of {items.length}.</p> : null}
    </Section>
  );
}
