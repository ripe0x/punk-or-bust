# keeper

Runs pulls, syncs and auction finalizes for the vaults of one `VaultFactory`. Node 22, one runtime
dependency (viem). The chain is the source of truth: every tick re-reads state; nothing is stored
except an optional cursor file that saves the log rescan on restart.

## Environment

| Variable | Default | |
|---|---|---|
| `RPC_URL` | required | HTTP RPC. Only its host is ever logged. |
| `KEEPER_PRIVATE_KEY` | required | Keeper EOA key. Never logged; removed from the environment at start. |
| `FACTORY` | required | `VaultFactory` address. |
| `FROM_BLOCK` | `0` | First block to scan for vaults. Set it to the factory's deploy block. |
| `POLL_MS` | `4000` | Tick interval. |
| `MIN_BALANCE_WEI` | `5e16` | Keeper balance alert threshold. |
| `ALERT_WEBHOOK_URL` | unset | JSON POST target for alerts (`{text, alert, ...}`), rate limited per alert. |
| `PORT` | `8080` | `GET /health`: last tick time and counts; 503 when the loop is stale. |
| `CURSOR_FILE` | unset | JSON file for the last scanned block, known vaults and open auctions. |
| `PRIORITY_FEE_WEI` | `1 gwei` | Tip. `maxFee = 2 x basefee + tip`. |
| `URGENT_PRIORITY_FEE_WEI` | `3 gwei` | Tip for urgent protective calls (`maxFee = 3 x basefee + tip`). |
| `PERMISSIONLESS_MAX_FEE_WEI` | `2 gwei` | Unreimbursed calls (vaults that did not approve this keeper, FWA `processAcquisitions`) only at or below this basefee + tip. `0` disables them. |
| `URGENT_AFTER_SEC` | `1800` | Allocated pull age that escalates (FWA's live settlement window is 1 hour). |
| `RBF_BLOCKS` / `RBF_BUMP_BPS` | `3` / `1500` | Replace-by-fee after 3 blocks, +15%. |
| `CANCEL_AFTER_BLOCKS` | `20` | A `requestPulls` stuck at its vault's gas ceiling is cancelled after this many blocks. |
| `SYNC_MAX_COUNT` | `10` | `sync(maxCount)` argument cap. |

## What a tick does

1. Clears or bumps the one in-flight tx (one tx per nonce stream at a time).
2. Scans `VaultCreated` and `AuctionStarted` logs (paged, halving the page on RPC errors).
3. Reads every vault and FWA's record of each outstanding pull at one block.
4. Plans, most urgent first: `finalizeAuction` past deadline, then `sync` (urgent first: an allocated
   pull older than 30 minutes, which also alerts), then FWA `processAcquisitions` for pulls stuck
   `Ready`, `TimedOut` or past their word deadline, then `requestPulls` (Running, fewer than 32 in
   flight, basefee + tip at or below the vault's `gasCeiling`, batch up to 5).
5. Simulates in that order and sends the first action that does something (a `sync` must resolve at
   least one pull). A pending `requestPulls` is replaced on its nonce by a protective call.

`requestPulls` caps `maxFeePerGas` at the vault's ceiling, so the contract's `tx.gasprice` check holds
in any block. Protective calls ignore the ceiling; the vault reimburses them up to 100 gwei.

## Run

```sh
npm ci
RPC_URL=... KEEPER_PRIVATE_KEY=... FACTORY=0x... FROM_BLOCK=... npm start
npm test          # decision logic, tx manager, tick, discovery (anvil smoke test runs if anvil is on PATH)
npm run abi       # regenerate src/abi from the contracts (needs forge)
```

## Deploy

```sh
docker build -t keeper keeper
docker run -d --restart unless-stopped -p 8080:8080 \
  -e RPC_URL -e KEEPER_PRIVATE_KEY -e FACTORY -e FROM_BLOCK -e ALERT_WEBHOOK_URL keeper
```

Pass secrets from the host's secret store, never from a file in the repo. Fund the keeper EOA; approved
vaults reimburse its gas.
