const { setTimeout: delay } = require('node:timers/promises');
const { rpc } = require('./rpc.cjs');
const { urls } = require('./config.cjs');

async function main() {
  const url = urls[process.argv[2]];
  if (!url) throw new Error('Unknown fixture service');
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      await rpc(url, 'eth_chainId');
      return;
    } catch {
      await delay(500);
    }
  }
  throw new Error('Fixture RPC did not become ready');
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
