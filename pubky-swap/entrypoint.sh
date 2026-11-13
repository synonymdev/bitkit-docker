#!/bin/sh
# Runs the Pubky Swaps provider on bitkit-docker's LND and Electrum. Its Pubky identity is a throwaway phrase made on first
# start and kept in the data volume, so the pubky the apps save as a contact survives restarts.
set -eu
phrase=/data/recovery-phrase
if [ ! -s "$phrase" ]; then
  umask 077
  pubky-swap-keygen > "$phrase"
fi
export PUBKY_SWAP_RECOVERY_PHRASE__FILE="$phrase"
macaroon=/lnd/data/chain/bitcoin/regtest/admin.macaroon
until [ -s "$macaroon" ]; do
  echo "waiting for LND's macaroon"
  sleep 2
done
# the provider connects to Electrum once at startup, and runs without its chain watcher if Electrum is not up yet
until bash -c 'exec 3<>/dev/tcp/electrs/60001' 2>/dev/null; do
  echo "waiting for Electrum"
  sleep 2
done
exec swap-provider \
  --network regtest \
  --directions submarine,reverse \
  --min-amount 10000 \
  --max-amount 1000000 \
  --base-fee 100 \
  --fee-ppm 2500 \
  --confirmations 1 \
  --wallet lnd \
  --lnd-address https://127.0.0.1:10009 \
  --lnd-cert /lnd/tls.cert \
  --lnd-macaroon "$macaroon" \
  --electrum-url tcp://electrs:60001 \
  --data-dir /data \
  --no-homeserver \
  "$@"
