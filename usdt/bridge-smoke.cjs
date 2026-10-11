const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { mkdtempSync, rmSync } = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { rpc } = require('./rpc.cjs');
const { urls } = require('./run.cjs');
const { state } = require('./setup.cjs');
const exec = promisify(execFile);
async function smoke() {
  const directory = mkdtempSync(path.join(state, 'bridge-smoke-'));
  const name = randomUUID();
  const wallet = async (account, ...args) => {
    const { stdout } = await exec(
      path.join(__dirname, 'wallet/target/debug/usdt-fixture-wallet'),
      args,
      {
        env: { ...process.env, USDT_WALLET_DIR: directory, USDT_WALLET_NAME: `${name}-${account}` },
        timeout: 180000,
      },
    );
    return JSON.parse(stdout);
  };
  const control = (...args) => rpc(urls.control, 'orchestra', args);
  const refresh = async (id, status) => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const payment = await wallet('sender', 'refresh', id);
      if (payment.status === status) return payment;
      await delay(500);
    }
    throw new Error(`Payment did not reach ${status}`);
  };
  try {
    await control('mode', 'healthy');
    await control('fee', '0.01');
    const sender = (await wallet('sender', 'address')).address;
    const recipient = (await wallet('recipient', 'address')).address;
    await rpc(urls.control, 'fund', [sender, '200']);

    const depositAddress = await wallet('recipient', 'deposit', 'receive', 'polygon', '3500000');
    assert.notEqual(depositAddress.address, recipient);
    const deposit = await control('deposit', recipient, 'polygon', '3.5');
    assert.equal((await wallet('recipient', 'deposit', 'history')).deposits[0].id, deposit.id);
    await control('advance', deposit.id, 'processing');
    const [delivery, duplicate] = await Promise.all([
      control('advance', deposit.id, 'completed'),
      control('advance', deposit.id, 'completed'),
    ]);
    assert.equal(delivery.destinationTxHash, duplicate.destinationTxHash);
    assert.equal(BigInt(await rpc(urls.control, 'balance', [recipient])), 3490000n);
    assert.equal(
      (await wallet('recipient', 'deposit', 'detail', deposit.id)).order.status,
      'completed',
    );
    const held = await control('deposit', recipient, 'polygon', '2');
    await wallet('recipient', 'deposit', 'refund', held.id, sender, 'polygon');
    await control('advance', held.id, 'refunded');
    assert.equal(
      (await wallet('recipient', 'deposit', 'detail', held.id)).order.status,
      'refunded',
    );

    const first = await wallet('sender', 'send', recipient, '2000000', 'Bsc');
    assert.equal(first.quote.bridge_provider, 'Orchestra');
    await refresh(first.transfer.id, 'Bridging');
    await control(
      'advance',
      (await wallet('sender', 'history')).find((t) => t.id === first.transfer.id).orchestra
        .quote_id,
      'completed',
    );
    const completed = await refresh(first.transfer.id, 'Confirmed');
    assert.equal(completed.received_amount, 1990000);

    const second = await wallet('sender', 'send', recipient, '2000000', 'Bsc');
    const pending = await refresh(second.transfer.id, 'Bridging');
    await control('advance', pending.orchestra.quote_id, 'needs_attention');
    await refresh(second.transfer.id, 'BridgeNeedsAttention');
    const before = BigInt(await rpc(urls.control, 'balance', [sender]));
    const returned = await control('advance', pending.orchestra.quote_id, 'refunded');
    await control('advance', pending.orchestra.quote_id, 'refunded');
    const refunded = await refresh(second.transfer.id, 'BridgeRefunded');
    assert.equal(refunded.orchestra.refund_tx, returned.refundTxHash);
    assert.equal(BigInt(await rpc(urls.control, 'balance', [sender])) - before, 2000000n);

    // Make the Orchestra quote unavailable so Core chooses the deployed USDT0 route.
    await control('fee', '100');
    const third = await wallet('sender', 'send', recipient, '2000000', 'Polygon');
    assert.equal(third.quote.bridge_provider, 'Usdt0');
    const bridging = await refresh(third.transfer.id, 'Bridging');
    await rpc(urls.control, 'layerzero', [bridging.tx_hash, 'BLOCKED']);
    await refresh(third.transfer.id, 'BridgeNeedsAttention');
    await rpc(urls.control, 'layerzero', [bridging.tx_hash, 'DELIVERED']);
    await refresh(third.transfer.id, 'Confirmed');
    console.log(
      JSON.stringify({
        passed: true,
        inbound: delivery.destinationTxHash,
        orchestra: completed.tx_hash,
        refund: returned.refundTxHash,
        usdt0: bridging.tx_hash,
      }),
    );
  } finally {
    await control('mode', 'healthy');
    await control('fee', '0.01');
    await rpc(urls.control, 'layerzero-mode', ['healthy']);
    rmSync(directory, { recursive: true, force: true });
  }
}
module.exports = { smoke };
