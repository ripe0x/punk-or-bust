import { ConnectButton } from '@rainbow-me/rainbowkit';

export function Connect() {
  return (
    <div className="connect">
      <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} />
    </div>
  );
}
