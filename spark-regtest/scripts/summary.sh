#!/bin/sh
# Where the environment's services are, and how to reach them. bitkit-docker: its own ports and `./spark` commands.
set -eu

: "${SPARK_CONFIG_PATH:?}" "${PUBLIC_HOST:=127.0.0.1}" "${OPERATOR_PUBLIC_PORTS:?}"
: "${MEMPOOL_PORT:?}" "${SSP_PORT:?}" "${LNURL_PORT:?}" "${DATA_SYNC_PORT:?}"

operators=""
for port in $OPERATOR_PUBLIC_PORTS; do
  operators="${operators:+$operators }http://$PUBLIC_HOST:$port"
done

cat <<SUMMARY

Spark regtest environment ready

config
  $SPARK_CONFIG_PATH (./spark config)

services
  chain api  http://$PUBLIC_HOST:$MEMPOOL_PORT/api
  explorer   http://$PUBLIC_HOST:$MEMPOOL_PORT
  ssp        http://$PUBLIC_HOST:$SSP_PORT
  lnurl      http://$PUBLIC_HOST:$LNURL_PORT
  data sync  http://$PUBLIC_HOST:$DATA_SYNC_PORT
  operators  $operators

commands
  ./spark mine 1
  ./spark invoice 10000
  ./spark pay <invoice>
  ./spark send <address> <sats>
  ./spark operators stop

SUMMARY
