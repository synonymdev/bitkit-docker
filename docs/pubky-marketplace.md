# Pubky marketplace fixture

Integration fixture for the Bitkit marketplace wallet journey (`journeys/pubky-marketplace` in
bitkit-ios and bitkit-android, tracked by [bitkit-ios#794](https://github.com/synonymdev/bitkit-ios/pull/794)
and [bitkit-android#1338](https://github.com/synonymdev/bitkit-android/pull/1338)). The README section
"Pubky Marketplace Journey" has the commands; this page has what is behind them.

## What runs

| Piece | Where | Pin |
| --- | --- | --- |
| Regtest bitcoind and Electrum on `tcp://127.0.0.1:60001` | the stack's `bitcoind` and `electrs` | as in `docker-compose.yml` |
| Pubky Core static testnet: DHT, PKARR relay, HTTP relay, one homeserver with open signup | `pubky-testnet`, built from `marketplace/pubky-testnet/Dockerfile` | pubky-core `f68014c1` |
| Homeserver and Paykit databases | `marketplace-postgres` | `postgres:16-alpine` |
| Paykit Server | `paykit-server`, built from source with the upstream `Dockerfile.local` | pubky/paykit-server `722ef268` (v0.1.0-rc4), paykit-rs `9b56a0ea` (v0.1.0-rc48), locks-core `8502ef79` (v0.1.0-rc1) |
| Purchase driver | `marketplace-driver`, run by `./pubky-marketplace` | `marketplace/driver/package-lock.json` |

`./pubky-marketplace build` checks the pinned trees out under `.marketplace/sources` (git ignored) and
fails if a checkout is not at its pin or if the Paykit Server tree's `Cargo.lock` does not lock paykit-rs
and locks-core to those revisions. `Dockerfile.local` then fails closed if a tree differs from the pins in
Paykit Server's Cargo manifests. The pins are at the top of `pubky-marketplace`.

### Why this Paykit Server revision

The apps ship Paykit SDK `0.1.0-rc55` (bitkit-ios and bitkit-android at their 2026-09-29 heads). Its setup
approval accepts only the Pubky grant auth URL: `pubkyauth://signin_grant` with `cid` and `cpk`. Paykit Server
`867fc883` (the merge of pubky/paykit-server#2) is built on paykit-rs rc43 and emits the legacy
`pubkyauth://signin?caps&relay&secret&x-bitkit-claim` URL, which both apps reject ("Missing query parameter
cid"). Paykit Server adopted grant URLs with paykit-rs rc48, and `722ef268` (v0.1.0-rc4) is the newest
merged revision. It keeps `/setup` and `x-bitkit-claim=watch-only-account-v1`. Paykit Server pins paykit-rs
rc48, three releases before the apps' rc55, and no setup, auth or companion-claim code changed between them;
the J1 device run on 2026-09-29 already delivered requests from a paykit-rs rc43 server to rc55 apps. The
driver's `setup-url` refuses any auth URL that is not `signin_grant` with `cid` and `cpk`, so a wrong pin
fails before it reaches a wallet. Unmerged Paykit Server branches move to paykit-rs rc56; they are not
pinned here.

## Ports

Published on the host loopback only, because the pinned Pubky clients resolve their local testnet on
these fixed ports:

| Port | Service |
| --- | --- |
| 6286, 6287 | homeserver (ICANN HTTP, Pubky TLS) |
| 15411, 15412 | PKARR relay, HTTP relay |
| 6881 (tcp and udp) | DHT bootstrap |
| 3001 | Paykit Server (`MARKETPLACE_PAYKIT_PORT`) |
| 16288 | homeserver admin (`MARKETPLACE_HOMESERVER_ADMIN_PORT`; the in-container 6288 is Homegate's host port) |
| 60001 | Electrum, from the base stack |

`paykit-server` and `marketplace-driver` share the `pubky-testnet` network namespace, as the upstream
Locks compose does, so their Pubky clients reach the testnet on localhost.

## Roles

The journey needs a seller, a buyer and a marketplace. The driver can play each of them, and Bitkit
wallets replace the wallet roles in the app journey.

- **Marketplace (always the driver).** It publishes a `paykit-payment` content lock on the seller's
  homeserver and posts a signed `POST /invoices` to Paykit Server as the trusted issuer. The issuer key
  is generated at `init`, and its public key is `locks.trusted_public_key` in the generated Paykit
  config. Paykit Server's status route is signed the same way. This is the part Locks plays in a full
  marketplace; Locks itself is not in this stack.
- **Seller (headless).** The driver holds the seller's Pubky identity, publishes the lock with it, and
  completes `/setup` through `paykit-companion-auth`, which approves the same
  `watch-only-account-v1` claim Bitkit approves. The seller's spending authority is a wallet seed that
  stays in the state volume; Paykit Server receives only the account xpub at `m/84'/1'/0'`.
- **Buyer (headless or Bitkit).** The headless buyer is `paykit-reader-demo` at the `bitkit/wallet`
  receiver path, paying from the regtest wallet. A Bitkit buyer is passed as `purchase --buyer <pubky>`.

Paykit Server runs at `bitkit/server`. A headless buyer's `receive` succeeding shows the server's
Paykit link to the buyer and the buyer's link back to the seller at those two paths.

## State and secrets

Everything lives in the `marketplace_state` volume, and `down` deletes it.

- `/state/paykit` (readable by the Paykit Server process): generated config and master key.
- `/state/secrets` (root, mode 0700, unreadable by Paykit Server): issuer seed, seller identity seed,
  seller wallet seed, buyer identity seed.
- `/state/fixture.json`, `/state/purchases.json`: public facts and the purchase ledger.
- `.marketplace/evidence/<run>/summary.json`: `verify` output, owned by the user who ran the wrapper (the driver
  hands it over from its root container). It holds public keys, bundle and request ids, addresses, txids and
  statuses, and no seed or token. `down` removes it, through a container if an older run left root-owned files.

The driver never prints a seed or key. `setup-url` prints a one-time auth URL that contains a session
secret; it is meant to be pasted into a wallet, so keep it out of logs and evidence.

## Lifecycle

The Pubky testnet keeps homeserver files and its DHT in memory, so its accounts do not survive a
restart while Paykit Server's database still expects them. The fixture is therefore disposable as a
whole: `down` removes the fixture containers, its Postgres and its state volume, and the three
services do not restart on their own. After a crash or a Docker restart, run `./pubky-marketplace
reset`. The regtest chain from the base stack is left alone.

## Purchase states

`purchase` returns once Paykit Server has durably accepted the invoice and reports `delivery`:
`queued` or `sent` from the server's outbox metrics, or `failed`. The Payment Request id exists only
in the SDK's delivery, so `receive` (headless buyer) reports it; for a Bitkit buyer read it from the
request row in the app. The purchase state moves `created`, `delivered`, `paid`, `payment_detected`,
`completed`. `completed` means a signed Paykit status of `confirmed` with a matching amount at one or
more confirmations, the gate Locks applies with `minimum_confirmations = 1`.

The derived address is the seller xpub's external child `0/<n>`, where `n` is the number of earlier
purchases for that seller, checked through `bitcoind deriveaddresses`. A headless `receive` compares it
with the address in the delivered Payment Request.

`mine --bundle` mines one block only after it finds the purchase transaction in the mempool. The headless buyer's
`pay` records its txid; for a buyer that pays from an app, `mine --bundle` looks for the transaction that pays
the derived address the purchase's exact amount, records its txid in the ledger and prints it. `status` does the
same for a payment that is already confirmed (it searches the last 50 blocks). More than one matching
transaction is an error, and no match makes `mine --bundle` refuse.

## Linked peers

`peers [--buyer <pubky>] [--bundle <id>] [--wait <seconds>]` is the fixture's answer to journey step 14. It
prints, for the seller and for the buyer (default: the latest purchase's buyer, else the headless buyer):

- the public Paykit receiver marker each identity publishes (`bitkit/server` for the seller, `bitkit/wallet` for
  the buyer), which shows contact payments are on;
- the seller's Paykit Server setup authority (`ready`, `setup_required` or `unavailable`);
- Paykit Server's persisted link state to the buyer for the purchase's reader binding (`none`, `handshake`,
  `connected`, `recovery_required` or `blocked`), and for the headless buyer its own view of the link.

`ready_for_purchase` is true when both markers are published and the seller's setup is ready. `linked` is true
only when Paykit Server reports the link `connected`. Paykit Server keeps that state per purchase and exposes no
per-peer query, so before a buyer's first purchase `server_side` reads `no_purchase_yet` and `linked` is false;
use `ready_for_purchase` there and `peers --wait 60` after `purchase`, which exits 1 if the link never connects.

## Limits

- **Setup relay.** The pinned Paykit Server starts the setup sign-in on `https://httprelay.pubky.app`,
  not on the local relay, and offers no config to change it. `seed` and a Bitkit seller's approval
  therefore need outbound internet. Only that one-time handshake leaves the machine.
- **Seller in the app.** Publishing a lock needs the seller's identity secret, so driver purchases use
  the headless seller. A Bitkit wallet that approves `setup-url` becomes another Paykit Server creator
  for the watch-only leg, and the driver does not sell as it. Full Locks legacy-connect authority for a
  Bitkit seller is out of scope here.
- **No Locks server, no guarded content.** The lock has no guarded resource, and the fixture does not
  cover marketplace browsing, content delivery, fiat payment or Hypercolor, which the journey also
  excludes.
- **Bitkit apps.** The commands for Bitkit wallets follow the journey's fixture contract. The buyer legs
  ran on both apps in the J1 device run on 2026-09-29, against the previous Paykit Server pin. The seller
  setup with the current pin has been run headlessly (`seed` and `verify`) and not yet against an app.
- **Fixed container names.** The base services keep their fixed container names, so another checkout's
  stack with the same names must be removed first.
