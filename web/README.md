# web

Static app for punk-or-bust vaults: create and run your vault, watch its live feed, and bid on
open miss auctions. Vite, React, viem and wagmi. Injected browser wallets only (EIP-6963).

## Config

Set at build time through Vite env vars (for example in the shell, or a local env file that is
never committed):

| Var | Meaning |
|---|---|
| `VITE_RPC_URL` | JSON-RPC endpoint for reads and log scans |
| `VITE_FACTORY` | `VaultFactory` address |
| `VITE_CHAIN_ID` | Chain id, default `1` |
| `VITE_DEFAULT_KEEPER` | Keeper address prefilled in the create form (optional) |
| `VITE_FROM_BLOCK` | First block to scan for events; set it to the factory deploy block |

## Commands

```sh
npm ci
npm run dev        # local dev server
npm run typecheck
npx vitest run     # unit tests for the pure helpers in src/lib
npm run build      # static output in dist/
npm run abi        # regenerate src/abi from the contracts (needs foundry)
```

Routes: `#/` your vault, `#/auctions` open auctions across all vaults, `#/vault/<address>` a
read-only view of any vault.

Vaults are found by scanning the factory's `VaultCreated` logs. Everything else comes from the
vaults' views: the auctions page reads `openAuctionIds()` and `auctionInfo()` per vault, and
`bidRefunds` for the connected wallet. The dashboard scans one vault's logs for its feed, keep list
and approved keepers (mappings the contract cannot list) and the latest wind-down reason.
