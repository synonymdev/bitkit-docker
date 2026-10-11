const assert = require('node:assert/strict');
const { test } = require('node:test');
const { rpc, serve, upstreamReader } = require('./rpc.cjs');
const { atomicAmount } = require('./contracts.cjs');

test('upstream forwards reads, blocks writes and hides provider credentials', async (t) => {
  const calls = [];
  const server = await serve(0, (method) => {
    calls.push(method);
    if (method === 'eth_chainId') return '0xa4b1';
    throw new Error('private upstream URL or credential');
  });
  t.after(() => server.close());
  const read = upstreamReader(`http://127.0.0.1:${server.address().port}`);
  assert.equal(await read('eth_chainId', []), '0xa4b1');
  for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'anvil_setStorageAt']) {
    await assert.rejects(read(method, []), /writes are disabled/);
  }
  await assert.rejects(read('eth_getCode', []), { message: 'Upstream read failed: eth_getCode' });
  assert.deepEqual(calls, ['eth_chainId', 'eth_getCode']);
});

test('upstream preserves HTTP and JSON-RPC throttling without provider diagnostics', async (t) => {
  const server = await serve(0, (method) => {
    throw Object.assign(
      new Error('private provider diagnostics'),
      method === 'eth_chainId' ? { httpStatus: 429 } : { code: 429, data: 'secret' },
    );
  });
  t.after(() => server.close());
  const read = upstreamReader(`http://127.0.0.1:${server.address().port}`);
  for (const method of ['eth_chainId', 'eth_getCode']) {
    await assert.rejects(read(method, []), (error) => {
      assert.equal(error.httpStatus, 429);
      assert.equal(error.message, `Upstream read failed: ${method}`);
      assert.equal(error.data, undefined);
      return true;
    });
  }
});

test('local RPC preserves errors and rejects browser control requests', async (t) => {
  let calls = 0;
  const server = await serve(0, () => {
    calls++;
    throw Object.assign(new Error('operation rejected'), { code: -32507, data: 'fixture' });
  });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(rpc(url, 'eth_sendUserOperation'), { code: -32507, data: 'fixture' });
  const response = await fetch(url, {
    method: 'POST',
    headers: { origin: 'https://example.org' },
    body: JSON.stringify({ method: 'reset' }),
  });
  assert((await response.json()).error);
  assert.equal(calls, 1);
});

test('funding uses exact positive six-decimal USDT amounts', () => {
  assert.equal(atomicAmount('0.000001'), 1n);
  assert.equal(atomicAmount('12.345678'), 12345678n);
  for (const amount of ['0', '-1', '1e6', '0.0000001', '1000000001', '01', '']) {
    assert.throws(() => atomicAmount(amount));
  }
});
