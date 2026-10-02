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
- **Payment Request fixture** (opt-in `payment-requests` profile): rc56 issuer and controlled peer on the marketplace Pubky testnet

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
   curl http://localhost:3000/health
   curl http://localhost:6288/
   ```

## Services Overview

### Bitcoin Core

- **Port**: 43782 (RPC), 39388 (P2P)
- **Network**: Regtest
- **Wallet**: Auto-created
- **Authentication**: `polaruser`/`polarpass`

### LND (Lightning Network Daemon)

- **REST API**: `http://localhost:8080`
- **P2P**: `localhost:9735`
- **RPC**: `localhost:10009`
- **Network**: Regtest
- **Features**: Zero-conf, SCID alias, AMP support

### LNURL Server

- **Port**: 3000
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

### VSS Server

- **Port**: 5050 (`127.0.0.1:5050` from the `vss` profile)
- **Features**: RS256 JWT authentication
- **Profile**: `docker compose --profile vss up -d vss-postgres vss` starts the server and its own database without the rest of the stack or the LNURL auth server. The server checks tokens with `lnurl-server/keys/public.pem`. The default `vss-server` service is unchanged.

### Homegate

- **Port**: 6288
- **Database**: Dedicated `homegate-postgres` service, exposed on host port 5433 by default
- **Admin mock**: `homegate-admin-mock`, available only inside the Compose network and password-protected by default
- **Features**:
  - Pubky Homeserver signup-code gatekeeping
  - IP verification enabled by default for local testing
  - SMS and Lightning verification disabled by default unless provider-backed config is added

### LNURL-Auth Server

- **Port**: 5005
- **Features**: Issuing RS256 JWT via LNURL-Auth protocol expected by VSS
- **Endpoints**:
  - `/health` - Service health check
  - `/auth` - LNURL-auth endpoint

### Electrum Server

- **Port**: 60001
- **Network**: Regtest
- **Features**: Full blockchain indexing

## API Examples



```bash
# Health Check
curl http://localhost:3000/health | jq

# Generate LNURL-withdraw
curl -s http://localhost:3000/generate/withdraw | jq

# Generate LNURL-pay
curl -s http://localhost:3000/generate/pay | jq

# Lightning Address
curl -s http://localhost:3000/.well-known/lnurlp/alice | jq

# VSS Health Check
curl -v http://localhost:5050/vss/getObject

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

#### Payment Requests and rc56 Deadline History

The `payment-requests` profile starts two disposable Paykit rc56 SDK peers on
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
for port in 3012 3013; do
  until health=$(curl -fsS "http://127.0.0.1:$port/health"); do sleep 2; done
  jq <<<"$health"
done
```

The peers sign up on the testnet and publish their endpoints before they listen,
so `/health` fails for a few seconds after `up`. The loop waits for them, and
`payment-requests/prepare` does the same for up to 150 seconds. A peer retries
its setup for two minutes and then exits; if the loop does not end, stop it and
read `docker compose --profile marketplace --profile payment-requests logs fixture-issuer rc56-peer`.

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

Example one-time issuance to a linked app after both sides report `Linked`:

```bash
APP_PUBKY=pubky... # replace with the disposable app identity
curl -fsS -X POST http://127.0.0.1:3012/request -H 'content-type: application/json' \
  -d "$(jq -nc --arg pubky "$APP_PUBKY" '{peer_pubky:$pubky,peer_path:"bitkit/wallet",amount_sats:15000,reference:"rc56-app-history"}')" | jq
```

These peers keep their identities and SDK records in memory and live in the
Pubky testnet's network namespace, so `./pubky-marketplace down` and `reset`
remove them together with the testnet. After `reset`, start them again with the
`up -d --no-build fixture-issuer rc56-peer` command above, wait for `/health`,
rerun `payment-requests/prepare` and relink the app. `./pubky-marketplace seed`
needs outbound internet for Paykit Server setup; the rc56 peer calls use the
local testnet. The lane still needs a Bitkit build pointed at the local Pubky
testnet and to verify the requested rows on device. The headless preparation
command does not populate a separate Bitkit identity's history; accepted and
paid app rows require the lane's controlled client to prepare those records
with the app's identity or an app build that supports importing fixture state.

#### Trezor Hardware PRs

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

- User Env dashboard: `http://localhost:9002`
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

- Android: build the local E2E backend with the same `E2E_HOMESERVER_PUBKY` in the environment. On each emulator run `adb reverse tcp:<port> tcp:<port>` for 6286, 6287, 15411 and 15412 (the homeserver admin port is published on 16288 and no app uses it); the Android journey README covers the emulator's `10.0.2.2` host address.
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

To make a Bitkit wallet the seller, the wallet approves two Pubky requests for the same identity: the Paykit watch-only setup (it gives Paykit Server the wallet's account xpub, so payouts land in that wallet) and a write grant on `/pub/locks.app/` (the role Locks plays: the driver publishes the payment lock with the granted session). One request cannot carry both, because the apps accept the watch-only claim only for exactly the two Paykit paths.

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

#### Bech32 LNURL Pay

- in `Env.{kt,swift}`, use for REGTEST electrum server: `"tcp://localhost:60001"`
- `adb reverse tcp:60001 tcp:60001 && adb reverse tcp:9735 tcp:9735`
- in app, wipe current wallet data and create fresh one
- run `docker compose up --build -d`
- fund onchain wallet: `./bitcoin-cli fund`
- send funds to in-app wallet address: `./bitcoin-cli send 0.25 -m`
- get local LND URI and open channel:
  - `curl -s http://localhost:3000/health | jq -r '.lnd.uris[0]' | pbcopy`
  - in app: send > paste > complete the flow
  - `./bitcoin-cli mine 3`
- generate LNURL pay: `http://localhost:3000/generate/pay`
- paste lnurl into app
- generate fixed amount LNURL pay (QuickPay): `curl -s 'http://localhost:3000/generate/pay?minSendable=10000&maxSendable=10000' | jq -r .lnurl | pbcopy`

#### Lightning Address

- `ngrok http 3000`
- change `DOMAIN` in `docker-compose.yml` to `__NGROK_URL__`
- `docker compose down` if running
- `docker compose up --build -d`
- `http://localhost:3000/.well-known/lnurlp/alice`
- copy the email-like lightning address and paste into app

#### LNURL-Channel

- (optional) use physical phone so localhost is usable via `adb reverse`
- (optional) reset `bitkit-docker` state
  - `docker compose down -v`
  - `rm -rf ./lnd ./lnurl-server/data`
  - `docker compose up --build -d`
- `adb reverse tcp:60001 tcp:60001 && adb reverse tcp:9735 tcp:9735`
- fund onchain wallet: `./bitcoin-cli fund`
- fund LND wallet:
  - `./bitcoin-cli send 0.2 "$(curl -s http://localhost:3000/health | jq -r '.lnd.address')" -m`
  - check balance: `curl -s http://localhost:3000/health | jq '.lnd.balance'`
- generate LNURL channel: `http://localhost:3000/generate/channel`
- paste lnurl into app and complete the flow
- mine blocks: `./bitcoin-cli mine 6`

#### LNURL-Withdraw
- setup a channel (see above)
- generate LNURL: `curl -s http://localhost:3000/generate/withdraw | jq -r .lnurl | pbcopy`
- set an amount of at least ₿5000 & complete the flow
- generate LNURL with limits: `curl -s "http://localhost:3000/generate/withdraw?minWithdrawable=100000&maxWithdrawable=200000" | jq -r .lnurl | pbcopy`
  - `minWithdrawable` (optional): min msats (default: 1000 = 1 sat)
  - `maxWithdrawable` (optional): max msats (default: 100000000 = 100k sats)

#### LNURL-Auth

- set DOMAIN in `docker-compose.yml` to `http://__YOUR_NETWORK_IP__:3000`
- run `docker compose down`
- run `docker compose up --build -d`
- generate LNURL auth: `http://localhost:3000/generate/auth`
- paste lnurl into app and complete the flow

#### LDK-NODE with JWT auth to VSS

- `adb reverse tcp:3000 tcp:3000 && adb reverse tcp:5050 tcp:5050`
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
- `adb reverse tcp:60001 tcp:60001 && adb reverse tcp:9735 tcp:9735`
- fund onchain wallet: `./bitcoin-cli fund`
- fund LND wallet:
  - `./bitcoin-cli send 0.2 "$(curl -s http://localhost:3000/health | jq -r '.lnd.address')" -m`
  - check balance: `curl -s http://localhost:3000/health | jq '.lnd.balance'`
- fund app wallet: `./bitcoin-cli send 0.002 -m`
- `curl -s http://localhost:3000/health | jq -r '.lnd.uris[0]' | pbcopy`
- in app: send > paste > complete flow for 100_000 sats > return to home screen
- mine blocks: `./bitcoin-cli mine 6`
- await channel ready notice

## Configuration

### Environment Variables

Key environment variables in `docker-compose.yml`:

- `BITCOIN_RPC_HOST`: Bitcoin RPC host (default: `bitcoind`)
- `BITCOIN_RPC_PORT`: Bitcoin RPC port (default: `43782`)
- `LND_REST_HOST`: LND REST API host (default: `lnd`)
- `LND_REST_PORT`: LND REST API port (default: `8080`)
- `HOMEGATE_PORT`: Host port for Homegate (default: `6288`)
- `HOMEGATE_POSTGRES_PORT`: Host port for Homegate PostgreSQL (default: `5433`)
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
curl -s http://localhost:3000/health | jq '.lnd.balance'
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
