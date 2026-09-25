#!/usr/bin/env bash
# Deploys VaultFactory (which deploys the router and the vault implementation).
#
#   ./script/deploy.sh dry-run   anvil fork of mainnet, throwaway unlocked sender, deploy plus a smoke
#                                vault; prints the record and the launch checklist. Writes nothing.
#   ./script/deploy.sh mainnet   real deploy, signed by the owner's ledger or keystore account.
#
# Env:
#   MAINNET_RPC_URL      required. Dry run: the fork source (archive not needed). Mainnet: the send RPC.
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
SCRIPT="script/Deploy.s.sol:Deploy"

die() { echo "error: $*" >&2; exit 1; }
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

# Prints "<label> <tx hash> block <n> gas <used>" for each receipt in a forge broadcast log.
receipts() {
  jq -r '.receipts[] | "\(.transactionHash) block \(.blockNumber | tonumber) gas \(.gasUsed | tonumber)"' "$1"
}

checklist() {
  local factory="$1"
  cat <<EOF

== launch checklist (docs/LAUNCH.md)
[ ] reward vault owner: setSeries($factory, true)
      calldata $(cast calldata "setSeries(address,bool)" "$factory" true)
[ ] FWA team: distributor grant for the reward vault (pending)
[ ] fund two keeper wallets
[ ] keeper secrets: RPC_URL SEND_RPC_URL KEEPER_PRIVATE_KEY FACTORY=$factory FROM_BLOCK=<deploy block>
[ ] web env: VITE_FACTORY=$factory VITE_FROM_BLOCK=<deploy block>, deploy
[ ] smoke test with a small vault
EOF
}

dry_run() {
  need anvil
  local port=8546 sender out bdir log
  sender="0x$(cast keccak "punk-or-bust dry run sender" | cut -c 27-66)"
  sender="$(cast to-check-sum-address "$sender")"
  out="$(mktemp -d)"
  bdir="$out/broadcast"
  log="$out/anvil.log"
  local fork_args=(--fork-url "$MAINNET_RPC_URL" --port "$port" --auto-impersonate --silent)
  [ -n "${FORK_BLOCK:-}" ] && fork_args+=(--fork-block-number "$FORK_BLOCK")
  anvil "${fork_args[@]}" >"$log" 2>&1 &
  local anvil_pid=$!
  trap 'kill '"$anvil_pid"' 2>/dev/null || true; rm -rf '"$out" EXIT
  local rpc="http://127.0.0.1:$port"
  for _ in $(seq 1 60); do cast chain-id --rpc-url "$rpc" >/dev/null 2>&1 && break; sleep 0.5; done
  [ "$(cast chain-id --rpc-url "$rpc")" = "1" ] || die "fork is not chain 1"
  [ -z "$(cast code "$sender" --rpc-url "$rpc" | sed 's/^0x$//')" ] || die "throwaway sender has code"
  cast rpc anvil_setBalance "$sender" "0x56BC75E2D63100000" --rpc-url "$rpc" >/dev/null # 100 ETH
  echo "== dry run on a mainnet fork at block $(cast block-number --rpc-url "$rpc"), sender $sender"

  local common=(--rpc-url "$rpc" --broadcast --unlocked --sender "$sender" --slow)
  FOUNDRY_BROADCAST="$bdir" DRY_RUN=true DEPLOY_COMMIT="$(commit)" \
    forge script "$SCRIPT" "${common[@]}"

  local run_log="$bdir/Deploy.s.sol/1/run-latest.json"
  local factory
  factory="$(jq -r '.receipts[0].contractAddress' "$run_log")"
  [ "$(cast code "$factory" --rpc-url "$rpc")" != "0x" ] || die "no factory code"
  local deploy_line
  deploy_line="$(receipts "$run_log")"
  cp "$run_log" "$out/deploy.json"

  echo
  echo "== smoke: createVault from the new factory, read back, stop, withdraw"
  FOUNDRY_BROADCAST="$bdir" DRY_RUN=true \
    forge script "$SCRIPT" --sig "smoke(address)" "$factory" "${common[@]}"
  local smoke_lines
  smoke_lines="$(receipts "$bdir/Deploy.s.sol/1/smoke-latest.json")"

  echo
  echo "== record (dry run, not written)"
  jq --arg f "$factory" '{chainId: 1, factory: $f, deployTx: .receipts[0].transactionHash,
      deployBlock: (.receipts[0].blockNumber | tonumber), gasUsed: (.receipts[0].gasUsed | tonumber)}' \
    "$out/deploy.json"
  echo
  echo "deploy       $deploy_line"
  echo "smoke txs (createVault, stop, withdraw):"
  echo "$smoke_lines" | sed 's/^/  /'
  checklist "$factory"
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
  case "$DEPLOY_SIGNER_ARGS" in
    *private-key* | *mnemonic* | *0x*) die "raw keys are not accepted" ;;
  esac

  [ -z "$(git status --porcelain)" ] || die "checkout is not clean"
  [ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || die "not on main"
  git fetch -q origin main
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "HEAD is not origin/main"
  [ ! -e "$RECORD" ] || die "$RECORD exists; the factory is already deployed"
  [ "$(cast chain-id --rpc-url "$MAINNET_RPC_URL")" = "1" ] || die "RPC is not chain 1"

  local verify=(--verify)
  if [ -n "${ETHERSCAN_API_KEY:-}" ]; then
    verify+=(--etherscan-api-key "$ETHERSCAN_API_KEY")
  else
    verify+=(--verifier sourcify)
  fi

  echo "== mainnet deploy from $DEPLOY_SENDER at commit $(git rev-parse HEAD)"
  echo "balance $(cast balance "$DEPLOY_SENDER" --ether --rpc-url "$MAINNET_RPC_URL") ETH"
  read -r -p "type 'deploy' to broadcast: " ok
  [ "$ok" = "deploy" ] || die "aborted"

  mkdir -p deployments
  # shellcheck disable=SC2086
  DRY_RUN=false DEPLOY_COMMIT="$(git rev-parse HEAD)" \
    forge script "$SCRIPT" --rpc-url "$MAINNET_RPC_URL" --broadcast --slow \
    --sender "$DEPLOY_SENDER" $DEPLOY_SIGNER_ARGS "${verify[@]}"

  local run_log="broadcast/Deploy.s.sol/1/run-latest.json"
  [ -f "$RECORD" ] || die "record not written"
  local tmp
  tmp="$(mktemp)"
  jq --slurpfile r "$run_log" '. + {deployTx: $r[0].receipts[0].transactionHash,
      deployBlock: ($r[0].receipts[0].blockNumber | tonumber)}' "$RECORD" >"$tmp"
  mv "$tmp" "$RECORD"
  [ "$(jq -r .factory "$RECORD")" = "$(jq -r '.receipts[0].contractAddress' "$run_log")" ] ||
    die "record factory does not match the receipt"

  # The router and implementation are created inside the factory constructor; verify them too.
  local factory router impl fwa rv fee helper
  factory="$(jq -r .factory "$RECORD")"
  router="$(jq -r .router "$RECORD")"
  impl="$(jq -r .vaultImplementation "$RECORD")"
  fwa="$(jq -r .fwa "$RECORD")"
  rv="$(jq -r .rewardVault "$RECORD")"
  fee="$(jq -r .feeRecipient "$RECORD")"
  helper="$(jq -r .transferHelper "$RECORD")"
  local vargs=(--chain 1 --watch)
  if [ -n "${ETHERSCAN_API_KEY:-}" ]; then
    vargs+=(--etherscan-api-key "$ETHERSCAN_API_KEY")
  else
    vargs+=(--verifier sourcify)
  fi
  forge verify-contract "${vargs[@]}" "$router" src/PurchaseRouter.sol:PurchaseRouter \
    --constructor-args "$(cast abi-encode "f(address,address,address,address)" "$fwa" "$factory" "$fee" "$helper")" ||
    echo "warning: router verification failed; retry by hand" >&2
  forge verify-contract "${vargs[@]}" "$impl" src/Vault.sol:Vault \
    --constructor-args "$(cast abi-encode "f(address,address,address,address,address)" "$fwa" "$factory" "$router" "$rv" "$fee")" ||
    echo "warning: implementation verification failed; retry by hand" >&2

  echo
  cat "$RECORD"
  checklist "$factory"
  echo
  echo "commit $RECORD in a PR."
}

case "$MODE" in
  dry-run) dry_run ;;
  mainnet) mainnet ;;
  *) die "usage: $0 dry-run|mainnet" ;;
esac
