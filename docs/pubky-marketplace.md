# Pubky marketplace fixture

Integration fixture for the Bitkit marketplace wallet journey (`journeys/pubky-marketplace` in
bitkit-ios and bitkit-android, tracked by [bitkit-ios#794](https://github.com/synonymdev/bitkit-ios/pull/794)
and [bitkit-android#1338](https://github.com/synonymdev/bitkit-android/pull/1338)). The README section
"Pubky Marketplace Journey" has the commands; this page has what is behind them.

## What runs

| Piece | Where | Pin |
| --- | --- | --- |
| Regtest bitcoind and Electrum on `tcp://127.0.0.1:60001` | the stack's `bitcoind` and `electrs` | as in `docker-compose.yml` |
| Pubky static testnet: DHT, PKARR relay, HTTP relay, one homeserver with open signup | `pubky-testnet`, built from `marketplace/pubky-testnet/Dockerfile` | `pubky-testnet` crate 0.14.0 |
| Homeserver and Paykit databases | `marketplace-postgres` | `postgres:16-alpine` |
| Paykit Server | `paykit-server`, built from source with the upstream `Dockerfile.local` (classic builder without BuildKit, see below) | pubky/paykit-server `0ffd4da2` (head of [pubky/paykit-server#46](https://github.com/pubky/paykit-server/pull/46), not yet merged or released; image label `tech.masivo.paykit-server`), paykit-rs `7185ae7d` (v0.1.0-rc65, the version both apps pin; label `tech.masivo.paykit-rs`), locks-core `b3dc87c9` (v0.1.0-rc8) |
| Purchase driver | `marketplace-driver`, run by `./pubky-marketplace` | `marketplace/driver/package-lock.json`, `@synonymdev/pubky` 0.14.0, Paykit helpers from the Paykit Server image (tagged with the same revision) |

`./pubky-marketplace build` checks the pinned trees out under `.marketplace/sources` (git ignored) and
fails if a checkout is not at its pin or if the Paykit Server tree's `Cargo.lock` does not lock paykit-rs
and locks-core to those revisions. `Dockerfile.local` then fails closed if a tree differs from the pins in
Paykit Server's Cargo manifests. The pins are at the top of `pubky-marketplace`; move `PAYKIT_SERVER_REV` to #46's merge commit or
release once it lands. Docker without BuildKit cannot build `Dockerfile.local` (named contexts, cache mounts), so `build` then generates a
classic Dockerfile from it (the named contexts become COPYs from `.marketplace/sources`) with the same labels. `build-paykit` builds only
Paykit Server and the driver, and takes the pins from the environment; `scripts/follow-app-paykit` uses it (README, Following the apps'
Paykit pin).

### Why these versions

Current Bitkit builds (Paykit SDK rc65) take a Pubky write lock (`LOCK` and `UNLOCK` on the path) before they write Paykit state. The
homeserver of the earlier Pubky Core pin `f68014c1` answers `LOCK` with 405, so creating a profile or publishing Paykit data failed in the
app. The 0.14.0 homeserver grants the locks.

Paykit Server `0ffd4da` (#46) is on Pubky 0.14.0 and paykit-rs rc65 and keeps `/setup` with `x-bitkit-claim=watch-only-account-v1`;
its setup flow emits the Pubky grant auth URL (`pubkyauth://signin_grant` with `cid` and `cpk`) that the apps accept. The driver's
`setup-url` refuses any auth URL that is not `signin_grant` with `cid` and `cpk`, so a wrong pin fails before it reaches a wallet. The
server's config names its Paykit app with `app_id` (paykit-rs has no receiver folders since rc59), and the driver reads the app registry
(`/pub/paykit/v0/app-registry.json`) where it read `receiver.json`. The driver's client is `@synonymdev/pubky` 0.14.0, the release of the
homeserver, whose signin names its client and returns a grant session, so the headless seller signs in as `marketplace.fixture`.

### Known limit: the headless seller stand-in

Paykit Server verifies the seller's app registry (`/pub/paykit/v0/app-registry.json`, written by the Paykit SDK from the seller's Paykit
identity key) before it persists a setup. A Bitkit wallet publishes it itself, so the app paths work: `setup-url`, `setup-wait`, `seller-auth`,
`purchase --seller bitkit`, `receive`, `pay`, `mine` and `peers` against a Bitkit seller, with the headless buyer. The Node driver has no Paykit SDK
to publish that registry for its own headless seller, so `seed` stops at `setup flow ended with HTTP 422 setup_failed`, and `verify` and
`verify-bitkit-seller`, which use the headless seller or a headless stand-in for the wallet, do not run until the driver gets one.

## Ports

Published on the host loopback only, because the pinned Pubky clients resolve their local testnet on
these fixed ports:

| Port | Service |
| --- | --- |
| 6286, 6287 | homeserver (ICANN HTTP, Pubky TLS) |
| 15411, 15412 | PKARR relay, HTTP relay |
| 6881 (tcp and udp) | DHT bootstrap |
| 3001 | Paykit Server (`MARKETPLACE_PAYKIT_PORT`) |
| 3012, 3013 | `fixture-issuer` and `rc56-peer` of the opt-in `payment-requests` profile (see the README); nothing listens until they run |
| 16288 | homeserver admin (`MARKETPLACE_HOMESERVER_ADMIN_PORT`; the in-container 6288 is Homegate's host port) |
| 60001 | Electrum, from the base stack |

`paykit-server` and `marketplace-driver` share the `pubky-testnet` network namespace, as the upstream
Locks compose does, so their Pubky clients reach the testnet on localhost. The `payment-requests` profile's `fixture-issuer`
and `rc56-peer` join it too. They sign up on the testnet homeserver and use its HTTP relay, and do not talk
to Paykit Server, so its pin does not affect them.

## Roles

The journey needs a seller, a buyer and a marketplace. The driver can play each of them, and Bitkit
wallets replace the wallet roles in the app journey.

- **Marketplace (always the driver).** It publishes a `paykit-payment` content lock on the seller's
  homeserver, with the seller's own session (headless seller) or with the write grant the Bitkit seller approved
  (see "Bitkit seller"), and posts a signed `POST /invoices` to Paykit Server as the trusted issuer. The issuer key
  is generated at `init`, and its public key is `locks.trusted_public_key` in the generated Paykit
  config. Paykit Server's status route is signed the same way. This is the part Locks plays in a full
  marketplace; Locks itself is not in this stack.
- **Seller (headless, the default).** The driver holds the seller's Pubky identity, publishes the lock with it, and
  completes `/setup` through `paykit-companion-auth`, which approves the same
  `watch-only-account-v1` claim Bitkit approves. The seller's spending authority is a wallet seed that
  stays in the state volume; Paykit Server receives only the account xpub at `m/84'/1'/0'`. `verify` uses it.
- **Seller (Bitkit).** A Bitkit wallet is the seller through two approvals; the driver holds no key or seed for
  it. See "Bitkit seller".
- **Buyer (headless or Bitkit).** The headless buyer is `paykit-reader-demo` at the `bitkit/wallet`
  receiver path, paying from the regtest wallet. A Bitkit buyer is passed as `purchase --buyer <pubky>`.

Paykit Server runs at `bitkit/server`. A headless buyer's `receive` succeeding shows the server's
Paykit link to the buyer and the buyer's link back to the seller at those two paths.

## State and secrets

Everything lives in the `marketplace_state` volume, and `down` deletes it.

- `/state/paykit` (readable by the Paykit Server process): generated config and master key.
- `/state/secrets` (root, mode 0700, unreadable by Paykit Server): issuer seed, seller identity seed,
  seller wallet seed, buyer identity seed, and `bitkit-seller.session`, the `/pub/app.locks/` grant session a
  Bitkit seller approved (bearer-equivalent for that path; the grant lasts two years).
- `/state/fixture.json`, `/state/purchases.json`: public facts and the purchase ledger.
- `.marketplace/evidence/<run>/summary.json`: `verify` output, owned by the user who ran the wrapper (the driver
  hands it over from its root container). It holds public keys, bundle and request ids, addresses, txids and
  statuses, and no seed or token. `down` removes it, through a container if an older run left root-owned files.

The driver never prints a seed or key. `setup-url` prints a one-time auth URL that contains a session
secret; it is meant to be pasted into a wallet, so keep it out of logs and evidence.

## Bitkit seller

In the wallet journey the Bitkit seller wallet is the seller: the marketplace acts for the identity that wallet
approves, and payouts land in the wallet. That takes two approvals of the same Pubky identity, in either order:

| Approval | Fixture command | Requester ID | Permissions | Gives the fixture |
| --- | --- | --- | --- | --- |
| Paykit setup (`x-bitkit-claim=watch-only-account-v1`) | `setup-url`, then `setup-wait <flow>` | `app.paykit.server` | `/pub/paykit/v0/bitkit/server` and `/pub/paykit/v0/private/bitkit/server`, READ, WRITE | Paykit Server holds the wallet's account xpub and derives the payout addresses |
| Marketplace grant | `seller-auth` | `locks.app` | `/pub/app.locks`, READ, WRITE | a session that writes the payment lock to the seller's homeserver |

One approval cannot carry both. Both apps accept the watch-only claim only when the requested capabilities are
exactly the two Paykit paths (a claim with other capabilities, or those two paths without a claim, is
rejected), and Paykit Server fixes those capabilities. An approval without the claim is an ordinary Pubky
grant request: both apps accept any capabilities and requester ID for it and show them for the user to
approve, so the marketplace grant needs no app change.

`seller-auth` starts a grant flow (`startGrantAuthFlow` with `/pub/app.locks/:rw`, client id `locks.app`) on the
testnet's HTTP relay, prints the `pubkyauth://signin_grant?caps&relay&secret&cid&cpk` URL, waits up to
`--timeout` seconds (default 300; the relay keeps a request about five minutes) and stores the approved
session under `/state/secrets`. It records the approving identity as the Bitkit seller and reports Paykit's
setup state for it. `setup-wait` then checks the wallet that approved the setup is the same identity, and
`purchase --seller bitkit` (or `--seller <approved pubky>`) refuses until it is. `peers --seller bitkit`,
`status`, `wait` and `mine --bundle` work on the purchase's own seller.

`seller-auth` prints one compact JSON object per line: `awaiting_approval` (with `auth_url`, `android`, `ios`) at
once, then `approved` when the wallet has approved. Read the request from the first line (`... | head -1 | jq
-r .auth_url`, or `jq -r 'select(.status == "awaiting_approval") | .auth_url'` over the stream) and collect both
with `jq -s`. `info` shows the result as `bitkit_seller.marketplace_grant` (`locks.app /pub/app.locks/:rw`)
and `bitkit_seller.setup_completed_at` (null until `setup-wait` has seen the setup complete), next to
`bitkit_seller.pubky` and `kind`; `seller.pubky` is the unused headless seller.

Handoff. Android opens either URL with the printed `android` command,
`adb shell "am start -a android.intent.action.VIEW -d '<auth_url>'"` (the app enables its
`pubkyauth://signin_grant` handler while it holds a Bitkit-generated Pubky identity). The double quotes around
the whole device command matter: adb hands its arguments to the device shell as one line, so single quotes
outside them are lost and the shell cuts the URL at the first `&`, leaving the app only `caps=...`. With more
than one device or emulator, add `--serial <adb-serial>` to `setup-url` or `seller-auth`
(`adb devices` lists them) and the printed command becomes `adb -s <adb-serial> shell "..."`.
iOS registers no `pubkyauth` scheme. Its `bitkit://pubky-auth/setup?<query>` handoff requires the claim, so it
opens only the setup request (`ios_url`). The marketplace grant is entered in the app: Scan QR Code, then Paste
QR Code with the URL on the simulator clipboard, or Enter QRCode String in E2E builds. An optional iOS app
change, accepting a claim-less `bitkit://pubky-auth/...` handoff, would let `xcrun simctl openurl` open it
without taps; it is not needed.

What is verified for the payout, and what is not. Paykit Server exposes no xpub, derived address or txid to
its creators, so for a Bitkit seller the fixture cannot derive the expected address:

- verified by the fixture: the Payment Request address a headless buyer receives (`receive`) is a regtest
  native SegWit address; the mempool holds a transaction paying exactly that address and the purchase amount
  (`pay`, `mine --bundle`; for an app buyer the address comes from `mine --address` or from the one p2wpkh
  output of exactly the amount, both exercised with an app buyer on Android and iOS); Paykit Server's signed status goes `detected` and then `confirmed` with a
  matching amount and one confirmation, which means its own derived address for the invoice received the
  payment; the purchase reaches `completed`.
- verified only in the seller app: that the address is derived from the wallet's own xpub. The seller wallet
  tracks its watch-only account, so its balance rises by the amount and the received activity carries the
  purchase transaction id.
- verified for a stand-in only: `verify-bitkit-seller` approves both requests with a headless client that owns
  the xpub, and asserts the Payment Request address and the paid output equal the stand-in's `0/0` child.

## Lifecycle

The Pubky testnet keeps homeserver files and its DHT in memory, so its accounts do not survive a
restart while Paykit Server's database still expects them. The fixture is therefore disposable as a
whole: `down` removes the fixture containers, its Postgres and its state volume, and the three
services do not restart on their own. After a crash or a Docker restart, run `./pubky-marketplace
reset`. The regtest chain from the base stack is left alone.

`up`, `reset` and every driver command fetch the pinned sources under `.marketplace/sources` when a tree is
missing, even if the images exist: the driver image is wired to the paykit-server build context, and compose
refuses to run the driver without it (a fresh clone on a host that built before). Nothing is fetched when the
trees are there.

## Output

Command results are JSON on stdout. Progress lines (`reset`, `up` and `down` announce each phase) and compose's own
messages go to stderr. On a host without buildx the wrapper sets `COMPOSE_BAKE=false`, so compose does not print
its "configured to build using Bake, but buildx isn't installed" warning on every run; set `COMPOSE_BAKE` yourself
to keep your own value. `2>&1 | jq` therefore works there, and `seller-auth` prints one object per line (see above).

## Purchase states

`purchase` returns once Paykit Server has durably accepted the invoice and reports `delivery`:
`queued` or `sent` from the server's outbox metrics, or `failed`. The Payment Request id exists only
in the SDK's delivery, so `receive` (headless buyer) reports it. For a Bitkit buyer the delivery goes to the
app, and neither Paykit Server's API nor the chain hands the id to the fixture, so `status` prints
`payment_request_id: null`; read the id from the request row in the app. The purchase state moves `created`, `delivered`, `paid`, `payment_detected`,
`completed`. `completed` means a signed Paykit status of `confirmed` with a matching amount at one or
more confirmations, the gate Locks applies with `minimum_confirmations = 1`.

The derived address is the seller xpub's external child `0/<n>`, where `n` is the number of earlier
purchases for that seller, checked through `bitcoind deriveaddresses`. A headless `receive` compares it
with the address in the delivered Payment Request. A Bitkit seller's xpub is not in the fixture, so its
purchases have `derived_address` null and a `payout_address` learned from the Payment Request, `mine --address`
or the transaction that pays the exact amount (`payout_address_source` says which: `payment_request`, `operator`
or `amount_match`). With an app buyer both `amount_match` and `mine --bundle` without `--address` have been
exercised, on Android and on iOS.

`mine --bundle` mines one block only after it finds the purchase transaction in the mempool. The headless buyer's
`pay` records its txid; for a buyer that pays from an app, `mine --bundle` looks for the transaction that pays
the derived address the purchase's exact amount, records its txid in the ledger and prints it. `status` does the
same for a payment that is already confirmed (it searches the last 50 blocks). More than one matching
transaction is an error, and no match makes `mine --bundle` refuse.

## Linked peers

`peers [--buyer <pubky>] [--bundle <id>] [--wait <seconds>]` is the fixture's answer to journey step 14. It
prints, for the seller and for the buyer (default: the reader of the purchase `--bundle` selects, else the latest purchase's buyer, else the headless buyer):

- the public Paykit receiver marker each identity publishes (`bitkit/server` for the seller, `bitkit/wallet` for
  the buyer), which shows contact payments are on;
- the seller's Paykit Server setup authority (`ready`, `setup_required` or `unavailable`);
- Paykit Server's persisted link state to the buyer for the purchase's reader binding (`none`, `handshake`,
  `connected`, `recovery_required` or `blocked`), and for the headless buyer its own view of the link.

`ready_for_purchase` is true when both markers are published and the seller's setup is ready. `linked` is true
only when Paykit Server reports the link `connected`. Paykit Server keeps that state per purchase and exposes no
per-peer query, so before a buyer's first purchase `server_side` reads `no_purchase_yet` and `linked` is false;
use `ready_for_purchase` there and `peers --wait 60` after `purchase`, which exits 1 if the link never connects.

`link.buyer_side` is the buyer's own view of the link and only the headless buyer can be asked. For an app buyer
it reads `not_observable`: the fixture holds no key for the app's end of the link, the app shows that side
(Linked), and `linked` rests on Paykit Server's side (`server_side: connected`) plus the two receiver markers.
`verify` and `verify-bitkit-seller` assert both: `ready_for_purchase` before the purchase and `linked` after `receive`.

## Limits

- **Setup relay.** The pinned Paykit Server starts the setup sign-in on `https://httprelay.pubky.app`,
  not on the local relay, and offers no config to change it. `seed` and a Bitkit seller's setup approval
  therefore need outbound internet. Only that one-time handshake leaves the machine: the marketplace grant
  of a Bitkit seller uses the local relay unless `seller-auth --relay` names another.
- **Locks authority.** A Bitkit seller gives the driver only a write grant on `/pub/app.locks/`, the path Locks
  publishes locks under, through the Pubky grant session path. Locks' own connect flow and its other seller
  APIs are out of scope.
- **No Locks server, no guarded content.** The lock has no guarded resource, and the fixture does not
  cover marketplace browsing, content delivery, fiat payment or Hypercolor, which the journey also
  excludes.
- **Bitkit apps.** The commands for Bitkit wallets follow the journey's fixture contract. The buyer legs
  ran on both apps in the J1 device run on 2026-09-29, against the previous Paykit Server pin. The seller
  setup with the current pin has been run headlessly (`seed` and `verify`) and not yet against an app. The
  Bitkit seller path (`seller-auth`, `purchase --seller bitkit`) has a headless self-test,
  `verify-bitkit-seller`, and has not been run against an app yet.
- **Patched Paykit Server reader helper.** Since pubky/paykit-server `468f12c` (2 Oct, on master and in #46) every invoice's Payment
  Request carries an acceptance deadline (`proposal_expires_at`), and the server's own `paykit-reader-demo` still rejects any request
  that has one, so the headless buyer's `receive` ends in `protocol_failed`. The fixture applies
  `marketplace/patches/paykit-server-reader-accepts-proposal-expiry.patch` to the pinned tree (image label
  `tech.masivo.paykit-server-patches`); `fetch_sources` stops when a patch no longer applies, which is the sign upstream fixed it.
- **Paykit Server on an unmerged branch.** The apps pin paykit-rs rc65, and only pubky/paykit-server#46 (`0ffd4da`) builds Paykit
  Server on rc65; master (`7ff868b`) is still on rc59. The fixture builds from #46's head until it merges or is released.
- **Fixed container names.** The base services keep their fixed container names, so another checkout's
  stack with the same names must be removed first.
