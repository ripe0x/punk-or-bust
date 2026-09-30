#!/usr/bin/env bash
# Local test environment: a persistent anvil mainnet fork with the factory deployed and one funded
# vault mid-run, plus the web env pointed at it. The vault talks to the real FWA V2 pool, so the
# fork carries its code and pull flows behave as on mainnet.
#
#   ./script/local.sh up     start anvil (chain id 31337), deploy, allowlist the series, create a
#                            running vault owned by anvil account 0, write deployments/local.json and
#                            web/.env.local. Idempotent-ish: run `down` first to reset.
#   ./script/local.sh down   stop the anvil started by `up`.
#
# Env:
#   MAINNET_RPC_URL   fork source (default: a free public RPC). State is read at the fork head.
#   FORK_BLOCK        pin the fork block (default latest).
#   PORT              anvil port (default 8546).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# 8545 / 31337 match a wallet's built-in "Localhost 8545" network, so it works with no wallet
# setup. Override PORT or CHAIN_ID to run beside another local chain on the same wallet.
PORT="${PORT:-8545}"
CHAIN_ID="${CHAIN_ID:-31337}"
RPC="http://127.0.0.1:$PORT"
FORK_SRC="${MAINNET_RPC_URL:-https://ethereum-rpc.publicnode.com}"
RECORD="deployments/local.json"
PIDFILE="deployments/.local-anvil.pid"
LOGFILE="deployments/.local-anvil.log"
SCRIPT="script/Deploy.s.sol:Deploy"
# Anvil default account 0. Public test key, never written here; anvil unlocks it for us.
OWNER="0xf39Fd6e51aad88F6F4ce6aB8827279cfffb92266"
KEEPER="0x70997970C51812dc3A010C7d01b50e0d17dc79C8" # account 1

die() { echo "error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || die "$1 not found"; }

down() {
  if [ -f "$PIDFILE" ]; then
    local pid; pid="$(cat "$PIDFILE")"
    kill "$pid" 2>/dev/null && echo "stopped anvil (pid $pid)" || echo "anvil (pid $pid) not running"
    rm -f "$PIDFILE"
  else
    echo "no $PIDFILE; nothing to stop"
  fi
}

up() {
  need forge; need cast; need jq; need anvil
  [ ! -f "$PIDFILE" ] || die "$PIDFILE exists; run '$0 down' first"

  local fork_args=(--fork-url "$FORK_SRC" --chain-id "$CHAIN_ID" --port "$PORT" --auto-impersonate)
  [ -n "${FORK_BLOCK:-}" ] && fork_args+=(--fork-block-number "$FORK_BLOCK")
  mkdir -p deployments
  anvil "${fork_args[@]}" >"$LOGFILE" 2>&1 &
  echo "$!" >"$PIDFILE"
  trap 'down' ERR
  for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break || sleep 0.5; done
  [ "$(cast chain-id --rpc-url "$RPC")" = "$CHAIN_ID" ] || die "fork did not come up on $CHAIN_ID"
  # Pin the base fee to zero. A keeper (a non-owner caller) may only requestPulls when the effective
  # gas price is at or below the vault's gas ceiling (default 1.2 gwei); the forked base fee starts
  # above that, so without this the keeper is blocked and nothing pulls.
  cast rpc anvil_setNextBlockBaseFeePerGas 0x0 --rpc-url "$RPC" >/dev/null
  local from_block; from_block="$(cast block-number --rpc-url "$RPC")"
  echo "== anvil forking $FORK_SRC at block $from_block, chain $CHAIN_ID, $RPC (pid $(cat "$PIDFILE"))"
  # The frontend scans logs from this block. anvil serves logs for blocks after the fork point from
  # its own memory, but proxies the fork block itself (and earlier) to the upstream fork RPC, which
  # rate-limits (429) and blanks the scan. Every app event is in a local block after the fork, so
  # start one block past it to keep the whole scan local.
  local scan_from=$((from_block + 1))

  echo "== deploy factory (sender $OWNER)"
  DEPLOY_RECORD="$RECORD" DEPLOY_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo local)" \
    forge script "$SCRIPT" --rpc-url "$RPC" --broadcast --unlocked --sender "$OWNER" --slow
  local factory rv rv_owner
  factory="$(jq -r .factory "$RECORD")"
  [ "$(cast code "$factory" --rpc-url "$RPC")" != "0x" ] || die "no factory code"

  echo "== allowlist the factory as a series (reward vault owner)"
  rv="$(jq -r .rewardVault "$RECORD")"
  rv_owner="$(cast call "$rv" "owner()(address)" --rpc-url "$RPC")"
  cast rpc anvil_setBalance "$rv_owner" "0xDE0B6B3A7640000" --rpc-url "$RPC" >/dev/null
  cast send "$rv" "setSeries(address,bool)" "$factory" true --from "$rv_owner" --unlocked --rpc-url "$RPC" >/dev/null
  [ "$(cast call "$rv" "seriesAllowed(address)(bool)" "$factory" --rpc-url "$RPC")" = "true" ] || die "series not allowed"

  echo "== create a running vault owned by $OWNER (0.5 ETH, rewards register on create)"
  local deadline; deadline="$(( $(cast block --rpc-url "$RPC" -f timestamp) + 86400 ))"
  # (maxDrawdownBps, maxPullCostWei, stopAfterKeeps, deadline, maxPulls)
  local params="(2000,100000000000000000,0,$deadline,5)"
  cast send "$factory" \
    "createVault(address[],(address,uint256)[],address[],(uint256,uint256,uint256,uint256,uint256),uint256,bool)" \
    "[]" "[]" "[$KEEPER]" "$params" "1200000000" true \
    --value 0.5ether --from "$OWNER" --unlocked --rpc-url "$RPC" >/dev/null
  local vault; vault="$(cast call "$factory" "vaultOf(address)(address)" "$OWNER" --rpc-url "$RPC")"
  # createVault registers in the same tx as the FWAT lock and can skip; the public retry lands it.
  if [ "$(cast call "$vault" "rewardsRegistered()(bool)" --rpc-url "$RPC")" != "true" ]; then
    cast send "$vault" "registerRewards()" --from "$OWNER" --unlocked --rpc-url "$RPC" >/dev/null
  fi
  [ "$(cast call "$vault" "rewardsRegistered()(bool)" --rpc-url "$RPC")" = "true" ] || echo "warning: vault rewards not registered"
  echo "vault $vault, status $(cast call "$vault" "status()(uint8)" --rpc-url "$RPC") (0 Idle, 1 Running, 2 WindingDown)"

  cat >web/.env.local <<EOF
# Written by script/local.sh up. Local fork only; git-ignored.
VITE_RPC_URL=$RPC
VITE_FACTORY=$factory
VITE_CHAIN_ID=$CHAIN_ID
VITE_FROM_BLOCK=$scan_from
VITE_DEFAULT_KEEPER=$KEEPER
VITE_WALLETCONNECT_PROJECT_ID=35fbd0525a32173af1040dc520a0e505
EOF

  cat <<EOF

== ready
  RPC        $RPC   (chain $CHAIN_ID)
  factory    $factory
  vault      $vault   (Running, owner $OWNER)
  web env    web/.env.local written

next:
  cd web && npm install && npm run dev
  wallet: add a network at $RPC / chain $CHAIN_ID, then import anvil account 0
          ($OWNER); its key is anvil's standard first test key, printed
          in $LOGFILE under "Private Keys" (index 0)
  fund your own wallet (a forked address only has its real mainnet balance):
          cast rpc anvil_setBalance <your address> 0x56BC75E2D63100000 --rpc-url $RPC  # 100 ETH
  run the keeper (drives pulls on every vault): its key is anvil account 1, in $LOGFILE index 1
          KEEPER_PRIVATE_KEY=<key> ./script/local.sh keeper
  or one manual pull: cast send $vault "requestPulls(uint256)" 1 --from $KEEPER --unlocked --rpc-url $RPC
  stop:  ./script/local.sh down
EOF
}

# Runs the reference keeper against the deployed factory with zero thresholds, so it acts on every
# vault at once instead of waiting as a backstop, and a low tip so it stays under the gas ceiling.
keeper() {
  need node; need jq
  [ -f "$RECORD" ] || die "no $RECORD; run '$0 up' first"
  [ -n "${KEEPER_PRIVATE_KEY:-}" ] || die "set KEEPER_PRIVATE_KEY (anvil account 1 key, in $LOGFILE index 1)"
  local factory from_block
  factory="$(jq -r .factory "$RECORD")"
  from_block="$(grep '^VITE_FROM_BLOCK=' web/.env.local 2>/dev/null | cut -d= -f2)"
  [ -d keeper/node_modules/viem ] || (cd keeper && npm install)
  echo "== keeper on $factory from block ${from_block:-0} via $RPC (acting immediately; auto-restarts)"
  cd keeper
  # The reference keeper can exit under a fast-moving local chain; restart it so the demo stays live.
  while true; do
    RPC_URL="$RPC" FACTORY="$factory" FROM_BLOCK="${from_block:-0}" \
      REQUEST_AFTER_S=0 SYNC_AFTER_S=0 FINALIZE_AFTER_S=0 POLL_MS=3000 \
      PRIORITY_FEE_WEI=100000000 URGENT_PRIORITY_FEE_WEI=100000000 MIN_BALANCE_WEI=0 \
      node src/index.mjs || true
    echo "keeper exited; restarting in 2s"
    sleep 2
  done
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
  keeper) keeper ;;
  *) die "usage: $0 up|down|keeper" ;;
esac
