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

- **Port**: 5050
- **Features**: RS256 JWT authentication

### Homegate

- **Port**: 6288
- **Database**: Dedicated `homegate-postgres` service, exposed on host port 5433 by default
- **Admin mock**: `homegate-admin-mock` on port 6289
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
- `HOMEGATE_ADMIN_MOCK_PORT`: Host port for the local Homegate admin API mock (default: `6289`)
- `HOMEGATE_ADMIN_MOCK_PASSWORD`: Admin password expected by the local Homegate admin API mock (default: `admin`)
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
