const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { rpc } = require('./rpc.cjs');
const { state, root } = require('./setup.cjs');
const { urls } = require('./run.cjs');
const exec = promisify(execFile);
async function smoke() {
  const directory = mkdtempSync(path.join(state, 'smoke-'));
  const runId = randomUUID();
  const wallet = async (name, ...args) => {
    const { stdout } = await exec(
      path.join(__dirname, 'wallet/target/debug/usdt-fixture-wallet'),
      args,
      {
        cwd: root,
        env: { ...process.env, USDT_WALLET_DIR: directory, USDT_WALLET_NAME: `${runId}-${name}` },
        timeout: 120000,
      },
    );
    return JSON.parse(stdout);
  };
  const settled = async (id) => {
    for (let i = 0; i < 40; i++) {
      const payment = await wallet('sender', 'refresh', id);
      if (payment.status !== 'Pending') {
        assert.equal(payment.status, 'Confirmed');
        return payment;
      }
      await delay(500);
    }
    throw new Error('Local payment did not confirm');
  };
  try {
    assert.equal((await rpc(urls.control, 'status')).mode, 'healthy');
    const sender = (await wallet('sender', 'address')).address;
    const recipient = (await wallet('recipient', 'address')).address;
    assert.equal(BigInt(await rpc(urls.node, 'eth_getBalance', [sender, 'latest'])), 0n);
    assert.equal(await rpc(urls.node, 'eth_getCode', [sender, 'latest']), '0x');
    await rpc(urls.control, 'fund', [sender, '20']);
    const before = BigInt(await rpc(urls.control, 'balance', [sender]));
    const first = await wallet('sender', 'send', recipient, '500000');
    const executed = await settled(first.transfer.id);
    assert(executed.fee > 0 && executed.fee <= first.quote.maximum_fee);
    assert.equal(
      BigInt(await rpc(urls.control, 'balance', [sender])),
      before - 500000n - BigInt(executed.fee),
    );
    assert.equal(BigInt(await rpc(urls.control, 'balance', [recipient])), 500000n);
    assert.match(await rpc(urls.node, 'eth_getCode', [sender, 'latest']), /^0xef0100/);
    assert.equal(BigInt(await rpc(urls.node, 'eth_getBalance', [sender, 'latest'])), 0n);

    // All CLI calls reopen the persisted Core wallet, including the held second operation.
    await rpc(urls.control, 'bundling', ['manual']);
    const second = await wallet('sender', 'send', recipient, '250000');
    assert.equal(second.transfer.status, 'Pending');
    assert.equal((await wallet('sender', 'refresh', second.transfer.id)).status, 'Pending');
    assert.equal(BigInt(await rpc(urls.control, 'balance', [recipient])), 500000n);
    await rpc(urls.control, 'bundle');
    await settled(second.transfer.id);
    assert.equal(BigInt(await rpc(urls.control, 'balance', [recipient])), 750000n);

    const binding = {
      payer: 'fixture-payer',
      payee: 'fixture-payee',
      payment_app_id: 'paykit-server',
      payment_request_id: randomUUID(),
      payment_reference: runId,
      payment_endpoint_identifier: 'usdt-arbitrum-address',
      period_starts_at: '',
      period_ends_at: '',
      conversion_quote_id: '',
    };
    const bindingFile = path.join(directory, 'binding.json');
    const proofFile = path.join(directory, 'proof.json');
    writeFileSync(bindingFile, JSON.stringify(binding));
    const proof = await wallet('sender', 'proof', first.transfer.id, bindingFile);
    assert(proof);
    writeFileSync(proofFile, JSON.stringify(proof));
    const verified = await wallet('recipient', 'verify', bindingFile, proofFile);
    assert.equal(verified.amount, 500000);
    writeFileSync(
      bindingFile,
      JSON.stringify({ ...binding, payment_reference: 'another-request' }),
    );
    await assert.rejects(
      wallet('recipient', 'verify', bindingFile, proofFile),
      'changed request binding must fail',
    );
    await rpc(urls.control, 'provider-mode', ['invalid-signature']);
    const rejected = await wallet('sender', 'send', recipient, '100000');
    assert.equal(rejected.transfer.status, 'Pending');
    assert.equal(
      (await rpc(urls.alto, 'debug_bundler_dumpMempool', [require('./contracts.cjs').ENTRY]))
        .length,
      0,
    );
    assert.equal(BigInt(await rpc(urls.control, 'balance', [recipient])), 750000n);
    console.log(
      JSON.stringify({
        passed: true,
        first: executed.tx_hash,
        second: second.transfer.id,
        proof: verified.payment_id,
      }),
    );
  } finally {
    await rpc(urls.control, 'provider-mode', ['healthy']);
    await rpc(urls.control, 'bundling', ['auto']);
    rmSync(directory, { recursive: true, force: true });
  }
}
module.exports = { smoke };
