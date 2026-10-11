const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { readFileSync, mkdirSync, createWriteStream } = require('node:fs');
const { parseEnv } = require('node:util');
const { createServer } = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const path = require('node:path');
const { toHex } = require('viem');
const { rpc, serve, upstreamReader } = require('./rpc.cjs');
const {
  TOKEN,
  ENTRY,
  PAYMASTER,
  executor,
  RATE,
  BALANCE_SLOT,
  initialize,
  paymasterData,
  atomicAmount,
  transfer,
  balance,
} = require('./contracts.cjs');
const { state } = require('./setup.cjs');
const pins = require('./pins.json');
const ports = {
  node: 23450,
  alto: 23451,
  provider: 23452,
  gateway: 23453,
  control: 23454,
  upstream: 23455,
};
const urls = Object.fromEntries(
  Object.entries(ports).map(([name, port]) => [name, `http://127.0.0.1:${port}`]),
);

async function waitReady(check, children) {
  for (let i = 0; i < 240; i++) {
    if (children.some((child) => child.exitCode !== null || child.signalCode !== null)) {
      throw new Error('Fixture process stopped; inspect .usdt/logs');
    }
    try {
      return await check();
    } catch {
      await delay(250);
    }
  }
  throw new Error('Fixture startup timed out; inspect .usdt/logs');
}
async function run() {
  const env = process.env.USDT_TEST_ENV_FILE
    ? parseEnv(readFileSync(process.env.USDT_TEST_ENV_FILE, 'utf8'))
    : process.env;
  const upstream = env.ARBITRUM_RPC_URL;
  if (!upstream || new URL(upstream).protocol !== 'https:')
    throw new Error(
      'Set an HTTPS ARBITRUM_RPC_URL in the environment or private USDT_TEST_ENV_FILE',
    );
  const anvil = path.join(state, 'bin', 'anvil');
  assert.match(execFileSync(anvil, ['--version'], { encoding: 'utf8' }), /1\.8\.5/);
  // Refuse occupied ports before starting or mutating any node.
  for (const port of Object.values(ports)) {
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    await new Promise((resolve) => server.close(resolve));
  }
  mkdirSync(path.join(state, 'logs'), { recursive: true, mode: 0o700 });
  const children = [];
  const servers = [];
  let failed;
  let finish;
  const lifetime = new Promise((resolve) => {
    finish = resolve;
  });
  function child(name, command, args, extraEnv = {}) {
    const log = createWriteStream(path.join(state, 'logs', `${name}.log`), { mode: 0o600 });
    const proc = spawn(command, args, {
      cwd: state,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(proc);
    proc.stdout.pipe(log);
    proc.stderr.pipe(log);
    proc.once('error', () => {
      failed = new Error(`${name} could not start`);
      finish();
    });
    proc.once('exit', (code) => {
      if (code) failed = new Error(`${name} exited with ${code}; inspect .usdt/logs`);
      finish();
    });
    return proc;
  }
  const stop = () => finish();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const reads = {};
    const read = upstreamReader(upstream);
    servers.push(
      await serve(ports.upstream, async (method, params) => {
        reads[method] = (reads[method] ?? 0) + 1;
        return read(method, params);
      }),
    );
    child('anvil', anvil, [
      '--host',
      '127.0.0.1',
      '--port',
      String(ports.node),
      '--fork-url',
      urls.upstream,
      '--fork-block-number',
      String(pins.forkBlock),
      '--chain-id',
      '42161',
      '--hardfork',
      'prague',
      '--silent',
      '--block-time',
      '1',
    ]);
    await waitReady(() => rpc(urls.node, 'eth_chainId'), children);
    await rpc(urls.node, 'evm_setNextBlockTimestamp', [Math.floor(Date.now() / 1000)]);
    await initialize(urls.node);
    const key = toHex(executor.getHdKey().privateKey);
    const alto = path.join(__dirname, 'node_modules/@pimlico/alto/esm/cli/alto.js');
    child('alto', process.execPath, [
      alto,
      '--entrypoints',
      ENTRY,
      '--rpc-url',
      urls.node,
      '--executor-private-keys',
      key,
      '--utility-private-key',
      key,
      '--port',
      String(ports.alto),
      '--chain-type',
      'default',
      '--safe-mode',
      'false',
      '--enable-debug-endpoints',
      'true',
      '--min-executor-balance',
      '0',
      '--log-level',
      'warn',
      '--json',
      'true',
    ]);
    await waitReady(() => rpc(urls.alto, 'eth_supportedEntryPoints'), children);
    let mode = 'healthy';
    servers.push(
      await serve(ports.provider, async (method, params) => {
        if (mode === 'unavailable')
          throw Object.assign(new Error('Fixture provider unavailable'), { httpStatus: 503 });
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
          return paymasterData(urls.node, params, mode);
        }
        return rpc(urls.alto, method, params);
      }),
    );
    const service = path.join(state, 'service');
    child('gateway', process.execPath, [path.join(service, 'dist/index.js')], {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(ports.gateway),
      ARBITRUM_RPC_URL: urls.node,
      LOCAL_PROVIDER_URL: urls.provider,
      PIMLICO_API_KEY: '',
      ORCHESTRA_API_KEY: '',
      ORCHESTRA_BRIDGE_SECRET: '',
      ORCHESTRA_BRIDGE_NETWORKS: '',
      ORCHESTRA_DEPOSIT_NETWORKS: '',
      USDT_BRIDGE_NETWORKS: '',
      REQUESTS_PER_MINUTE: '10000',
      GLOBAL_REQUESTS_PER_MINUTE: '100000',
    });
    await waitReady(async () => {
      const response = await fetch(`${urls.gateway}/healthz`);
      if (!response.ok) throw new Error('Gateway is not ready');
    }, children);
    let snapshot = await rpc(urls.node, 'evm_snapshot');
    servers.push(
      await serve(ports.control, async (method, params) => {
        switch (method) {
          case 'status':
            return {
              chainId: 42161,
              forkBlock: pins.forkBlock,
              mode,
              urls,
              reads,
              block: await rpc(urls.node, 'eth_blockNumber'),
              versions: pins,
            };
          case 'balance':
            return (await balance(urls.node, params[0])).toString();
          case 'fund':
            return transfer(urls.node, params[0], atomicAmount(params[1]));
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
            mode = 'healthy';
            await rpc(urls.alto, 'debug_bundler_setBundlingMode', ['auto']);
            return true;
          default:
            throw new Error('Unknown fixture command');
        }
      }),
    );
    console.log(JSON.stringify({ ready: true, ...urls, forkBlock: pins.forkBlock }));
    await lifetime;
    if (failed) throw failed;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    for (const server of servers) server.close();
    for (const proc of children.reverse()) {
      if (proc.exitCode !== null || proc.signalCode !== null) continue;
      proc.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => proc.once('exit', resolve)), delay(3000)]);
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    }
  }
}
module.exports = { run, ports, urls };
