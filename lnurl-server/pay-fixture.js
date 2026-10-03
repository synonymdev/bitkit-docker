const express = require('express');
const { createHash, randomBytes } = require('crypto');
const bolt11 = require('bolt11');
const { encode } = require('lnurl');
const QRCode = require('qrcode');

// Disposable invoices for fetching and decoding, without an LND wallet or channels.
// The public test key has no funds and is never used by a Lightning node.
const testKey = '01'.padStart(64, '0');
const metadata = JSON.stringify([['text/plain', 'LNURL-pay regtest fixture']]);
const minSendable = 1000;
const maxSendable = 1000000000;
const reason = 'LNURL fixture invoice callback unavailable';

function createApp() {
    const app = express();
    let mode = 'error';
    app.use(express.json());
    app.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });

    const origin = (req) => (process.env.LNURL_FIXTURE_DOMAIN || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const error = (res, message) => res.json({ status: 'ERROR', reason: message });

    app.get('/health', (req, res) => res.json({ status: 'OK', network: 'regtest', mode }));
    app.get('/fixture', (req, res) => res.json({ mode }));
    app.post('/fixture', (req, res) => {
        if (!['error', 'healthy'].includes(req.body.mode)) {
            return res.status(400).json({ status: 'ERROR', reason: 'mode must be error or healthy' });
        }
        mode = req.body.mode;
        res.json({ mode });
    });

    app.get('/pay/fixture', (req, res) => res.json({
        tag: 'payRequest',
        callback: `${origin(req)}/pay/fixture/callback`,
        minSendable,
        maxSendable,
        metadata,
        commentAllowed: 0
    }));

    app.get('/pay/fixture/callback', (req, res) => {
        const { amount } = req.query;
        if (typeof amount !== 'string' || !/^\d+$/.test(amount) ||
            !Number.isSafeInteger(Number(amount)) || Number(amount) < minSendable || Number(amount) > maxSendable) {
            return error(res, 'amount must be an integer within the advertised millisatoshi range');
        }
        if (mode === 'error') return error(res, reason);

        const invoice = bolt11.encode({
            network: { bech32: 'bcrt', pubKeyHash: 111, scriptHash: 196, validWitnessVersions: [0, 1] },
            millisatoshis: amount,
            tags: [
                { tagName: 'payment_hash', data: createHash('sha256').update(randomBytes(32)).digest('hex') },
                { tagName: 'payment_secret', data: randomBytes(32).toString('hex') },
                { tagName: 'purpose_commit_hash', data: createHash('sha256').update(metadata).digest('hex') },
                { tagName: 'expire_time', data: 3600 },
                { tagName: 'min_final_cltv_expiry', data: 18 }
            ]
        });
        res.json({ pr: bolt11.sign(invoice, testKey).paymentRequest, routes: [] });
    });

    app.get('/generate/pay', async (req, res, next) => {
        try {
            const url = `${origin(req)}/pay/fixture`;
            const lnurl = encode(url);
            res.json({ url, lnurl, qrCode: await QRCode.toDataURL(lnurl), type: 'pay' });
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
