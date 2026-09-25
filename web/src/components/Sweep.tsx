import { useState } from 'react';
import { getAddress, isAddress, type Address } from 'viem';
import { useReadContracts } from 'wagmi';
import { vaultAbi } from '../abi/Vault';
import { fwaAbi } from '../abi/IFWA';
import { useTx } from '../hooks/useTx';
import { forcedNfts, type VaultEvent } from '../lib/events';
import { FORCED_KIND } from '../lib/format';
import { Addr, Field, Section, TxLink, TxStatus } from './ui';

/** Forced and stuck NFTs the vault may hold, and the owner's sweep form. */
export function Sweep({ vault, fwa, events }: { vault: Address; fwa: Address; events: VaultEvent[] }) {
  const tx = useTx();
  const forced = forcedNfts(events);
  const listings = useReadContracts({
    contracts: forced.map((f) => ({ address: fwa, abi: fwaAbi, functionName: 'listings', args: [f.listingId] }) as const),
    query: { enabled: forced.length > 0 },
  });
  const [collection, setCollection] = useState('');
  const [tokenId, setTokenId] = useState('');
  const validColl = isAddress(collection.trim(), { strict: false });
  const validId = /^\d+$/.test(tokenId.trim());

  const sweep = (c: Address, id: bigint) =>
    tx.send('Sweep NFT', { address: vault, abi: vaultAbi, functionName: 'sweepNft', args: [c, id] });

  return (
    <Section title="Sweep NFT">
      <p className="small">
        Sends an NFT the vault holds to your wallet. This happens after forced FWA outcomes. A stuck NFT needs Recover first.
      </p>
      {forced.length ? (
        <ul className="plain">
          {forced.map((f, i) => {
            const l = listings.data?.[i]?.result as readonly unknown[] | undefined;
            const c = l?.[0] as Address | undefined;
            const id = l?.[3] as bigint | undefined;
            return (
              <li key={f.requestId.toString()} className="row wrap">
                <span>
                  {FORCED_KIND[f.kind]}: listing #{f.listingId.toString()}
                  {c ? (
                    <>
                      {' '}
                      <Addr address={c} /> #{id?.toString()}
                    </>
                  ) : null}{' '}
                  <TxLink hash={f.txHash} label="tx" />
                </span>
                {f.kind === 1 ? (
                  <button
                    className="btn-small"
                    disabled={tx.busy}
                    onClick={() => tx.send('Recover', { address: vault, abi: vaultAbi, functionName: 'recoverStuck', args: [f.listingId] })}
                  >
                    Recover
                  </button>
                ) : null}
                {c && id !== undefined ? (
                  <button className="btn-small" disabled={tx.busy} onClick={() => sweep(c, id)}>
                    Sweep
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="row wrap">
        <Field label="Collection">
          <input spellCheck={false} placeholder="0x..." value={collection} onChange={(e) => setCollection(e.target.value)} />
        </Field>
        <Field label="Token id">
          <input inputMode="numeric" value={tokenId} onChange={(e) => setTokenId(e.target.value)} />
        </Field>
        <button
          className="btn-small"
          disabled={tx.busy || !validColl || !validId}
          onClick={() => sweep(getAddress(collection.trim()), BigInt(tokenId.trim()))}
        >
          Sweep
        </button>
      </div>
      <TxStatus state={tx.state} />
    </Section>
  );
}
