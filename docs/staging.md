# Bitkit staging

A public regtest backend for Bitkit's staging builds and E2E runs with no Blocktank part. It replaces Blocktank's staging (`*.stag0.blocktank.to`), which Bitkit still depends on for wallet backups, sign-in, the regtest chain and test funding, and which goes with the Blocktank sunset.

Spark is not hosted here: staging builds and CI use Lightspark's hosted regtest for Spark, and a local Spark stack is a separate bitkit-docker profile.

## What runs

`staging/compose.yml` (project `bitkit-staging`) runs everything behind one Caddy, which publishes ports 80, 443 and 9999 and gets the certificates. It keeps stag0's paths, so moving an app or test is a host swap.

| Endpoint | Serves | Service |
| --- | --- | --- |
| `https://<staging-host>/vss_rs_auth` | VSS wallet backups | `vss` + `vss-db` (the pinned `vss-server` submodule) |
| `https://<staging-host>/lnurl_auth/auth` | LNURL-auth that issues VSS's JWTs | `lnurl-auth` (synonymdev/lnurl-auth-server) |
| `https://<staging-host>/fx/rates/btc` | BTC fiat rates | relayed from `FX_UPSTREAM_ORIGIN` + `FX_UPSTREAM_PATH` |
| `https://<staging-host>/backups-ldk` | RN app backups for the RN-to-native migration | `ldk-backup` |
| `https://<staging-host>/electrs` | Esplora REST of the chain | `electrs` |
| `https://<staging-host>/regtest/chain/deposit`, `/regtest/chain/mine` (also under `/blocktank/api/v2`) | Faucet and miner with Blocktank's request and response shape | `faucet` |
| `https://<mempool-host>` | Explorer; `/api/v1/*` is mempool's backend, the rest of `/api/*` is Esplora | `mempool-web`, `mempool-api`, `mempool-db` |
| `ssl://<electrum-host>:9999` | Electrum | `electrs` (mempool's electrs fork) through Caddy's TLS |
| — | Regtest chain | `bitcoind` (RPC stays on the compose network) |

Faucet contract, as the E2E scripts call it. `deposit` and `mine` need `FAUCET_AUTH` as HTTP basic auth: `init.sh` generates it, callers keep it as a CI secret, and the faucet refuses to start without it. Each client gets `FAUCET_RATE_PER_MIN` calls a minute (default 20, then `429`), on top of the per-call caps below. stag0's open `mine` endpoint is what stalled its chain, Electrum and VSS.

- `POST /regtest/chain/deposit {"address": "bcrt1…", "amountSat": 50000}` returns the txid as plain text. `amountSat` defaults to 100,000 and is capped by `FAUCET_MAX_SAT`.
- `POST /regtest/chain/mine {"count": 6}` returns the block hashes. `count` defaults to 1 and is capped by `FAUCET_MAX_BLOCKS`.
- `GET /health` returns the tip height and the faucet's balance. On a fresh chain the faucet mines 101 blocks to fund itself; mined blocks pay the faucet.

## What Bitkit calls on stag0 today

Default branches of bitkit-android, bitkit-ios, bitkit-core, bitkit-e2e-tests and bitkit-docker, including CI workflows. None of these repositories has Actions variables, and no secret name in bitkit-android, bitkit-ios or bitkit-e2e-tests suggests a URL. Secret values and bitkit-core's secrets are not covered.

| stag0 endpoint | Called from | Serves | After the sunset | New staging |
| --- | --- | --- | --- | --- |
| `bitkit.stag0…/vss_rs_auth` | android `Env.vssServerUrl`, ios `Env.vssServerUrl` | VSS | must stay | `/vss_rs_auth` |
| `bitkit.stag0…/lnurl_auth/auth` | android and ios `lnurlAuthServerUrl` | LNURL-auth for VSS | must stay | `/lnurl_auth/auth` |
| `bitkit.stag0…/fx/rates/btc` | android and ios `btcRatesServer` (regtest, testnet, signet) | fx rates | stays (production FX stays) | `/fx/rates/btc`, relayed read-only from production's FX feed (`FX_UPSTREAM_ORIGIN`) |
| `ssl://electrs.bitkit.stag0…:9999` | android `ElectrumServers.REGTEST.STAG`, ios `electrumServerUrl`; e2e `ELECTRUM_HOST` default and seedkit; bitkit-core onchain tests; android `scripts/electrum-bridge.py` and journeys; bitkit-docker marketplace driver and docs | Electrum | must stay | `ssl://<electrum-host>:9999` |
| `ssl://fulcrum.bitkit.stag0…:18484` | bitkit-core onchain tests | Electrum (Fulcrum) | must stay | `ssl://<electrum-host>:9999` |
| `mempool.bitkit.stag0…` | android and ios `blockExplorerUrl`; e2e `regtest-mine.yml` tip check | explorer, chain API | must stay | `https://<mempool-host>` |
| `bitkit.stag0…/electrs` | nothing on default branches; the Spark chain service reads `bitkit.to/electrs` on mainnet | Esplora REST | must stay | `/electrs` |
| `api.stag0…/blocktank/api/v2/regtest/chain/deposit`, `…/mine` | e2e `fund-address.sh`, `mine-blocks.sh`, `test/helpers` (`BLOCKTANK_URL`), `regtest-mine.yml`, seedkit; bitkit-docker marketplace driver, shop-mixed docs | regtest faucet and miner | must stay | `/regtest/chain/*` |
| `bitkit.stag0…/backups-ldk` | android and ios `rnBackupServerHost`; e2e migration (the RN app's own staging build) | RN backups | stays while the RN migration is supported | `/backups-ldk` |
| `api.stag0…/blocktank/api/v2/regtest/channel/pay` | e2e `payInvoice`, `pay-lightning-address.sh` | Blocktank LSP's Lightning node | goes | not hosted; Lightning tests move to Spark on Lightspark's regtest |
| `api.stag0…/blocktank/api/v2` (orders, info, push and wake registration) | android and ios `blocktankApiUrl`; android's `.claude` blocktank-api plugin | Blocktank LSP | goes | not hosted. Fee rates come from Blocktank `info` today; mempool's `/api/v1/fees/recommended` is here if the apps move to it |
| `bitkit.stag0…/rgs/snapshot` | android and ios `ldkRgsServerUrl` | LDK rapid gossip sync | goes with LDK | not hosted |
| `api.stag0…/scorer` | android and ios `ldkScorerUrl` | LDK scorer | goes with LDK | not hosted |
| `api.stag.blocktank.to/blocktank/api/v2` | bitkit-core blocktank tests | Blocktank LSP | goes | not hosted |

The Blocktank-only tests are already being removed in synonymdev/bitkit-ios#1246, synonymdev/bitkit-android#1817 and synonymdev/bitkit-e2e-tests#302 (merged).

### Two regtest chains

Spark on Lightspark's hosted regtest uses Lightspark's chain, while the apps' on-chain wallet reads this staging's chain. On regtest builds the Spark drafts keep the SDK's default chain service and only move the on-chain wallet onto Spark's chain when `ESPLORA_URL` is set. Spark deposits, exits and Transfer to Savings therefore land on a chain this staging does not see. Which chain staging builds use for on-chain is still an open call.

## Settings to change

Every caller moves to the new names; nothing keeps a stag0 name.

| Repository | Setting | Value |
| --- | --- | --- |
| bitkit-android | `Env.vssServerUrl`, `lnurlAuthServerUrl`, `btcRatesServer`, `rnBackupServerHost` (non-mainnet) | `https://<staging-host>/vss_rs_auth`, `/lnurl_auth/auth`, `/fx/rates/btc`, `/backups-ldk` |
| bitkit-android | `ElectrumServers.REGTEST.STAG`, `blockExplorerUrl` (regtest) | `ssl://<electrum-host>:9999`, `https://<mempool-host>/` |
| bitkit-android | `ldkRgsServerUrl`, `ldkScorerUrl`, `blocktankApiUrl` (regtest) | none (drop with LDK and Blocktank) |
| bitkit-ios | the same `Env` values | as above |
| bitkit-e2e-tests | `BLOCKTANK_URL` default (`test/helpers/constants.ts`, `scripts/*.sh`, seedkit), `regtest-mine.yml` inputs | `https://<staging-host>` |
| bitkit-e2e-tests, bitkit-android, bitkit-ios | faucet callers (deposit, mine, the nightly miner) | send `FAUCET_AUTH` as basic auth, from a repository secret |
| bitkit-e2e-tests | `ELECTRUM_HOST` default, seedkit Electrum, `MEMPOOL_SERVER` | `<electrum-host>`, `https://<mempool-host>` |
| bitkit-core | onchain test Electrum URLs | `ssl://<electrum-host>:9999` |
| bitkit-docker | marketplace driver `MARKETPLACE_ELECTRUM` default and regtest URL, docs | `ssl://<electrum-host>:9999`, `https://<staging-host>/regtest` |

## Migration checklist

The new staging is a fresh build: nothing comes from stag0, neither images, configs nor data. It gets new hostnames off `blocktank.to`, new credentials, and auth on every write endpoint. stag0 may have been compromised, so none of its state is reused.

1. DevOps: pick the three hostnames, deploy the stack below and run the smoke checks.
2. DevOps: share `FAUCET_AUTH` with the Bitkit team for the repository secrets.
3. Bitkit: ship the settings above in the apps, tests and tools, with the faucet callers sending `FAUCET_AUTH`.
4. Staging wallets start fresh: a new chain, so no stag0 balances, and new VSS identities. The app derives its LNURL-auth linking key from the auth host, so wallets restored on the new host find no stag0 backups. Fund test wallets again from the faucet.
5. Migration E2E: the released RN app it installs may have stag0's hosts built in. Re-create its fixtures against the new staging, or keep those tests off until they can.
6. Retire `*.stag0.blocktank.to` once no caller uses it.

## Deploy

Needs Docker with Compose, ports 80, 443 and 9999 open, and DNS records for the three hosts.

```bash
git clone https://github.com/synonymdev/bitkit-docker.git
git clone https://github.com/synonymdev/lnurl-auth-server.git   # private; staging builds it from this sibling checkout
cd bitkit-docker
git submodule update --init vss-server
cd staging
./init.sh                 # .env with fresh passwords and keys, JWT key pair in secrets/
$EDITOR .env              # STAGING_HOST, MEMPOOL_HOST, ELECTRUM_HOST, ACME_EMAIL
docker compose up -d --build
```

- Staging needs only the `vss-server` submodule. `LNURL_AUTH_SERVER_SRC` in `.env` points at another lnurl-auth-server checkout if it doesn't sit beside bitkit-docker.
- `init.sh` never overwrites a value or key, so it is safe to rerun. Keep `.env` and `secrets/` out of the repository and back them up with the volumes.
- Only Caddy publishes ports. With an ingress of your own, drop `caddy` and route the paths in `staging/Caddyfile` to the same services. Electrum is plain TCP on `electrs:60001`, so it needs a TLS stream in front.
- Data lives in the named volumes `bitcoin`, `electrs`, `mempool-db`, `vss-db`, `lnurl-auth`, `ldk-backup` and `caddy-data`. Back up `vss-db` and `ldk-backup`. The chain can be rebuilt, and electrs and mempool reindex.

## Smoke checks

```bash
H=https://<staging-host>
curl -s $H/health                                                              # {"height":…,"balanceSat":…}
curl -s -u "$FAUCET_AUTH" -X POST $H/regtest/chain/deposit -H 'Content-Type: application/json' -d '{"address":"bcrt1…"}'   # txid
curl -s -u "$FAUCET_AUTH" -X POST $H/regtest/chain/mine -H 'Content-Type: application/json' -d '{"count":1}'
curl -s https://<mempool-host>/api/blocks/tip/height
curl -s $H/electrs/blocks/tip/hash
curl -s $H/fx/rates/btc | head -c 100
curl -s $H/lnurl_auth/auth                                                     # an LNURL-auth URL on $H/lnurl_auth
openssl s_client -connect <electrum-host>:9999 -servername <electrum-host> </dev/null 2>/dev/null | head -1
```

The E2E scripts need only the new `BLOCKTANK_URL` and `-u "$FAUCET_AUTH"` on their faucet `curl` calls (`fund-address.sh`, `mine-blocks.sh`); `test/helpers/regtest.ts` sends the same credentials as an `Authorization: Basic` header.

## Operate

- Blocks: the faucet mines only on request. The nightly `regtest-mine.yml` in bitkit-e2e-tests keeps the chain moving once it points here.
- Faucet funds: regtest block rewards halve every 150 blocks and reach zero near height 4950. Mine a batch while `GET /health` shows a low balance and the chain is below that.
- Credentials: rotate `FAUCET_AUTH` by editing `.env` and `docker compose up -d faucet`, then update the callers' secret.
- Upgrades: images are pinned in `staging/compose.yml`. Bump one, then `docker compose up -d --build`.
- Logs: `docker compose logs -f <service>`.
