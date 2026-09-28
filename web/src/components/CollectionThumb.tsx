import { useEffect, useState } from 'react';
import { useNftImage } from '../hooks/useNftImage';
import { isPunks } from '../lib/collections';
import { placeholderColor, resolveUri } from '../lib/nft';

/** Collection thumbnail: the bundled punk for CryptoPunks, the listed sample image otherwise, a tinted placeholder on failure. */
export function CollectionThumb({ address, image }: { address: string; image?: string }) {
  const punks = isPunks(address);
  const { image: punkImage, bg } = useNftImage(punks ? (address as `0x${string}`) : undefined, punks ? 1042n : undefined);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [image]);

  const src = punks ? punkImage : image && !failed ? resolveUri(image) : null;
  return (
    <div className="coll-thumb" style={{ background: punks ? bg : placeholderColor(address) }}>
      {src ? <img src={src} alt="" loading="lazy" onError={punks ? undefined : () => setFailed(true)} /> : null}
    </div>
  );
}
