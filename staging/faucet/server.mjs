// Regtest faucet and miner with the paths of Blocktank's regtest API, so the e2e scripts only change BLOCKTANK_URL.
//   POST /regtest/chain/deposit {address, amountSat?} -> txid as plain text (default 100,000 sats)
//   POST /regtest/chain/mine {count?}                 -> JSON array of block hashes (default 1)
//   GET  /health                                       -> {height, balanceSat}
// deposit and mine need FAUCET_AUTH (user:password) as HTTP basic auth, and each client gets
// FAUCET_RATE_PER_MIN of them a minute. The faucet refuses to start without FAUCET_AUTH.
import http from 'node:http';

const env = process.env;
const RPC_URL = env.BITCOIN_RPC_URL ?? 'http://bitcoind:43782';
const AUTH = 'Basic ' + Buffer.from(`${env.BITCOIN_RPC_USER}:${env.BITCOIN_RPC_PASSWORD}`).toString('base64');
const WALLET = env.FAUCET_WALLET ?? 'faucet';
const DEFAULT_SAT = Number(env.FAUCET_DEFAULT_SAT ?? 100_000);
const MAX_SAT = Number(env.FAUCET_MAX_SAT ?? 10_000_000);
const MAX_BLOCKS = Number(env.FAUCET_MAX_BLOCKS ?? 100);
if (!env.FAUCET_AUTH) throw new Error('FAUCET_AUTH (user:password) is required');
const FAUCET_AUTH = 'Basic ' + Buffer.from(env.FAUCET_AUTH).toString('base64');
const RATE_PER_MIN = Number(env.FAUCET_RATE_PER_MIN ?? 20);
const hits = new Map(); // client -> request times in the last minute

// Caddy sets X-Forwarded-For to the client it sees, so the header names the caller
function limited(req) {
  const client = req.headers['x-forwarded-for'] ?? req.socket.remoteAddress;
  const now = Date.now();
  const recent = (hits.get(client) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(client, recent);
  return recent.length > RATE_PER_MIN;
}
setInterval(() => {
  const now = Date.now();
  for (const [client, times] of hits) if (times.every((t) => now - t >= 60_000)) hits.delete(client);
}, 60_000).unref();

async function rpc(method, params = [], wallet = WALLET) {
  const url = wallet ? `${RPC_URL}/wallet/${wallet}` : RPC_URL;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '1.0', id: method, method, params }),
  });
  const body = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
  if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
  return body.result;
}

async function mine(count) {
  return rpc('generatetoaddress', [count, await rpc('getnewaddress')]);
}

// Load or create the faucet wallet; mine 101 blocks on a fresh chain so its first coinbase is spendable.
async function bootstrap() {
  for (;;) {
    try {
      const loaded = await rpc('listwallets', [], null);
      if (!loaded.includes(WALLET)) {
        await rpc('loadwallet', [WALLET], null).catch(() => rpc('createwallet', [WALLET], null));
      }
      if ((await rpc('getbalance')) < 1) await mine(101);
      console.log(`faucet ready at height ${await rpc('getblockcount', [], null)}`);
      return;
    } catch (e) {
      console.log(`waiting for bitcoind: ${e.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve(null); }
    });
  });
}

const routes = {
  'POST /regtest/chain/deposit': async (body) => {
    const sat = body.amountSat ?? DEFAULT_SAT;
    if (typeof body.address !== 'string' || !Number.isInteger(sat) || sat <= 0 || sat > MAX_SAT) {
      return [400, `address and amountSat (1-${MAX_SAT}) required`];
    }
    return [200, await rpc('sendtoaddress', [body.address, (sat / 1e8).toFixed(8)])];
  },
  'POST /regtest/chain/mine': async (body) => {
    const count = body.count ?? 1;
    if (!Number.isInteger(count) || count <= 0 || count > MAX_BLOCKS) return [400, `count (1-${MAX_BLOCKS}) required`];
    return [200, await mine(count)];
  },
  'GET /health': async () => [200, {
    height: await rpc('getblockcount', [], null),
    balanceSat: Math.round((await rpc('getbalance')) * 1e8),
  }],
};

http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname.replace(/^\/blocktank\/api\/v2/, '');
  const route = routes[`${req.method} ${path}`];
  let [status, out] = [404, 'not found'];
  if (route && req.method === 'POST' && req.headers.authorization !== FAUCET_AUTH) {
    [status, out] = [401, 'unauthorized'];
  } else if (route && req.method === 'POST' && limited(req)) {
    [status, out] = [429, `at most ${RATE_PER_MIN} requests a minute`];
  } else if (route) {
    const body = await readJson(req);
    try {
      [status, out] = body === null ? [400, 'invalid JSON'] : await route(body);
    } catch (e) {
      [status, out] = [e.code === -5 ? 400 : 500, e.message];
    }
  }
  const text = typeof out === 'string';
  res.writeHead(status, { 'Content-Type': text ? 'text/plain' : 'application/json' });
  res.end(text ? out : JSON.stringify(out));
}).listen(Number(env.PORT ?? 3000), bootstrap);
