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
| `wallet send ADDRESS ATOMIC_AMOUNT` | Quote and send through the real Core engine |
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
- Orchestra operators, deposit monitoring, route liquidity, refunds and LayerZero relaying cannot run locally. They need provider contract fixtures plus a smaller live acceptance set. The gateway already accepts `LOCAL_ORCHESTRA_URL`; the companion service draft adds `LOCAL_LAYERZERO_URL`. Bridge endpoints are disabled in this baseline so they cannot accidentally use live providers. Use the gateway's deposit/bridge HTTP tests as the schema examples when adding journey scenarios; execute applicable local token transfers separately rather than inventing successful receipts.
- Keep this on a trusted development host. Control, node, provider, gateway and upstream ports bind loopback. Alto 0.0.21 binds its debug RPC on all interfaces; do not expose port 23451 from the runner or run the fixture on a public host.

Ports: node 23450, Alto 23451, signing/provider router 23452, app gateway 23453, fixture controls 23454, upstream read proxy 23455. Android uses `adb reverse tcp:23453 tcp:23453`; iOS uses loopback. Core intentionally does not accept `10.0.2.2` HTTP endpoints.

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
```
