import { useAccount, useConnect, useDisconnect } from 'wagmi';
import { chain } from '../config';
import { shortAddr } from '../lib/format';
import { errorMessage } from '../lib/errors';

export function Connect() {
  const { address, chainId, isConnected } = useAccount();
  const { connectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    return (
      <div className="connect">
        {chainId !== chain.id ? <span className="pill pill-bad">Wrong network</span> : null}
        <span className="mono">{shortAddr(address)}</span>
        <button className="btn-small" onClick={() => disconnect()}>
          Disconnect
        </button>
      </div>
    );
  }

  // EIP-6963 wallets announce themselves; the generic injected entry is only a fallback.
  const announced = connectors.filter((c) => c.id !== 'injected');
  const list = announced.length ? announced : connectors;
  return (
    <div className="connect">
      {list.length === 0 ? <span className="muted">No browser wallet found</span> : null}
      {list.map((c) => (
        <button key={c.uid} className="btn-small" disabled={isPending} onClick={() => connect({ connector: c })}>
          {c.icon ? <img src={c.icon} alt="" width={16} height={16} /> : null}
          {list.length === 1 && c.id === 'injected' ? 'Connect wallet' : c.name}
        </button>
      ))}
      {error ? <span className="field-error">{errorMessage(error)}</span> : null}
    </div>
  );
}
