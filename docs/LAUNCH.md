# Launch

Mainnet launch checklist. The owner signs every transaction; nothing here holds a key.

## 1. Dry run

```sh
MAINNET_RPC_URL=<mainnet rpc> ./script/deploy.sh dry-run
```

Forks mainnet in anvil with a throwaway unlocked sender, then runs the real deploy script:
preflight, `FwaClientLib` (CREATE2, deterministic address) and `VaultFactory`, postflight. It then
creates a vault from the new factory, reads it back, stops it and withdraws, allowlists the factory
as the reward vault owner, and registers the vault. It prints the record, gas per transaction and
this checklist. It leaves no files behind. Expect about 8.4M gas for the deploy (library 1.77M,
factory 6.59M) and 0.4M for `createVault`.

Preflight reverts unless, on chain 1: the pool's runtime equals `refs/fwa-v2/FWAV2.json` with only
its two immutables (VRF service, purchase notifier) differing; `pool.rewards()` and `pool.token()`
are the known FWA V2 rewards and FWAT; the transfer helper's `token()` is FWAT and `permit2()` is
Permit2; the reward vault has code and holds FWAT; the fee recipient is nonzero. It logs the reward
vault owner and whether the distributor grant exists.

## 2. Deploy

From a clean checkout of `main` at `origin/main`:

```sh
export MAINNET_RPC_URL=<mainnet rpc>
export DEPLOY_SENDER=<signer address>
export DEPLOY_SIGNER_ARGS="--ledger"          # or "--account <keystore name>"
export ETHERSCAN_API_KEY=<key>                # optional; Sourcify otherwise
./script/deploy.sh mainnet
```

The wrapper refuses a dirty tree, another branch, a non-1 chain id, raw keys, and an existing
`deployments/mainnet.json`. The script writes `deployments/pending.json`; once every transaction has
a successful receipt the wrapper writes `deployments/mainnet.json` (addresses, deploy tx and block,
every transaction, chain id, commit). Commit it in a PR.

## 3. Verify

`--verify` covers `VaultFactory` and `FwaClientLib`. The wrapper then verifies the router and the
vault implementation (created in the factory constructor) with `forge verify-contract`. Check all
four show as verified; rerun a failed one by hand with the same arguments.

## 4. Post-deploy

- [ ] Reward vault owner allowlists the factory. To `0xEa20a110ad3Dfc483977d14f80203994E65D34FB`:

  ```sh
  cast calldata "setSeries(address,bool)" <factory> true
  # 0x709e0328 + <factory, 32 bytes> + 0000...0001
  cast send 0xEa20a110ad3Dfc483977d14f80203994E65D34FB "setSeries(address,bool)" <factory> true <signer args>
  ```

  Vaults created before this call register later through `registerRewards()` (permissionless).
- [ ] FWA team grants the reward vault distributor status on FWAT. Status: pending. Until it lands,
  harvesting reverts; pulls are unaffected.
- [ ] Fund two keeper wallets (separate keys, a few tenths of an ETH each; `MIN_BALANCE_WEI` alerts
  at 0.05 ETH).
- [ ] Keeper secrets, per app (`keeper/fly.toml`, `keeper/fly.backstop-b.toml`; replace the app name
  placeholders): `fly secrets set RPC_URL=... SEND_RPC_URL=... KEEPER_PRIVATE_KEY=...
  FACTORY=<factory> FROM_BLOCK=<deploy block>`, optional `ALERT_WEBHOOK_URL`. Use different RPC
  providers for the two apps. `fly deploy -c <file>` from `keeper/`, then check `/health`.
- [ ] Web: in Netlify (base directory `web`, `web/netlify.toml`) set `VITE_RPC_URL`,
  `VITE_FACTORY=<factory>`, `VITE_FROM_BLOCK=<deploy block>`, optional `VITE_DEFAULT_KEEPER`, and
  deploy. The RPC URL ships in the bundle; restrict its key to the site's domain.
- [ ] Smoke test: create a small vault (for example 0.02 ETH, one pull, low drawdown) from the site,
  confirm it registered with the reward vault, watch a keeper sync it, then `stop()` and
  `withdraw()`.

## Rollback

The factory has no admin and nothing can be paused or upgraded. If a bug is found, stop promoting
the factory in the UI (take the site down or point it at a fixed factory) and tell users. Each vault
owner can always `stop()` (no new pulls; in-flight pulls still resolve through `sync`) and, once the
vault is idle, `withdraw()`. A fixed version is a new factory deployment with its own
`setSeries` call.
