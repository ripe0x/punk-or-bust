import { useEffect, useState } from 'react';
import { useNftImage } from '../hooks/useNftImage';
import { isPunks } from '../lib/collections';
import { placeholderColor, resolveUri } from '../lib/nft';

/** Collection thumbnail: the bundled punk for CryptoPunks, the listed sample image otherwise, a tinted placeholder on failure. */
export function CollectionThumb({ address, image, sampleTokenId }: { address: string; image?: string; sampleTokenId?: string }) {
  const punks = isPunks(address);
  const { image: punkImage, bg } = useNftImage(punks ? (address as `0x${string}`) : undefined, punks ? 1042n : undefined);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [image]);

  const staticSrc = !punks && image && !failed ? resolveUri(image) : null;
  const needSample = !punks && !staticSrc && !!sampleTokenId && /^\d+$/.test(sampleTokenId);
  const { image: sampleImage } = useNftImage(needSample ? (address as `0x${string}`) : undefined, needSample ? BigInt(sampleTokenId!) : undefined);
  const src = punks ? punkImage : (staticSrc ?? sampleImage);
  return (
    <div className="coll-thumb" style={{ background: punks ? bg : placeholderColor(address) }}>
      {src ? <img src={src} alt="" loading="lazy" onError={punks || !staticSrc ? undefined : () => setFailed(true)} /> : null}
    </div>
  );
}
