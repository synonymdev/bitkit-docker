# Shop on staging with our own Paykit Server

The `shop-mixed` profile (`./shop-mixed`) is the second Shop route for Bitkit tests. The first is Synonym's staging Shop
(`shop.staging.pubky.app`) as it is deployed; this one replaces only its Paykit Server and marketplace with ours, so a test can run a
Paykit Server version the staging Shop does not. The README section "Shop on Staging with Our Own Paykit Server" has the commands.

## What runs where

| Piece | Where | Pin |
| --- | --- | --- |
| Paykit Server | `shop-mixed-paykit`, built from the release tag by `marketplace/shop-mixed/paykit-server.Dockerfile` | `v0.1.0-rc11` = `662dca06`, paykit-rs `ad3c7224` (v0.1.0-rc72), locks-core v0.1.0-rc9, Pubky 0.15.0 |
| Its database | `shop-mixed-postgres` | `postgres:16-alpine` |
| Public URL | `shop-mixed-tunnel`, a Cloudflare quick tunnel to `shop-mixed-paykit:3001` | cloudflared 2026.9.3 |
| Marketplace (Locks and the trusted issuer) | `shop-mixed-driver`, `marketplace/driver/driver.mjs` with `MARKETPLACE_BACKEND=staging` | `@synonymdev/pubky` 0.14.0 |
| Homeserver, HTTP relay | Synonym's staging: `homeserver.staging.pubky.app` (`ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy`), `httprelay.staging.pubky.app` | staging |
| Chain | Blocktank's staging regtest: Electrum `ssl://electrs.bitkit.stag0.blocktank.to:9999`, mining through `api.stag0.blocktank.to/blocktank/api/v2/regtest/chain/mine` | staging |

The homeserver key and Electrum endpoint are the staging constants of bitkit-android `Env.kt` and bitkit-ios `Env.swift`, so a
staging Bitkit build and this Paykit Server see the same identities and the same chain. Paykit Server resolves Pubky on mainnet
(`[paykit] network = "mainnet"`), where the staging homeserver is published, and uses `bitcoin.network = "regtest"`, which makes its
Android setup link open `to.bitkit.dev`.

## Pins

The Paykit Server image is built from `git clone --branch v0.1.0-rc11`, and the build fails when the tag is not at
`SHOP_MIXED_PAYKIT_SERVER_REV` or its `Cargo.lock` does not lock paykit-rs at `SHOP_MIXED_PAYKIT_RS_REV`. The image labels
(`tech.masivo.paykit-server`, `tech.masivo.paykit-server-tag`, `tech.masivo.paykit-rs`, `org.opencontainers.image.revision`) name what
it was built from; `./shop-mixed health` prints them. Move the three `SHOP_MIXED_*` defaults in `docker-compose.yml` together.

## Config

`shop-mixed-driver init` (run by the driver service, which then stays up; Paykit Server waits for its files) writes the issuer key,
the master key and the Paykit Server config into the `shop_mixed_state` volume. The config trusts the driver's issuer key under
`[signed_services]`, accepts the setup page from any origin (`allowed_origins = ["*"]`, the page is opened through the tunnel), and
counts one proxy hop (`trusted_proxy_hops = 1`, Cloudflare's `X-Forwarded-For`).

## Limits

- Bitkit wallets are the seller and the buyer. The headless roles need the local testnet and bitcoind, so `seed`, `fund`, `receive`,
  `pay`, `peers`, `verify` and `verify-bitkit-seller` refuse.
- The quick tunnel gets a new hostname at every start and carries no uptime guarantee; read it with `./shop-mixed url`.
- A staging identity needs a staging invite code at signup, as for any staging test.
