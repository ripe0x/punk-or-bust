import { describe, expect, it } from 'vitest';
import { diffKeepList, formatKeepList, isEmptyDiff, parseKeepList } from './keepList';

const A = '0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb';
const A_SUM = '0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB';
const B = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';

describe('parseKeepList', () => {
  it('reads whole collections and checksums them', () => {
    const r = parseKeepList(`${A}\n${B}`);
    expect(r.errors).toEqual([]);
    expect(r.collections).toEqual([A_SUM, B]);
    expect(r.tokens).toEqual([]);
  });
  it('reads token ids in several forms', () => {
    const r = parseKeepList(`${A} 1 2 3\n${B}:7, ${B}/8; ${B}#0x0a`);
    expect(r.errors).toEqual([]);
    expect(r.collections).toEqual([]);
    expect(r.tokens.map((t) => `${t.collection}:${t.tokenId}`)).toEqual([
      `${A_SUM}:1`,
      `${A_SUM}:2`,
      `${A_SUM}:3`,
      `${B}:7`,
      `${B}:8`,
      `${B}:10`,
    ]);
  });
  it('reads comma separated collections on one line', () => {
    const r = parseKeepList(`${A}, ${B}`);
    expect(r.collections).toEqual([A_SUM, B]);
  });
  it('drops duplicates, blank lines and comments', () => {
    const r = parseKeepList(`\n${A} // punks\n${A.toUpperCase().replace('0X', '0x')}\n\n${B} 5 5`);
    expect(r.collections).toEqual([A_SUM]);
    expect(r.tokens).toHaveLength(1);
  });
  it('reports bad input', () => {
    const r = parseKeepList('12\nhello\n0x1234');
    expect(r.errors).toHaveLength(3);
    expect(r.errors[0]).toContain('no collection');
  });
});

describe('formatKeepList and diffKeepList', () => {
  it('round trips', () => {
    const parsed = parseKeepList(`${A}\n${B} 9 2`);
    const again = parseKeepList(formatKeepList(parsed));
    expect(again.collections).toEqual(parsed.collections);
    expect(again.tokens.map(String)).toEqual(parsed.tokens.map(String));
    expect(formatKeepList(parsed)).toBe(`${A_SUM}\n${B} 2 9`);
  });
  it('diffs adds and removes', () => {
    const cur = parseKeepList(`${A}\n${B} 1 2`);
    const next = parseKeepList(`${B}\n${B} 2 3`);
    const d = diffKeepList(cur, next);
    expect(d.addCollections).toEqual([B]);
    expect(d.removeCollections).toEqual([A_SUM]);
    expect(d.addTokens.map((t) => t.tokenId)).toEqual([3n]);
    expect(d.removeTokens.map((t) => t.tokenId)).toEqual([1n]);
    expect(isEmptyDiff(diffKeepList(cur, cur))).toBe(true);
  });
});
