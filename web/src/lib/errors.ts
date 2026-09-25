import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from 'viem';

const MESSAGES: Record<string, string> = {
  Unauthorized: 'This wallet is not allowed to do that.',
  AlreadyInitialized: 'This vault is already set up.',
  BadStatus: 'Not allowed while the vault is in this state.',
  BadParams: 'One of the values is out of range.',
  BadCount: 'Pull count must be 1 to 5.',
  TooManyOutstanding: 'Too many pulls in flight. Wait for some to resolve.',
  PurchaseBlackout: 'FWA is not selling pulls right now.',
  NotPriced: 'FWA has no pull price right now.',
  GasPriceTooHigh: 'Gas price is above the vault gas ceiling.',
  FloorReached: 'The drawdown floor is reached. Waiting for in-flight pulls.',
  BidTooLow: 'Bid is below the minimum next bid.',
  AuctionEnded: 'This auction has ended.',
  AuctionNotEnded: 'This auction has not ended yet.',
  VaultExists: 'This wallet already has a vault.',
  BadConfig: 'Factory is misconfigured.',
};

/** Plain message for a contract custom error name. */
export function explainRevert(name: string): string {
  return MESSAGES[name] ?? `Reverted: ${name}`;
}

/** Short user-facing message for any wallet or contract error. */
export function errorMessage(err: unknown): string {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return 'Cancelled in wallet.';
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName) {
      return explainRevert(revert.data.errorName);
    }
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}
