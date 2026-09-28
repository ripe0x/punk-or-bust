import { describe, expect, it } from 'vitest';
import { placeholderColor, resolveUri } from './nft';

describe('resolveUri', () => {
  it('maps ipfs:// to a public gateway', () => {
    expect(resolveUri('ipfs://bafy123/1.json')).toBe('https://ipfs.io/ipfs/bafy123/1.json');
  });
  it('passes other schemes through', () => {
    expect(resolveUri('data:application/json;utf8,{}')).toBe('data:application/json;utf8,{}');
    expect(resolveUri('https://example.com/1.json')).toBe('https://example.com/1.json');
  });
});

describe('placeholderColor', () => {
  it('is deterministic for the same address', () => {
    const a = placeholderColor('0x0000000000000000000000000000000000dEaD');
    const b = placeholderColor('0x0000000000000000000000000000000000dEaD');
    expect(a).toBe(b);
  });
  it('is case-insensitive', () => {
    expect(placeholderColor('0xABCDEF')).toBe(placeholderColor('0xabcdef'));
  });
});
