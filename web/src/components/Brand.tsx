import { useEffect, useMemo, useState } from 'react';
import { COLLECTIONS, isPunks, PUNKS_721 } from '../lib/collections';
import { useCollectionCounts } from '../hooks/useCollectionCounts';
import { useNftImage } from '../hooks/useNftImage';

const ROTATE_MS = 2600;
const MAX_NAME = 12;

type Slot = { word: string; image?: string; punk: boolean };

/**
 * "<name> or Bust" header wordmark. Starts on Punk, then rolls, odometer style, through short-named
 * pool collections that have listings (all short-named ones when the listing count is unavailable,
 * e.g. no image API). Punks has no static image, so its slot uses the on-chain punk thumbnail.
 */
export function Brand() {
  const counts = useCollectionCounts();
  const punk = useNftImage(PUNKS_721, 1042n);

  const slots = useMemo<Slot[]>(() => {
    const rest = COLLECTIONS.filter(
      (c) =>
        !isPunks(c.address) &&
        c.name.length <= MAX_NAME &&
        !!c.image &&
        (!counts.loaded || (counts.counts[c.address.toLowerCase()]?.count ?? 0) > 0),
    ).map((c) => ({ word: c.name, image: c.image, punk: false }));
    return [{ word: 'Punk', punk: true }, ...rest];
  }, [counts.loaded, counts.counts]);

  const [i, setI] = useState(0); // Punk first.
  useEffect(() => {
    if (slots.length <= 1) return;
    const t = setInterval(() => {
      setI((cur) => {
        let n = cur;
        while (n === cur) n = Math.floor(Math.random() * slots.length);
        return n;
      });
    }, ROTATE_MS);
    return () => clearInterval(t);
  }, [slots.length]);

  const slot = slots[Math.min(i, slots.length - 1)];
  const img = slot.punk ? punk.image ?? undefined : slot.image;
  const bg = slot.punk ? punk.bg : undefined;

  return (
    <a href="/" className="brand">
      <span className="brand-mark" style={{ background: bg }} aria-hidden="true">
        {img ? <img key={slot.word} src={img} alt="" className="brand-odo-word" /> : null}
      </span>
      <span className="brand-name">
        <span className="brand-odo">
          <span key={slot.word} className="brand-odo-word">
            {slot.word}
          </span>
        </span>{' '}
        or Bust
      </span>
    </a>
  );
}
