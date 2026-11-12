const assert = require('node:assert/strict');
const { rpc } = require('./rpc.cjs');
const { urls } = require('./config.cjs');
const { smoke: maxSmoke } = require('./max-smoke.cjs');

async function smoke() {
  // Prime Alto's estimation path, then verify its deployed contracts survive each reset.
  await maxSmoke();
  for (let reset = 0; reset < 2; reset++) {
    assert.equal(await rpc(urls.control, 'reset'), true);
    await maxSmoke();
  }
  console.log(JSON.stringify({ passed: true, resets: 2, maxSettlements: 3 }));
}
module.exports = { smoke };
