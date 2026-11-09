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

Faucet contract, as the E2E scripts call it. With `FAUCET_AUTH` set (`init.sh` generates it), `deposit` and `mine` need that HTTP basic auth. An open `mine` endpoint is what flooded stag0's chain.

- `POST /regtest/chain/deposit {"address": "bcrt1…", "amountSat": 50000}` returns the txid as plain text. `amountSat` defaults to 100,000 and is capped by `FAUCET_MAX_SAT`.
- `POST /regtest/chain/mine {"count": 6}` returns the block hashes. `count` defaults to 1 and is capped by `FAUCET_MAX_BLOCKS`.
- `GET /health` returns the tip height and the faucet's balance. On a fresh chain the faucet mines 101 blocks to fund itself; mined blocks pay the faucet.

## What Bitkit calls on stag0 today

Default branches of bitkit-android, bitkit-ios, bitkit-core, bitkit-e2e-tests and bitkit-docker, including CI workflows. None of these repositories has Actions variables, and no secret name in bitkit-android, bitkit-ios or bitkit-e2e-tests suggests a URL. Secret values and bitkit-core's secrets are not covered.

| stag0 endpoint | Called from | Serves | After the sunset | New staging |
| --- | --- | --- | --- | --- |
| `bitkit.stag0…/vss_rs_auth` | android `Env.vssServerUrl`, ios `Env.vssServerUrl` | VSS | must stay | `/vss_rs_auth` |
| `bitkit.stag0…/lnurl_auth/auth` | android and ios `lnurlAuthServerUrl` | LNURL-auth for VSS | must stay | `/lnurl_auth/auth` |
| `bitkit.stag0…/fx/rates/btc` | android and ios `btcRatesServer` (regtest, testnet, signet) | fx rates | stays (production FX stays) | `/fx/rates/btc` |
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

Phase 1 needs none of these: the stag0 names point at the new stack. Phase 2 changes them to the new names.

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

A wallet's VSS identity comes from the LNURL-auth host: the app derives its linking key from the domain in the LNURL. Existing staging wallets keep their backups only when the auth host keeps its name and the VSS data is copied. So the move has two phases.

Phase 1, DevOps, no app release:

1. Deploy the stack below on a new host, with `STAGING_HOST=bitkit.stag0.blocktank.to`, `MEMPOOL_HOST=mempool.bitkit.stag0.blocktank.to` and `ELECTRUM_HOST=electrs.bitkit.stag0.blocktank.to`.
2. Copy stag0's data in, with stag0 stopped for writes:
   - VSS: dump stag0's `vss_db` table and restore it into `vss-db`.
   - Chain: a fresh chain is the clean start, but it wipes every staging on-chain balance. stag0's chain has grown by about 30k junk blocks a day since an open `mine` call on 7 Nov. To keep balances anyway, copy stag0 bitcoind's regtest `blocks` and `chainstate` into the `bitcoin` volume. stag0's bitcoind must not be newer than the stack's (26.0), or the copy may not open. Electrs reindexes on start.
   - Faucet funds: regtest block rewards reach zero near height 4950, so on a copied chain past that, mining no longer funds the faucet. Move a large balance from stag0's faucet wallet to the new faucet (`GET /health` after start, then send to a `getnewaddress` of its `faucet` wallet), or copy that wallet in and set `FAUCET_WALLET` to its name.
   - RN backups: copy stag0's backup server storage into the `ldk-backup` volume, and put stag0's backup server key pair in `.env`.
3. Point those three names at the new host and run the smoke checks.
4. The E2E faucet calls go to `api.stag0.blocktank.to/blocktank/api/v2/regtest/chain/*`: route that path to the new host's same path, or set the E2E `BLOCKTANK_URL` defaults to `https://bitkit.stag0.blocktank.to` now. The rest of `api.stag0` (LSP, RGS, scorer) retires with Blocktank.

Phase 2, when the `blocktank.to` names go:

1. Set the new names in `.env` and add the stag0 names to their site blocks in `staging/Caddyfile`, so both name sets work for a while.
2. Ship the settings above in the apps and tests. Staging wallets start with fresh VSS identities on the new auth host. If the released RN app used by the migration E2E has its staging hosts built in, keep `/backups-ldk` and Electrum on the old names until the migration tests stop using it.
3. Retire the stag0 names.

## Deploy

Needs Docker with Compose, ports 80, 443 and 9999 open, and DNS records for the three hosts.

```bash
git clone --recurse-submodules https://github.com/synonymdev/bitkit-docker.git
git clone https://github.com/synonymdev/lnurl-auth-server.git   # private, read access needed
cd bitkit-docker/staging
./init.sh                 # .env with fresh passwords and keys, JWT key pair in secrets/
$EDITOR .env              # STAGING_HOST, MEMPOOL_HOST, ELECTRUM_HOST, ACME_EMAIL
docker compose up -d --build
```

- `--recurse-submodules` fetches `homegate` over SSH too. Without access to it, run `git submodule update --init vss-server` instead.
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

With `FAUCET_AUTH` empty, the E2E scripts work unchanged against it: `BLOCKTANK_URL=$H ./scripts/fund-address.sh bcrt1… 50000` and `BLOCKTANK_URL=$H ./scripts/mine-blocks.sh 6`. With it set, add `-u "$FAUCET_AUTH"` to the faucet `curl` calls.

## Operate

- Blocks: the faucet mines only on request. The nightly `regtest-mine.yml` in bitkit-e2e-tests keeps the chain moving once it points here.
- Faucet funds: regtest block rewards halve every 150 blocks and reach zero near height 4950. Below that, mine a batch when `GET /health` shows a low balance. Above it, the faucet lives on what it holds.
- Upgrades: images are pinned in `staging/compose.yml`. Bump one, then `docker compose up -d --build`.
- Logs: `docker compose logs -f <service>`.
