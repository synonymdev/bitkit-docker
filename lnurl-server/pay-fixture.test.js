const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('crypto');
const bolt11 = require('bolt11');
const { decode } = require('lnurl');
const { createApp } = require('./pay-fixture');

test('LNURL metadata stays available while callbacks fail until explicitly switched healthy', async (t) => {
    const server = createApp().listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (path) => {
        const res = await fetch(`${base}${path}`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        return res.json();
    };
    const setMode = (mode) => fetch(`${base}/fixture`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode })
    });

    const generated = await get('/generate/pay');
    assert.equal(decode(generated.lnurl), `${base}/pay/fixture`);
    assert.match(generated.qrCode, /^data:image\/png;base64,/);
    const pay = await get('/pay/fixture');
    assert.equal(pay.tag, 'payRequest');
    assert.deepEqual(JSON.parse(pay.metadata), [['text/plain', 'LNURL-pay regtest fixture']]);
    assert.equal(pay.callback, `${base}/pay/fixture/callback`);
    const callbackPath = '/pay/fixture/callback?amount=100001';
    for (let attempt = 0; attempt < 2; attempt++) {
        assert.equal((await get(callbackPath)).status, 'ERROR');
    }
    assert.equal((await get('/fixture')).mode, 'error');
    assert.equal((await setMode('invalid')).status, 400);
    assert.equal((await get('/fixture')).mode, 'error');
    assert.equal((await setMode('healthy')).status, 200);
    assert.deepEqual(await get('/pay/fixture'), pay);

    const response = await get(callbackPath);
    const invoice = bolt11.decode(response.pr);
    assert.equal(invoice.network.bech32, 'bcrt');
    assert.equal(invoice.millisatoshis, '100001');
    assert.equal(invoice.tagsObject.purpose_commit_hash, createHash('sha256').update(pay.metadata).digest('hex'));
    assert.equal(invoice.payeeNodeKey, '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
    assert.equal(invoice.tagsObject.payment_secret.length, 64);
    assert.ok(invoice.timeExpireDate > Date.now() / 1000);
    assert.deepEqual(response.routes, []);
    assert.notEqual((await get(callbackPath)).pr, response.pr);

    for (const amount of ['', '0', '999', '1000000001', '1000.5', '1000x', '-1000', '9007199254740993']) {
        assert.equal((await get(`/pay/fixture/callback?amount=${amount}`)).status, 'ERROR');
    }
    assert.equal((await get('/pay/fixture/callback')).status, 'ERROR');
    assert.equal((await get('/pay/fixture/callback?amount=1000&amount=2000')).status, 'ERROR');
    assert.equal((await get('/health')).network, 'regtest');
    await setMode('error');
    assert.equal((await get(callbackPath)).status, 'ERROR');
});

test('a delayed callback is held until its time passes or the next mode change releases it', async (t) => {
    const server = createApp({}).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (path) => (await fetch(`${base}${path}`)).json();
    const setMode = (body) => fetch(`${base}/fixture`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const callbackPath = '/pay/fixture/callback?amount=21000';

    assert.equal((await setMode({ mode: 'delay', ms: -1 })).status, 400);
    assert.equal((await setMode({ mode: 'delay', ms: 300 })).status, 200);
    let start = Date.now();
    assert.ok(bolt11.decode((await get(callbackPath)).pr));
    assert.ok(Date.now() - start >= 280);

    assert.equal((await setMode({ mode: 'delay' })).status, 200);
    start = Date.now();
    const held = get(callbackPath);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((await get('/fixture')).held, 1);
    await setMode({ mode: 'error' });
    assert.equal((await held).status, 'ERROR');
    assert.ok(Date.now() - start >= 190);
    const state = await get('/fixture');
    assert.equal(state.held, 0);
    assert.deepEqual(state.callbacks.map((c) => c.answer), ['invoice', 'error']);
    assert.equal((await get('/fixture/invoices')).invoices.length, 1);
    assert.equal((await get('/fixture/invoices')).invoices[0].settled, null);
    assert.equal((await get('/channel/fixture')).status, 'ERROR');
});
