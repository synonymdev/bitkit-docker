# Local USDT execution

`./usdt-fixture` runs an isolated Arbitrum state fork, Alto, a test token-paymaster signer and the real Bitkit USDT gateway as host processes. This works without Docker on hosted macOS runners. It does not start or replace Bitcoin, Lightning, VSS, Pubky or rate services.

## Versions and state

Install Node 22.23.1 (or a later Node 22), npm, Rust, Git and tar. `setup` downloads Anvil with a verified release checksum and builds the gateway and Core wallet at the revisions in `usdt/pins.json`. Alto and viem are locked by `usdt/package-lock.json`; Rust dependencies are locked by `usdt/wallet/Cargo.lock`. Core is fetched shallowly into `.usdt/core` to avoid cloning its binary release history. Its published 0.8.0-rc2 source is used without modifications.

Runtime files, test wallet databases and process logs are kept in ignored `.usdt/`. The foreground launcher owns its processes and stops them on Ctrl-C. A new run starts a new chain. Do not restart/reset the fixture midway through an app recovery journey. Use dedicated test apps, seeds and Paykit peers; a chain reset does not reset their databases or VSS backups.

The upstream must serve historical state at the pinned block. Put `ARBITRUM_RPC_URL=https://...` in an untracked private file and pass its path as `USDT_TEST_ENV_FILE`. Only the read proxy knows that URL; Anvil receives a localhost URL. The proxy allowlists reads and blocks transaction submission, wallet methods and node mutations. Cold startup and new account/storage lookups can incur provider RPC charges. No public-chain tokens are spent.

## Commands

```sh
./usdt-fixture setup
USDT_TEST_ENV_FILE=/absolute/path/to/private.env ./usdt-fixture run
# Another terminal, from this checkout:
./usdt-fixture status
./usdt-fixture smoke
./usdt-fixture fund 0xYOUR_TEST_WALLET 10
./usdt-fixture balance 0xYOUR_TEST_WALLET
eval "$(./usdt-fixture env)"
```

`fund` executes an actual ERC-20 transfer from a storage-funded donor, producing real receipt/history events. It does not overwrite the recipient balance. `smoke` creates independent disposable Core wallets and checks first-use EIP-7702 delegation without ETH, two sends, USDT fees and the approved fee bound, pending/manual inclusion across wallet reopen, proof verification, changed request binding and rejected paymaster authorization. It restores provider/bundler modes and removes only its own temporary wallet files.

| Command | Use |
| --- | --- |
| `provider-mode healthy\|unavailable\|expired\|invalid-signature` | Exercise provider outage or authorization failure |
| `bundling manual`, then `bundle` | Keep a submitted payment pending across app restart, then include it |
| `bundling auto` | Restore automatic inclusion |
| `mine 3` | Advance Core's history confirmation window |
| `reset` | Revert this fork and clear Alto's mempool; reset matching test apps/peers separately |
| `wallet address` | Address of the disposable Core wallet |
| `wallet send ADDRESS ATOMIC_AMOUNT [Destination]` | Quote and send through Core; optional destination uses `Polygon`, `Bsc`, etc. |
| `wallet quote ADDRESS ATOMIC_AMOUNT [Destination]` | Inspect a quote without paying |
| `wallet refresh ID` | Reconcile pending execution, including older receipts; Core may retry the identical signed operation |
| `wallet proof ID BINDING_FILE` | Create the standard proof after execution |
| `wallet verify BINDING_FILE PROOF_FILE` | Verify receipt, token, recipient and signature using the recipient Core wallet |

`USDT_WALLET_NAME` chooses a deterministic public test account; `USDT_WALLET_DIR` chooses its local database directory. The mnemonic and derivation passphrases are public test material. Never use them for actual funds. `wallet` uses a no-op backup adapter; it is an execution/proof tool, not a VSS test. App recovery tests must use the existing VSS helpers.

The binding JSON uses Core's fields: `payer`, `payee`, `payment_app_id`, `payment_request_id`, `payment_reference`, `payment_endpoint_identifier`, `period_starts_at`, `period_ends_at`, `conversion_quote_id`. Use exact authenticated SDK values; absent optional values are empty strings. Proof verification alone does not check the requested price/deadline or prevent evidence reuse: the receiving app/server owns those rules.

## Fidelity and limits

- Real deployed USDT0, EntryPoint v0.8, wallet delegate and SingletonPaymaster bytecode execute on the fork. Only the test signer's authorization, test balances and EntryPoint deposit are initialized locally. Contracts check signatures and collect token fees.
- The local signer replaces Pimlico's hosted pricing/authorization service. It uses a fixed 3,000 USDT/ETH rate. Local gas/fee numbers are not production quotes.
- Alto runs with `safe-mode=false`: its strict tracing path does not handle this Anvil/EIP-7702 setup. Contract simulation and execution remain real; production bundler reputation/storage-access policy is not covered.
- Anvil is an EVM fork, not the Arbitrum sequencer or L1 rollup. Local inclusion/finality and gas do not prove real Arbitrum finality or Nitro fees.
- Orchestra operators, external deposit monitoring, route liquidity and LayerZero relaying are simulated by local HTTP providers. The real gateway validates their responses through `LOCAL_ORCHESTRA_URL` and `LOCAL_LAYERZERO_URL`; neither provider contacts its public API. Arbitrum credits/refunds execute real token transfers. Off-Arbitrum hashes and delivery states are fixture evidence, not destination-chain execution. Live operator delivery/refunds still need separate acceptance.
- Keep this on a trusted development host. Control, node, provider, gateway and upstream ports bind loopback. Alto 0.0.21 binds its debug RPC on all interfaces; do not expose port 23451 from the runner or run the fixture on a public host.

Ports: node 23450, Alto 23451, signing/provider router 23452, app gateway 23453, fixture controls 23454, upstream read proxy 23455, Orchestra 23456, LayerZero 23457. Android uses `adb reverse tcp:23453 tcp:23453`; iOS uses loopback. Core intentionally does not accept `10.0.2.2` HTTP endpoints.

## Bridge scenarios

Providers start with the stack. Discovery offers all six Orchestra deposit
networks, its seven outbound networks, and the four configured USDT0 routes.
`env` enables those USDT0 networks in the app. The local Orchestra API key and
bridge-ticket secret are public fixture values; production keys are not used.

```sh
./usdt-fixture bridge-smoke
# First register this wallet's Polygon deposit address in the app.
./usdt-fixture orchestra deposit 0xWALLET polygon 3.5
./usdt-fixture orchestra advance DEPOSIT_ID processing
./usdt-fixture orchestra advance DEPOSIT_ID completed
# After an actual app send:
./usdt-fixture orchestra list
./usdt-fixture orchestra advance QUOTE_ID needs_attention
./usdt-fixture orchestra advance QUOTE_ID refunded
./usdt-fixture layerzero SOURCE_TX BLOCKED
./usdt-fixture layerzero SOURCE_TX DELIVERED
```

`orchestra deposit` simulates external observation, initially held. It requires
a registered wallet and takes a decimal USDT amount (including BSC). Completion
creates an actual Arbitrum transfer of the input minus the fixture fee.
Outgoing quotes have distinct funding addresses. Their order becomes visible
only after a matching real USDT transfer from the quoted owner. No command can
mark an unfunded quote completed. Repeated terminal commands share the same
settlement transfer, even when called concurrently. A different terminal outcome
requires a fresh scenario.

| Control | Meaning |
| --- | --- |
| `orchestra list` | Registered wallets, quotes with owners/recipients, funding orders and deposits |
| `orchestra advance ID STATUS` | `processing`, `needs_attention`, `failed`, `completed`, `refunding`, `refunded` |
| `orchestra fee USDT` | Flat fee on future quotes/deposits, default `0.01` USDT; existing terms remain fixed |
| `orchestra quote-ttl SECONDS` | Expiry of future quotes, default 120; very short values exercise expired-quote rejection |
| `orchestra mode MODE` | `healthy`, `unavailable`, `rate-limited`, `invalid-response` |
| `layerzero-mode MODE` | The same failure modes, independent of Orchestra |
| `layerzero TX STATUS` | `INFLIGHT`, `CONFIRMING`, `DELIVERED`, `FAILED`, `BLOCKED`, `PAYLOAD_STORED`, `APPLICATION_BURNED`, `APPLICATION_SKIPPED` |

LayerZero responses decode the actual source receipt's OFTSent event to obtain
the GUID, pathway and transaction identity. They cannot create an execution that
did not happen. USDT0 contracts/fees execute on the fork; relaying and destination
delivery are simulated. `FAILED`/`BLOCKED` represent retryable attention states;
`APPLICATION_BURNED`/`APPLICATION_SKIPPED` represent terminal failure. Orchestra
`failed` maps to attention in Core, since an operator may still recover/refund it.

For an outgoing Orchestra refund, `advance QUOTE_ID refunded` transfers the
original USDT principal to the wallet on Arbitrum. Core verifies that receipt;
the original gas fee is not refunded. For an incoming deposit, request the refund
through the app first, then advance its state. That source-chain refund is
simulated and does not change the Arbitrum balance. The app's ordinary signed
refund request, ownership checks and address validation still run.

Use BSC/Base/Tron/Solana for Orchestra-only sends. On shared networks, changing
`fee` changes which quote Core selects; a fee of `100` makes Orchestra unavailable
for a small Polygon transfer and exercises USDT0. Restore fee/modes/lifetime after
each test. Core keeps its normal polling backoff, so allow 30-60 seconds for app
updates; reopening the CLI wallet starts a fresh polling session.

`bridge-smoke` checks incoming credit, a requested external refund, real Orchestra
funding/completion, a real Arbitrum refund and USDT0 execution with LayerZero
attention/delivery. It uses disposable wallets and checks exact local balances.
Fixture provider state stays in memory through app restarts; restarting the
fixture or `reset` clears provider state and the chain together. Do not reset
midway through a wallet/VSS recovery test. If a settlement's local RPC operation
fails, its command retains that failure rather than risking a duplicate transfer;
start a fresh isolated scenario after diagnosing the failure.

## Shop / Locks

The optional Shop overlay preserves staging Pubky, rate feeds and Bitcoin. It enables Paykit Server's existing USDT RPC setting and pins Locks to the per-rail verification draft (`pubky/locks#75`, exact revision in `shop-order`). No new payment-verification code is needed in those services for local execution.

```sh
# Start usdt-fixture run first. Use a separate Shop project and keep it for recovery tests.
SHOP_ORDER_USDT=1 SHOP_ORDER_PROJECT=shop-usdt ./shop-order fetch
SHOP_ORDER_USDT=1 SHOP_ORDER_PROJECT=shop-usdt ./shop-order up
SHOP_ORDER_USDT=1 SHOP_ORDER_PROJECT=shop-usdt ./shop-order health
```

Follow the existing [Shop setup](shop-order.md) to register the seller and enable its USDT receiving address. Fund the payer on this fork, pay the original request, then assert the server's per-rail status and actual unlock. The overlay's read-only RPC sidecar shares Paykit Server's loopback network namespace. Host connectivity uses Docker Desktop's `host.docker.internal`; on Linux, run the fork where the container can reach it through an equivalent private host route before using this overlay. Do not point the verifier at mainnet while the app uses the fork.

The overlay is infrastructure wiring; a paid USDT Shop journey and browser unlock remain acceptance tests for the E2E suite. Reset only the dedicated `shop-usdt` project. Always use the same `SHOP_ORDER_USDT=1` and project value for subsequent commands, including teardown.

## Checks

```sh
npm --prefix usdt run lint
npm --prefix usdt test
cargo fmt --manifest-path usdt/wallet/Cargo.toml --check
cargo clippy --locked --manifest-path usdt/wallet/Cargo.toml --all-targets --no-deps -- -D warnings
./usdt-fixture smoke
./usdt-fixture bridge-smoke
```
