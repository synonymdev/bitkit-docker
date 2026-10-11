# Local USDT execution

`./usdt-fixture` runs an isolated Arbitrum state fork, Alto, a test token-paymaster signer and the real Bitkit USDT gateway in the opt-in `usdt` Compose profile. It uses a dedicated project (`usdt-fixture` by default), leaving the existing Bitcoin, Lightning, VSS, Pubky and rate services alone.

## Versions and state

Install Docker with Compose, Git, jq and tar. Your Git credentials must allow reads of the pinned Core and service repositories. `build` fetches their exact revisions from `usdt/pins.json` into ignored `.usdt/sources/` and exports clean source trees for the container build. Credentials and Git metadata stay outside images. Anvil's Linux release is checksum-verified; Alto and viem use `usdt/package-lock.json`; the Core wallet uses `usdt/wallet/Cargo.lock`. Node and Rust run inside pinned build images, with no host toolchain required. The launcher fingerprints the tracked fixture build inputs, including working-tree edits, and uses that fingerprint for every fixture/gateway image tag. Different revisions therefore cannot overwrite each other's images on the same Docker daemon. Use the launcher for build, startup and tools so they select the same images. Linux AMD64 and ARM64 are supported. CI must use a Docker-capable runner.

`up` starts four services and waits for health: the fixture/control server, Anvil, Alto and the gateway. They share a network namespace so the existing Core and gateway localhost checks still apply. One-off checks and wallet commands run in the tools container. `logs` follows service output; `ps` shows health. Wallet databases live in the `usdt_state` named volume; the chain and provider state are held in memory. Anvil caches fetched mainnet state in the `usdt_fork_cache` volume, reused across resets and container recreation. `down` removes only this Compose project's containers, network, cache and disposable wallet volume.

Keep the stack running through app restart, reinstall and VSS recovery tests. Do not restart individual services or reset the chain mid-scenario. Repeated `up` leaves already-running services intact. Use `down` followed by `up` for a fresh stack, with matching dedicated app/peer state. `reset` reverts the live chain and clears provider/bundler state but does not reset wallet databases or VSS backups. Never use a funded mainnet app or real seed.

The upstream must serve historical state at the pinned block. Put only `ARBITRUM_RPC_URL=https://...` in an untracked private file and export its absolute path as `USDT_TEST_ENV_FILE`. Compose mounts that file read-only as a secret in the fixture container; it is not an environment value, build argument or image layer. The fixture server runs as container root to read a private file regardless of its Linux host owner; the node, bundler, gateway and wallet tools run as non-root. Only the read proxy uses the URL; Anvil receives a localhost URL. The proxy allowlists reads and blocks transaction submission, wallet methods and node mutations. An Alchemy Free Arbitrum endpoint supports the required archive-state reads; no paid Debug/Trace API or broad historical-log access is required. Anvil paces upstream requests at 150 compute units/second, leaving headroom under the free plan's 300 CU/s limit, and retries throttled reads. The monthly provider quota still applies. Cold startup and new storage lookups consume provider RPC quota; paid endpoints can incur charges. `status` shows forwarded upstream read counts. No public-chain tokens are spent.

The fork read proxy returns no pre-fork mainnet logs. Anvil serves locally mined logs normally, including wide queries spanning the fork boundary. This keeps disposable E2E wallet history within the test timeline and avoids Alchemy Free's 10-block `eth_getLogs` limit. It is not a test of historical mainnet wallet recovery. Seed recovery tests recover payments made on the running local chain; keep that chain alive throughout the test.

## Commands

```sh
./usdt-fixture build
export USDT_TEST_ENV_FILE=/absolute/path/to/private.env
./usdt-fixture up
./usdt-fixture ps
./usdt-fixture check
./usdt-fixture smoke
./usdt-fixture bridge-smoke
./usdt-fixture fund 0xYOUR_TEST_WALLET 10
./usdt-fixture balance 0xYOUR_TEST_WALLET
eval "$(./usdt-fixture env)"
# When all journeys are finished:
./usdt-fixture down
```

`fund` executes an actual ERC-20 transfer from a storage-funded donor, producing real receipt/history events. It does not overwrite the recipient balance. `smoke` creates independent disposable Core wallets and checks first-use EIP-7702 delegation without ETH, two sends, USDT fees and the approved fee bound, pending/manual inclusion across wallet reopen, proof verification, incoming history, recovery into an empty database, changed request binding and rejected paymaster authorization. It restores provider/bundler modes and removes only its own temporary wallet files.

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
| `wallet sync`, then `wallet history` | Scan local payment history; repeat `sync` until `complete` is true |
| `wallet proof ID BINDING_FILE` | Create the standard proof after execution |
| `wallet verify BINDING_FILE PROOF_FILE` | Verify receipt, token, recipient and signature using the recipient Core wallet |

`USDT_WALLET_NAME` chooses a deterministic public test account. Wallet databases are kept under `/state/wallet` in the named volume. Put binding/proof input files in `.usdt/evidence/` on the host; tools read them at `/evidence/`. Redirect a wallet command's JSON output to a host file to save a proof. The mnemonic and derivation passphrases are public test material. Never use them for actual funds. `wallet` uses a no-op backup adapter; it is an execution/proof tool, not a VSS test. App recovery tests must use the existing VSS helpers.

The binding JSON uses Core's fields: `payer`, `payee`, `payment_app_id`, `payment_request_id`, `payment_reference`, `payment_endpoint_identifier`, `period_starts_at`, `period_ends_at`, `conversion_quote_id`. Use exact authenticated SDK values; absent optional values are empty strings. Proof verification alone does not check the requested price/deadline or prevent evidence reuse: the receiving app/server owns those rules.

## Fidelity and limits

- Real deployed USDT0, EntryPoint v0.8, wallet delegate and SingletonPaymaster bytecode execute on the fork. Only the test signer's authorization, test balances and EntryPoint deposit are initialized locally. Contracts check signatures and collect token fees.
- The local signer replaces Pimlico's hosted pricing/authorization service. It uses a fixed 3,000 USDT/ETH rate. Local gas/fee numbers are not production quotes.
- Alto runs with `safe-mode=false`: its strict tracing path does not handle this Anvil/EIP-7702 setup. Contract simulation and execution remain real; production bundler reputation/storage-access policy is not covered.
- Anvil is an EVM fork, not the Arbitrum sequencer or L1 rollup. Local inclusion/finality and gas do not prove real Arbitrum finality or Nitro fees.
- Orchestra operators, external deposit monitoring, route liquidity and LayerZero relaying are simulated by local HTTP providers. The real gateway validates their responses through `LOCAL_ORCHESTRA_URL` and `LOCAL_LAYERZERO_URL`; neither provider contacts its public API. Arbitrum credits/refunds execute real token transfers. Off-Arbitrum hashes and delivery states are fixture evidence, not destination-chain execution. Live operator delivery/refunds still need separate acceptance.
- Keep this on a trusted development host and private Docker network. Only gateway and control ports are published, on host loopback. Node, bundler, signer and upstream ports are not published. Other containers on the fixture network are trusted test infrastructure.

Published ports default to gateway 23453 and controls 23454; set `USDT_GATEWAY_PORT` and `USDT_CONTROL_PORT` before `up` and `env` to change them. `USDT_PROJECT` selects the isolated Compose project. Keep these settings and `USDT_TEST_ENV_FILE` consistent across commands. Internal ports are node 23450, Alto 23451, signing/router 23452, upstream read proxy 23455, Orchestra 23456, LayerZero 23457 and the read-only Shop RPC 23458. Android reverses the selected gateway port with adb; iOS uses loopback. Core intentionally does not accept `10.0.2.2` HTTP endpoints.

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
# Start ./usdt-fixture up first. Use a separate Shop project and keep it for recovery tests.
SHOP_ORDER_USDT=1 SHOP_ORDER_PROJECT=shop-usdt ./shop-order fetch
SHOP_ORDER_USDT=1 SHOP_ORDER_PROJECT=shop-usdt ./shop-order up
SHOP_ORDER_USDT=1 SHOP_ORDER_PROJECT=shop-usdt ./shop-order health
```

Follow the existing [Shop setup](shop-order.md) to register the seller and enable its USDT receiving address. Fund the payer on this fork, pay the original request, then assert the server's per-rail status and actual unlock. The overlay's read-only RPC sidecar shares Paykit Server's loopback network namespace. It reaches the fork through the fixture's private Compose network on Linux and Docker Desktop, without exposing node mutation methods or using a host route. Use the same `USDT_PROJECT` as the running fixture. An explicit `SHOP_ORDER_LOCKS_REV` overrides the default USDT-capable Locks revision. Do not point the verifier at mainnet while the app uses the fork.

The overlay is infrastructure wiring; a paid USDT Shop journey and browser unlock remain acceptance tests for the E2E suite. Reset only the dedicated `shop-usdt` project. Always use the same `SHOP_ORDER_USDT=1` and project value for subsequent commands, including teardown.

## Checks

```sh
./usdt-fixture build # Includes Rust fmt/build/clippy and fixture lint/tests
./usdt-fixture up
./usdt-fixture check
./usdt-fixture smoke
./usdt-fixture bridge-smoke
```
