const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { rpc } = require('./rpc.cjs');
const { state, urls } = require('./config.cjs');
async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'smoke') return require('./smoke.cjs').smoke();
  if (command === 'bridge-smoke') return require('./bridge-smoke.cjs').smoke();
  if (command === 'wallet') {
    execFileSync('usdt-fixture-wallet', args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        USDT_WALLET_DIR: process.env.USDT_WALLET_DIR ?? path.join(state, 'wallet'),
      },
    });
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
  console.log('Use ./usdt-fixture help for commands.');
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
