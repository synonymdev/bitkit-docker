# Shop order on our own servers (`shop-order`)

A Shop order paid end to end: a Pubky Ring seller lists a digital product, a Bitkit buyer pays the original request once, Paykit
Server sees `amount_matched`, the Lock Server completes the bundle, and the same marketplace order becomes `paid`. Our own Paykit
Server, Lock Server, marketplace service and Shop run here; Synonym's staging homeserver, relay, Shop indexer and Blocktank's staging
regtest chain do the rest, so Bitkit staging builds (devDebug, iOS Debug) work unchanged.

Synonym's staging Shop stays the first route to try. Use this profile when the staging Shop cannot serve the Bitkit build under
test, for example a Paykit version the staging Paykit Server does not run.

## Revisions

| Component | Revision | Built from |
| --- | --- | --- |
| Shop | pubky/pubky-marketplace#154, fbe3babba0c3c05990571221b5d4dc0c31788e68 | the repository's Dockerfile |
| Marketplace service | pubky/pubky-marketplace-service#98, 005b0707e6047b388ce032f4b51a2e0ed9e3a752 | the repository's Dockerfile |
| Lock Server | pubky/locks v0.1.0-rc10, 01cfeca14c7b5d385d8c3536c0cb4e1af81b458c | the repository's Dockerfile |
| Paykit Server | v0.1.0-rc11, 662dca0619a9aa2962bcd677bd5ddd4563cd2784 (paykit-rs ad3c7224 = rc72) | `marketplace/shop-mixed` |

`./shop-order fetch` checks out each source at exactly that commit and refuses another. These are the commits the Android
(aa330959, devDebug) and iOS (bb02e835, Debug) order-paid acceptance ran on, on 10 Oct.

## Run

```bash
SHOP_ORDER_PROVISIONING=1 ./shop-order fetch   # the pinned sources, plus the seller's provisioning page
./shop-order up                                # keys, Paykit rc11, tunnels, Postgres, Lock Server, service, Shop
./shop-order urls                              # SHOP_URL, SERVICE_URL, LOCKS_URL, PAYKIT_URL
./shop-order health                            # readiness, revisions, Paykit's trusted keys
```

The first build compiles three Rust services and the Shop, and the Shop's build needs about 6 GB of memory. Each start gets new
quick-tunnel URLs; `up` writes them to `.shop-order/run/urls.env` and every origin setting is filled from them.

## Seller

1. Open `SHOP_URL`, sign in with Pubky Ring, **Connect Locks**, reload the Shop, then do the Bitkit/Paykit setup. The Shop sends no
   `creator` parameter (`PUBKY_RUNTIME_PAYKIT_SETUP_CREATOR_PARAM=false`). This order matters: the setup reads the seller's Lock
   Server session, so Locks comes first.
2. Create the listing in the Shop studio as usual. The marketplace service registers it as revision 1.
3. Create its Lock with the seller's Locks session (the frontend session the Shop holds after Connect Locks, saved as
   `{"session_token": ..., "creator": ...}`; keep the file private):

   ```bash
   ./shop-order lock --session-file seller-locks-session.json --content product.txt --sats 1000
   ```

   It registers the content, creates a content Lock whose criterion is a Paykit payment of that price to the seller, and prints
   the listing's `digitalLock`. It writes no order and no payment.
4. Open `SHOP_URL/marketplace/shop-order-provision` as the seller, enter the listing id and the `digitalLock`, and publish. That
   publishes revision 2 through the Shop's normal path (`schema.parse`, then `CommerceApplication.commitUpsertListing`), which
   emits the service's `listing.sync`. The service takes Lock terms only from the seller-signed homeserver record, so
   `prepare_locks` needs that revision; the Shop's own publish flow works the same way (register, then sync).
5. Check the service holds the Lock snapshot, the current revision and stock before any checkout. Then remove the provisioning
   page: `./shop-order fetch` (without `SHOP_ORDER_PROVISIONING`) and `./shop-order up`; keys and data are kept.

The listing keeps two different hashes: its cover image's `contentHash`, which the service registers, and the guarded content's
`resourceHash` (BLAKE3) in `digitalLock`. Physical listings are not supported yet: they need pubky-marketplace-service#89 and
Paykit Server #67/#68.

## Buyer

1. Fund the Bitkit buyer on Blocktank's staging regtest chain (`./shop-mixed mine` confirms). Use one wallet per simultaneous payer,
   and keep only one running instance of a restored wallet.
2. Sign in to `SHOP_URL` with Bitkit and save the seller as a contact first.
3. Start a fresh order. Checkout still asks for a shipping address for a Locks-backed listing.
4. Press **Pay**, then **Request payment in your wallet** on the order page. The Shop runs `prepare_locks`, creates the Lock bundle
   and registers it. Check the payer, seller, request and amount in Bitkit, then pay once.

Pass: the original Paykit invoice has `amount_matched: true`, the original SDK request reaches `proof_submitted`, the Lock Server
completes the original bundle, the same service order is `paid`, one transaction of the listed amount exists, and the buyer's
authenticated content access returns the content. If registration needs a retry, keep the browser profile and the stored bundle
and retry that same payment; never create a new invoice or pay again to settle a doubt.

## Configuration

Every secret is made by `shop-order-keys` on the first start, kept in the project's state volume (mode 0600) and reused after, so
a rerun keeps its databases, the seller's Paykit setup and the Lock Server identity (`SHOP_ORDER_FRESH=1 ./shop-order up` makes new
ones). Nothing is committed. What each service gets:

- **Shop** (runtime `PUBKY_RUNTIME_*`): `PAYKIT_SERVER_API=upstream` and `PAYKIT_SETUP_CREATOR_PARAM=false` together,
  `COMMERCE_ADAPTER_MODE=locks-paykit`, `MARKETPLACE_GRANT_FLOW_ENABLED=true`, the service, Lock Server and Paykit setup URLs, and
  the staging homeserver, homegate, relay, pkarr relays and Nexus. Its BFF: `SHOP_BFF_GRANT_FLOW_ENABLED`, allowed and public
  origins, the service URL, its grant-state database (tables from the Shop's `db/bff`, applied once), `CRON_SECRET`, and its
  assertion and service-request signing keys.
- **Marketplace service**: upstream Paykit with its request-signing key, which Paykit trusts; the Lock Server URL with bundle and
  lookup keys and a 3,600-second payment window; digital-delivery, private-data and Stripe encryption keys (the Stripe key is
  needed even for Bitcoin); the grant flow with its encryption and result keys and the Shop's assertion and request verifying
  keyrings; and refusal audit with its own writer and retention logins, made on Postgres's first start. Its three refusal-audit
  attestations are set because this database is disposable: it has no backup or replica, and its audit rows are not evidence.
- **Lock Server**: grant-connect for `shop.pubky.app` returning to `SHOP_URL`, credentials up to 3,600 seconds (the payment
  window), Paykit at our rc11, and `network = "mainnet"`, which is where it resolves Pubky keys (the staging homeserver is
  published there); payments stay on the staging regtest chain.
- **Paykit Server**: `[signed_services]` trusts the driver's issuer, the Lock Server's signer and the service's request key. Trust
  is merged, never replaced, and each start reads the list back (`./shop-order health` prints it).

## Ownership and cleanup

The stack runs under its compose project, never a QA lane's: a lane's cleanup removes that lane's project. `./shop-order down`
removes the containers and volumes; `./shop-order down --keep-data` keeps the databases, keys and the seller's setup for a rerun.
On a QA box, a lease on the seat keeps the VM up while it runs.
