const { readFileSync } = require('node:fs');
const { parseEnv } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const assert = require('node:assert/strict');
const { toHex } = require('viem');
const { rpc, serve, upstreamReader } = require('./rpc.cjs');
const {
  TOKEN,
  ENTRY,
  PAYMASTER,
  RATE,
  BALANCE_SLOT,
  initialize,
  paymasterData,
  atomicAmount,
  transfer,
  balance,
} = require('./contracts.cjs');
const { ports, urls } = require('./config.cjs');
const pins = require('./pins.json');
const { serveProvider } = require('./bridge-http.cjs');
const { OrchestraFixture } = require('./orchestra.cjs');
const { LayerZeroFixture } = require('./layerzero.cjs');

async function run() {
  const { ARBITRUM_RPC_URL: upstream } = parseEnv(
    readFileSync('/run/secrets/usdt_upstream', 'utf8'),
  );
  if (!upstream || new URL(upstream).protocol !== 'https:')
    throw new Error('Provide an HTTPS ARBITRUM_RPC_URL in USDT_TEST_ENV_FILE');
  const servers = [];
  let finish;
  const lifetime = new Promise((resolve) => {
    finish = resolve;
  });
  const stop = () => finish();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const reads = {};
    const read = upstreamReader(upstream);
    servers.push(
      await serve(ports.upstream, async (method, params) => {
        // Test history starts after the fork; Anvil keeps locally mined logs itself.
        if (method === 'eth_getLogs') return [];
        reads[method] = (reads[method] ?? 0) + 1;
        return read(method, params);
      }),
    );
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        await rpc(urls.node, 'eth_chainId');
        ready = true;
        break;
      } catch {
        await delay(500);
      }
    }
    assert(ready, 'Anvil did not start');
    await rpc(urls.node, 'evm_setNextBlockTimestamp', [Math.floor(Date.now() / 1000)]);
    await initialize(urls.node);
    // Shop's verifier can read this fork over the private Compose network.
    servers.push(await serve(ports.reader, upstreamReader(urls.node), '0.0.0.0'));
    let mode = 'healthy';
    const max = { estimatesWithOverride: 0, paymasterAuthorizations: 0, submissions: 0 };
    servers.push(
      await serve(ports.provider, async (method, params) => {
        if (mode === 'unavailable')
          throw Object.assign(new Error('Fixture provider unavailable'), { httpStatus: 503 });
        // Startup readiness must not depend on Alto, which waits for this provider.
        if (method === 'eth_chainId') return rpc(urls.node, method, params);
        if (method === 'pimlico_getTokenQuotes')
          return {
            quotes: [
              {
                token: TOKEN,
                paymaster: PAYMASTER,
                postOpGas: toHex(50000),
                exchangeRate: toHex(RATE),
                balanceSlot: toHex(BALANCE_SLOT),
              },
            ],
          };
        if (method === 'pm_getPaymasterStubData' || method === 'pm_getPaymasterData') {
          if (method === 'pm_getPaymasterData') max.paymasterAuthorizations++;
          return paymasterData(urls.node, params, mode);
        }
        if (method === 'eth_estimateUserOperationGas' && params[2] !== undefined)
          max.estimatesWithOverride++;
        if (method === 'eth_sendUserOperation') max.submissions++;
        return rpc(urls.alto, method, params);
      }),
    );
    const orchestra = new OrchestraFixture(urls.node);
    const layerzero = new LayerZeroFixture(urls.node);
    servers.push(await serveProvider(ports.orchestra, orchestra, 'local-orchestra-fixture'));
    servers.push(await serveProvider(ports.layerzero, layerzero));
    // Alto deploys simulation contracts before opening its RPC server. Preserve those
    // deployments in the reset baseline, otherwise quotes fail after evm_revert.
    let altoReady = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        const entrypoints = await rpc(urls.alto, 'eth_supportedEntryPoints');
        if (entrypoints.some((entry) => entry.toLowerCase() === ENTRY.toLowerCase())) {
          altoReady = true;
          break;
        }
      } catch {
        // Alto may still be deploying its simulation contracts.
      }
      await delay(500);
    }
    assert(altoReady, 'Alto did not start');
    let snapshot = await rpc(urls.node, 'evm_snapshot');
    servers.push(
      await serve(
        ports.control,
        async (method, params) => {
          switch (method) {
            case 'status':
              return {
                chainId: 42161,
                forkBlock: pins.forkBlock,
                mode,
                max: { ...max },
                urls: {
                  ...urls,
                  gateway: `http://127.0.0.1:${process.env.USDT_GATEWAY_PORT ?? ports.gateway}`,
                  control: `http://127.0.0.1:${process.env.USDT_CONTROL_PORT ?? ports.control}`,
                },
                reads,
                block: await rpc(urls.node, 'eth_blockNumber'),
                versions: pins,
              };
            case 'balance':
              return (await balance(urls.node, params[0])).toString();
            case 'fund':
              return transfer(urls.node, params[0], atomicAmount(params[1]));
            case 'orchestra':
              return orchestra.control(params);
            case 'layerzero':
              return layerzero.set(...params);
            case 'layerzero-mode':
              return layerzero.setMode(params[0]);
            case 'mine': {
              const count = Number(params[0] ?? 3);
              if (!Number.isInteger(count) || count < 1 || count > 1000)
                throw new Error('Mine 1-1000 blocks');
              return rpc(urls.node, 'anvil_mine', [count]);
            }
            case 'provider-mode':
              if (!['healthy', 'unavailable', 'expired', 'invalid-signature'].includes(params[0]))
                throw new Error('Unknown provider mode');
              mode = params[0];
              return mode;
            case 'bundling':
              if (!['auto', 'manual'].includes(params[0])) throw new Error('Use auto or manual');
              return rpc(urls.alto, 'debug_bundler_setBundlingMode', [params[0]]);
            case 'bundle':
              return rpc(urls.alto, 'debug_bundler_sendBundleNow');
            case 'reset':
              await rpc(urls.alto, 'debug_bundler_setBundlingMode', ['manual']);
              await rpc(urls.alto, 'debug_bundler_clearState');
              assert.equal(await rpc(urls.node, 'evm_revert', [snapshot]), true);
              await rpc(urls.node, 'evm_setNextBlockTimestamp', [Math.floor(Date.now() / 1000)]);
              await rpc(urls.node, 'anvil_mine', [1]);
              snapshot = await rpc(urls.node, 'evm_snapshot');
              orchestra.reset();
              layerzero.reset();
              mode = 'healthy';
              await rpc(urls.alto, 'debug_bundler_setBundlingMode', ['auto']);
              return true;
            default:
              throw new Error('Unknown fixture command');
          }
        },
        '0.0.0.0',
      ),
    );
    console.log(JSON.stringify({ ready: true, forkBlock: pins.forkBlock }));
    await lifetime;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    for (const server of servers) server.close();
  }
}
run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
