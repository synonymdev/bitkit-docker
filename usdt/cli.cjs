const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { rpc } = require('./rpc.cjs');
const { setup, state } = require('./setup.cjs');
const { run, urls } = require('./run.cjs');
async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'setup') return setup();
  if (command === 'run') return run();
  if (command === 'smoke') return require('./smoke.cjs').smoke();
  if (command === 'bridge-smoke') return require('./bridge-smoke.cjs').smoke();
  if (command === 'wallet') {
    execFileSync(path.join(__dirname, 'wallet/target/debug/usdt-fixture-wallet'), args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        USDT_WALLET_DIR: process.env.USDT_WALLET_DIR ?? path.join(state, 'wallet'),
      },
    });
    return;
  }
  if (command === 'env') {
    console.log(
      `export USDT_RPC_URL=${urls.gateway}/v1/usdt/chain-rpc\nexport USDT_BUNDLER_URL=${urls.gateway}/v1/usdt/rpc\nexport USDT_DEPOSITS_URL=${urls.gateway}/v1/usdt/deposits\nexport USDT_BRIDGES_URL=${urls.gateway}/v1/usdt/bridges\nexport USDT_BRIDGE_NETWORKS=ethereum,polygon,plasma,stable\nexport USDT_FIXTURE_URL=${urls.control}`,
    );
    return;
  }
  if (
    [
      'status',
      'balance',
      'fund',
      'mine',
      'reset',
      'provider-mode',
      'bundling',
      'bundle',
      'orchestra',
      'layerzero',
      'layerzero-mode',
    ].includes(command)
  ) {
    console.log(JSON.stringify(await rpc(urls.control, command, args), null, 2));
    return;
  }
  if (command !== 'help') throw new Error(`Unknown command ${command}`);
  console.log(`Usage: ./usdt-fixture <command>
  setup                         Install pinned Anvil and build the gateway
  run                           Run local services until Ctrl-C
  smoke                         Real Core first/subsequent sends, fees, pending/restart and proofs
  bridge-smoke                  Real local funding/receipts through bridge provider fixtures
  wallet ARGS                   Core test wallet (address, send, refresh, history, proof, verify)
  env                           Print app endpoint exports
  status                        Health, versions and upstream read counts
  fund ADDRESS AMOUNT_USDT      Send real local tokens to a wallet
  balance ADDRESS               Read atomic USDT balance
  mine [COUNT]                  Mine blocks for history/finality checks
  provider-mode MODE            healthy | unavailable | expired | invalid-signature
  bundling MODE                 auto | manual (hold pending operations)
  bundle                        Include pending operations
  reset                         Reset this fixture's chain/mempool; reset test apps/peers too
  orchestra ARGS                list | deposit OWNER NETWORK USDT | advance ID STATUS | mode | fee | quote-ttl
  layerzero TX_HASH STATUS      Set delivery state for a real OFTSent receipt
  layerzero-mode MODE           healthy | unavailable | rate-limited | invalid-response
`);
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
