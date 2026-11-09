# Sourced by the other scripts. Needs BITCOIND_RPC_URL, BITCOIND_RPC_USER,
# BITCOIND_RPC_PASSWORD and SSP_GRPC_URI.

# Mined to when no wallet should own the coinbase.
UNOWNED_ADDRESS=bcrt1qs758ursh4q9z627kt3pp5yysm78ddny6txaqgw

log() {
  echo "[$(basename "$0" .sh)] $*"
}

# rpc <method> [params json] [wallet]. Prints the result, fails on an RPC error.
rpc() {
  _path=""
  [ -n "${3:-}" ] && _path="/wallet/$3"
  _response=$(curl -s --user "$BITCOIND_RPC_USER:$BITCOIND_RPC_PASSWORD" \
    -H 'content-type: text/plain' \
    --data "{\"jsonrpc\":\"1.0\",\"id\":\"local\",\"method\":\"$1\",\"params\":${2:-[]}}" \
    "$BITCOIND_RPC_URL$_path") || return 1
  if [ "$(printf '%s\n' "$_response" | jq '.error')" != "null" ]; then
    printf '%s\n' "$_response" | jq -c '.error' >&2
    return 1
  fi
  printf '%s\n' "$_response" | jq -c '.result'
}

# rpc for a method that returns a string, printed without its quotes.
rpc_string() {
  _result=$(rpc "$@") || return 1
  printf '%s\n' "$_result" | jq -r .
}

wait_for_bitcoind() {
  until rpc getblockchaininfo >/dev/null 2>&1; do
    sleep 1
  done
}

# bitkit-docker: main_rpc <method> [params json] calls bitkit-docker's bitcoind, whose chain spark-bitcoind follows.
main_rpc() {
  BITCOIND_RPC_URL=$MAIN_BITCOIND_RPC_URL BITCOIND_RPC_USER=$MAIN_BITCOIND_RPC_USER \
    BITCOIND_RPC_PASSWORD=$MAIN_BITCOIND_RPC_PASSWORD rpc "$@"
}

# bitkit-docker: waits until spark-bitcoind holds bitkit-docker's chain, so nothing mined here starts a fork of it.
wait_for_chain_sync() {
  until main_rpc getblockcount >/dev/null 2>&1; do
    sleep 1
  done
  until [ "$(rpc getconnectioncount)" -gt 0 ] &&
    [ "$(rpc getblockcount)" -ge "$(main_rpc getblockcount)" ]; do
    sleep 1
  done
}

# The wallet funds the SSP and the faucet. It is loaded on startup once created.
# bitkit-docker: its keys are fixed (SPARK_WALLET_TPRV) and imported from the chain's start, so after ./spark reset the
# new wallet holds what the last one held, and the shared chain's coins are not spent one reset at a time.
ensure_wallet() {
  : "${SPARK_WALLET_TPRV:?}"
  rpc listwallets | jq -e 'index("default")' >/dev/null && return 0
  rpc loadwallet '["default"]' >/dev/null 2>&1 && return 0
  rpc createwallet '["default", false, true, "", false, true, true]' >/dev/null
  _requests=""
  for _branch in 0 1; do
    _descriptor="wpkh($SPARK_WALLET_TPRV/84h/1h/0h/$_branch/*)"
    _checksum=$(rpc getdescriptorinfo "[\"$_descriptor\"]" | jq -r .checksum)
    _internal=false
    [ "$_branch" = 1 ] && _internal=true
    _requests="$_requests{\"desc\":\"$_descriptor#$_checksum\",\"timestamp\":0,\"active\":true,\"internal\":$_internal,\"range\":[0,4999]},"
  done
  log "importing the wallet's keys and scanning the chain for its coins"
  rpc importdescriptors "[[${_requests%,}]]" default | jq -e 'all(.success)' >/dev/null
}

ssp_cli() {
  ssp-cli --grpc-uri "$SSP_GRPC_URI" "$@"
}

# How many denominations hold LEAVES_PER_DENOMINATION leaves or more.
pool_stocked() {
  ssp_cli pool status | awk -v min="$LEAVES_PER_DENOMINATION" -v power="$MAX_DENOMINATION_POWER" '
    /^requested/ { done = 1 }
    !done && / sats x / { count[$1] = $4 }
    END {
      stocked = 0
      for (p = 0; p <= power; p++) if (count[2 ^ p] + 0 >= min) stocked++
      print stocked
    }'
}

pool_denominations() {
  echo $((MAX_DENOMINATION_POWER + 1))
}

# The chain API answers from the block the SDK's wallets are about to read, not
# from a block electrs has yet to index.
chain_api_current() {
  : "${CHAIN_API_URL:?}"
  [ "$(curl -sf "$CHAIN_API_URL/blocks/tip/height" || echo -1)" -ge "$(rpc getblockcount)" ]
}

# Answers once the lnurl server serves the addresses wallets register with it.
lnurl_serving() {
  curl -sf -o /dev/null "${LNURL_URL:?}/health"
}

# Answers once the data-sync service serves the wallets syncing through it.
data_sync_serving() {
  curl -sf -o /dev/null "${DATA_SYNC_WEB_URL:?}/"
}

# Answers once every operator can be reached through the proxy wallets use.
operators_serving() {
  for _url in ${OPERATOR_URLS:?}; do
    curl -sf -o /dev/null "$_url/-/ready" || return 1
  done
}

wait_for_ssp() {
  until ssp_cli get-info >/dev/null 2>&1; do
    sleep 1
  done
}
