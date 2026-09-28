/** Resolves a tokenURI/image URI: passes data: URIs through, maps ipfs:// to a public gateway. */
export function resolveUri(uri: string): string {
  if (uri.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${uri.slice('ipfs://'.length)}`;
  if (uri.startsWith('ar://')) return `https://arweave.net/${uri.slice('ar://'.length)}`;
  return uri;
}

/** A soft, deterministic pastel background for a collection address, used when an image is unavailable. */
export function placeholderColor(address: string): string {
  let hash = 0;
  const s = address.toLowerCase();
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return `hsl(${hue}, 38%, 83%)`;
}
