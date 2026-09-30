#!/usr/bin/env bash
# Local fork only. FWA V2's off-chain VRF operator does not run on a fork, so pulls never leave
# "Pending" and the UI sits at "Waiting for the draw". This impersonates the pool's VRF coordinator,
# delivers a random word for each pending pull (weighted selection, like the real VRF), and processes
# the pool's queue, so pulls allocate. The running keeper then syncs them to kept, sold or auction.
#
#   ./script/drivefork.sh [--loop|warp] [vault ...]
#     no vaults: every vault the factory in deployments/local.json created.
#     --loop:    keep allocating as the keeper syncs and requests more, until interrupted.
#     warp:      jump past open auction deadlines and finalize them (local fork only).
#
# Env: RPC_URL (default from web/.env.local, else http://127.0.0.1:8545).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RECORD="deployments/local.json"
env_val() { grep "^$1=" web/.env.local 2>/dev/null | cut -d= -f2- | tr -d '"'; }
RPC="${RPC_URL:-$(env_val VITE_RPC_URL)}"
RPC="${RPC:-http://127.0.0.1:8545}"

die() { echo "error: $*" >&2; exit 1; }
command -v cast >/dev/null || die "cast not found"
[ -f "$RECORD" ] || die "no $RECORD; run './script/local.sh up' first"

POOL="$(cast call "$(jq -r .factory "$RECORD")" 'FWA()(address)' --rpc-url "$RPC")"
# Coordinator lives in the pool's storage slot 0 (Chainlink VRF v2.5, per the fork suite).
COORD="0x$(cast storage "$POOL" 0 --rpc-url "$RPC" | sed 's/^0x//' | tail -c 41)"
COORD="$(cast to-check-sum-address "$COORD")"

LOOP=0
WARP=0
VAULTS=()
for a in "$@"; do
  case "$a" in
    --loop) LOOP=1 ;;
    warp | --warp) WARP=1 ;;
    *) VAULTS+=("$a") ;;
  esac
done

# Jump the fork clock past every open auction's deadline and finalize them, so a run stuck
# "finishing up" on auctions settles to Idle at once. Local fork only.
warp_auctions() {
  cast rpc evm_increaseTime 7200 --rpc-url "$RPC" >/dev/null
  cast rpc anvil_mine 3 --rpc-url "$RPC" >/dev/null
  echo "warped +2h to block time $(cast block --rpc-url "$RPC" -f timestamp)"
  local V n
  for V in "$@"; do
    n=0
    while read -r aid; do
      [ -n "$aid" ] || continue
      cast send "$V" 'finalizeAuction(uint256)' "$aid" --from "$COORD" --unlocked --gas-limit 8000000 --rpc-url "$RPC" >/dev/null 2>&1 && n=$((n + 1))
    done < <(cast call "$V" 'openAuctionIds()(uint256[])' --rpc-url "$RPC" | sed 's/\[[0-9.e+]*\]//g' | tr -d '[] ' | tr ',' '\n')
    echo "  $V: finalized $n auction(s), status now $(cast call "$V" 'status()(uint8)' --rpc-url "$RPC")"
  done
}

# Every vault the factory created, from its VaultCreated(owner, vault) logs (vault is topic 2).
discover_vaults() {
  local factory from
  factory="$(jq -r .factory "$RECORD")"
  from="$(env_val VITE_FROM_BLOCK)"; from="${from:-0}"
  cast logs --rpc-url "$RPC" --from-block "$from" --address "$factory" \
    'VaultCreated(address,address)' --json 2>/dev/null |
    jq -r '.[].topics[2] | "0x" + .[26:]' | sort -u
}

acq_status() { cast call "$POOL" 'acquisitions(uint256)(address,uint256,uint256,uint256,uint8)' "$1" --rpc-url "$RPC" | tail -1 | sed 's/ .*//'; }
acq_seq() { cast call "$POOL" 'acquisitionMeta(uint256)(uint64,uint64,uint64,uint16,uint16,uint256)' "$1" --rpc-url "$RPC" | head -1 | sed 's/ .*//'; }
num() { cast call "$POOL" "$1()(uint64)" --rpc-url "$RPC" | sed 's/ .*//'; }

# Allocate every currently pending pull across the given vaults, in the pool's sequence order.
drive_once() {
  local vaults=("$@") id ids st seq next last i
  declare -A SEQID=()
  for V in "${vaults[@]}"; do
    ids="$(cast call "$V" 'outstanding()(uint256[])' --rpc-url "$RPC" | sed 's/\[[0-9.e+]*\]//g' | tr -d '[] ')"
    [ -n "$ids" ] || continue
    IFS=',' read -ra arr <<<"$ids"
    for id in "${arr[@]}"; do
      [ -n "$id" ] || continue
      [ "$(acq_status "$id")" = "1" ] || continue
      SEQID[$(acq_seq "$id")]="$id"
    done
  done
  [ "${#SEQID[@]}" -gt 0 ] || { echo "  nothing pending to allocate"; return 1; }
  local allocated=0
  for i in $(seq 1 200); do
    next="$(num nextSequenceToProcess)"; last="$(num lastIssuedSequence)"
    [ "$next" -gt "$last" ] && break
    id="${SEQID[$next]:-}"
    if [ -n "$id" ]; then
      # A uniform random word in [0, totalWeight) makes the pool pick a listing weighted by its
      # weight, exactly as the real VRF does, so pulls hit low-value listings far more often than
      # high-value ones. A fixed word would deterministically pick one slot and skew the outcomes.
      local tw word
      tw="$(cast call "$POOL" 'totalWeight()(uint256)' --rpc-url "$RPC" | sed 's/ .*//')"
      word="$(python3 -c 'import secrets,sys; n=int(sys.argv[1]); print(secrets.randbelow(n) if n>0 else 0)' "$tw")"
      cast send "$POOL" 'rawFulfillRandomWords(uint256,uint256[])' "$id" "[$word]" \
        --from "$COORD" --unlocked --gas-limit 3000000 --rpc-url "$RPC" >/dev/null 2>&1 && allocated=$((allocated + 1))
    fi
    cast send "$POOL" 'processAcquisitions(uint256)' 1 --from "$COORD" --unlocked --rpc-url "$RPC" >/dev/null 2>&1 || break
  done
  cast send "$POOL" 'activateListings(uint256)' 64 --from "$COORD" --unlocked --rpc-url "$RPC" >/dev/null 2>&1 || true
  # Settle allocated pulls with generous gas. The sell-back path nests a gas-capped notifier
  # callback deep enough that an estimated gas limit starves it, so sync catches the revert and
  # skips; an explicit high limit lets it complete.
  if [ -z "${NO_SYNC:-}" ]; then
    for V in "${vaults[@]}"; do
      cast send "$V" 'sync(uint256)' 32 --from "$COORD" --unlocked --gas-limit 8000000 --rpc-url "$RPC" >/dev/null 2>&1 || true
    done
  fi
  echo "  allocated $allocated pull(s)"
  return 0
}

if [ "${#VAULTS[@]}" -eq 0 ]; then
  mapfile -t VAULTS < <(discover_vaults)
  [ "${#VAULTS[@]}" -gt 0 ] || die "no vaults found; pass one as an argument"
fi
echo "pool $POOL, coordinator $COORD, vaults ${VAULTS[*]}"
cast rpc anvil_setBalance "$COORD" 0xDE0B6B3A7640000 --rpc-url "$RPC" >/dev/null

if [ "$WARP" -eq 1 ]; then
  warp_auctions "${VAULTS[@]}"
  exit 0
fi

if [ "$LOOP" -eq 1 ]; then
  echo "looping (Ctrl-C to stop); the keeper syncs and requests more between passes"
  while true; do echo "== pass"; drive_once "${VAULTS[@]}" || true; sleep 6; done
else
  drive_once "${VAULTS[@]}" || true
  echo "done; the keeper will sync the allocated pulls to kept/sold/auction"
fi
