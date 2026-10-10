#!/bin/sh
# Start one shop-order service with its config: `start.sh locks|service|shop`. The public URLs come from the quick tunnels, which
# ./shop-order writes to /run/order/urls.env once they answer; secrets come from the keys step in /state/order. Values that name
# an origin (CORS, the Lock Server's return origins, the Shop's own origin) are filled from those URLs, which change at every start.
set -eu

until [ -s /run/order/urls.env ]; do
  echo "[shop-order] $1 waiting for the tunnel URLs (./shop-order up writes them)"
  sleep 2
done
set -a
. /run/order/urls.env
set +a

case "$1" in
  locks)
    set -a
    . /state/order/locks.env
    set +a
    cat >/tmp/locks.toml <<TOML
bind_addr = "0.0.0.0:3000"
[credentials]
lock_server_secret_key = "/state/order/locks-seed"
lock_server_public_key = "${LOCKS_PUBLIC_KEY}"
max_ttl_seconds = 3600
[database]
url_env = "PUBKY_LOCK_DATABASE_URL"
max_connections = 10
run_migrations_on_startup = true
[paykit]
server_url = "http://shop-mixed-paykit:3001"
minimum_confirmations = 0
[worker]
enabled = true
poll_interval_ms = 250
claim_timeout_seconds = 60
worker_id = "shop-order"
[runtime]
environment = "development"
[creator_authority_acquisition]
enabled = true
method = "grant-connect"
frontend_session_ttl_seconds = 86400
frontend_session_code_ttl_seconds = 120
[creator_authority_acquisition.grant_connect]
client_id = "shop.pubky.app"
allowed_return_origins = ["${SHOP_URL}"]
[secrets]
creator_authority_key_env = "PUBKY_LOCK_CREATOR_AUTH_ENCRYPTION_KEY"
[logging]
level = "info"
[pubky]
network = "mainnet"
[pkdns]
public_ip = "127.0.0.1"
public_pubky_tls_port = 6287
public_icann_http_port = 3000
icann_domain = "localhost"
key_republisher_interval_seconds = 86400
TOML
    exec locks-server --config /tmp/locks.toml
    ;;
  service)
    set -a
    . /state/order/service.env
    BIND_ADDR=0.0.0.0:8080
    ALLOWED_ORIGINS="${SHOP_URL}"
    PUBLIC_APP_ORIGIN="${SHOP_URL}"
    PUBLIC_SERVICE_ORIGIN="${SERVICE_URL}"
    HOMESERVER_URL=https://homeserver.staging.pubky.app
    PAYKIT_SERVER_API=upstream
    PAYKIT_SERVER_URL="${PAYKIT_URL}"
    LOCKS_SERVER_URL="${LOCKS_URL}"
    LOCKS_PAYMENT_WINDOW_SECONDS=3600
    MARKETPLACE_GRANT_FLOW_ENABLED=true
    MARKETPLACE_GRANT_CLIENT_ID=shop.pubky.app
    MARKETPLACE_GRANT_RELAY_URL=https://httprelay.staging.pubky.app/inbox
    SHOP_GRANT_ASSERTION_ISSUER="${SHOP_URL}"
    REFUSAL_AUDIT_BACKUP_EXPIRY_ATTESTED=true
    REFUSAL_AUDIT_REPLICA_EXPIRY_ATTESTED=true
    REFUSAL_AUDIT_RESIDUAL_RISK_ACCEPTED=true
    RUST_LOG=info
    set +a
    exec marketplace-service
    ;;
  shop)
    set -a
    . /state/order/bff.env
    SHOP_BFF_GRANT_FLOW_ENABLED=true
    SHOP_ALLOWED_ORIGINS="[\"${SHOP_URL}\"]"
    SHOP_PUBLIC_ORIGIN="${SHOP_URL}"
    MARKETPLACE_SERVICE_URL=http://shop-order-service:8080
    SHOP_GRANT_ASSERTION_ISSUER="${SHOP_URL}"
    PUBKY_RUNTIME_ENV=staging
    PUBKY_RUNTIME_TESTNET=false
    PUBKY_RUNTIME_HOMESERVER=ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy
    PUBKY_RUNTIME_HOMESERVER_URL=https://homeserver.staging.pubky.app
    PUBKY_RUNTIME_HOMEGATE_URL=https://homegate.staging.pubky.app
    PUBKY_RUNTIME_DEFAULT_HTTP_RELAY=https://httprelay.staging.pubky.app/inbox
    PUBKY_RUNTIME_PKARR_RELAYS='["https://pkarr.pubky.app","https://pkarr.pubky.org"]'
    PUBKY_RUNTIME_NEXUS_URL=https://nexus-shop-migration.staging.pubky.app
    PUBKY_RUNTIME_CDN_URL=https://nexus-shop-migration.staging.pubky.app/static
    PUBKY_RUNTIME_MARKETPLACE_URL="${SERVICE_URL}"
    PUBKY_RUNTIME_LOCKS_URL="${LOCKS_URL}"
    PUBKY_RUNTIME_PAYKIT_SETUP_URL="${PAYKIT_URL}/setup"
    PUBKY_RUNTIME_PAYKIT_SERVER_API=upstream
    PUBKY_RUNTIME_PAYKIT_SETUP_CREATOR_PARAM=false
    PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE=locks-paykit
    PUBKY_RUNTIME_MARKETPLACE_GRANT_FLOW_ENABLED=true
    set +a
    exec node server.js
    ;;
  *)
    echo "usage: start.sh locks|service|shop" >&2
    exit 2
    ;;
esac
