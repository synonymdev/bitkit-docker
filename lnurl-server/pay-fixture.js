const express = require('express');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { createHash, randomBytes } = require('crypto');
const bolt11 = require('bolt11');
const { encode } = require('lnurl');
const QRCode = require('qrcode');

// Invoices for LNURL-pay journeys. With `LND_REST_URL` set (the `lnurl-pay` profile starts the project's LND beside this fixture),
// each invoice is a real one of that LND, payable by a wallet that holds a channel to it (`/channel/fixture` opens one). Without it,
// invoices are disposable ones signed with a public test key, for fetching and decoding only.
const testKey = '01'.padStart(64, '0');
const metadata = JSON.stringify([['text/plain', 'LNURL-pay regtest fixture']]);
const minSendable = 1000;
const maxSendable = 1000000000;
const reason = 'LNURL fixture invoice callback unavailable';
const modes = ['error', 'healthy', 'delay'];
// a held callback answers at the latest after this, so a forgotten `delay` does not hold a wallet's request for ever
const maxHoldMs = 15 * 60 * 1000;

function lndClient(env) {
    const base = env.LND_REST_URL && env.LND_REST_URL.replace(/\/$/, '');
    if (!base) return null;
    const dir = env.LND_DIR || '/lnd';
    const macaroonPath = env.LND_MACAROON_PATH || path.join(dir, 'data/chain/bitcoin/regtest/admin.macaroon');
    return (method, route, body) => new Promise((resolve, reject) => {
        let macaroon;
        try {
            macaroon = fs.readFileSync(macaroonPath).toString('hex');
        } catch (err) {
            return reject(new Error(`LND is not ready: no macaroon at ${macaroonPath}`));
        }
        const url = new URL(base + route);
        // the regtest LND's self-signed certificate names its container, not the service name this fixture dials
        const req = https.request(url, { method, rejectUnauthorized: false, headers: { 'Grpc-Metadata-macaroon': macaroon, 'Content-Type': 'application/json' }, timeout: 30000 }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                let parsed;
                try { parsed = data ? JSON.parse(data) : {}; } catch (err) { return reject(new Error(`LND ${route}: ${data.slice(0, 200)}`)); }
                if (res.statusCode >= 400) return reject(new Error(`LND ${route}: ${parsed.message || parsed.error || res.statusCode}`));
                resolve(parsed);
            });
        });
        req.on('timeout', () => req.destroy(new Error(`LND ${route}: timed out`)));
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

function bitcoinClient(env) {
    const url = env.BITCOIN_RPC_URL;
    if (!url) return null;
    return async (method, params = []) => {
        const parsed = new URL(url);
        const auth = Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString('base64');
        parsed.username = '';
        parsed.password = '';
        const res = await fetch(parsed, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '1.0', id: 'lnurl-fixture', method, params }) });
        const out = await res.json();
        if (out.error) throw new Error(`bitcoind ${method}: ${out.error.message}`);
        return out.result;
    };
}

function createApp(env = process.env) {
    const app = express();
    const lnd = lndClient(env);
    const bitcoin = bitcoinClient(env);
    let mode = 'error';
    let delayMs = null;
    let released = 0;
    const wakers = new Set();
    const callbacks = [];
    const invoices = [];
    const channels = new Map();
    app.use(express.json());
    app.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });

    const origin = (req) => (env.LNURL_FIXTURE_DOMAIN || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const error = (res, message) => res.json({ status: 'ERROR', reason: message });
    const wake = () => { for (const fn of wakers) fn(); };
    const state = () => ({ mode, delay_ms: delayMs, held: callbacks.filter((c) => !c.answered_at).length, invoices: lnd ? 'lnd' : 'synthetic' });

    app.get('/health', (req, res) => res.json({ status: 'OK', network: 'regtest', ...state() }));
    app.get('/fixture', (req, res) => res.json({ ...state(), callbacks }));
    // `{mode: "delay", ms}` holds every callback for `ms` (without `ms`, until the next POST); any later POST releases the held ones,
    // which then answer as the new mode says (`delay` released by its own timer answers as `healthy`)
    app.post('/fixture', (req, res) => {
        if (!modes.includes(req.body.mode)) {
            return res.status(400).json({ status: 'ERROR', reason: `mode must be one of ${modes.join(', ')}` });
        }
        const { ms } = req.body;
        if (req.body.mode === 'delay' && ms !== undefined && (!Number.isSafeInteger(ms) || ms < 0 || ms > maxHoldMs)) {
            return res.status(400).json({ status: 'ERROR', reason: `ms must be an integer from 0 to ${maxHoldMs}` });
        }
        mode = req.body.mode;
        delayMs = mode === 'delay' && ms !== undefined ? ms : null;
        released += 1;
        wake();
        res.json(state());
    });

    const invoice = async (amount) => {
        const descriptionHash = createHash('sha256').update(metadata).digest();
        if (lnd) {
            const created = await lnd('POST', '/v1/invoices', { value_msat: amount, description_hash: descriptionHash.toString('base64'), expiry: 3600 });
            return { pr: created.payment_request, hash: Buffer.from(created.r_hash, 'base64').toString('hex') };
        }
        const hash = createHash('sha256').update(randomBytes(32)).digest('hex');
        const encoded = bolt11.encode({
            network: { bech32: 'bcrt', pubKeyHash: 111, scriptHash: 196, validWitnessVersions: [0, 1] },
            millisatoshis: amount,
            tags: [
                { tagName: 'payment_hash', data: hash },
                { tagName: 'payment_secret', data: randomBytes(32).toString('hex') },
                { tagName: 'purpose_commit_hash', data: descriptionHash.toString('hex') },
                { tagName: 'expire_time', data: 3600 },
                { tagName: 'min_final_cltv_expiry', data: 18 }
            ]
        });
        return { pr: bolt11.sign(encoded, testKey).paymentRequest, hash };
    };

    app.get('/pay/fixture', (req, res) => res.json({
        tag: 'payRequest',
        callback: `${origin(req)}/pay/fixture/callback`,
        minSendable,
        maxSendable,
        metadata,
        commentAllowed: 0
    }));

    app.get('/pay/fixture/callback', async (req, res, next) => {
        try {
            const { amount } = req.query;
            if (typeof amount !== 'string' || !/^\d+$/.test(amount) ||
                !Number.isSafeInteger(Number(amount)) || Number(amount) < minSendable || Number(amount) > maxSendable) {
                return error(res, 'amount must be an integer within the advertised millisatoshi range');
            }
            const entry = { at: new Date().toISOString(), amount_msat: Number(amount), held_ms: 0, answered_at: null, answer: null };
            callbacks.push(entry);
            if (mode === 'delay') {
                const start = Date.now();
                const generation = released;
                const limit = Math.min(delayMs === null ? maxHoldMs : delayMs, maxHoldMs);
                await new Promise((resolve) => {
                    let timer;
                    const done = () => { clearTimeout(timer); wakers.delete(check); resolve(); };
                    const check = () => { if (released !== generation) done(); };
                    timer = setTimeout(done, limit);
                    wakers.add(check);
                    req.on('close', () => { if (!res.writableEnded) done(); });
                });
                entry.held_ms = Date.now() - start;
            }
            entry.answered_at = new Date().toISOString();
            if (mode === 'error') {
                entry.answer = 'error';
                return error(res, reason);
            }
            const made = await invoice(amount);
            entry.answer = 'invoice';
            entry.payment_hash = made.hash;
            invoices.push({ payment_hash: made.hash, amount_msat: Number(amount), issued_at: entry.answered_at });
            res.json({ pr: made.pr, routes: [] });
        } catch (err) {
            next(err);
        }
    });

    // what the issued invoices became: `settled` comes from LND, so a journey can tell that no payment went out after a deadline
    app.get('/fixture/invoices', async (req, res, next) => {
        try {
            const out = [];
            for (const item of invoices) {
                let settled = null;
                if (lnd) settled = (await lnd('GET', `/v1/invoice/${item.payment_hash}`)).state === 'SETTLED';
                out.push({ ...item, settled });
            }
            res.json({ invoices: out });
        } catch (err) {
            next(err);
        }
    });

    const generate = (route, type) => async (req, res, next) => {
        try {
            const url = `${origin(req)}${route}`;
            const lnurl = encode(url);
            res.json({ url, lnurl, qrCode: await QRCode.toDataURL(lnurl), type });
        } catch (err) {
            next(err);
        }
    };
    app.get('/generate/pay', generate('/pay/fixture', 'pay'));
    app.get('/generate/channel', generate('/channel/fixture', 'channel'));

    const needLnd = (res) => {
        if (lnd) return false;
        res.status(400).json({ status: 'ERROR', reason: 'this fixture runs without LND (LND_REST_URL unset)' });
        return true;
    };
    const mine = async (blocks, address) => {
        if (!bitcoin) throw new Error('BITCOIN_RPC_URL unset');
        return bitcoin('generatetoaddress', [blocks, address || await bitcoin('getnewaddress', ['', 'bech32'])]);
    };

    // LNURL-channel: the wallet connects to LND at `LND_P2P_ADDRESS` (the device reaches it on its own loopback), then LND opens a
    // channel of `CHANNEL_SATS` and pushes `PUSH_SATS` to the wallet, so the wallet can pay this fixture's invoices; six blocks confirm it
    app.get('/channel/fixture', async (req, res, next) => {
        try {
            if (needLnd(res)) return;
            const info = await lnd('GET', '/v1/getinfo');
            const k1 = randomBytes(32).toString('hex');
            channels.set(k1, { created_at: new Date().toISOString() });
            res.json({ tag: 'channelRequest', uri: `${info.identity_pubkey}@${env.LND_P2P_ADDRESS || '127.0.0.1:23735'}`, callback: `${origin(req)}/channel/fixture/callback`, k1 });
        } catch (err) {
            next(err);
        }
    });

    app.get('/channel/fixture/callback', async (req, res, next) => {
        try {
            if (needLnd(res)) return;
            const { k1, remoteid, private: isPrivate, cancel } = req.query;
            const request = channels.get(k1);
            if (!request || request.channel_point) return error(res, 'unknown or used k1');
            if (cancel === '1') {
                channels.delete(k1);
                return res.json({ status: 'OK' });
            }
            if (!/^0[23][0-9a-f]{64}$/.test(remoteid || '')) return error(res, 'remoteid must be a compressed public key');
            const capacity = Number(env.CHANNEL_SATS || 1000000);
            const push = Number(env.PUSH_SATS || 500000);
            const funded = async () => Number((await lnd('GET', '/v1/balance/blockchain')).confirmed_balance || 0) >= capacity * 2;
            if (!(await funded())) await mine(101, (await lnd('GET', '/v1/newaddress?type=WITNESS_PUBKEY_HASH')).address);
            // LND refuses to open a channel until it has synced the chain; after mining it also has to count the matured coinbase
            for (let i = 0; i < 60 && !((await lnd('GET', '/v1/getinfo')).synced_to_chain && await funded()); i++) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
            const opened = await lnd('POST', '/v1/channels', {
                node_pubkey: Buffer.from(remoteid, 'hex').toString('base64'),
                local_funding_amount: String(capacity),
                push_sat: String(push),
                private: isPrivate === '1',
                // a static-remote-key channel: an anchor channel would need the wallet to hold an on-chain reserve first
                commitment_type: 'STATIC_REMOTE_KEY',
                spend_unconfirmed: true
            });
            request.channel_point = `${Buffer.from(opened.funding_txid_bytes, 'base64').reverse().toString('hex')}:${opened.output_index}`;
            request.remoteid = remoteid;
            await mine(6);
            res.json({ status: 'OK' });
        } catch (err) {
            // LNURL wallets read a JSON ERROR, not an HTTP failure
            error(res, err.message);
        }
    });

    app.get('/fixture/channels', async (req, res, next) => {
        try {
            if (needLnd(res)) return;
            const [open, pending] = await Promise.all([lnd('GET', '/v1/channels'), lnd('GET', '/v1/channels/pending')]);
            res.json({ requests: [...channels.values()], open: open.channels || [], pending: pending.pending_open_channels || [] });
        } catch (err) {
            next(err);
        }
    });

    // mines `blocks` (default 6) on the project's bitcoind, to confirm a channel or a wallet's on-chain payment
    app.post('/fixture/mine', async (req, res, next) => {
        try {
            const blocks = req.body.blocks === undefined ? 6 : req.body.blocks;
            if (!Number.isSafeInteger(blocks) || blocks < 1 || blocks > 200) return res.status(400).json({ status: 'ERROR', reason: 'blocks must be 1 to 200' });
            res.json({ mined: (await mine(blocks, req.body.address)).length });
        } catch (err) {
            next(err);
        }
    });

    app.use((err, req, res, next) => res.status(500).json({ status: 'ERROR', reason: err.message }));
    return app;
}

if (require.main === module) {
    const server = createApp().listen(process.env.PORT || 3010, '0.0.0.0');
    process.on('SIGTERM', () => server.close());
    process.on('SIGINT', () => server.close());
}

module.exports = { createApp };
