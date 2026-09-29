#!/usr/bin/env node
// Purchase driver for the Pubky marketplace test fixture.
//
// It plays the marketplace side of the journey against the fixture's Paykit
// Server: it publishes a payment lock on the seller's homeserver and asks
// Paykit Server for an invoice as the trusted issuer (the role Locks plays in a
// full marketplace). Roles it can also stand in for, so the whole journey runs
// without a wallet app: the seller (watch-only setup) and the buyer (receive
// and pay). Bitkit wallets take the buyer and seller roles in the app journey.
//
// Secrets stay in /state/secrets (root, 0700). Paykit Server only ever sees the
// seller's account xpub. Nothing here prints a seed, a key or a token.

import { spawn } from 'node:child_process';
import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { blake3 } from '@noble/hashes/blake3';
import { HDKey } from '@scure/bip32';
import { Keypair, Pubky, PublicKey } from '@synonymdev/pubky';

const STATE = '/state';
const SECRETS = `${STATE}/secrets`;
const PAYKIT_DIR = `${STATE}/paykit`;
const FIXTURE_FILE = `${STATE}/fixture.json`;
const PURCHASES_FILE = `${STATE}/purchases.json`;
const EVIDENCE_DIR = '/evidence';

const PAYKIT_URL = process.env.PAYKIT_URL ?? 'http://127.0.0.1:3001';
const RPC_URL = process.env.BITCOIN_RPC_URL ?? 'http://bitcoind:43782';
const RPC_AUTH = `${process.env.BITCOIN_RPC_USER ?? 'polaruser'}:${process.env.BITCOIN_RPC_PASS ?? 'polarpass'}`;
// The static testnet homeserver key is fixed by Pubky Core.
const HOMESERVER = 'pubky8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo';
const SETUP_ORIGIN = 'http://localhost:8080';
const SERVER_PATH = 'bitkit/server';
const BUYER_PATH = 'bitkit/wallet';
const ACCOUNT_INDEX = 0;
const DEFAULT_SATS = 15000;
const EXPECTED_ASSET = 'btc';
const EXPECTED_ENDPOINT = 'btc-regtest-p2wpkh';

const log = (message) => process.stderr.write(`[marketplace] ${message}\n`);
const out = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

class DriverError extends Error {}
const fail = (message) => {
  throw new DriverError(message);
};

// ---------------------------------------------------------------- state files

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
}

async function writeSecret(path, value) {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function readSecret(name) {
  const path = `${SECRETS}/${name}`;
  if (!existsSync(path)) fail(`missing ${name}; run: ./pubky-marketplace seed`);
  return (await readFile(path, 'utf8')).trim();
}

async function readFixture() {
  const fixture = await readJson(FIXTURE_FILE, null);
  if (!fixture?.seller) fail('fixture is not seeded; run: ./pubky-marketplace seed');
  return fixture;
}

// ------------------------------------------------------------------- bitcoind

async function rpc(method, params = []) {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from(RPC_AUTH).toString('base64')}`,
    },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'driver', method, params }),
  });
  const body = await response.json().catch(() => fail(`bitcoind ${method}: HTTP ${response.status}`));
  if (body.error) fail(`bitcoind ${method}: ${body.error.message}`);
  return body.result;
}

const satsToBtc = (sats) => (Number(sats) / 1e8).toFixed(8);

async function chainInfo() {
  const info = await rpc('getblockchaininfo');
  return { height: info.blocks, hash: info.bestblockhash, chain: info.chain };
}

async function mineBlocks(count) {
  const address = await rpc('getnewaddress');
  return rpc('generatetoaddress', [count, address]);
}

async function ensureMatureCoins() {
  const { height } = await chainInfo();
  if (height < 101) {
    log(`mining ${101 - height} blocks so the regtest wallet has spendable coins`);
    await mineBlocks(101 - height);
  }
}

// -------------------------------------------------------------------- Paykit

async function paykitReady() {
  try {
    const response = await fetch(`${PAYKIT_URL}/health/ready`);
    return { ok: response.status === 200, body: await response.json().catch(() => ({})) };
  } catch {
    return { ok: false, body: {} };
  }
}

async function waitForPaykit(seconds = 180) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const ready = await paykitReady();
    if (ready.ok) return ready.body;
    if (Date.now() > deadline) fail('Paykit Server is not ready; see: ./pubky-marketplace logs paykit-server');
    await sleep(2000);
  }
}

// RFC 8785 canonical JSON for the string, integer, boolean, null, array and
// object values this driver signs and hashes.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}

function keyFromSeed(seed) {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  return createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
}

// Paykit Server's business routes accept only bodies signed by the trusted key.
async function signedPost(path, body, { signature } = {}) {
  const text = canonical(body);
  const issuerSeed = Buffer.from(await readSecret('issuer.seed'), 'base64url');
  const headers = { 'content-type': 'application/json' };
  const value = signature ?? b64url(sign(null, Buffer.from(text), keyFromSeed(issuerSeed)));
  if (value !== 'none') headers['x-paykit-signature'] = value;
  const response = await fetch(`${PAYKIT_URL}${path}`, { method: 'POST', headers, body: text });
  const raw = await response.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, raw };
}

async function paykitStatus(purchase) {
  const response = await signedPost('/transactions/status', {
    bundle_id: purchase.bundle_id,
    creator: purchase.seller,
  });
  if (response.status !== 200) fail(`Paykit status returned HTTP ${response.status}`);
  return response.json;
}

async function outboxState() {
  const text = await (await fetch(`${PAYKIT_URL}/metrics`)).text();
  const value = (name) =>
    text
      .split('\n')
      .filter((line) => line.startsWith(name) && !line.startsWith('#'))
      .reduce((total, line) => total + Number(line.trim().split(/\s+/).pop()), 0);
  return {
    depth: value('paykit_outbox_depth'),
    permanent_failures: value('paykit_outbox_permanent_failures'),
  };
}

// ------------------------------------------------------------- Pubky identity

const pubkyClient = () => Pubky.testnet('localhost');

async function signUpIdentity(seed) {
  const keypair = Keypair.fromSecret(seed);
  const signer = pubkyClient().signer(keypair);
  try {
    await signer.signup(PublicKey.from(HOMESERVER), null);
  } catch (error) {
    const message = String(error?.message ?? error).toLowerCase();
    if (!/already|409|conflict/.test(message)) throw error;
    await signer.signin();
  }
  return keypair.publicKey.toString();
}

async function sellerSession() {
  const seed = Buffer.from(await readSecret('seller-identity.seed'), 'base64url');
  const signer = pubkyClient().signer(Keypair.fromSecret(seed));
  return signer.signin();
}

// ----------------------------------------------------------- helper binaries

function runHelper(binary, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.stdin.end(JSON.stringify(input));
  });
}

const readerEnv = (seller) => ({
  PAYKIT_READER_STATE_PATH: `${STATE}/reader/state.bin`,
  PAYKIT_READER_PUBKY_TESTNET_HOST: 'localhost',
  PAYKIT_READER_RECEIVER_PATH: BUYER_PATH,
  PAYKIT_READER_SERVER_PUBKY: seller,
  PAYKIT_READER_SERVER_PATH: SERVER_PATH,
});

// ------------------------------------------------------------------ encodings

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function crockford(bytes) {
  let bits = 0;
  let value = 0;
  let result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += CROCKFORD[(value << (5 - bits)) & 31];
  return result;
}

const newBundleId = () => crockford(randomBytes(16));

// -------------------------------------------------------------------- commands

async function init() {
  await mkdir(SECRETS, { recursive: true, mode: 0o700 });
  await chmod(SECRETS, 0o700);
  await mkdir(PAYKIT_DIR, { recursive: true, mode: 0o755 });
  await mkdir(`${STATE}/reader`, { recursive: true, mode: 0o700 });
  if (!existsSync(`${SECRETS}/issuer.seed`)) {
    await writeSecret(`${SECRETS}/issuer.seed`, b64url(randomBytes(32)));
    log('created the marketplace issuer key');
  }
  const issuer = Keypair.fromSecret(Buffer.from(await readSecret('issuer.seed'), 'base64url'))
    .publicKey.toString();
  if (!existsSync(`${PAYKIT_DIR}/master-key`)) {
    await writeFile(`${PAYKIT_DIR}/master-key`, b64url(randomBytes(32)), { mode: 0o644 });
    log('created the Paykit Server master key');
  }
  const config = `[http]
listen_addr = "0.0.0.0:3001"

[locks]
trusted_public_key = "${issuer}"

[setup]
allowed_origins = ["${SETUP_ORIGIN}"]

[paykit]
receiver_path = "${SERVER_PATH}"
receiver_path_priority = ["bitkit"]
network = "testnet"

[bitcoin]
network = "regtest"

[electrum]
endpoint = "tcp://electrs:60001"
poll_interval = "1s"

[outbox]
poll_interval = "500ms"
`;
  const path = `${PAYKIT_DIR}/paykit-server.toml`;
  if (!existsSync(path) || (await readFile(path, 'utf8')) !== config) {
    await writeFile(path, config, { mode: 0o644 });
  }
  out({ status: 'initialized', issuer });
}

async function completeSetup(flowId, seconds = 120) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const response = await fetch(`${PAYKIT_URL}/setup/${flowId}/complete`, { method: 'POST' });
    if (response.status === 200) return;
    if (![408, 425, 429, 502, 503, 504].includes(response.status)) {
      fail(`setup flow ended with HTTP ${response.status}`);
    }
    if (Date.now() > deadline) fail('setup flow did not complete in time');
    await sleep(1500);
  }
}

async function beginSetup() {
  const state = `marketplace-${Date.now()}`;
  const response = await fetch(
    `${PAYKIT_URL}/setup?return_to=${encodeURIComponent(SETUP_ORIGIN)}&state=${state}`,
  );
  if (response.status !== 200) fail(`GET /setup returned HTTP ${response.status}`);
  const html = await response.text();
  const flow = html.match(/const flowId=("(?:[^"\\]|\\.)*");/);
  const auth = html.match(/<code>([^<]+)<\/code>/);
  if (!flow || !auth) fail('setup page has no flow id or auth URL');
  const authUrl = auth[1]
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
  return { flowId: JSON.parse(flow[1]), authUrl };
}

async function setupUrl() {
  await waitForPaykit();
  const { flowId, authUrl } = await beginSetup();
  const claim = new URL(authUrl.replace('pubkyauth://', 'http://pubkyauth/')).searchParams.get('x-bitkit-claim');
  out({
    flow_id: flowId,
    auth_url: authUrl,
    claim,
    next: `./pubky-marketplace setup-wait ${flowId}`,
  });
}

async function setupWait(flowId) {
  if (!flowId) fail('usage: setup-wait <flow>');
  await completeSetup(flowId, 300);
  out({ flow_id: flowId, status: 'complete' });
}

async function createBuyer() {
  const seed = randomBytes(32);
  await writeSecret(`${SECRETS}/buyer-identity.seed`, b64url(seed));
  const buyer = await signUpIdentity(seed);
  const fixture = await readFixture();
  await mkdir(`${STATE}/reader`, { recursive: true });
  // A fresh buyer starts with fresh reader state, so exactly one request is actionable.
  await rm(`${STATE}/reader/state.bin`, { force: true });
  const prepared = await runHelper(
    'paykit-reader-demo',
    { version: 1, operation: 'prepare', reader_secret: b64url(seed) },
    readerEnv(fixture.seller.pubky),
  );
  if (prepared.code !== 0) fail(`buyer receiver marker failed: ${prepared.stdout || prepared.stderr}`);
  fixture.buyer = { pubky: buyer, receiver_path: BUYER_PATH, kind: 'headless' };
  await writeJson(FIXTURE_FILE, fixture);
  log(`headless buyer ready: ${buyer}`);
  return fixture.buyer;
}

async function seed(args) {
  const buyerMode = flag(args, '--buyer') ?? 'headless';
  if (!['headless', 'none'].includes(buyerMode)) fail('usage: seed [--buyer headless|none]');
  await waitForPaykit();
  await ensureMatureCoins();
  let fixture = await readJson(FIXTURE_FILE, {});
  if (!fixture.seller) {
    // The seller wallet's seed is spending authority and stays in /state/secrets.
    // Paykit Server receives only the watch-only account xpub at m/84'/1'/0'.
    const walletSeed = randomBytes(32);
    await writeSecret(`${SECRETS}/seller-wallet.seed`, walletSeed.toString('hex'));
    const account = HDKey.fromMasterSeed(walletSeed, { private: 0x04358394, public: 0x043587cf }).derive(
      `m/84'/1'/${ACCOUNT_INDEX}'`,
    );
    const xpub = account.publicExtendedKey;
    if (!xpub.startsWith('tpub')) fail('seller account key is not a regtest tpub');
    const identitySeed = randomBytes(32);
    await writeSecret(`${SECRETS}/seller-identity.seed`, b64url(identitySeed));
    const sellerPubky = await signUpIdentity(identitySeed);
    log(`seller identity ${sellerPubky}; completing the watch-only setup`);
    const { flowId, authUrl } = await beginSetup();
    const approval = await runHelper('paykit-companion-auth', {
      version: 1,
      auth_url: authUrl,
      creator_secret: b64url(identitySeed),
      account_xpub: xpub,
      account_index: ACCOUNT_INDEX,
    });
    if (approval.code !== 0 || !approval.stdout.includes('"approved"')) {
      fail(`companion approval failed: ${approval.stderr || approval.stdout}`);
    }
    await completeSetup(flowId);
    fixture = {
      homeserver: HOMESERVER,
      seller: {
        pubky: sellerPubky,
        account_xpub: xpub,
        account_index: ACCOUNT_INDEX,
        receiver_path: SERVER_PATH,
        kind: 'headless',
        setup_completed_at: new Date().toISOString(),
      },
    };
    await writeJson(FIXTURE_FILE, fixture);
  } else {
    log('seller already seeded');
  }
  if (buyerMode === 'headless' && (!fixture.buyer || flagPresent(args, '--fresh-buyer'))) await createBuyer();
  out(await publicInfo());
}

const flagPresent = (args, name) => args.includes(name);
function flag(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

async function publicInfo() {
  const fixture = await readJson(FIXTURE_FILE, {});
  const chain = await chainInfo().catch(() => null);
  const purchases = await readJson(PURCHASES_FILE, []);
  return {
    homeserver: HOMESERVER,
    homeserver_z32: HOMESERVER.replace(/^pubky/, ''),
    pubky_testnet: {
      homeserver_http: 'http://localhost:6286',
      homeserver_pubky_tls: 'localhost:6287',
      pkarr_relay: 'http://localhost:15411',
      http_relay: 'http://localhost:15412',
      dht: 'localhost:6881',
    },
    paykit_server: { url: 'http://localhost:3001', receiver_path: SERVER_PATH, network: 'regtest' },
    electrum: 'tcp://127.0.0.1:60001',
    chain,
    seller: fixture.seller
      ? {
          pubky: fixture.seller.pubky,
          account_xpub: fixture.seller.account_xpub,
          account_index: fixture.seller.account_index,
          spending_authority: 'held only in the fixture state volume, never given to Paykit Server',
        }
      : null,
    buyer: fixture.buyer ?? null,
    purchases: purchases.length,
    latest_purchase: purchases.at(-1) ?? null,
  };
}

async function fund(args) {
  const [address, sats = '1000000'] = args;
  if (!address || !address.startsWith('bcrt1')) fail('usage: fund <bcrt1 address> [sats]');
  if (!/^\d+$/.test(sats) || Number(sats) <= 0) fail('sats must be a positive integer');
  await ensureMatureCoins();
  const txid = await rpc('sendtoaddress', [address, satsToBtc(sats)]);
  const [block] = await mineBlocks(1);
  const chain = await chainInfo();
  out({ txid, sats: Number(sats), block, height: chain.height, tip: chain.hash });
}

function lockFor({ seller, sats, issuer }) {
  return {
    version: 1,
    creator: seller,
    criteria: [
      {
        criterion_id: 'criterion-1',
        verifier_type: 'paykit-payment',
        params: { recipient_pubky: seller, amount: String(sats), asset: 'BTC' },
      },
    ],
    lock_logic: { type: 'all', criteria: ['criterion-1'] },
    access_policy: { requested_credential_ttl_seconds: 900 },
    lock_server: { override: issuer },
    created_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  };
}

async function issuerPubky() {
  const seed = Buffer.from(await readSecret('issuer.seed'), 'base64url');
  return Keypair.fromSecret(seed).publicKey.toString();
}

async function expectedAddress(fixture, child) {
  const info = await rpc('getdescriptorinfo', [`wpkh(${fixture.seller.account_xpub}/0/*)`]);
  const addresses = await rpc('deriveaddresses', [info.descriptor, [child, child]]);
  return addresses[0];
}

async function purchase(args) {
  const sats = Number(flag(args, '--sats') ?? DEFAULT_SATS);
  if (!Number.isInteger(sats) || sats <= 0) fail('--sats must be a positive integer');
  const buyerArg = flag(args, '--buyer') ?? 'headless';
  const fixture = await readFixture();
  let reader;
  if (buyerArg === 'headless') {
    if (!fixture.buyer) fail('no headless buyer; run: ./pubky-marketplace seed --buyer headless');
    reader = fixture.buyer.pubky;
  } else {
    reader = buyerArg;
  }
  await waitForPaykit();
  const purchases = await readJson(PURCHASES_FILE, []);
  const childIndex = purchases.filter((entry) => entry.seller === fixture.seller.pubky).length;

  const lock = lockFor({ seller: fixture.seller.pubky, sats, issuer: await issuerPubky() });
  const lockText = canonical(lock);
  const lockId = crockford(blake3(Buffer.from(lockText)));
  const lockPath = `/pub/locks.app/${lockId}.json`;
  const session = await sellerSession();
  await session.storage.putText(lockPath, lockText);

  const bundleId = newBundleId();
  const lockResource = `${fixture.seller.pubky}${lockPath}`;
  const response = await signedPost('/invoices', { bundle_id: bundleId, lock_resource: lockResource, reader });
  if (response.status !== 204) {
    const code = response.json?.error?.code ? ` ${response.json.error.code}` : '';
    const hint =
      response.status === 503
        ? '; the buyer needs a Paykit receiver marker on this homeserver (Bitkit: enable contact payments)'
        : '';
    fail(`POST /invoices returned HTTP ${response.status}${code}${hint}`);
  }
  const record = {
    bundle_id: bundleId,
    seller: fixture.seller.pubky,
    reader,
    buyer_kind: buyerArg === 'headless' ? 'headless' : 'external',
    amount_sats: sats,
    asset: EXPECTED_ASSET,
    endpoint: EXPECTED_ENDPOINT,
    lock_resource: lockResource,
    derived_address: await expectedAddress(fixture, childIndex),
    child_index: childIndex,
    created_at: new Date().toISOString(),
    state: 'created',
  };
  purchases.push(record);
  await writeJson(PURCHASES_FILE, purchases);

  // The invoice call returns once the delivery intent is durable; the outbox
  // worker then hands the Payment Request to the SDK.
  let delivery = await outboxState();
  const deadline = Date.now() + 20000;
  while (delivery.depth > 0 && delivery.permanent_failures === 0 && Date.now() < deadline) {
    await sleep(500);
    delivery = await outboxState();
  }
  record.delivery = delivery.permanent_failures > 0 ? 'failed' : delivery.depth === 0 ? 'sent' : 'queued';
  await writeJson(PURCHASES_FILE, purchases);
  out({ ...record, paykit_status: await paykitStatus(record) });
}

async function findPurchase(bundleId) {
  const purchases = await readJson(PURCHASES_FILE, []);
  const purchase = bundleId ? purchases.find((entry) => entry.bundle_id === bundleId) : purchases.at(-1);
  if (!purchase) fail(bundleId ? `unknown bundle ${bundleId}` : 'no purchases yet; run: ./pubky-marketplace purchase');
  return { purchases, purchase };
}

async function receive(args) {
  const fixture = await readFixture();
  const { purchases, purchase } = await findPurchase(args[0]);
  if (purchase.buyer_kind !== 'headless') fail('receive is for the headless buyer; a Bitkit buyer receives in the app');
  const seed = await readSecret('buyer-identity.seed');
  log('waiting for the Payment Request (up to 5 minutes)');
  const result = await runHelper(
    'paykit-reader-demo',
    { version: 1, operation: 'receive', reader_secret: seed },
    readerEnv(fixture.seller.pubky),
  );
  if (result.code !== 0) fail(`receive failed: ${result.stdout || result.stderr}`);
  const request = JSON.parse(result.stdout);
  // The pinned reader rejects any endpoint other than btc-regtest-p2wpkh and any
  // payload that is not a JSON object with a string value before it projects.
  if (request.status !== 'received' || request.asset !== EXPECTED_ASSET) fail('Payment Request is not canonical lowercase btc');
  if (!request.address.startsWith('bcrt1')) fail('Payment Request address is not regtest');
  if (request.amount_sats !== String(purchase.amount_sats)) fail('Payment Request amount does not match the purchase');
  if (request.address !== purchase.derived_address) fail('Payment Request address is not the seller xpub child for this purchase');
  purchase.payment_request_id = request.payment_request_id;
  purchase.delivery = 'received';
  purchase.state = 'delivered';
  await writeJson(PURCHASES_FILE, purchases);
  out({
    bundle_id: purchase.bundle_id,
    payment_request_id: request.payment_request_id,
    delivery: 'received',
    asset: request.asset,
    endpoint: EXPECTED_ENDPOINT,
    address: request.address,
    amount_sats: Number(request.amount_sats),
    address_derived_from_seller_xpub: true,
  });
}

async function pay(args) {
  const { purchases, purchase } = await findPurchase(args[0]);
  await ensureMatureCoins();
  const txid = await rpc('sendtoaddress', [purchase.derived_address, satsToBtc(purchase.amount_sats)]);
  purchase.txid = txid;
  purchase.state = 'paid';
  await writeJson(PURCHASES_FILE, purchases);
  const mempool = await rpc('getrawmempool');
  const tx = await rpc('getrawtransaction', [txid, true]);
  const match = tx.vout.find((output) => output.scriptPubKey.address === purchase.derived_address);
  out({
    bundle_id: purchase.bundle_id,
    txid,
    mempool_entries: mempool.length,
    matched_output_sats: match ? Math.round(match.value * 1e8) : null,
  });
}

async function statusCommand(args) {
  const { purchases, purchase } = await findPurchase(args[0]);
  const paykit = await paykitStatus(purchase);
  const before = purchase.state;
  if (paykit.status === 'confirmed' && paykit.amount_matched && paykit.confirmations >= 1) purchase.state = 'completed';
  else if (paykit.status === 'detected' && paykit.amount_matched) purchase.state = 'payment_detected';
  if (purchase.state !== before) await writeJson(PURCHASES_FILE, purchases);
  out({
    bundle_id: purchase.bundle_id,
    seller: purchase.seller,
    reader: purchase.reader,
    payment_request_id: purchase.payment_request_id ?? null,
    delivery: purchase.delivery ?? null,
    derived_address: purchase.derived_address,
    amount_sats: purchase.amount_sats,
    txid: purchase.txid ?? null,
    paykit_status: paykit,
    // Completed is the gate Locks applies with minimum_confirmations = 1.
    purchase_state: purchase.state,
  });
}

async function mine(args) {
  const bundle = flag(args, '--bundle');
  const before = await chainInfo();
  const mempoolBefore = await rpc('getrawmempool');
  if (bundle) {
    const { purchase } = await findPurchase(bundle);
    if (!purchase.txid || !mempoolBefore.includes(purchase.txid)) fail('the purchase transaction is not in the mempool');
  }
  const [block] = await mineBlocks(1);
  const after = await chainInfo();
  if (after.height !== before.height + 1) fail(`expected exactly one new block, chain moved ${before.height} to ${after.height}`);
  out({
    mined: 1,
    height: after.height,
    block,
    mempool_before: mempoolBefore.length,
    mempool_after: (await rpc('getrawmempool')).length,
  });
}

async function waitFor(args) {
  const [bundle, target, seconds = '90'] = args;
  if (!bundle || !['detected', 'confirmed'].includes(target)) fail('usage: wait <bundle> <detected|confirmed> [seconds]');
  const { purchase } = await findPurchase(bundle);
  const deadline = Date.now() + Number(seconds) * 1000;
  for (;;) {
    const paykit = await paykitStatus(purchase);
    const reached =
      target === 'detected'
        ? ['detected', 'confirmed'].includes(paykit.status) && paykit.amount_matched
        : paykit.status === 'confirmed' && paykit.confirmations >= 1 && paykit.amount_matched;
    if (reached) return out({ bundle_id: bundle, paykit_status: paykit });
    if (Date.now() > deadline) fail(`payment never reached ${target}; last status ${JSON.stringify(paykit)}`);
    await sleep(1500);
  }
}

// The whole journey with the driver in every wallet role. Each step asserts.
async function verify() {
  const evidence = { started_at: new Date().toISOString(), steps: {} };
  const capture = async (name, run) => {
    let output = '';
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      output += chunk;
      return true;
    };
    try {
      await run();
    } finally {
      process.stdout.write = original;
    }
    const value = output ? JSON.parse(output) : null;
    evidence.steps[name] = value;
    log(`${name}: ok`);
    return value;
  };

  await capture('seed', () => seed(['--buyer', 'none']));
  delete evidence.steps.seed; // public facts are recorded under seller and buyer
  const fixture = await readFixture();
  const buyer = await createBuyer();
  evidence.seller = { pubky: fixture.seller.pubky, account_xpub: fixture.seller.account_xpub, account_index: fixture.seller.account_index };
  evidence.buyer = { pubky: buyer.pubky };

  const created = await capture('purchase', () => purchase(['--buyer', 'headless']));
  if (created.paykit_status.status !== 'undetected') fail('a new purchase must start undetected');
  const bundle = created.bundle_id;
  const invoiceBody = { bundle_id: bundle, lock_resource: created.lock_resource, reader: created.reader };

  const unsigned = await signedPost('/invoices', invoiceBody, { signature: 'none' });
  const garbage = await signedPost('/invoices', invoiceBody, { signature: b64url(Buffer.alloc(64)) });
  const unsignedStatus = await signedPost('/transactions/status', { bundle_id: bundle, creator: created.seller }, { signature: 'none' });
  if (unsigned.status !== 401 || garbage.status !== 401 || unsignedStatus.status !== 401) {
    fail('Paykit Server accepted an unsigned or garbage-signed business call');
  }
  evidence.steps.trust_boundary = { unsigned_invoice: 401, garbage_signed_invoice: 401, unsigned_status: 401 };
  log('trust_boundary: ok');

  const received = await capture('receive', () => receive([bundle]));
  const heightBefore = (await chainInfo()).height;
  const paid = await capture('pay', () => pay([bundle]));
  if (paid.matched_output_sats !== received.amount_sats || paid.mempool_entries !== 1) {
    fail('the mempool must hold exactly the purchase transaction with an amount-matched output');
  }
  await capture('detected', () => waitFor([bundle, 'detected']));
  const mined = await capture('mine', () => mine(['--bundle', bundle]));
  if (mined.height !== heightBefore + 1) fail('exactly one block must confirm the payment');
  await capture('confirmed', () => waitFor([bundle, 'confirmed']));
  const final = await capture('status', () => statusCommand([bundle]));
  if (final.purchase_state !== 'completed') fail('purchase did not complete');

  evidence.finished_at = new Date().toISOString();
  evidence.result = 'passed';
  if (existsSync(EVIDENCE_DIR)) {
    const dir = `${EVIDENCE_DIR}/${evidence.started_at.replace(/[:.]/g, '-')}`;
    await mkdir(dir, { recursive: true });
    await writeJson(`${dir}/summary.json`, evidence);
    evidence.evidence_dir = `.marketplace/evidence/${dir.split('/').pop()}`;
  }
  out(evidence);
}

const commands = {
  init: () => init(),
  seed,
  info: async () => out(await publicInfo()),
  'setup-url': () => setupUrl(),
  'setup-wait': (args) => setupWait(args[0]),
  fund,
  purchase,
  receive,
  pay,
  status: statusCommand,
  mine,
  wait: waitFor,
  verify: () => verify(),
};

const [command, ...args] = process.argv.slice(2);
if (!commands[command]) {
  process.stderr.write(`unknown driver command: ${command ?? '(none)'}\n`);
  process.exit(2);
}
try {
  await commands[command](args);
} catch (error) {
  if (error instanceof DriverError) {
    process.stderr.write(`FAIL: ${error.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`FAIL: ${String(error?.message ?? error)}\n`);
  process.exit(1);
}
