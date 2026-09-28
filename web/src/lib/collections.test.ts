import { describe, expect, it } from 'vitest';
import { isPunks, sortCollections, PUNKS_721 } from './collections';

describe('isPunks', () => {
  it('matches CryptoPunks 721 address case-insensitive', () => {
    expect(isPunks(PUNKS_721)).toBe(true);
    expect(isPunks(PUNKS_721.toLowerCase())).toBe(true);
    expect(isPunks(PUNKS_721.toUpperCase())).toBe(true);
  });
  it('rejects other addresses', () => {
    expect(isPunks('0x0000000000000000000000000000000000000000')).toBe(false);
    expect(isPunks('0x1111111111111111111111111111111111111111')).toBe(false);
  });
});

describe('sortCollections', () => {
  const testList = [
    { address: '0x0000000000000000000000000000000000000001', name: 'Alpha' },
    { address: PUNKS_721, name: 'CryptoPunks 721' },
    { address: '0x0000000000000000000000000000000000000002', name: 'Zulu' },
    { address: '0x0000000000000000000000000000000000000003', name: 'Bravo' },
  ];

  it('puts CryptoPunks first regardless of price', () => {
    const askWei: Record<string, bigint> = {};
    askWei[PUNKS_721.toLowerCase()] = 1n; // Lower price
    askWei['0x0000000000000000000000000000000000000001'.toLowerCase()] = 100n; // Higher price
    const sorted = sortCollections(testList, askWei);
    expect(sorted[0].address).toBe(PUNKS_721);
  });

  it('sorts by price descending after Punks', () => {
    const askWei: Record<string, bigint> = {};
    askWei['0x0000000000000000000000000000000000000001'.toLowerCase()] = 50n;
    askWei['0x0000000000000000000000000000000000000002'.toLowerCase()] = 100n;
    askWei['0x0000000000000000000000000000000000000003'.toLowerCase()] = 25n;
    const sorted = sortCollections(testList, askWei);
    // Punks first
    expect(sorted[0].address).toBe(PUNKS_721);
    // Then by descending price
    expect(sorted[1].address).toBe('0x0000000000000000000000000000000000000002'); // 100
    expect(sorted[2].address).toBe('0x0000000000000000000000000000000000000001'); // 50
    expect(sorted[3].address).toBe('0x0000000000000000000000000000000000000003'); // 25
  });

  it('sorts unpriced collections by name after priced ones', () => {
    const askWei: Record<string, bigint> = {};
    askWei['0x0000000000000000000000000000000000000001'.toLowerCase()] = 50n;
    // 0x0000000000000000000000000000000000000002: undefined
    // 0x0000000000000000000000000000000000000003: undefined
    const sorted = sortCollections(testList, askWei);
    // Punks first
    expect(sorted[0].address).toBe(PUNKS_721);
    // Priced collection
    expect(sorted[1].address).toBe('0x0000000000000000000000000000000000000001');
    // Unpriced collections sorted by name
    expect(sorted[2].name).toBe('Bravo');
    expect(sorted[3].name).toBe('Zulu');
  });

  it('does not mutate input list', () => {
    const original = JSON.parse(JSON.stringify(testList));
    const askWei: Record<string, bigint> = {};
    askWei['0x0000000000000000000000000000000000000002'.toLowerCase()] = 100n;
    sortCollections(testList, askWei);
    expect(testList).toEqual(original);
  });

  it('stable sort for same prices', () => {
    const list = [
      { address: '0x0000000000000000000000000000000000000001', name: 'Aaa' },
      { address: '0x0000000000000000000000000000000000000002', name: 'Bbb' },
    ];
    const askWei: Record<string, bigint> = {};
    askWei['0x0000000000000000000000000000000000000001'.toLowerCase()] = 50n;
    askWei['0x0000000000000000000000000000000000000002'.toLowerCase()] = 50n;
    const sorted = sortCollections(list, askWei);
    expect(sorted[0].name).toBe('Aaa');
    expect(sorted[1].name).toBe('Bbb');
  });
});
