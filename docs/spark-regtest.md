# Spark Regtest

The `spark` profile runs a Spark network of your own on bitkit-docker's regtest chain:

- three Spark operators;
- the Spark service provider (SSP), with its Lightning node and Alice, a second node that holds a channel with it;
- the Breez LNURL and data-sync servers;
- mempool.space (frontend and backend) as the explorer and the chain API the Spark SDK reads.

Use it for local development, offline E2E runs and emergency-exit tests, where you need to stop the operators and
mine to timelock maturity. Shared CI and staging stay on Lightspark's hosted regtest, which Breez tests on too.

## What runs

| Part | Version |
| --- | --- |
| Operators | `breez/spark@b54845c`, the last public operator commit, with `spark-regtest/operator-status-filter.patch` |
| SSP, Lightning nodes, LNURL server | `breez/spark-sdk@7b6124227`, the last commit on that operator, with `spark-regtest/sspd-silent-payment-proof.patch` |
| data-sync | `breez/data-sync@adaa7b1` |
| Chain | `spark-bitcoind` (Bitcoin Core 31.0), peered with bitkit-docker's `bitcoind` |
| Explorer and chain API | `mempool/backend` and `mempool/frontend` v3.3.1 on `mempool/electrs` v3.3.0 |

- **Why its own node.** Spark's transactions are v3 with P2A anchors, broadcast as packages. Bitcoin Core 26.0, which
  bitkit-docker's `bitcoind` runs, relays none of them.
  `spark-bitcoind` follows the same chain over P2P, so Savings, LND and Spark see the same blocks.
- **Mine with `./spark mine`.** A block mined on `bitcoind` (`./bitcoin-cli mine`) leaves Spark's transactions waiting
  in `spark-bitcoind`'s mempool. A block mined with `./spark` holds both nodes' transactions.
- **Why this operator.** Breez's current operator image is private. The patch makes the 1 Oct operator skip a tree node
  status SDK 0.27 and later ask for (`RETURNED`), which it never stores. Without it, wallet sync fails.
- **Why this SSP.** A newer SSP cannot talk to that operator. The SSP's patch is upstream's `silent_payment_proof` field
  (always null), which Spark SDK 0.28 asks for.
- **Builds.** The images build from the pinned sources on the first `./spark up`, which takes a while (Rust and Go).
  Later starts reuse them.
- **Keys.** `spark-regtest/spark.env` holds the fixed keys of upstream's local environment. They belong to this regtest
  network alone.

## Start

```bash
./spark up        # build, start bitkit-docker with the spark profile, and wait until a wallet can connect
./spark config    # the Spark config a wallet connects with (spark-regtest/data/spark-config.json)
./spark status
./spark down      # stop the Spark services; bitkit-docker keeps running
./spark reset     # stop them and delete their state
```

- **First start.** The operators generate 12,000 signing keys each, then the SSP stocks its leaf pool. `./spark up`
  prints the progress and ends with where every service is.
- **Mining.** While the stack sets up, `spark-miner` mines a block every 5 s. After that it mines only on request.
  `SPARK_BLOCK_INTERVAL_SECONDS=10 ./spark up` keeps a block every 10 s instead.
- **Funds.** On a chain under 200 blocks, the miner mines to 200 into its own wallet. On a longer chain, it takes 20 BTC
  from `bitcoind`'s wallet. If that wallet holds less, run `./bitcoin-cli fund`, then
  `docker compose restart spark-miner`.

| Setting | Default | What it sets |
| --- | --- | --- |
| `SPARK_PUBLIC_HOST` | `127.0.0.1` | The host the Spark config names for the operators and the SSP |
| `SPARK_BLOCK_INTERVAL_SECONDS` | `0` | Seconds between blocks once ready; `0` mines only on request |
| `SPARK_CHANNEL_SATS` | `50000000` | Alice's channel with the SSP's node, half of it pushed to the SSP |
| `SPARK_DKG_MIN_AVAILABLE_KEYS` | `12000` | Unused keyshares each operator keeps |

## Point a Bitkit dev build at it

Bitkit's regtest builds connect to Lightspark's hosted regtest by default. A dev build connects to this stack when it
gets two settings, read like `ESPLORA_URL`:

| Setting | Value | What the app does with it |
| --- | --- | --- |
| `SPARK_LOCAL_CONFIG_B64` | `./spark config --base64` | `parse_spark_config` gives the SDK's `spark_config`: the operators and the SSP. Fee ladders go off, since the 1 Oct operator rejects the anchorless refunds they build ("expected 2 outputs, got 1") |
| `SPARK_LOCAL_CHAIN_URL` | `http://127.0.0.1:23090/api` | The SDK's chain service (REST, type `MempoolSpace`) and the emergency exit's broadcaster |

- **Builds only.** Both settings apply to dev and regtest builds only. Left unset, the build stays on the hosted
  regtest.
- **Savings.** ldk-node stays on bitkit-docker's Electrum (`tcp://127.0.0.1:60001`), which is the same chain.
- **Reset.** `./spark reset` issues a new config, so build again or pass the new one at launch.

### Android emulator

```bash
SPARK_LOCAL_CONFIG_B64="$(./spark config --base64)" SPARK_LOCAL_CHAIN_URL=http://127.0.0.1:23090/api ./gradlew assembleDevDebug
for port in 23535 23536 23537 23049 23090 60001; do adb reverse tcp:$port tcp:$port; done
```

`adb reverse` gives the emulator the host's ports on its own loopback: the operators, the SSP, the chain API and Electrum.

### iOS simulator

The simulator shares the Mac's loopback, so the `127.0.0.1` URLs work as they are. Set the two settings at build time,
or pass them to a launch with the `SIMCTL_CHILD_` prefix (`SIMCTL_CHILD_SPARK_LOCAL_CONFIG_B64`,
`SIMCTL_CHILD_SPARK_LOCAL_CHAIN_URL`).

## Fund a wallet

```bash
./spark pay <bolt11> [sats]       # Alice pays the wallet's Spark invoice over Lightning (sats for an amountless one)
./spark send <address> 100000     # pay a Spark deposit, Savings or exit funding address, then mine 1 block
./spark send <address> 100000 -m 0  # the same, mining nothing
./spark invoice 10000             # an invoice of Alice's, for the wallet to pay out of Spark
```

A Spark deposit is claimed by the SSP once it confirms (1 block here).

## Run an exit test

A unilateral exit makes no operator calls, so stopped operators are the uncooperative case.

1. Fund the wallet on Spark (`./spark pay` or `./spark send` to its deposit address).
2. Stop the operators: `./spark operators stop` (or one: `./spark operators stop 1`). The proxy stays up, so the wallet
   reaches ports that do not answer.
3. Start the emergency exit in the app, then pay the fee funding address it shows: `./spark send <address> <sats>`.
4. Confirm the tree nodes: each package needs its parent confirmed, so run `./spark mine` once per step, until the app
   waits for the timelock.
5. Mature the refunds: `./spark mature` mines 2,000 blocks in steps of 100. A leaf's refund timelock starts at 2,000
   blocks and drops by 100 with each transfer.
6. Mine once more for the refunds, and again for the sweep to Savings.

Read the exit's on-chain state at any step:

```bash
./spark mempool                   # what waits for a block
./spark tx <txid>                 # status, inputs with their sequence (the CSV), and who spent each output
./spark address <address>         # an address's balance, UTXOs and transactions
```

The explorer at http://127.0.0.1:23090 shows the same.

**The operators broadcast first.** With the operators running, their watchtower broadcasts a matured refund itself,
50 blocks after maturity, with its fee taken from the leaf. To test that path:
- run `./spark operators start`;
- close the app;
- run `./spark mature` and `./spark mine 60`;
- reopen the app. The exit rebuilds (Redo) from the operators' refund.

**A stale state.** A previous owner can publish its older refund once that matures, 100 blocks after the current
owner's. To test it, restore the older wallet's storage, mine past both timelocks, and publish the old refund first.
The current owner's exit then has to report the leaf as lost.
