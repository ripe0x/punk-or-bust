import { getAddress, isAddress, type Address } from 'viem';

export interface KeepToken {
  collection: Address;
  tokenId: bigint;
}

export interface KeepList {
  collections: Address[];
  tokens: KeepToken[];
}

export interface ParsedKeepList extends KeepList {
  errors: string[];
}

const tokenKey = (t: KeepToken) => `${t.collection.toLowerCase()}:${t.tokenId}`;

/**
 * Parses a pasted keep list. One entry per line (or separated by ";"). An address alone keeps the
 * whole collection; an address followed by token ids keeps only those tokens. Accepted forms:
 *   0xabc...                  whole collection
 *   0xabc... 1 2 3            tokens 1, 2 and 3
 *   0xabc...:7, 0xabc.../8    token 7 and token 8
 *   0xabc..., 0xdef...        two collections
 * Token ids are decimal or 0x hex. Text after "//" on a line is ignored. Duplicates are dropped.
 */
export function parseKeepList(text: string): ParsedKeepList {
  const collections = new Map<string, Address>();
  const tokens = new Map<string, KeepToken>();
  const errors: string[] = [];

  const lines = text.split(/[\n;]/);
  lines.forEach((raw, i) => {
    const line = raw.split('//')[0].trim();
    if (!line) return;
    const parts = line.split(/[\s,:/#]+/).filter(Boolean);
    let current: Address | null = null;
    let currentHasTokens = false;
    const flush = () => {
      if (current && !currentHasTokens) collections.set(current.toLowerCase(), current);
    };
    for (const part of parts) {
      if (/^0x[0-9a-fA-F]{40}$/.test(part)) {
        flush();
        if (!isAddress(part, { strict: false })) {
          errors.push(`Line ${i + 1}: bad address ${part}`);
          current = null;
          continue;
        }
        current = getAddress(part);
        currentHasTokens = false;
      } else if (/^\d+$/.test(part) || /^0x[0-9a-fA-F]{1,64}$/.test(part)) {
        if (!current) {
          errors.push(`Line ${i + 1}: token id ${part} has no collection before it`);
          continue;
        }
        const t = { collection: current, tokenId: BigInt(part) };
        tokens.set(tokenKey(t), t);
        currentHasTokens = true;
      } else {
        errors.push(`Line ${i + 1}: cannot read "${part}"`);
      }
    }
    flush();
  });

  return { collections: [...collections.values()], tokens: [...tokens.values()], errors };
}

/** Renders a keep list back to the text form `parseKeepList` reads. */
export function formatKeepList(list: KeepList): string {
  const lines = list.collections.map((c) => c as string);
  const byCollection = new Map<string, { collection: Address; ids: bigint[] }>();
  for (const t of list.tokens) {
    const k = t.collection.toLowerCase();
    const entry = byCollection.get(k) ?? { collection: t.collection, ids: [] };
    entry.ids.push(t.tokenId);
    byCollection.set(k, entry);
  }
  for (const { collection, ids } of byCollection.values()) {
    ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    lines.push(`${collection} ${ids.join(' ')}`);
  }
  return lines.join('\n');
}

export interface KeepListDiff {
  addCollections: Address[];
  removeCollections: Address[];
  addTokens: KeepToken[];
  removeTokens: KeepToken[];
}

/** What to set and unset to move the on-chain keep list from `current` to `next`. */
export function diffKeepList(current: KeepList, next: KeepList): KeepListDiff {
  const cur = new Set(current.collections.map((c) => c.toLowerCase()));
  const nxt = new Set(next.collections.map((c) => c.toLowerCase()));
  const curT = new Set(current.tokens.map(tokenKey));
  const nxtT = new Set(next.tokens.map(tokenKey));
  return {
    addCollections: next.collections.filter((c) => !cur.has(c.toLowerCase())),
    removeCollections: current.collections.filter((c) => !nxt.has(c.toLowerCase())),
    addTokens: next.tokens.filter((t) => !curT.has(tokenKey(t))),
    removeTokens: current.tokens.filter((t) => !nxtT.has(tokenKey(t))),
  };
}

export function isEmptyDiff(d: KeepListDiff): boolean {
  return !d.addCollections.length && !d.removeCollections.length && !d.addTokens.length && !d.removeTokens.length;
}
