#!/usr/bin/env bash
# Deploys VaultFactory (which deploys the router and the vault implementation) with the linked
# FwaClientLib. See docs/LAUNCH.md.
#
#   ./script/deploy.sh dry-run   anvil fork of mainnet with a throwaway unlocked sender: deploy, a
#                                smoke vault, the reward vault series step; prints the record and
#                                the launch checklist. Leaves no files behind.
#   ./script/deploy.sh mainnet   real deploy, signed by the owner's ledger or keystore account;
#                                writes deployments/mainnet.json.
#
# Env:
#   MAINNET_RPC_URL      required. Dry run: the fork source. Mainnet: the RPC the deploy goes through.
#   FWA REWARD_VAULT FEE_RECIPIENT TRANSFER_HELPER   optional overrides (default: SPEC mainnet values)
#   DEPLOY_SIGNER_ARGS   mainnet: "--ledger" or "--account <keystore name>". Never a raw key.
#   DEPLOY_SENDER        mainnet: the signer's address.
#   ETHERSCAN_API_KEY    mainnet: verify on Etherscan when set, Sourcify otherwise.
#   FORK_BLOCK           dry run: fork block (default latest).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="${1:-}"
RECORD="deployments/mainnet.json"
PENDING="deployments/pending.json"
SCRIPT="script/Deploy.s.sol:Deploy"

die() {
  echo "error: $*" >&2
  exit 1
}
need() { command -v "$1" >/dev/null || die "$1 not found"; }

need forge
need cast
need jq
[ -n "${MAINNET_RPC_URL:-}" ] || die "MAINNET_RPC_URL is required"

commit() {
  local c
  c="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then c="$c+dirty"; fi
  echo "$c"
}

# One line per transaction in a forge broadcast log: "<label> <tx hash> <block> <gas used>", with
# the label the created contract or the called function.
receipts() {
  local label hash block gas
  while read -r label hash block gas; do
    printf '%-14s %s %d %d\n' "$label" "$hash" "$((block))" "$((gas))"
  done < <(jq -r '.receipts as $r | .transactions[] | . as $t | $r[] | select(.transactionHash == $t.hash)
      | [($t.contractName // ($t.function // "call" | split("(")[0])), .transactionHash, .blockNumber, .gasUsed]
      | join(" ")' "$1")
}

# The script's record plus the transactions from the broadcast log.
final_record() {
  local txs
  txs="$(receipts "$2" | jq -R -s 'split("\n") | map(select(length > 0) | [splits(" +")]
      | {label: .[0], hash: .[1], block: (.[2] | tonumber), gasUsed: (.[3] | tonumber)})')"
  jq --argjson txs "$txs" '. + {
      deployTx: ($txs[] | select(.label == "VaultFactory") | .hash),
      deployBlock: ($txs[] | select(.label == "VaultFactory") | .block),
      transactions: $txs
    }' "$1"
}

checklist() {
  local factory block
  factory="$(cast to-check-sum-address "$1")"
  block="$2"
  cat <<EOF

== launch checklist (docs/LAUNCH.md)
[ ] verify factory, router, implementation, FwaClientLib
[ ] reward vault owner: setSeries($factory, true)
      to 0xEa20a110ad3Dfc483977d14f80203994E65D34FB
      data $(cast calldata "setSeries(address,bool)" "$factory" true)
[ ] FWA team: distributor grant for the reward vault (pending)
[ ] fund two keeper wallets
[ ] keeper secrets: RPC_URL SEND_RPC_URL KEEPER_PRIVATE_KEY, FACTORY=$factory FROM_BLOCK=$block
[ ] web env: VITE_RPC_URL, VITE_FACTORY=$factory VITE_FROM_BLOCK=$block; deploy
[ ] smoke test with a small vault
EOF
}

dry_run() {
  need anvil
  local port=8546 sender out bdir rpc
  sender="$(cast to-check-sum-address "0x$(cast keccak "punk-or-bust dry run sender" | cut -c 27-66)")"
  out="$(mktemp -d)"
  bdir="$out/broadcast"
  rpc="http://127.0.0.1:$port"
  local fork_args=(--fork-url "$MAINNET_RPC_URL" --port "$port" --auto-impersonate --silent)
  [ -n "${FORK_BLOCK:-}" ] && fork_args+=(--fork-block-number "$FORK_BLOCK")
  anvil "${fork_args[@]}" >"$out/anvil.log" 2>&1 &
  trap 'kill '"$!"' 2>/dev/null || true; rm -rf '"$out"' deployments/dry-run.json' EXIT
  for _ in $(seq 1 60); do cast chain-id --rpc-url "$rpc" >/dev/null 2>&1 && break || sleep 0.5; done
  [ "$(cast chain-id --rpc-url "$rpc")" = "1" ] || die "fork is not chain 1"
  [ "$(cast code "$sender" --rpc-url "$rpc")" = "0x" ] || die "throwaway sender has code"
  cast rpc anvil_setBalance "$sender" "0x56BC75E2D63100000" --rpc-url "$rpc" >/dev/null # 100 ETH
  echo "== dry run on a mainnet fork at block $(cast block-number --rpc-url "$rpc"), sender $sender"

  local common=(--rpc-url "$rpc" --broadcast --unlocked --sender "$sender" --slow)
  mkdir -p deployments
  FOUNDRY_BROADCAST="$bdir" DEPLOY_RECORD=deployments/dry-run.json DEPLOY_COMMIT="$(commit)" \
    forge script "$SCRIPT" "${common[@]}"
  local run_log="$bdir/Deploy.s.sol/1/run-latest.json" record factory
  record="$(final_record deployments/dry-run.json "$run_log")"
  factory="$(jq -r .factory <<<"$record")"
  [ "$(cast code "$factory" --rpc-url "$rpc")" != "0x" ] || die "no factory code"

  echo
  echo "== smoke: createVault from the new factory, read back, stop, withdraw"
  FOUNDRY_BROADCAST="$bdir" forge script "$SCRIPT" --sig "smoke(address)" "$factory" "${common[@]}"
  local smoke_log="$bdir/Deploy.s.sol/1/smoke-latest.json" vault
  vault="$(cast call "$factory" "vaultOf(address)(address)" "$sender" --rpc-url "$rpc")"

  echo
  echo "== post-deploy: reward vault owner allowlists the factory, then the vault registers"
  local rv rv_owner
  rv="$(jq -r .rewardVault <<<"$record")"
  rv_owner="$(cast call "$rv" "owner()(address)" --rpc-url "$rpc")"
  cast rpc anvil_setBalance "$rv_owner" "0xDE0B6B3A7640000" --rpc-url "$rpc" >/dev/null
  local series_tx register_tx
  series_tx="$(cast send "$rv" "setSeries(address,bool)" "$factory" true --from "$rv_owner" --unlocked \
    --rpc-url "$rpc" --json | jq -r '"\(.transactionHash) \(.gasUsed)"')"
  [ "$(cast call "$rv" "seriesAllowed(address)(bool)" "$factory" --rpc-url "$rpc")" = "true" ] ||
    die "series not allowed"
  register_tx="$(cast send "$vault" "registerRewards()" --from "$sender" --unlocked \
    --rpc-url "$rpc" --json | jq -r '"\(.transactionHash) \(.gasUsed)"')"
  [ "$(cast call "$vault" "rewardsRegistered()(bool)" --rpc-url "$rpc")" = "true" ] || die "not registered"
  [ "$(cast call "$rv" "seriesOf(address)(address)" "$vault" --rpc-url "$rpc")" = "$factory" ] ||
    die "reward vault series of the vault"
  echo "setSeries ok, registerRewards ok, seriesOf(vault) = factory"

  echo
  echo "== record (dry run, not written)"
  jq . <<<"$record"
  echo
  echo "== transactions (label, hash, block, gas used)"
  receipts "$run_log"
  receipts "$smoke_log"
  printf '%-14s %s %d\n' setSeries "${series_tx% *}" "$((${series_tx#* }))"
  printf '%-14s %s %d\n' registerRewards "${register_tx% *}" "$((${register_tx#* }))"
  checklist "$factory" "$(jq -r .deployBlock <<<"$record")"
  echo
  echo "dry run ok"
}

mainnet() {
  [ -n "${DEPLOY_SIGNER_ARGS:-}" ] || die "DEPLOY_SIGNER_ARGS is required (--ledger or --account <name>)"
  [ -n "${DEPLOY_SENDER:-}" ] || die "DEPLOY_SENDER is required"
  case " $DEPLOY_SIGNER_ARGS " in
    *" --ledger "* | *" --account "*) ;;
    *) die "DEPLOY_SIGNER_ARGS must use --ledger or --account" ;;
  esac
  case " $DEPLOY_SIGNER_ARGS " in
    *--private-key* | *" --mnemonic "* | *" --mnemonics "* | *--interactive* | *" -i "*)
      die "raw keys and mnemonics are not accepted"
      ;;
  esac
  # A raw 32-byte hex key anywhere in the args (a keystore name such as "ripe0x" is fine).
  if grep -qE '(0x)?[0-9a-fA-F]{64}' <<<"$DEPLOY_SIGNER_ARGS"; then
    die "raw keys and mnemonics are not accepted"
  fi

  [ -z "$(git status --porcelain)" ] || die "checkout is not clean"
  [ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || die "not on main"
  git fetch -q origin main
  [ "$(git rev-parse HEAD)" = "$(git rev-parse FETCH_HEAD)" ] || die "HEAD is not origin/main"
  [ ! -e "$RECORD" ] || die "$RECORD exists; the factory is already deployed"
  [ "$(cast chain-id --rpc-url "$MAINNET_RPC_URL")" = "1" ] || die "RPC is not chain 1"

  local verify=(--verify)
  if [ -n "${ETHERSCAN_API_KEY:-}" ]; then
    verify+=(--etherscan-api-key "$ETHERSCAN_API_KEY")
  else
    verify+=(--verifier sourcify)
  fi

  echo "== mainnet deploy from $DEPLOY_SENDER at commit $(git rev-parse HEAD)"
  # Simulate first with no signer, so the cost is shown before any keystore or Ledger prompt.
  echo "== compiling (the first build can take several minutes)"
  forge build
  echo "== simulating (no signing)"
  local sim gas basefee
  sim="$(forge script "$SCRIPT" --rpc-url "$MAINNET_RPC_URL" --sender "$DEPLOY_SENDER" 2>&1)" ||
    { echo "$sim" | tail -40; die "simulation failed"; }
  gas="$(grep -oE 'Estimated total gas used for script: [0-9]+' <<<"$sim" | grep -oE '[0-9]+$' || true)"
  [ -n "$gas" ] || { echo "$sim" | tail -40; die "no gas estimate in the simulation output"; }
  basefee="$(cast base-fee --rpc-url "$MAINNET_RPC_URL")"
  echo "estimated gas        $gas (forge adds a 30% buffer; about 8.5M is actually used)"
  echo "current base fee     $(cast from-wei "$basefee" gwei) gwei"
  echo "cost at base fee     $(cast from-wei "$((gas * basefee))") ETH"
  echo "cost at 2x base fee  $(cast from-wei "$((gas * basefee * 2))") ETH (upper bound if fees rise)"
  grep -E 'Estimated amount required' <<<"$sim" || true
  echo "sender balance       $(cast balance "$DEPLOY_SENDER" --ether --rpc-url "$MAINNET_RPC_URL") ETH"
  read -r -p "type 'deploy' to sign and broadcast: " ok
  [ "$ok" = "deploy" ] || die "aborted"

  mkdir -p deployments
  rm -f "$PENDING"
  # shellcheck disable=SC2086
  DEPLOY_RECORD="$PENDING" DEPLOY_COMMIT="$(git rev-parse HEAD)" \
    forge script "$SCRIPT" --rpc-url "$MAINNET_RPC_URL" --broadcast --slow \
    --sender "$DEPLOY_SENDER" $DEPLOY_SIGNER_ARGS "${verify[@]}"

  local run_log="broadcast/Deploy.s.sol/1/run-latest.json"
  [ -f "$PENDING" ] || die "no pending record"
  [ "$(jq '.receipts | length' "$run_log")" = "$(jq '.transactions | length' "$run_log")" ] ||
    die "not every transaction has a receipt; $PENDING kept, $RECORD not written"
  [ "$(jq '[.receipts[] | select(.status != "0x1")] | length' "$run_log")" = "0" ] ||
    die "a transaction reverted; $PENDING kept, $RECORD not written"
  final_record "$PENDING" "$run_log" >"$RECORD"
  rm -f "$PENDING"

  # The router and implementation are created inside the factory constructor, so --verify does not
  # cover them; verify them here. The factory and FwaClientLib are verified by --verify above.
  local factory router impl fwa rv fee helper lib
  factory="$(jq -r .factory "$RECORD")"
  router="$(jq -r .router "$RECORD")"
  impl="$(jq -r .vaultImplementation "$RECORD")"
  fwa="$(jq -r .fwa "$RECORD")"
  rv="$(jq -r .rewardVault "$RECORD")"
  fee="$(jq -r .feeRecipient "$RECORD")"
  helper="$(jq -r .transferHelper "$RECORD")"
  lib="src/fwa/FwaClientLib.sol:FwaClientLib:$(jq -r .fwaClientLib "$RECORD")"
  local vargs=(--chain 1 --watch)
  if [ -n "${ETHERSCAN_API_KEY:-}" ]; then
    vargs+=(--etherscan-api-key "$ETHERSCAN_API_KEY")
  else
    vargs+=(--verifier sourcify)
  fi
  forge verify-contract "${vargs[@]}" "$router" src/PurchaseRouter.sol:PurchaseRouter \
    --constructor-args "$(cast abi-encode "f(address,address,address,address)" "$fwa" "$factory" "$fee" "$helper")" ||
    echo "warning: router verification failed; retry by hand" >&2
  forge verify-contract "${vargs[@]}" "$impl" src/Vault.sol:Vault --libraries "$lib" \
    --constructor-args "$(cast abi-encode "f(address,address,address,address,address)" "$fwa" "$factory" "$router" "$rv" "$fee")" ||
    echo "warning: implementation verification failed; retry by hand" >&2

  echo
  cat "$RECORD"
  checklist "$factory" "$(jq -r .deployBlock "$RECORD")"
  echo
  echo "commit $RECORD in a PR."
}

case "$MODE" in
  dry-run) dry_run ;;
  mainnet) mainnet ;;
  *) die "usage: $0 dry-run|mainnet" ;;
esac
