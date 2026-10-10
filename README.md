# Bitkit Docker - Bitcoin & Lightning Dev Environment

A complete Docker-based development environment for Bitcoin and Lightning Network development, featuring a LNURL server for Lightning payments and testing guides using the Bitkit app.

## Services

- **Bitcoin Core** (regtest): Bitcoin node for development
- **LND**: Lightning Network Daemon for Lightning payments
- **Electrum Server**: For Bitcoin blockchain queries
- **LNURL Server**: Lightning payment server with LNURL support
- **LDK Backup Server**: Lightning Development Kit backup service
- **VSS Server**: Versioned Storage Server for app and ldk-node state backups
- **Homegate**: Pubky Homeserver signup gatekeeper with local admin API mock
- **Pubky marketplace fixture** (opt-in `marketplace` profile): Pubky testnet, Paykit Server and a purchase driver for the marketplace wallet journey
- **Payment Request fixture** (opt-in `payment-requests` profile): rc65 issuer and controlled peer on the marketplace Pubky testnet

## Quick Start

1. **Clone and start the services:**

   ```bash
   git clone --recurse-submodules git@github.com:ovitrif/bitkit-docker.git
   cd bitkit-docker
   docker compose up -d
   ```

2. **Wait for services to initialize** (about 30-60 seconds)

3. **Check health:**

   ```bash
   curl http://localhost:23000/health
   curl http://localhost:6288/
   ```

## Services Overview

### Bitcoin Core

- **Port**: 43782 (RPC), 39388 (P2P)
- **Network**: Regtest
- **Wallet**: Auto-created
- **Authentication**: `polaruser`/`polarpass`

### LND (Lightning Network Daemon)

- **REST API**: `http://localhost:23180`
- **P2P**: `localhost:23735`
- **RPC**: `localhost:23009`
- **Network**: Regtest
- **Features**: Zero-conf, SCID alias, AMP support

### LNURL Server

- **Port**: 23000
- **Features**:
  - LNURL-withdraw
  - LNURL-pay
  - LNURL-auth
  - LNURL-channel
  - Lightning Address support
  - QR code generation
- **Endpoints**:
  - `/health` - Service health check
  - `/generate` - Generate UI for LNURL
  - `/generate/withdraw` - Generate LNURL-withdraw
  - `/generate/pay` - Generate LNURL-pay
  - `/generate/channel` - Generate LNURL-channel
  - `/generate/auth` - Generate LNURL-auth
  - `/generate/bolt11` - Generate Bolt11 invoice (`?amount=` sats, `?amount_msat=` msats)
  - `/.well-known/lnurlp/:username` - Lightning Address

### LNURL-pay callback fixture

The optional `lnurl-pay` profile serves LNURL-pay metadata and controlled invoice callback responses on port `23010`. Each Compose project has its own in-memory mode, which starts as `error` and stays there until explicitly changed. Restarting the container resets it to `error`.

```bash
docker compose --profile lnurl-pay up -d --build --wait lnurl-server-fixture
curl -fsS http://localhost:23010/health
# Read the encoded LNURL and QR image for the fixed payment endpoint.
curl -fsS http://localhost:23010/generate/pay
curl -fsS http://localhost:23010/pay/fixture
# Initially returns HTTP 200 with LNURL status ERROR and a reason, on every request.
curl -fsS 'http://localhost:23010/pay/fixture/callback?amount=100001'
# Change the same callback to return a fresh signed regtest invoice.
curl -fsS -X POST http://localhost:23010/fixture \
  -H 'Content-Type: application/json' -d '{"mode":"healthy"}'
curl -fsS 'http://localhost:23010/pay/fixture/callback?amount=100001'
# Reset before another journey; GET /fixture reads the current mode.
curl -fsS -X POST http://localhost:23010/fixture \
  -H 'Content-Type: application/json' -d '{"mode":"error"}'
# Verify the fixture's HTTP contract and signed invoice properties.
docker compose --profile lnurl-pay exec -T lnurl-server-fixture node --test pay-fixture.test.js
```

Use the address and forwarded port reachable by the wallet when requesting `/generate/pay` or `/pay/fixture`: the response derives its URLs from the request's host, including any remapped port. Set `LNURL_FIXTURE_DOMAIN` before starting the service if the wallet must use a different origin (for example `http://10.0.2.2:23010` for an Android emulator).

`{"mode":"delay","ms":N}` holds every callback for `N` milliseconds and then answers with an invoice; without `ms` a callback waits until the next `POST /fixture`, which releases it with that request's mode (`healthy` for an invoice, `error` for an error). A callback is held for 15 minutes at most. `GET /fixture` lists the callbacks with how long each was held and what it answered, and `GET /fixture/invoices` lists the issued invoices with `settled` from LND, so a journey can check that a wallet did not pay after its deadline.

The profile starts the project's LND beside the fixture, and invoices are real invoices of that LND. To make them payable from a wallet, give it a channel: `GET /generate/channel` returns an LNURL-channel; when the wallet accepts it, LND (funded on the project's bitcoind first when it holds too little) opens a 1,000,000 sat static-remote-key channel that pushes 500,000 sat to the wallet, and mines six blocks to confirm it (`CHANNEL_SATS` and `PUSH_SATS` change the amounts). Ask `/generate/pay` and `/generate/channel` with a `Host` header naming the address the wallet dials (`-H 'Host: 127.0.0.1:23010'` for an Android emulator mapped with `adb reverse`) when you reach the fixture on another port: the encoded LNURL takes its origin from that header. The wallet dials LND at `LND_P2P_ADDRESS` (default `127.0.0.1:23735`, which an Android emulator reaches through `adb reverse tcp:23735 tcp:<published port>`). `GET /fixture/channels` shows LND's open and pending channels, and `POST /fixture/mine` with `{"blocks":N}` mines more blocks.

```bash
curl -fsS http://localhost:23010/generate/channel | jq -r .lnurl   # paste or scan in the wallet, then accept the connection
curl -fsS http://localhost:23010/fixture/channels | jq '.open[] | {remote_pubkey, capacity, local_balance, remote_balance, active}'
curl -fsS -X POST http://localhost:23010/fixture -H 'Content-Type: application/json' -d '{"mode":"delay"}'   # hold the next callbacks
curl -fsS -X POST http://localhost:23010/fixture -H 'Content-Type: application/json' -d '{"mode":"healthy"}' # release them with invoices
curl -fsS http://localhost:23010/fixture/invoices | jq
```

Healthy invoices use the requested amount in millisatoshis and bind the exact metadata with a SHA-256 description hash. They are signed, freshly generated `lnbcrt` invoices with a one-hour expiry and payment secret. This fixture supports invoice fetching, decoding and callback retry journeys; it has no Lightning node or channels and cannot settle payments. Use the regular LNURL server with LND for actual payments. Its controls are unauthenticated and intended only for disposable local test environments.

### VSS Server

- **Port**: 23050 (`127.0.0.1:23050` from the `vss` profile)
- **Features**: RS256 JWT authentication
- **Profile**: `docker compose --profile vss up -d vss-postgres vss` starts the server and its own database without the rest of the stack or the LNURL auth server. The server checks tokens with `lnurl-server/keys/public.pem`. The default `vss-server` service is unchanged.

### Homegate

- **Port**: 6288
- **Database**: Dedicated `homegate-postgres` service, exposed on host port 23433 by default
- **Admin mock**: `homegate-admin-mock`, available only inside the Compose network and password-protected by default
- **Features**:
  - Pubky Homeserver signup-code gatekeeping
  - IP verification enabled by default for local testing
  - SMS and Lightning verification disabled by default unless provider-backed config is added

### LNURL-Auth Server

- **Port**: 23005
- **Features**: Issuing RS256 JWT via LNURL-Auth protocol expected by VSS
- **Endpoints**:
  - `/health` - Service health check
  - `/auth` - LNURL-auth endpoint

### Electrum Server

- **Port**: 60001
- **Network**: Regtest
- **Features**: Full blockchain indexing

## Ports

Every host port is 1024 or above. The ports Bitkit, the Pubky SDK or Bitkit's UI tests dial by a fixed number keep it; every other service publishes in `23000`-`23999`, mostly at `23000` plus the last three digits of its container port. Services reach each other on their container ports (`lnd:8080`, `darkhttpd:80`).

| Service | Host port | Container port |
| --- | --- | --- |
| bitcoind RPC, P2P | 43782, 39388 | same |
| electrs | 60001 | same |
| darkhttpd (fee estimates) | 23080 | 80 |
| LND REST, P2P, gRPC | 23180, 23735, 23009 | 8080, 9735, 10009 |
| LDK backup server | 23003 | 3003 |
| LNURL server | 23000 | 3000 |
| LNURL-pay fixture (`lnurl-pay`) | 23010 | 3010 |
| PostgreSQL | 23432 | 5432 |
| LNURL-auth server | 23005 | 5005 |
| VSS server | 23050 | 5050 |
| Homegate, its PostgreSQL | 6288 (`HOMEGATE_PORT`), 23433 (`HOMEGATE_POSTGRES_PORT`) | 6288, 5432 |
| Trezor Bridge (both Trezor services) | 21325, 21328 | same |
| Trezor User Env controller, dashboard, MCP, VNC, noVNC | 9001, 23902, 23903, 23590, 23680 | 9001, 9002, 9003, 5900, 6080 |
| Trezor emulator fixture controller, dashboard, noVNC (`trezor-emulator`) | 23901, 23902, 23680 | 9001, 9002, 6080 |
| Pubky testnet DHT, PKARR relay, HTTP relay, homeserver HTTP, Pubky TLS (`marketplace`) | 6881, 15411, 15412, 6286, 6287 | 6881, 15411, 15412, 6286, 6297 (homeserver-proxy) |
| homeserver-proxy control, homeserver admin (`marketplace`) | 23298, 23288 (`MARKETPLACE_HOMESERVER_ADMIN_PORT`) | 6298, 6288 |
| Paykit Server (`marketplace`) | 23101 (`MARKETPLACE_PAYKIT_PORT`) | 3001 |
| `fixture-issuer`, `rc56-peer` (`payment-requests`) | 23012, 23013 | 3012, 3013 |
| Paykit Server, quick tunnel metrics (`shop-mixed`) | 23110, 23111 | 3001, 23111 |

## API Examples



```bash
# Health Check
curl http://localhost:23000/health | jq

# Generate LNURL-withdraw
curl -s http://localhost:23000/generate/withdraw | jq

# Generate LNURL-pay
curl -s http://localhost:23000/generate/pay | jq

# Lightning Address
curl -s http://localhost:23000/.well-known/lnurlp/alice | jq

# VSS Health Check
curl -v http://localhost:23050/vss/getObject

# Homegate service check
curl http://localhost:6288/
```

## Development

### Homegate

Homegate starts with the default `docker compose up -d` stack. Its source is included as the `homegate` submodule, and the container reads [homegate-config.toml](homegate-config.toml), which points at a local `homegate-admin-mock` service so startup does not require real Pubky Homeserver credentials.

The local stack sets high IP verification limits so repeated profile-creation test runs do not exhaust the quota from the same machine.

Useful commands:

```bash
# Rebuild and start Homegate with its database and admin mock
docker compose up --build -d homegate

# Check the service root
curl http://localhost:6288/

# Exercise IP verification against the local admin mock
curl -X POST http://localhost:6288/ip_verification

# Follow logs
docker compose logs -f homegate
```

To test against a real Homeserver admin API or provider-backed SMS/Lightning verification, update [homegate-config.toml](homegate-config.toml) before starting the service:

- Point `[homeserver].admin_api_url` and `admin_password` at the real admin API
- Add `[sms_verification]` with Prelude credentials for SMS verification
- Add `[ln_verification]` with PhoenixD credentials for Lightning verification

### bitcoin-cli helper

The `bitcoin-cli` script provides shortcuts for common operations. Run `./bitcoin-cli --help` for full usage.

**Bitcoin Core:**
- `fund` - Generate 101 blocks to fund the wallet
- `mine [count]` - Mine blocks (use `--auto` for continuous mining)
- `send [amount] [address] [-m N]` - Send BTC to address, optionally mine N blocks after
- `getInvoice [amount]` - Generate BIP21 URI with new address, copy to clipboard

**LND:**
- `getinfo` - Show LND node info (connectivity check)
- `bolt11 [amount] [--msat] [-m memo]` - Create a Lightning invoice (amount in sats, or msats with `--msat`)
- `holdinvoice [amount] [-m memo]` - Create a hold invoice (any-amount by default)
- `settleinvoice <preimage>` - Settle a hold invoice with its preimage
- `cancelinvoice <payment_hash>` - Cancel a pending hold invoice

```bash
# Fund wallet and mine blocks
./bitcoin-cli fund
./bitcoin-cli mine 1

# Create a Lightning invoice
./bitcoin-cli bolt11 500                      # 500 sats invoice
./bitcoin-cli bolt11 500500 --msat            # 500500 msats invoice
./bitcoin-cli bolt11 500 -m "test"            # with memo

# Create and settle a hold invoice
./bitcoin-cli holdinvoice -m "test"           # any-amount invoice
./bitcoin-cli holdinvoice 500 -m "test"       # 500 sats invoice
./bitcoin-cli settleinvoice <preimage>        # after payment received
./bitcoin-cli cancelinvoice <payment_hash>    # to cancel before payment
```

### LND CLI (raw)

For full lncli access:

```bash
docker compose exec lnd lncli --lnddir /home/lnd/.lnd --network regtest <command>
```

### View Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f lnurl-server
docker compose logs -f vss-server
docker compose logs -f homegate
docker compose logs -f lnd
docker compose logs -f bitcoind
```

### Bitkit Testing

#### Payment Requests and Deadline History

The `payment-requests` profile starts two disposable Paykit rc65 SDK peers (paykit-rs `7185ae7`, Pubky 0.14.0) on
the marketplace fixture's Pubky testnet. `fixture-issuer` publishes a regtest
Paykit endpoint and sends one-time requests. `rc56-peer` can accept, reject,
cancel and pay requests through the shared regtest Bitcoin node. Plain
`docker compose up -d` does not start either peer. The commands below need
`curl`, `jq` and `python3` on the host.

```bash
./pubky-marketplace up
./pubky-marketplace seed
docker compose --profile marketplace --profile payment-requests build fixture-issuer
docker compose --profile marketplace --profile payment-requests up -d --no-build fixture-issuer rc56-peer
for port in 23012 23013; do
  until health=$(curl -fsS "http://127.0.0.1:$port/health"); do sleep 2; done
  jq <<<"$health"
done
```

The peers sign up on the testnet and publish their endpoints before they listen,
so `/health` fails for a few seconds after `up`. The loop waits for them, and
`payment-requests/prepare` does the same for up to 150 seconds. A peer retries
its setup for two minutes and then exits; if the loop does not end, stop it and
read `docker compose --profile marketplace --profile payment-requests logs fixture-issuer rc56-peer`.

For a contact-link lifecycle test, run `./payment-requests/prepare --link-only`
before installing the app. It returns `{"link":"linked",...}` only after two
disposable SDK peers have signed up, published their endpoints, and completed a
private handshake on the local testnet. This checks the Pubky write-lock path
without creating payment requests. A failure leaves the device test unstarted;
inspect the peer and `pubky-testnet` logs. The preflight does not stand in for
the app's own background and resume check.

Build the Android app with `E2E=true E2E_BACKEND=local`,
`E2E_HOMESERVER_PUBKY` from `./pubky-marketplace info | jq -r .homeserver_z32`,
and `E2E_LOCAL_HOST=127.0.0.1`. On each test device, reverse ports 6286,
6287, 6288, 15411, 15412 and 60001 to that device's own fixture project before
first launch. Use two fresh app identities on this testnet and save each other
as contacts. This keeps the held SDK call on a local Pubky server that supports
`LOCK` and `UNLOCK`; a staging build reaches the public homeserver instead.
After the test, remove any selective `homeserver-proxy` rules set for it.

Each `/health` response gives the identity, receiver path and published
`btc-regtest-p2wpkh` address. Prepare and verify all one-time J1 states plus
an accepted monthly subscription with one paid period and a new monthly
proposal:

```bash
./payment-requests/prepare | jq
```

The command returns every request id and the regtest txids after checking the
peer's SDK states. `/pay` sends a transaction and a txid proof. If proof
delivery fails after the transaction was sent, retry queued delivery with
`POST /sync`; `/proof` accepts an existing wallet txid, address and amount.

To test Bitkit, use a disposable app identity on this local Pubky testnet.
Link it to the issuer's `pubky` and `receiver_path`, then `POST /link` with
`mode: "accept"` on the issuer using the wallet's `peer_pubky` and
`peer_path`. Call `POST /sync` while the app advances its handshake. Send
`POST /request` to the app identity; the default actual-payment deadline is
seven days ahead, or set `deadline_at` to a UTC RFC3339 timestamp. The app
must synchronize the request and verify its own history row. To prepare
rejected or canceled records, issue another request and call `/reject` or
`/cancel` with its id from the payer side. For monthly requests,
`POST /request` accepts `monthly_starts_at` (UTC RFC3339) and
`period_start_deadline_seconds`; `/pay` then needs
`billing_period_start` and `billing_period_end`.
`POST /request` also accepts `proposal_expires_at` (UTC RFC3339, the
acceptance deadline, apart from the payment deadline) and `lnurl`, an LNURL-pay
string such as the LNURL fixture's `GET /generate/pay`: the request then
accepts only `btc-lightning-lnurl`, which the private payment list sent with it
offers beside the regtest address. `/pay` funds the issuer's bitcoind wallet by
mining to it when it holds less than the payment and a fee.

Example one-time issuance to a linked app after both sides report `Linked`:

```bash
APP_PUBKY=pubky... # replace with the disposable app identity
curl -fsS -X POST http://127.0.0.1:23012/request -H 'content-type: application/json' \
  -d "$(jq -nc --arg pubky "$APP_PUBKY" '{peer_pubky:$pubky,peer_path:"bitkit/wallet",amount_sats:15000,reference:"rc56-app-history"}')" | jq
```

These peers keep their identities and SDK records in memory and live in the
Pubky testnet's network namespace, so `./pubky-marketplace down` and `reset`
remove them together with the testnet. After `reset`, start them again with the
`up -d --no-build fixture-issuer rc56-peer` command above, wait for `/health`,
rerun `payment-requests/prepare` and relink the app. `./pubky-marketplace seed`
needs outbound internet for Paykit Server setup; the rc65 peer calls use the
local testnet. The lane still needs a Bitkit build pointed at the local Pubky
testnet and to verify the requested rows on device. The headless preparation
command does not populate a separate Bitkit identity's history; accepted and
paid app rows require the lane's controlled client to prepare those records
with the app's identity or an app build that supports importing fixture state.

##### Withholding the issuer's endpoints

A journey that needs the app's request resolution to fail (for example
`requested-resolution-failure.xml`) withholds the issuer's payment endpoints
before it sends the request, then restores them:

```bash
TO_APP=$(jq -nc --arg pubky "$APP_PUBKY" '{peer_pubky:$pubky,peer_path:"bitkit/wallet"}')
curl -fsS -X POST http://127.0.0.1:23012/endpoints -H 'content-type: application/json' \
  -d "$(jq -c '. + {action:"withhold"}' <<<"$TO_APP")" | jq
curl -fsS -X POST http://127.0.0.1:23012/request -H 'content-type: application/json' \
  -d "$(jq -c '. + {amount_sats:15000,reference:"unresolvable"}' <<<"$TO_APP")" | jq
# ... the app retries and shows "The payment request is no longer available." ...
curl -fsS -X POST http://127.0.0.1:23012/endpoints -H 'content-type: application/json' \
  -d "$(jq -c '. + {action:"restore"}' <<<"$TO_APP")" | jq
curl -fsS http://127.0.0.1:23012/endpoints | jq   # {"withheld": false, ...}
```

`withhold` removes the issuer's public `btc-regtest-p2wpkh` endpoint and sends
the named peer an empty private payment list. While withheld, `/request` sends
its request with that empty list, so the request names an endpoint the app
cannot resolve (`"endpoints_withheld": true` in its answer). `restore`
publishes the endpoint again and sends the peer the full list; the app's next
attempt resolves it. Without `peer_pubky`, only the public endpoint changes.

#### Following the apps' Paykit pin

The Paykit fixtures must run the paykit-rs version the app under test pins: the payment request peers
(`payment-request-fixture:rc65-shared`, paykit-rs `7185ae7`, v0.1.0-rc65) and Paykit Server (built from
the head of [pubky/paykit-server#46](https://github.com/pubky/paykit-server/pull/46), `0ffd4da`, until it
merges or is released). Each image records the paykit-rs commit it was built from (label
`tech.masivo.paykit-rs`, or `/usr/local/share/paykit-rs-rev` in the peers' image).

```bash
scripts/follow-app-paykit synonymdev/bitkit-android 1401 --check   # print the pin and what is out of date (exit 3)
scripts/follow-app-paykit synonymdev/bitkit-ios a6846779a71081f262f47883570125bd541b4fd6
```

It reads the pin at the PR head (Android `gradle/libs.versions.toml`, iOS `Package.resolved`), rebuilds the
peers' image as `payment-request-fixture:<rc>-shared` when it was built from another commit, and builds
Paykit Server and the driver from the Paykit Server PR the app PR links (its merge commit once merged),
else from master, when that revision locks the same paykit-rs tag (exit 4 when none does). Afterwards every
tag Compose resolves for those images, `COMPOSE_FILE` overrides included, points at the new build.

#### Homeserver proxy (explicit holds and selective faults)

The apps reach the testnet homeserver through `homeserver-proxy`, which the
marketplace profile starts with the testnet: the host's 6287 (Pubky TLS) goes
to it, it presents the static testnet's homeserver key (secret `[0; 32]`) and
forwards every request to the homeserver's plain HTTP on 6286. Clients inside
the testnet's namespace (Paykit Server, the payment request peers) still reach
the homeserver on 6287 directly. Without rules the proxy only forwards.

The control port is 23298 (6298 in the container). `POST /rules` installs a rule
for a `pubky` identity and owner-relative `path` prefix (empty matches every
path). The optional `method` restricts it to one HTTP method, normalized to
uppercase. Method-specific rules take precedence over rules for every method;
within those groups the longest path wins. Keys take z32 with or without the
`pubky` prefix. A rule with the same identity, path and method replaces the old
rule and releases its existing waiters with their original response behavior.

Use `hold: true` for an overlap or publication barrier. It has **no timer**:
every matching request waits until its rule is released or replaced. A client
can still cancel its own request; the rule stays installed for retries.
`delay_ms` keeps the earlier timed-delay behavior and cannot be combined with
`hold`. `status` injects a response instead of forwarding, after any hold or
delay. A rule containing only `status: 404` persists until removed, so SDK
reads cannot start seeing published records because a delay expired.

```bash
PROXY=http://127.0.0.1:23298 # use the control port published by your own seat
# Identity barrier: install before the request, then gate its arrival.
curl -fsS -X POST "$PROXY/rules" -H 'content-type: application/json' \
  -d "$(jq -nc --arg pubky "$APP_PUBKY" '{pubky:$pubky,path:"/pub/pubky.app/profile.json",method:"GET",hold:true}')"
python3 scripts/homeserver-wait.py --control "$PROXY" --owner "$APP_PUBKY" \
  --path /pub/pubky.app/profile.json --method GET --timeout 30

# Withdrawal and re-publication barriers: arm BOTH before starting either operation.
# Narrow path to the relevant records when known; empty covers all this identity's paths.
for method in DELETE PUT; do
  curl -fsS -X POST "$PROXY/rules" -H 'content-type: application/json' \
    -d "$(jq -nc --arg pubky "$APP_PUBKY" --arg method "$method" '{pubky:$pubky,path:"",method:$method,hold:true}')"
done
# Call after the run initiates both operations. Exit 0 requires both to be pending
# in the SAME response, before taking the run's assignment/state snapshot.
python3 scripts/homeserver-wait.py --control "$PROXY" --owner "$APP_PUBKY" \
  --method DELETE --method PUT --timeout 30

# Missing-peer barrier: arm before fresh peer B starts publishing.
curl -fsS -X POST "$PROXY/rules" -H 'content-type: application/json' \
  -d "$(jq -nc --arg pubky "$PEER_PUBKY" '{pubky:$pubky,path:"",method:"PUT",hold:true}')"
# Preserve missing-record responses through all resumed SDK work, even if a write retries.
curl -fsS -X POST "$PROXY/rules" -H 'content-type: application/json' \
  -d "$(jq -nc --arg pubky "$PEER_PUBKY" '{pubky:$pubky,path:"",method:"GET",status:404}')"
python3 scripts/homeserver-wait.py --control "$PROXY" --owner "$PEER_PUBKY" --method PUT --timeout 30
curl -fsS "$PROXY/requests" | jq '{pending, missing_reads:[.requests[] | select(.status == 404)]}'

# Release only this publication barrier; the GET 404 fault remains until released separately.
curl -fsS -X POST "$PROXY/rules/release" -H 'content-type: application/json' \
  -d "$(jq -nc --arg pubky "$PEER_PUBKY" '{pubky:$pubky,path:"",method:"PUT"}')"
# Repeat with method GET to restore peer reads when the run needs recovery.
# Always clear remaining rules in the run's cleanup, including after a failed wait.
curl -fsS -X DELETE "$PROXY/rules"
```

`GET /requests` contains `pending` (currently held requests, with id, arrival
time, owner, method, path and matched rule path) and `requests` (last 200
completed requests, including actual `delayed_ms` and `held`). Keep the pending
snapshot beside the run's state snapshot and confirm the barrier is still
pending at that point. Verify the resumed SDK's exact peer paths have logged
404 responses before calling a missing-record fault established; a publication
hold alone does not prove it. All these faults apply only to clients routed
through the proxy, not the in-namespace peers.

`scripts/homeserver-wait.py` requires Python 3 only. Its timeout exits nonzero
with the last snapshot; it never releases rules or treats completed requests
as pending. Do not infer overlap from a configured rule or a sleep.

To install an updated proxy into an already leased seat, build a uniquely tagged
image from the fix's pinned checkout and replace **only** that seat's proxy.
Use the generated seat Compose files and project, not a new base stack:

```bash
# FIXTURE_TREE is the pinned bitkit-docker fix checkout copied to this box.
# Keep the seat's existing COMPOSE_FILE and COMPOSE_PROJECT_NAME from its seat environment.
FIX_REV=$(git -C "$FIXTURE_TREE" rev-parse HEAD)
PROXY_IMAGE=bitkit-docker/homeserver-proxy:$FIX_REV
docker build -t "$PROXY_IMAGE" -f "$FIXTURE_TREE/payment-requests/Dockerfile" "$FIXTURE_TREE/payment-requests"
# Create this override in the seat's own fixture directory.
cat > homeserver-proxy.override.yaml <<EOF
services:
  homeserver-proxy:
    image: $PROXY_IMAGE
EOF
COMPOSE_FILE="$COMPOSE_FILE:$PWD/homeserver-proxy.override.yaml" \
  docker compose --profile marketplace up -d --no-deps --no-build --force-recreate homeserver-proxy
curl -fsS "$PROXY/health" # ok
curl -fsS "$PROXY/requests" | jq -e 'has("pending")'
```

For a fresh standalone fixture checkout, `docker compose --profile marketplace
up -d --build homeserver-proxy` starts the testnet and proxy. Verify the fixture
itself without driving an app: `cargo test --locked --manifest-path
payment-requests/Cargo.toml --bin homeserver-proxy` exercises raw-public-key TLS,
explicit holds, independent releases, persistent 404 reads and healthy forwarding;
`python3 -m unittest discover -s scripts -p test_homeserver_wait.py` checks the
arrival gate.

#### Trezor Hardware PRs

For isolated Linux or Docker-backed simulator projects, use the optional
`trezor-emulator` profile. It builds a named image from the pinned official User
Env, starts Bridge, and initializes the deterministic T2T1 device automatically:

```bash
docker compose --profile trezor-emulator build trezor-emulator
docker compose --profile trezor-emulator up -d --wait trezor-emulator
curl -fsS -X POST http://127.0.0.1:21325/enumerate
docker compose --profile trezor-emulator exec -T trezor-emulator \
  /trezor-user-env/.venv/bin/python3 /opt/bitkit-trezor/trezor-fixture-check.py
```

Point the simulator's Bridge URL at `http://127.0.0.1:21325`. The dashboard is at
`http://127.0.0.1:23902`, the controller at `ws://127.0.0.1:23901`, and noVNC at
`http://127.0.0.1:23680`. For projects that remap ports, use their published Bridge
port (or the simulator seat's forwarded address). The device uses the `all all
...` seed, no PIN or passphrase, and the label `Bitkit Test Trezor`. Each project's
volumes are separate, and each startup wipes and initializes its own emulator.
The image's digest fixes both the bundled firmware and Bridge; startup downloads
nothing. Health requires setup to finish and both Bridge and the emulator to run.

The diagnostic checks the deterministic public key, a `bcrt1` address, and
Bridge signing of a synthetic transaction with an independently verified
signature. It uses the debug link to approve only that diagnostic's prompts;
run it while no wallet uses the device. It needs no app or live chain and
does not broadcast a transaction.

Run the existing `bitcoind` and `electrs` services for funding and broadcasting
regtest transactions. The emulator signs `Regtest` transactions without needing
its own chain backend. To control button confirmations through the debug link:

```bash
docker compose --profile trezor-emulator exec -T trezor-emulator \
  /trezor-user-env/.venv/bin/python3 /opt/bitkit-trezor/trezor-controller.py \
  send-json '{"type":"emulator-press-yes"}'
```

See [docs/trezor-emulator.md](docs/trezor-emulator.md) for fixture diagnostics and
the separate manual User Env workflow below. Stop only this profile's service
with `docker compose --profile trezor-emulator stop trezor-emulator`.

Use this section as the entry point when checking Bitkit app PRs or merged features that need the official Trezor emulator. Start by preparing the deterministic Trezor User Env:

```bash
./scripts/trezor-emulator start
```

The macOS Trezor User Env service is included in the default `docker compose up -d` stack. The helper uses this repo-managed Compose service, then resets Bridge and the emulator into the deterministic review state. Linux users can start the host-network service with `docker compose --profile trezor-linux up -d trezor-user-env-linux`.

The helper starts the official Trezor User Env without its regtest stack, launches Bridge, wipes a deterministic T2T1 emulator, and sets it up with the `all all ...` seed and `Bitkit Test Trezor` label. It uses `scripts/trezor-controller.py` inside the container to talk to the User Env websocket controller.

##### Bitkit Android

For a physical phone, reverse the Bridge port and install the dev build with Bridge enabled:

```bash
./scripts/trezor-emulator adb
TREZOR_BRIDGE=true TREZOR_BRIDGE_URL=http://127.0.0.1:21325 ./gradlew installDevDebug
```

For an Android emulator, install with the emulator host Bridge URL:

```bash
TREZOR_BRIDGE=true TREZOR_BRIDGE_URL=http://10.0.2.2:21325 ./gradlew installDevDebug
```

Open the dashboard at `Settings -> Advanced -> Dev Settings -> Trezor`, then check:

- Scan shows the Bridge emulator device
- Connect succeeds and device features are shown
- Get address succeeds
- Get public key succeeds
- Sign and verify message succeed
- Send or compose reaches the expected funded or no-funds state
- Disconnect, reconnect, and forget-device cleanup behave correctly

##### Bitkit iOS

Run the relevant Trezor branch from Xcode. The User Env dashboard and Bridge are available on the host at:

- User Env dashboard: `http://localhost:23902`
- Trezor Bridge: `http://localhost:21325`

Open the dashboard at `Settings -> Advanced -> Trezor Hardware Wallet`, then check:

- Scan shows the Bridge emulator device
- Connect succeeds and device features are shown
- Get address succeeds
- Get public key succeeds
- Sign and verify message succeed
- Send or compose reaches the expected funded or no-funds state
- Disconnect, reconnect, and forget-device cleanup behave correctly

See [docs/trezor-emulator.md](docs/trezor-emulator.md) for helper internals, environment overrides, and troubleshooting commands.

#### Pubky Marketplace Journey

Use this section for the Bitkit marketplace wallet journey (`journeys/pubky-marketplace` in [bitkit-ios](https://github.com/synonymdev/bitkit-ios/tree/master/journeys/pubky-marketplace) and [bitkit-android](https://github.com/synonymdev/bitkit-android/tree/master/journeys/pubky-marketplace)). The `marketplace` profile adds the integration fixture that the journey lists: a Pubky testnet, Paykit Server `722ef268` (v0.1.0-rc4) with `/setup` and `x-bitkit-claim=watch-only-account-v1`, and a purchase driver. That revision emits the Pubky grant auth URL (`pubkyauth://signin_grant` with `cid` and `cpk`) that the apps' Paykit SDK (0.1.0-rc55) requires; the merge of [pubky/paykit-server#2](https://github.com/pubky/paykit-server/pull/2) (`867fc883`) emits the legacy URL, which the apps reject. It reuses this stack's regtest `bitcoind` and Electrum on `tcp://127.0.0.1:60001`. A plain `docker compose up -d` does not start it, and `./pubky-marketplace` starts only the chain and fixture services, so run it without the full stack. It needs Docker, `git`, `curl` and `jq` on the host, and outbound internet during the first build and during setup approval (see the setup relay note in [docs/pubky-marketplace.md](docs/pubky-marketplace.md)).

```bash
./pubky-marketplace up                    # fetch pinned sources, build, start, wait until Paykit Server is ready (first build takes a while)
./pubky-marketplace seed                  # mine to maturity, seller wallet and identity, watch-only setup, headless buyer
./pubky-marketplace verify                # whole journey with no wallet app; writes .marketplace/evidence/<run>/summary.json
```

`verify` creates one purchase, receives the Payment Request as a headless buyer, checks the unsigned and garbage-signed calls fail with 401, pays the derived address, confirms the transaction is the only mempool entry, mines exactly one block, and waits for the signed Paykit status `confirmed`. Run the same steps by hand:

```bash
./pubky-marketplace purchase --sats 15000   # prints bundle id, derived address, amount, delivery state
./pubky-marketplace receive <bundle>        # headless buyer: Payment Request id, checks lowercase btc and the address
./pubky-marketplace pay <bundle>            # headless buyer pays from the regtest wallet
./pubky-marketplace wait <bundle> detected  # signed Paykit status: detected
./pubky-marketplace mine --bundle <bundle>  # exactly one block, refuses if the purchase is not in the mempool (finds an app buyer's payment by address and amount)
./pubky-marketplace wait <bundle> confirmed
./pubky-marketplace status <bundle>         # signed Paykit status and purchase state (completed at 1 confirmation)
```

For Bitkit wallets, build each simulator or emulator against this fixture before its first launch:

- iOS: build with the local E2E backend and the fixture homeserver key, passing each build setting as its own `--extra-args` element. Putting them all in one quoted string makes xcodebuild read the whole string as the value of the first setting, so `E2E_HOMESERVER_PUBKY` never reaches `Info.plist`. Electrum resolves to `tcp://127.0.0.1:60001` with no override.

  ```bash
  xcodebuildmcp simulator build-and-run --simulator-id <simulator-id> \
    --extra-args 'SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) E2E_BUILD' \
    --extra-args 'E2E_BACKEND=local' \
    --extra-args 'E2E_NETWORK=regtest' \
    --extra-args "E2E_HOMESERVER_PUBKY=$(./pubky-marketplace info | jq -r .homeserver_z32)"
  ```

- Android: build the local E2E backend with the same `E2E_HOMESERVER_PUBKY` in the environment. On each emulator run `adb reverse tcp:<port> tcp:<port>` for 6286, 6287, 15411 and 15412 (the homeserver admin port is published on 23288 and no app uses it); the Android journey README covers the emulator's `10.0.2.2` host address.
- In each wallet create a Bitkit-generated Pubky identity (not a Pubky Ring import) and enable contact payments.

Then, with the buyer wallet:

```bash
./pubky-marketplace info | jq -r .seller.pubky        # save this seller as a contact in the buyer wallet
./pubky-marketplace fund <buyer bcrt1 address> 1000000  # sends coins and mines one funding block
./pubky-marketplace peers --buyer <buyer pubky>      # journey step 14: seller setup ready, both receiver markers published
./pubky-marketplace purchase --buyer <buyer pubky>    # the Payment Request appears in the buyer wallet
./pubky-marketplace peers --buyer <buyer pubky> --wait 60  # after the purchase: Paykit Server's link to the buyer is connected
```

Pay the request in the app, then confirm with `./pubky-marketplace mine --bundle <bundle>`, `./pubky-marketplace wait <bundle> confirmed` and `./pubky-marketplace status <bundle>`. By default the seller of a purchase is the fixture's headless seller, and `verify` always uses it.

To make a Bitkit wallet the seller, the wallet approves two Pubky requests for the same identity: the Paykit watch-only setup (it gives Paykit Server the wallet's account xpub, so payouts land in that wallet) and a write grant on `/pub/app.locks/` (the role Locks plays: the driver publishes the payment lock with the granted session). One request cannot carry both, because the apps accept the watch-only claim only for exactly the two Paykit paths.

```bash
./pubky-marketplace seed --buyer none            # once per fixture; the headless seller stays unused
./pubky-marketplace setup-url                    # open android or ios_url in the seller wallet, approve, then:
./pubky-marketplace setup-wait <flow>
./pubky-marketplace seller-auth                  # prints the marketplace grant request (first JSON line), waits for the approval (last line)
./pubky-marketplace purchase --seller bitkit --buyer <buyer pubky>
./pubky-marketplace mine --bundle <bundle>       # after the buyer pays; add --address <bcrt1...> if two payments match the amount
./pubky-marketplace wait <bundle> confirmed
./pubky-marketplace status <bundle>              # payout address, txid, signed Paykit status, purchase state
```

Both URLs are `pubkyauth://signin_grant?...` links whose one-time secret must stay out of logs and evidence. On Android run each printed `android` command (`adb shell "am start -a android.intent.action.VIEW -d '<auth_url>'"`; keep the double quotes, or the device shell cuts the URL at the first `&`). With several devices or emulators pass `--serial <adb-serial>` to `setup-url` or `seller-auth` and the command gets `-s <adb-serial>`. On iOS the setup request opens through the printed `ios_url` (`xcrun simctl openurl <simulator-id> '<ios_url>'`); the marketplace grant has no iOS deep link, so put its `auth_url` on the simulator clipboard (`printf %s '<auth_url>' | xcrun simctl pbcopy <simulator-id>`) and use Scan QR Code, then Paste QR Code (E2E builds also have Enter QRCode String). The marketplace request goes through the testnet's HTTP relay on `localhost:15412` (published by the fixture; on Android it is one of the `adb reverse` ports above) and expires after about five minutes; pass `--relay https://httprelay.pubky.app/inbox/` to use the public relay instead. The setup request still uses the public relay and needs outbound internet.

The fixture cannot check a Bitkit seller's payout address against the wallet's xpub, because Paykit Server keeps the xpub and the derived address to itself. It checks that the Payment Request address is a regtest native SegWit address, that exactly the amount is paid to it on chain, and Paykit Server's signed status (`detected`, then `confirmed` with a matching amount). That the address belongs to the wallet shows in the seller app: its balance rises by the amount and the received activity carries the same txid as `status`. `./pubky-marketplace verify-bitkit-seller` runs the whole path with a headless stand-in for the wallet and does check the payout against the stand-in's xpub.

Remove the fixture with `./pubky-marketplace down`, or start over with `./pubky-marketplace reset`. The Pubky testnet keeps its accounts in memory, so the fixture cannot restart with its state and `down` deletes it (the regtest chain stays). `./pubky-marketplace --help` lists every command. See [docs/pubky-marketplace.md](docs/pubky-marketplace.md) for the pins, ports, roles and what the fixture does not cover.

#### Shop on Staging with Our Own Paykit Server

The `shop-mixed` profile runs the marketplace half of the Shop ourselves and everything else on Synonym's staging: Paykit Server
v0.1.0-rc11 (`662dca06`, paykit-rs `ad3c7224` = v0.1.0-rc72, the version the Bitkit send-fix builds pin) on the staging homeserver
`ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy` (`homeserver.staging.pubky.app`), watching Blocktank's staging regtest
Electrum (`ssl://electrs.bitkit.stag0.blocktank.to:9999`, the one Bitkit's staging builds use), behind a Cloudflare quick tunnel
(`https://<words>.trycloudflare.com`, a new name at every start). Bitkit staging builds (Android `devDebug`, iOS `Debug`) are the
seller and the buyer as they are; no local build, `adb reverse` or local chain is needed. Use it when the staging Shop cannot serve a
test, for example when the app pins a Paykit version the staging Paykit Server does not run. Needs Docker, `curl` and `jq`, and
outbound internet.

```bash
./shop-mixed up                          # builds on first use (a Rust build), starts, waits until /health/ready answers through the tunnel
./shop-mixed health                      # pinned revisions, loopback and tunnel /health/ready
./shop-mixed setup-url                   # seller wallet: open `android` / `ios_url`, or `setup_page` in its browser, approve, then:
./shop-mixed setup-wait <flow>
./shop-mixed seller-auth                 # the marketplace grant on /pub/app.locks/ through httprelay.staging.pubky.app
./shop-mixed purchase --buyer <buyer pubky>   # the Payment Request appears in the buyer wallet
./shop-mixed wait <bundle> detected      # after the buyer pays in the app
./shop-mixed mine                        # one block on Blocktank's staging regtest chain
./shop-mixed wait <bundle> confirmed
./shop-mixed down                        # removes the stack and its state
```

The headless seller and buyer of the `marketplace` profile need the local testnet and chain, so `seed`, `fund`, `receive`, `pay`,
`peers` and `verify` refuse here. See [docs/shop-mixed.md](docs/shop-mixed.md) for what runs where and how the pins are checked.

#### Bech32 LNURL Pay

- in `Env.{kt,swift}`, use for REGTEST electrum server: `"tcp://localhost:60001"`
- `adb reverse tcp:60001 tcp:60001 && adb reverse tcp:23735 tcp:23735`
- in app, wipe current wallet data and create fresh one
- run `docker compose up --build -d`
- fund onchain wallet: `./bitcoin-cli fund`
- send funds to in-app wallet address: `./bitcoin-cli send 0.25 -m`
- get local LND URI and open channel:
  - `curl -s http://localhost:23000/health | jq -r '.lnd.uris[0]' | pbcopy`
  - in app: send > paste > complete the flow
  - `./bitcoin-cli mine 3`
- generate LNURL pay: `http://localhost:23000/generate/pay`
- paste lnurl into app
- generate fixed amount LNURL pay (QuickPay): `curl -s 'http://localhost:23000/generate/pay?minSendable=10000&maxSendable=10000' | jq -r .lnurl | pbcopy`

#### Lightning Address

- `ngrok http 23000`
- change `DOMAIN` in `docker-compose.yml` to `__NGROK_URL__`
- `docker compose down` if running
- `docker compose up --build -d`
- `http://localhost:23000/.well-known/lnurlp/alice`
- copy the email-like lightning address and paste into app

#### LNURL-Channel

- (optional) use physical phone so localhost is usable via `adb reverse`
- (optional) reset `bitkit-docker` state
  - `docker compose down -v`
  - `rm -rf ./lnd ./lnurl-server/data`
  - `docker compose up --build -d`
- `adb reverse tcp:60001 tcp:60001 && adb reverse tcp:23735 tcp:23735`
- fund onchain wallet: `./bitcoin-cli fund`
- fund LND wallet:
  - `./bitcoin-cli send 0.2 "$(curl -s http://localhost:23000/health | jq -r '.lnd.address')" -m`
  - check balance: `curl -s http://localhost:23000/health | jq '.lnd.balance'`
- generate LNURL channel: `http://localhost:23000/generate/channel`
- paste lnurl into app and complete the flow
- mine blocks: `./bitcoin-cli mine 6`

#### LNURL-Withdraw
- setup a channel (see above)
- generate LNURL: `curl -s http://localhost:23000/generate/withdraw | jq -r .lnurl | pbcopy`
- set an amount of at least ₿5000 & complete the flow
- generate LNURL with limits: `curl -s "http://localhost:23000/generate/withdraw?minWithdrawable=100000&maxWithdrawable=200000" | jq -r .lnurl | pbcopy`
  - `minWithdrawable` (optional): min msats (default: 1000 = 1 sat)
  - `maxWithdrawable` (optional): max msats (default: 100000000 = 100k sats)

#### LNURL-Auth

- set DOMAIN in `docker-compose.yml` to `http://__YOUR_NETWORK_IP__:23000`
- run `docker compose down`
- run `docker compose up --build -d`
- generate LNURL auth: `http://localhost:23000/generate/auth`
- paste lnurl into app and complete the flow

#### LDK-NODE with JWT auth to VSS

- `adb reverse tcp:23000 tcp:23000 && adb reverse tcp:23050 tcp:23050`
  - cd to root dir
  - `git submodule update --init --recursive`
  - `docker compose up --build -d`
- in `Env.kt` use commented REGTEST urls for `lnurlAuthSeverUrl` and `vssServerUrl`
- uninstall & reinstall new app
- create new wallet
- send onchain from other wallet to have activity
- backup seed, then wipe and restore

#### External Node Channel

- (optional) use physical phone so localhost is usable via `adb reverse`
- (optional) reset `bitkit-docker` state
  - `docker compose down -v`
  - `rm -rf ./lnd ./lnurl-server/data`
  - `docker compose up --build -d`
- in `Env.kt`, change `ElectrumServers.REGTEST` to `"tcp://127.0.0.1:60001"`
- `adb reverse tcp:60001 tcp:60001 && adb reverse tcp:23735 tcp:23735`
- fund onchain wallet: `./bitcoin-cli fund`
- fund LND wallet:
  - `./bitcoin-cli send 0.2 "$(curl -s http://localhost:23000/health | jq -r '.lnd.address')" -m`
  - check balance: `curl -s http://localhost:23000/health | jq '.lnd.balance'`
- fund app wallet: `./bitcoin-cli send 0.002 -m`
- `curl -s http://localhost:23000/health | jq -r '.lnd.uris[0]' | pbcopy`
- in app: send > paste > complete flow for 100_000 sats > return to home screen
- mine blocks: `./bitcoin-cli mine 6`
- await channel ready notice

## Configuration

### Environment Variables

Key environment variables in `docker-compose.yml`:

- `BITCOIN_RPC_HOST`: Bitcoin RPC host (default: `bitcoind`)
- `BITCOIN_RPC_PORT`: Bitcoin RPC port (default: `43782`)
- `LND_REST_HOST`: LND REST API host (default: `lnd`)
- `LND_REST_PORT`: LND REST API port inside the compose network (default: `8080`; the host reaches it on `23180`)
- `HOMEGATE_PORT`: Host port for Homegate (default: `6288`)
- `HOMEGATE_POSTGRES_PORT`: Host port for Homegate PostgreSQL (default: `23433`)
- `HOMEGATE_ADMIN_MOCK_PASSWORD`: Admin password expected by the local Homegate admin API mock (default: `admin`; keep this in sync with [homegate-config.toml](homegate-config.toml))
- `HOMEGATE_ADMIN_MOCK_PUBKY`: Homeserver public key returned by the local Homegate admin API mock

### Volumes

- `./lnd:/lnd-certs:ro` - LND certificates and macaroons
- `./lnurl-server/data:/data` - LNURL server database
- `./lnurl-server/keys:/app/keys:ro` - RSA keys for JWT signing
- `bitcoin_home` - Bitcoin blockchain data
- `postgres_data` - VSS PostgreSQL database
- `homegate_postgres_data` - Homegate PostgreSQL database
- `homegate_data` - Homegate local state, including the generated phone-number pepper

### VSS Server Setup

**RSA Key Generation:**

```bash
# Generate RSA keys for JWT
openssl genrsa -out private.pem 2048
openssl rsa -in private.pem -pubout -out public.pem

# Copy keys for services
mv private.pem public.pem lnurl-server/keys/

# Update VSS_JWT_PUBLIC_KEY env variable in docker-compose.yml
```

**Database Setup:**

- PostgreSQL container with `postgres` database
- Table schemas: `https://github.com/lightningdevkit/vss-server/tree/main/rust/impls/src/postgres/sql`
- Auto-mounted from `sql/v0_create_vss_db.sql`

**Docker Setup:**

```bash
# Clean slate
docker compose down -v
rm -rf ./lnd ./lnurl-server/data
# run in lnurl-auth-server root dir:
rm -rf ./data ./test-data

# Optional: Rotate keys
# rm -rf lnurl-server/keys/ private.pem public.pem
# Then Generate new RSA keys (see above)

# Initialize submodules:
git submodule update --init --recursive

# Start services
docker compose up --build -d
```

## Troubleshooting

### Services not starting

1. Check if ports are available
2. Ensure Docker has enough resources
3. Check logs: `docker compose logs`

### LNURL server not connecting to LND

1. Wait for LND to fully sync
2. Check macaroon files exist
3. Verify network connectivity between containers

### Homegate exits immediately

1. Check logs: `docker compose logs homegate homegate-admin-mock`
2. Verify [homegate-config.toml](homegate-config.toml) is mounted and points `[homeserver].admin_api_url` at a reachable admin API
3. Confirm the configured homeserver admin API responds to `/info`; Homegate stops during startup if that check fails

### Bitcoin RPC issues

1. Ensure Bitcoin Core is fully synced
2. Check RPC authentication credentials
3. Verify port mappings

### Nuke databases

1. Run `docker compose down -v`
2. Delete databases: `rm -rf ./lnd ./lnurl-server/data`
3. Delete RSA keys: `rm -rf ./lnurl-server/keys ./public.pem`
4. Delete lnurl-auth-server db: cd to its root dir then run `rm -rf ./data ./test-data`

### LNURL issues

1. Check latest logs snapshot: `docker logs lnurl-server --tail 10`
2. Check live logs: `docker compose logs -f lnurl-server`
3. Check LND wallet balance:

```sh
curl -s http://localhost:23000/health | jq '.lnd.balance'
```

## Security Notes

- This setup uses **regtest** network for development
- Self-signed certificates are used for LND REST API
- Default credentials are used
- All services are exposed on localhost only

## Production Considerations

Do not use for production. Bitkit Dev server is vibe-coded and not optimised.

## License

This project is licensed under the MIT License.
See the [LICENSE](./LICENSE) file for more details.
