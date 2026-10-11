const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseAbi, encodeEventTopics, encodeAbiParameters } = require('viem');
const { OrchestraFixture } = require('./orchestra.cjs');
const { LayerZeroFixture, OFT, oftAbi } = require('./layerzero.cjs');
const { serveProvider } = require('./bridge-http.cjs');
const { serve } = require('./rpc.cjs');
const { TOKEN } = require('./contracts.cjs');
const { evmAddress, digest } = require('./bridge-assets.cjs');
const owner = evmAddress('payer');
const recipient = evmAddress('recipient');
const url = (path) => new URL(path, 'http://localhost');

test('outbound quotes bind real funding and retain their price through retries and settlement', async (t) => {
  let logs = [];
  let holdReceipt;
  const receipt = { status: '0x1', blockHash: digest('block'), transactionHash: digest('funding') };
  const node = await serve(0, (method) => {
    if (method === 'eth_blockNumber') return '0x10';
    if (method === 'eth_getLogs') return logs;
    if (method === 'eth_getTransactionReceipt') return holdReceipt ? holdReceipt() : receipt;
    throw new Error(`Unexpected ${method}`);
  });
  t.after(() => node.close());
  const fixture = new OrchestraFixture(`http://127.0.0.1:${node.address().port}`);
  const body = {
    sourceChain: 'arbitrum',
    sourceAsset: 'USDT',
    destinationChain: 'bsc',
    destinationAsset: 'USDT',
    refundChain: 'arbitrum',
    refundAddress: owner,
    recipientAddress: recipient,
    amount: '1000000',
  };
  const [quote, retry] = await Promise.all([
    fixture.request('POST', url('/v1/orchestration/quote'), body, 'same-request'),
    fixture.request('POST', url('/v1/orchestration/quote'), body, 'same-request'),
  ]);
  assert.deepEqual(retry, quote);
  assert.equal(quote.estimatedOut, '990000000000000000');
  await fixture.control(['fee', '0.1']);
  assert.deepEqual(
    await fixture.request('POST', url('/v1/orchestration/quote'), body, 'same-request'),
    quote,
  );
  await assert.rejects(
    fixture.request(
      'POST',
      url('/v1/orchestration/quote'),
      { ...body, amount: '2' },
      'same-request',
    ),
    /idempotency_conflict/,
  );
  await assert.rejects(fixture.advance(quote.quoteId, 'completed'), /no matching on-chain/);
  const abi = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  logs = [
    {
      address: TOKEN,
      topics: encodeEventTopics({
        abi,
        eventName: 'Transfer',
        args: { from: owner, to: quote.depositAddress },
      }),
      data: encodeAbiParameters([{ type: 'uint256' }], [1000000n]),
      transactionHash: digest('funding'),
      blockHash: digest('block'),
    },
  ];
  let releaseReceipt;
  const receiptRequested = new Promise((requested) => {
    holdReceipt = () => {
      holdReceipt = null;
      return new Promise((resolve) => {
        releaseReceipt = () => resolve(receipt);
        requested();
      });
    };
  });
  const pendingLookup = fixture.request(
    'GET',
    url(`/v1/orchestration/order?quoteId=${quote.quoteId}`),
  );
  await receiptRequested;
  const done = await fixture.advance(quote.quoteId, 'completed');
  releaseReceipt();
  assert.deepEqual((await pendingLookup).order, done);
  assert.equal(done.sourceTxHash, digest('funding'));
  assert.equal(done.amountOut, quote.estimatedOut);
  assert.deepEqual(await fixture.advance(quote.quoteId, 'completed'), done);
  await assert.rejects(fixture.advance(quote.quoteId, 'refunded'), /Settlement already selected/);
});

test('standing addresses preserve wallet ownership, history pagination and refund requests', async () => {
  const fixture = new OrchestraFixture('http://unused');
  const ref = `bitkit-arb-usdt-v1-${recipient.toLowerCase()}`;
  const instruction = { destination: { chain: 'arbitrum', asset: 'USDT', address: recipient } };
  const address = await fixture.request(
    'PUT',
    url(`/v1/standing-deposit-addresses/${ref}`),
    instruction,
  );
  assert.deepEqual(
    await fixture.request('GET', url(`/v1/standing-deposit-addresses/${ref}`)),
    address,
  );
  const deposit = fixture.addDeposit(recipient, 'bsc', '2');
  assert.equal(deposit.amount, '2000000000000000000');
  const path = `/v1/standing-deposit-addresses/${ref}`;
  assert.equal(
    (await fixture.request('GET', url(`${path}/deposits?offset=0`))).deposits[0].id,
    deposit.id,
  );
  assert.deepEqual((await fixture.request('GET', url(`${path}/deposits?offset=50`))).deposits, []);
  await assert.rejects(fixture.advance(deposit.id, 'refunded'), /through the app first/);
  await fixture.request('POST', url(`${path}/resolve`), {
    depositIds: [deposit.id],
    refundAddress: owner,
  });
  assert.equal(deposit.batchState, 'refund_requested');
  await fixture.advance(deposit.id, 'refunding');
  await fixture.request('POST', url(`${path}/resolve`), {
    depositIds: [deposit.id],
    refundAddress: owner,
  });
  assert.equal(deposit.batchState, 'refunding');
  await fixture.advance(deposit.id, 'refunded');
  await assert.rejects(fixture.advance(deposit.id, 'completed'), /Refund already requested/);
  assert.equal(
    (await fixture.request('GET', url(`${path}/deposits`))).deposits[0].status,
    'refunded',
  );
  fixture.reset();
  await assert.rejects(fixture.request('GET', url(path)), /not_found/);
});

test('LayerZero status uses the successful source receipt GUID and pathway', async (t) => {
  const hash = digest('source'),
    guid = digest('guid');
  let succeeded = true;
  const node = await serve(0, () => ({
    status: succeeded ? '0x1' : '0x0',
    transactionHash: hash,
    logs: [
      {
        address: OFT,
        topics: encodeEventTopics({
          abi: oftAbi,
          eventName: 'OFTSent',
          args: { guid, fromAddress: owner },
        }),
        data: encodeAbiParameters(
          [{ type: 'uint32' }, { type: 'uint256' }, { type: 'uint256' }],
          [30109, 1000000n, 1000000n],
        ),
      },
    ],
  }));
  t.after(() => node.close());
  const fixture = new LayerZeroFixture(`http://127.0.0.1:${node.address().port}`);
  const path = url(`/v1/messages/tx/${hash}`);
  const message = (await fixture.request('GET', path)).data[0];
  assert.equal(message.guid, guid);
  assert.equal(message.pathway.dstEid, 30109);
  assert.equal(message.status.name, 'INFLIGHT');
  for (const state of ['BLOCKED', 'DELIVERED', 'APPLICATION_BURNED'])
    assert.equal((await fixture.set(hash, state)).data[0].status.name, state);
  succeeded = false;
  assert.deepEqual((await fixture.request('GET', path)).data, []);
  await assert.rejects(fixture.set(hash, 'DELIVERED'), /no successful OFTSent/);
});

test('provider HTTP fixtures require local requests and expose controlled outages', async (t) => {
  const fixture = new OrchestraFixture('http://unused');
  const server = await serveProvider(0, fixture, 'fixture-key');
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address().port}/v2/orchestration/routes`;
  assert.equal((await fetch(endpoint)).status, 400);
  const headers = { authorization: 'Bearer fixture-key' };
  assert.equal(
    (await fetch(endpoint, { headers: { ...headers, origin: 'https://example.com' } })).status,
    400,
  );
  for (const [mode, status] of [
    ['unavailable', 503],
    ['rate-limited', 429],
    ['invalid-response', 200],
    ['healthy', 200],
  ]) {
    await fixture.control(['mode', mode]);
    const response = await fetch(endpoint, { headers });
    assert.equal(response.status, status);
    if (mode === 'healthy') assert.equal((await response.json()).assets.length, 8);
  }
});
