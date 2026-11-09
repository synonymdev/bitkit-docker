# spark-regtest

The `spark` compose profile, which `docker-compose.yml` includes. [docs/spark-regtest.md](../docs/spark-regtest.md)
explains how to use it.

| Path | What it is |
| --- | --- |
| `compose.yml` | Every Spark service, prefixed `spark-`, in the `spark` profile |
| `operator.dockerfile`, `operator-status-filter.patch` | The operator from `breez/spark@b54845c`, patched |
| `sspd.dockerfile`, `sspd-silent-payment-proof.patch` | The SSP from `breez/spark-sdk@7b6124227`, with upstream's `ce29ca045` |
| `migrations.dockerfile` | The operators' database schema from the same commit |
| `tools.dockerfile`, `scripts/` | The image the setup scripts run in, with the SSP's and the Lightning nodes' CLIs |
| `config/` | nginx for the operator proxy and mempool, and the databases Postgres creates |
| `spark.env` | Fixed keys for this regtest network alone |
| `data/` | Written at start: `spark-config.json`, the config a wallet connects with (not committed) |

## Upstream

`scripts/`, `config/`, `spark.env`, the dockerfiles and `compose.yml` are adapted from
[breez/spark-sdk](https://github.com/breez/spark-sdk) `regtest/local` and `crates/spark-itest/docker` at `7b6124227`,
the last commit there built on the public operator. They are © 2025 Breez, under the MIT License.

What differs:

- Service names carry a `spark-` prefix, and host ports sit in bitkit-docker's 23000-23999 range.
- `spark-bitcoind` (Core 31.0) peers with bitkit-docker's `bitcoind` instead of running a chain of
  its own. Before it mines, `miner.sh` waits until it holds that chain (`wait_for_chain_sync` in `lib.sh`).
- Its wallet is topped up from `bitcoind`'s wallet, since a long shared chain pays little per coinbase. `funder.sh`
  waits for 1 BTC instead of 1,000.
- Its wallet's keys are fixed (`SPARK_WALLET_TPRV` in `spark.env`), so it keeps its coins across `./spark reset`.
- `ready.sh` says when that wallet cannot fund the SSP, and its wait for the chain API keeps the startup deadline.
- Mining defaults to on request once the stack is ready.
- The SSP carries upstream's `ce29ca045` (the `silent_payment_proof` field, always null), which Spark SDK 0.28 asks for.
  Newer SSPs cannot talk to the public operator, so the SSP, ldk-server and LNURL server stay on `7b6124227`.
- `summary.sh` prints `./spark` commands.

Breez's current operator is private, so the operator stays on `b54845c` and the rest on the spark-sdk commit built on
it. When a Spark SDK release asks the SSP for something new, backport the SSP change from spark-sdk as another patch.
