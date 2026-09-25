# keeper

A reference bot for the vaults of one `VaultFactory`: `sync`, `finalizeAuction` and `requestPulls`.
Vaults are public by default, so anyone may make these calls and the vault pays the caller its gas
plus a bounty. This keeper acts on every vault the factory created, and by default it is a backstop:
it steps in only when work is overdue, leaving public bots the first chance. Set the thresholds to 0
and it acts at once, like any public bot.

Node 22, one runtime dependency (viem). The chain is the source of truth: every tick re-reads state;
nothing is stored except an optional cursor file that saves the log rescan on restart.

## Environment

| Variable | Default | |
|---|---|---|
| `RPC_URL` | required | HTTP RPC for reads, simulation and receipts. Only its host is ever logged. |
| `SEND_RPC_URL` | unset | HTTP RPC used only to send signed transactions, for example a private relay. Unset: `RPC_URL`. Only its host is ever logged. |
| `KEEPER_PRIVATE_KEY` | required | Keeper EOA key. Never logged; removed from the environment at start. |
| `FACTORY` | required | `VaultFactory` address. |
| `FROM_BLOCK` | `0` | First block to scan for vaults. Set it to the factory's deploy block. |
| `POLL_MS` | `4000` | Tick interval. |
| `SYNC_AFTER_S` | `900` | Sync only once the oldest allocated, unsynced pull is this old (FWA `allocatedAt`). |
| `FINALIZE_AFTER_S` | `600` | Finalize an auction only this long past its deadline. |
| `REQUEST_AFTER_S` | `600` | Request pulls only for a `Running` vault with no new pull requests for this long. |
| `URGENT_AFTER_SEC` | `1800` | Allocated pull age that alerts and syncs whatever the payout (FWA's live settlement window is 1 hour). |
| `FINALIZE_GRACE_SEC` | `900` | Time past an auction's deadline that alerts and finalizes whatever the payout. |
| `MIN_BALANCE_WEI` | `5e16` | Keeper balance alert threshold. |
| `ALERT_WEBHOOK_URL` | unset | JSON POST target for alerts (`{text, alert, ...}`), rate limited per alert. |
| `PORT` | `8080` | `GET /health`: last tick time and counts; 503 when the loop is stale. |
| `CURSOR_FILE` | unset | JSON file for the last scanned block and known vaults. |
| `PRIORITY_FEE_WEI` | `1 gwei` | Tip. `maxFee = 2 x basefee + tip`. |
| `URGENT_PRIORITY_FEE_WEI` | `3 gwei` | Tip for urgent protective calls (`maxFee = 3 x basefee + tip`). |
| `RBF_BLOCKS` / `RBF_BUMP_BPS` | `3` / `1500` | Replace-by-fee after 3 blocks, +15%. |
| `CANCEL_AFTER_BLOCKS` | `20` | A `requestPulls` stuck at its vault's gas ceiling is cancelled after this many blocks. |
| `SYNC_MAX_COUNT` | `32` | `sync(maxCount)` argument cap. Keep at 32: the vault pays the bounty only when a sync clears every resolvable pull. |

## What a tick does

1. Clears or bumps the one in-flight tx (one tx per nonce stream at a time).
2. Scans `VaultCreated` logs for new vaults (paged, halving the page on RPC errors). No other logs
   are read.
3. Reads every vault at one block through its own views: `syncStatus()` (pulls a sync can resolve,
   the oldest FWA `allocatedAt`, auctions past deadline), `openAuctionIds()` and, when an auction is
   past its deadline, `auctionInfo()`, plus `privateMode`, `idle`, the bounties and the run.
4. Plans, most urgent first: `finalizeAuction` past deadline, then `sync` (urgent first), then a
   probing `sync` for a vault whose pulls are all still `Pending` in FWA (at most once per 10 blocks;
   `sync` advances FWA's sequence itself), then `requestPulls` (`Running`, fewer than 32 in flight,
   basefee + tip at or below the vault's `gasCeiling`, batch up to 5; in a private-mode vault only
   when the owner approved this keeper).
5. Keeps only overdue actions (the thresholds above). Allocated pulls and auctions are timed from
   the chain; a `requestPulls` quiet period, and syncs with no allocated pull, are timed from when
   this keeper first saw the work, and restart when another caller changes it.
6. Simulates at the latest block, in that order, and sends the first action that does something (a
   `sync` must resolve at least one pull; a `requestPulls` that ends the run is paid once per run
   and is sent) and whose expected payout covers its cost.
7. A pending `requestPulls` is replaced on its nonce by a protective call. Before every bump the tx
   is simulated again; if another caller already did the work, the nonce is cancelled with a
   self-transfer instead.

## Payout

A call pays when it does useful work: gas at `min(basefee + 2 gwei, tx.gasprice, ceiling)` (the
owner's `gasCeiling` for `requestPulls`, 100 gwei for `sync` and `finalizeAuction`), gas capped per
function, plus the bounty, never more than the vault's idle ETH. The bounty is `bountyWei` for
`requestPulls` and `finalizeAuction`; for `sync` it rises from `bountyWei` to `syncBountyMaxWei` as
the oldest allocated pull ages to 30 minutes. The owner is never paid, and in private mode only
approved keepers are. The keeper estimates this from the vault's state and the simulated gas, and
sends only when it is at least the tx's cost. Urgent protective calls (an allocated pull at
`URGENT_AFTER_SEC`, an auction at `FINALIZE_GRACE_SEC` past deadline) go out regardless, since they
protect pulls already bought.

`requestPulls` caps `maxFeePerGas` at the vault's ceiling, so the contract's `tx.gasprice` check holds
in any block.

## Private relay

With `SEND_RPC_URL` pointing at a relay such as Flashbots Protect, transactions skip the public
mempool. Protect does not include a reverting transaction, so a lost race (another bot finalized or
synced first) costs nothing. A dropped transaction leaves its nonce pending; the next bump re-simulates
and cancels it with a self-transfer through the same relay. Nonces, receipts and simulation stay on
`RPC_URL`.

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
  -e RPC_URL -e SEND_RPC_URL -e KEEPER_PRIVATE_KEY -e FACTORY -e FROM_BLOCK -e ALERT_WEBHOOK_URL keeper
```

Pass secrets from the host's secret store, never from a file in the repo. Fund the keeper EOA; vaults
reimburse the gas of the calls they pay for.
