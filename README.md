# Bitkit Docker - Bitcoin & Lightning Development Environment

A complete Docker-based development environment for Bitcoin and Lightning Network development, featuring a LNURL server for Lightning payments.

## Services

- **Bitcoin Core** (regtest): Bitcoin node for development
- **LND**: Lightning Network Daemon for Lightning payments
- **Electrum Server**: For Bitcoin blockchain queries
- **LNURL Server**: Lightning payment server with LNURL support
- **LDK Backup Server**: Lightning Development Kit backup service
- **VSS Server**: Versioned Storage Server for app and ldk-node state backups

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
  - `/.well-known/lnurlp/:username` - Lightning Address

### VSS Server

- **Port**: 5050
- **Features**: RS256 JWT authentication

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
```

## Development

### Adding Blocks (for testing)

```bash
./bitcoin-cli mine 1
```

### LND CLI

```bash
docker compose exec lnd lncli --network=regtest --tlscertpath=/home/lnd/.lnd/tls.cert --macaroonpath=/home/lnd/.lnd/data/chain/bitcoin/regtest/admin.macaroon getinfo
```

### View Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f lnurl-server
docker compose logs -f vss-server
docker compose logs -f lnd
docker compose logs -f bitcoind
```

### Bitkit Testing

#### Bech32 LNURL Pay

- in `Env.{kt,swift}`, use for REGTEST electrum server: `"tcp://localhost:60001"`
- in app, wipe current wallet data and create fresh one
- run `docker compose up --build -d`
- mine blocks: `./bitcoin-cli mine 101`
- fund onchain wallet: `./bitcoin-cli fund`
- send funds to the app's wallet address: `./bitcoin-cli send 0.25`
- mine block: `./bitcoin-cli mine 1`
- get local LND nodeID and open channel
  - `http://localhost:3000/health`
  - `curl -s http://localhost:3000/health | jq -r .lnd.uris`
  - `android` copy, replace `127.0.0.1` with `__YOUR_NETWORK_IP__` and paste into app, then complete the flow
  - `./bitcoin-cli mine 3`
- generate LNURL pay: `http://localhost:3000/generate/pay`
- paste lnurl into app
- generate fixed amount LNURL pay (QuickPay): `http://localhost:3000/generate/pay?minSendable=10000&maxSendable=10000`

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
- `adb reverse tcp:60001 tcp:60001`
- `adb reverse tcp:9735 tcp:9735`
- mine 101 blocks: `./bitcoin-cli fund`
- fund LND wallet:
  - get address: `curl -s http://localhost:3000/address | jq `-r .address``
  - fund LND wallet: `./bitcoin-cli send 0.2`
  - mine block `./bitcoin-cli mine 1`
  - check balance: `curl -s http://localhost:3000/balance | jq`
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

- checkout [bitkit-docker](https://github.com/ovitrif/bitkit-docker) repo
- set DOMAIN in `docker-compose.yml` to `http://__YOUR_NETWORK_IP__:3000`
- run `docker compose down`
- run `docker compose up --build -d`
- generate LNURL auth: `http://localhost:3000/generate/auth`
- paste lnurl into app and complete the flow

#### LDK-NODE with JWT auth to VSS

- `adb reverse tcp:3000 tcp:3000`
- `adb reverse tcp:5050 tcp:5050`
- checkout latest [bitkit-docker](https://github.com/ovitrif/bitkit-docker)
  - cd to its root dir
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
- `adb reverse tcp:60001 tcp:60001`
- `adb reverse tcp:9735 tcp:9735`
- mine 101 blocks: `./bitcoin-cli fund`
- fund LND wallet:
  - get address: `curl -s http://localhost:3000/address | jq -r .address`
  - fund LND wallet: `./bitcoin-cli send 0.2`
  - mine block `./bitcoin-cli mine 1`
  - check balance: `curl -s http://localhost:3000/health | jq '.lnd.balance'`
- fund app wallet: `./bitcoin-cli send 0.002`
- mine block `./bitcoin-cli mine 1`
- `curl -s http://localhost:3000/health | jq -r '.lnd.uris[0]'` and copy to clipboard
- send > paste invoice > complete flow for 100_000 sats > return to home screen
- mine blocks: `./bitcoin-cli mine 6`
- await channel ready notice

## Configuration

### Environment Variables

Key environment variables in `docker-compose.yml`:

- `BITCOIN_RPC_HOST`: Bitcoin RPC host (default: `bitcoind`)
- `BITCOIN_RPC_PORT`: Bitcoin RPC port (default: `43782`)
- `LND_REST_HOST`: LND REST API host (default: `lnd`)
- `LND_REST_PORT`: LND REST API port (default: `8080`)

### Volumes

- `./lnd:/lnd-certs:ro` - LND certificates and macaroons
- `./lnurl-server/data:/data` - LNURL server database
- `./lnurl-server/keys:/app/keys:ro` - RSA keys for JWT signing
- `bitcoin_home` - Bitcoin blockchain data
- `postgres_data` - VSS PostgreSQL database

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

# Initialize vss-server submodule:
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
curl -s http://localhost:3000/balance | jq
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
