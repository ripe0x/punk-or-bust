# punk-or-bust spec

This file is the source of truth. A question it does not answer goes to the owner, and the answer
lands here in the same PR. Nothing else in the repo states requirements.

## Product

A user funds a personal vault, picks a drawdown limit and a keep list, and a keeper runs FWA V2
pulls for them. Pulled NFTs on the keep list go to the user's wallet. Everything else sells back
to FWA, or goes to a short auction when the floor oracle says it is clearly under-backed. Sale
proceeds recycle into more pulls until a stop condition hits, then the remaining ETH returns to
the user.

Target chain: Ethereum mainnet, FWA V2 pool `0x958C41181182e76F221331b2755b77D9e1426A98` only.

## Contracts

| Contract | Role |
|---|---|
| `VaultFactory` | Deploys the router and the vault implementation in its constructor `(fwa, rewardVault, feeRecipient, transferHelper)`. Clones one vault per user (CREATE2, salt from the owner), keeps the registry, and presents the "series" interface the shared reward vault expects. No admin. |
| `Vault` | One per user. FWA's purchaser of record. Holds the user's ETH, runs pulls, routes reveals. Clone of one implementation. |
| `PurchaseRouter` | Shared. The only caller of `FWA.acquire`, so FWA's builder reward accrues to it. Accepts ETH only from factory vaults. Fixed treasury. No admin. |
| Execution module (if needed) | Delegatecall target for vault code that does not fit under EIP-170. Only split if the size forces it. |

External, already deployed:

| Contract | Address | Used for |
|---|---|---|
| FWA V2 pool | `0x958C41181182e76F221331b2755b77D9e1426A98` | pulls, settlement, floor oracle pointer |
| FWA V2 rewards | `0xa54b44c7a894aa19c49734a753d01f9b8c5f6516` | epoch rewards, builder allowance |
| Shared reward vault | `0xEa20a110ad3Dfc483977d14f80203994E65D34FB` | FWAT custody and per-vault claims (holds the distributor grant) |
| FWAT transfer helper | read from chain before deploy | router's builder FWAT delivery to treasury |

## Fees and builder reward

- Fee recipient and router treasury: `0xea194A186EBe76A84E2B2027f5f23F81939c05AD`. Immutable.
- Pull fee: **0.025%** (250 parts per million) of the ETH purchase price of each completed pull,
  excluding VRF. A pull is completed once FWA allocates it a listing, including forced outcomes.
  Failed or refunded pulls pay nothing. Charged once.
- Builder reward: FWA pays a share of its protocol fee (currently 1,500 bps of it) to the address
  that calls `acquire`, and only when that caller is not the purchaser. The router is the caller
  and the vault is the purchaser, so the reward accrues to the router and goes to the treasury. It
  comes out of FWA's protocol fee, not the user's funds.
- Router builder claims buy FWAT with no on-chain price floor, so only the treasury can trigger a
  claim (directly or by signature).

## Vault lifecycle

States: `Idle`, `Running`, `WindingDown`.

- `factory.createVault{value}(keepList, keepers, runParams, gasCeiling, autoReturn)` (paid by the
  user): clone, register with the reward vault, lock the owner's 100% FWAT share, store the keep
  list, keepers, gas ceiling (validated as in `setGasCeiling`) and auto-return, start the first run.
- `vault.startRun{value}(runParams)` from `Idle`. One run at a time.
- `stop()` (owner): no new pulls; in-flight pulls and auctions resolve; then `Idle`.
- A run ends on its own at: drawdown floor, keep target reached, deadline, pull cap, or FWA
  config outside the run's bounds (a quote above `maxPullCostWei`). Then `WindingDown`, then `Idle`.
  `RunWindingDown` carries the reason: `Owner` (stop), `Floor`, `Deadline`, `Keeps`, `MaxPulls`,
  `PriceCap`.
- Auto-return: when the last in-flight item of a run resolves, the vault sends its idle ETH to the
  owner. Default on, owner-settable.
- `withdraw()` (owner) any time the vault is `Idle`.
- `sweepNft(collection, tokenId)` (owner): send any NFT the vault holds to the owner (forced or
  stuck paths).
- Late ETH from FWA (forced settlements, refund credit) joins the owner's idle balance.
- `OWNER` is immutable. Moving to a new key is withdraw plus a new vault.

Run parameters, fixed per run: `maxDrawdownBps` (0 to 10,000), `maxPullCostWei`,
`stopAfterKeeps` (0 means no limit), `deadline`, `maxPulls`.

Note: in-flight pulls count as total loss for the floor check, so `maxDrawdownBps = 0` means the
run can never pull. Allowed, and the UI says so.

## Owner settings, editable at any time (including mid-run)

- Keep list: whole collections and specific `(collection, tokenId)` pairs. Only affects reveals
  after the change.
- Gas price ceiling for paid callers (pull requests and their reimbursement). Default
  **1.2 gwei**. Must be above zero and at most 100 gwei.
- Approved keepers.
- Private mode (default off).
- Bounties (see Bounties).
- Auto-return on or off.

## Permissions

Public by default: anyone may call `requestPulls`, `sync` and `finalizeAuction`, always inside the
run's limits (floor, max pull cost, max pulls, deadline, outstanding cap).

- `privateMode` (owner setting, default off): only the owner and approved keepers may
  `requestPulls`, and only approved keepers are paid. `sync` and `finalizeAuction` stay open.
- Everything that only brings value back (sync reveals, settle, finalize auctions, recover forced
  or stuck outcomes, claim refunds, harvest rewards): anyone.
- Paid callers: anyone but the owner in public mode, approved keepers in private mode. The owner is
  never paid.
- A paid call is reimbursed from idle ETH at `min(basefee + 2 gwei, tx.gasprice, ceiling)`, gas
  capped per call, plus its bounty, never more than idle ETH (gas first, then bounty). It is paid
  only when it does useful work: `requestPulls` opens a pull, `sync` resolves a pull or processes an
  FWA acquisition, `finalizeAuction` finalizes. Payment comes before auto-return, so the call that
  ends a run is paid.
- Sync and auction finalizing protect pulls already bought, so their reimbursement ignores the
  owner's ceiling: `min(basefee + 2 gwei, tx.gasprice, 100 gwei)`, same per-call gas caps.
- Nobody but the owner can `requestPulls` when `tx.gasprice` is above the owner's ceiling (pull
  cost rises with gas). The owner can pull at any gas price.
- A paid pull request first reserves its worst-case reimbursement plus `bountyWei`, so paid
  spending never crosses the drawdown floor.
- Liveness: before resolving, `sync` calls FWA `processAcquisitions(min(outstanding, 8))` when an
  outstanding pull is not yet terminal in FWA (for example `Ready` after a skipped callback fast
  path, or `TimedOut`). A revert there is ignored.

### Bounties

- `requestPulls` and `finalizeAuction`: `bountyWei` (default 0.0003 ETH).
- `sync`: `bountyWei` rising linearly to `syncBountyMaxWei` (default 0.003 ETH) as the oldest
  allocated pull it resolves ages from 0 to 30 minutes since its FWA `allocatedAt`; the max after
  that. A sync that resolves no allocated pull (refunds, or processing only) pays `bountyWei`.
- `setBounties(bountyWei, syncBountyMaxWei)` (owner, any time): each at or above its default,
  `syncBountyMaxWei >= bountyWei`, `bountyWei <= 0.003 ETH`, `syncBountyMaxWei <= 0.03 ETH`.

### Views for callers

`openAuctionIds()`, `auctionInfo(requestId)` (record plus the minimum next bid), and `syncStatus()`:
outstanding pulls FWA no longer holds as `Pending`, the oldest `allocatedAt` among outstanding pulls
still allocated (zero if none), and open auctions past their deadline. `feesPaid` is the running
total of pull fees paid.

## Drawdown floor

`floor = runStartValue * (10_000 - maxDrawdownBps) / 10_000`. A pull is allowed only if
`value - nextPullCost >= floor`, where value is idle ETH plus guaranteed receivables (revealed
pulls at their backstop) plus kept NFTs at the backstop given up for them. In-flight requests
count as zero, and so do allocated pulls not yet synced. Each pull is priced at its quote plus
its pull fee. The run ends on the floor only when nothing is in flight. Deposits during a run
raise `runStartValue` by the deposit.

## Reveal routing

Evaluated once, at reveal, in this order:

1. On the keep list (token entry, then collection entry): `keepAndForward` to the owner. If the
   keep reverts (for example a transfer-restricted collection), fall through to 3.
2. Miss auction if all of: collection is auction-eligible (not FWA token packs, not
   transfer-restricted), oracle fresh, `gapBps >= 900`, and `oracleBid - backstop >= minSurplusWei`.
3. Otherwise sell back (`acceptDepositorBid`) immediately.

Where:

- `backstop = backing * settlementDiscountBps / 10_000`
- `gapBps = (oracleBid - backstop) * 10_000 / backstop`
- `(oracleBid, oracleAsk, observedAt, periodUsed) = FWA.floorOracle().getFloorRange(collection)`
- Fresh means `observedAt` within the pool's `maxOracleAge()` and `periodUsed` at least the pool's
  `minOracleChallengePeriod()`. Manual oracle overrides are not treated as fresh.
- No reading, stale reading, or oracle-exempt collection: auction only if `backing >= 1 ETH`,
  otherwise sell back.
- A reading is also no reading when any oracle or pool read reverts or answers short, when
  `bid == 0`, `bid >= ask`, or `observedAt` is zero or in the future (the pool's own checks), or when
  `periodUsed` is above 24 hours (the pool's maximum challenge period, not readable on chain), which
  is how a manual override is marked.
- A keep that reverts sells back directly; it never opens an auction.

The oracle only chooses between two routes that both keep the FWA backstop as the floor. It
never sets a price the vault must accept.

## Miss auction

- Runs before settlement: the vault never takes the NFT. The winner is delivered by
  `keepAndForward`; with no bid, or a failed delivery, the vault sells back.
- Opening bid: backstop * 1.05. Minimum increment: 5%.
- Duration **60 minutes at most, extensions included**. Late bids extend by 5 minutes up to that
  cap. The cap is also bounded by the FWA settlement window minus a settle buffer.
- A cap on concurrent open auctions per vault keeps recycling from stalling.
- Bids are escrowed in the vault and refunded when outbid.

Decisions:

- An auction opens for 30 minutes. A bid with less than 5 minutes left moves the deadline to 5
  minutes after it, never past the hard deadline: `min(open + 60 min, allocatedAt +
  settlementWindow - 30 min)`. When less than 35 minutes of the window remain at reveal, the miss
  sells back.
- At most 8 open auctions per vault; at the cap a miss sells back.
- Open auctions count as in flight: toward the 32 cap, at zero for the drawdown floor, and the run
  does not end while one is open. The pull fee is charged when the auction opens.
- Outbid refunds are pushed with a 100,000 gas stipend; a failed push is credited to the bidder,
  who claims it with `claimBidRefund(to)`. Escrow and credits are never part of idle ETH, owner
  withdrawal, or auto-return.
- `finalizeAuction` is separate from `sync`, permissionless after the deadline, and pays a paid
  caller (see Permissions). A winner is paid out as a sale (proceeds to idle, status `Sold`). If the
  listing already left `Allocated`, the pull is `Forced` and the bid refunded. If the sell back
  itself reverts, the whole finalize reverts and can be retried.

## Rewards

- The vault is the purchaser, so FWA epoch rewards accrue to it.
- The factory registers each vault with the shared reward vault, and the vault locks the owner's
  share at 100%. Anyone can harvest a vault's rewards into the reward vault and anyone can
  deliver the owner's claim (it always pays the owner).
- Prerequisites outside this repo: the reward vault owner allowlists the factory
  (`setSeries(factory, true)`), and FWA grants the reward vault distributor status. Until the
  grant lands, harvesting reverts; pulls are unaffected.

## Live FWA values (mainnet, block 26,055,939)

Read live by the contracts; recorded here because they shape operations. `settlementWindow` 1
hour, `finalizeWindow` 1 hour, `settlementDiscountBps` 9,000, `builderRewardBps` 1,500,
`maxOracleAge` 7 days, `minOracleChallengePeriod` 6 hours. With a 1 hour window a miss auction
runs at most about 30 minutes, and keepers must sync within minutes of allocation.

## Deferred, not in v1

- Punks auction adapter. In v1 a CryptoPunk follows the normal keep, auction, or sell-back rules.
- Pooled rounds on any collection, and the long (about 20 to 23 hour) target auction they would
  use.
- Buying back into an open oracle challenge bid.

## Constants and defaults

| Name | Value |
|---|---|
| Pull fee | 250 ppm (0.025%) |
| Fee recipient / router treasury | `0xea194A186EBe76A84E2B2027f5f23F81939c05AD` |
| Default gas ceiling | 1.2 gwei (owner editable, 0 < x <= 100 gwei) |
| Miss auction gap trigger | 900 bps |
| Miss auction min surplus | 0.01 ETH |
| Miss auction max duration | 3,600 s including extensions |
| Miss auction extension | 300 s |
| Miss auction base duration | 1,800 s |
| Miss auction settle buffer | 1,800 s before the purchaser window ends |
| Max open auctions per vault | 8 |
| Opening premium / min increment | 10,500 bps / 10,500 bps |
| No-oracle auction threshold | 1 ETH backing |
| Max request batch | 5 (FWA's `maxAcquisitionsPerTx`) |
| Max outstanding pulls | 32 |
| Private mode default | off |
| Default bounty (`bountyWei`) | 0.0003 ETH (owner may raise, max 0.003 ETH) |
| Default sync bounty max (`syncBountyMaxWei`) | 0.003 ETH (owner may raise, max 0.03 ETH) |
| Sync bounty ramp | 1,800 s after FWA `allocatedAt` |
| Max FWA acquisitions processed per sync | 8 |
