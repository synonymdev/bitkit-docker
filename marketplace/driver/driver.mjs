#!/usr/bin/env node
// Purchase driver for the Pubky marketplace test fixture.
//
// It plays the marketplace side of the journey against the fixture's Paykit
// Server: it publishes a payment lock on the seller's homeserver and asks
// Paykit Server for an invoice as the trusted issuer (the role Locks plays in a
// full marketplace). Roles it can also stand in for, so the whole journey runs
// without a wallet app: the seller (watch-only setup) and the buyer (receive
// and pay). Bitkit wallets take the buyer and seller roles in the app journey.
// A Bitkit seller approves two Pubky grants: the Paykit setup (`setup-url`) and
// a `/pub/app.locks/` write grant for the marketplace (`seller-auth`), and the
// driver publishes the payment lock with that grant session.
//
// Secrets stay in /state/secrets (root, 0700). Paykit Server only ever sees the
// seller's account xpub. Nothing here prints a seed, a key or a token.

import { spawn } from 'node:child_process';
import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { chmod, chown, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { blake3 } from '@noble/hashes/blake3';
import { HDKey } from '@scure/bip32';
import { AuthFlowKind, Keypair, Pubky, PublicKey } from '@synonymdev/pubky';
import { mergeTrust, missingTrust, requiredKeys, trustedKeys, withTrust } from './trust.mjs';

const STATE = '/state';
const SECRETS = `${STATE}/secrets`;
const PAYKIT_DIR = `${STATE}/paykit`;
const FIXTURE_FILE = `${STATE}/fixture.json`;
const PURCHASES_FILE = `${STATE}/purchases.json`;
const EVIDENCE_DIR = '/evidence';

const PAYKIT_URL = process.env.PAYKIT_URL ?? 'http://127.0.0.1:3001';
const RPC_URL = process.env.BITCOIN_RPC_URL ?? 'http://bitcoind:43782';
const RPC_AUTH = `${process.env.BITCOIN_RPC_USER ?? 'polaruser'}:${process.env.BITCOIN_RPC_PASS ?? 'polarpass'}`;
// MARKETPLACE_BACKEND=staging is the shop-mixed profile (docs/shop-mixed.md): our own Paykit Server on Synonym's staging homeserver and
// relay, watching the regtest chain of Bitkit's staging builds (Blocktank staging Electrum). Bitkit wallets play the seller and the buyer
// there; the headless roles need the local testnet and bitcoind, so their commands refuse.
const STAGING = process.env.MARKETPLACE_BACKEND === 'staging';
// The static testnet homeserver key is fixed by Pubky Core; staging is homeserver.staging.pubky.app.
const HOMESERVER = STAGING
  ? (process.env.MARKETPLACE_HOMESERVER ?? 'pubkyufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy')
  : 'pubky8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo';
const SETUP_ORIGIN = process.env.MARKETPLACE_SETUP_ORIGIN ?? 'http://localhost:8080';
// Bitkit's staging builds (bitkit-android Env.kt, bitkit-ios Env.swift): Electrum and the Blocktank regtest API.
const STAGING_ELECTRUM = process.env.MARKETPLACE_ELECTRUM ?? 'ssl://electrs.bitkit.stag0.blocktank.to:9999';
const BLOCKTANK_REGTEST = 'https://api.stag0.blocktank.to/blocktank/api/v2/regtest';
// The quick tunnel's metrics server answers /quicktunnel with its public hostname.
const TUNNEL_METRICS = process.env.MARKETPLACE_TUNNEL_METRICS;
// The grant client id Paykit Server requires in its config and puts in the setup auth URL as cid.
const PAYKIT_CLIENT_ID = 'app.paykit.server';
// Pubky 0.10 sessions are grants, so a signin names its client.
const HEADLESS_CLIENT_ID = 'marketplace.fixture';
// The write grant a Bitkit seller approves for the marketplace (the role Locks plays). The apps show the
// client id as "Requester ID" and the path as the requested permission.
const LOCKS_CLIENT_ID = 'locks.app';
const LOCKS_CAPS = '/pub/app.locks/:rw';
// The testnet's own HTTP relay; wallets reach it on localhost like the homeserver (Android: adb reverse 15412). Staging has its own.
const LOCKS_RELAY = STAGING ? 'https://httprelay.staging.pubky.app/inbox/' : 'http://localhost:15412/inbox/';
const BITKIT_SESSION_SECRET = 'bitkit-seller.session';
// Bitkit gives every setup request a fresh BIP84 account, starting at index 1.
const STANDIN_ACCOUNT_INDEX = 1;
const SERVER_PATH = 'bitkit/server';
const BUYER_PATH = 'bitkit/wallet';
const BUYER_APP_ID = 'bitkit';
const ACCOUNT_INDEX = 0;
const DEFAULT_SATS = 15000;
const EXPECTED_ASSET = 'btc';
const EXPECTED_ENDPOINT = 'btc-regtest-p2wpkh';

const log = (message) => process.stderr.write(`[marketplace] ${message}\n`);
const out = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const outLine = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
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

// Files on the host mounts belong to the user who ran the wrapper, not to this container's root.
async function handToHost(...paths) {
  const uid = Number(process.env.MARKETPLACE_HOST_UID);
  const gid = Number(process.env.MARKETPLACE_HOST_GID);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) return;
  for (const path of paths) {
    try {
      await chown(path, uid, gid);
    } catch (error) {
      log(`could not hand ${path} to the host user: ${error.code ?? error.message}`);
    }
  }
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
  if (STAGING && !fixture?.bitkit_seller) fail('no Bitkit seller yet; run: ./shop-mixed seller-auth');
  if (!STAGING && !fixture?.seller) fail('fixture is not seeded; run: ./pubky-marketplace seed');
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
  // Paykit Server signs requests over `paykit-http-signature-v1\0<METHOD>\0<path>\0<body>` (src/http/auth.rs, signature_preimage).
  const preimage = Buffer.concat([Buffer.from(`paykit-http-signature-v1\0POST\0${path}\0`), Buffer.from(text)]);
  const value = signature ?? b64url(sign(null, preimage, keyFromSeed(issuerSeed)));
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

const pubkyClient = () => (STAGING ? new Pubky() : Pubky.testnet('localhost'));

async function signUpIdentity(seed) {
  const keypair = Keypair.fromSecret(seed);
  const signer = pubkyClient().signer(keypair);
  try {
    await signer.signup(PublicKey.from(HOMESERVER), null);
  } catch (error) {
    const message = String(error?.message ?? error).toLowerCase();
    if (!/already|409|conflict/.test(message)) throw error;
    await signer.signin(HEADLESS_CLIENT_ID);
  }
  return keypair.publicKey.toString();
}

// A write session on the seller's /pub/app.locks/, for publishing the payment lock. The headless seller signs
// in with its own key. A Bitkit seller has no key here: the session is the grant its wallet approved in
// `seller-auth`, restored from the state volume (each restore mints a fresh short-lived bearer).
async function sellerSession(seller) {
  if (seller.kind === 'headless') {
    const seed = Buffer.from(await readSecret('seller-identity.seed'), 'base64url');
    return pubkyClient().signer(Keypair.fromSecret(seed)).signin(HEADLESS_CLIENT_ID);
  }
  const session = await pubkyClient().restoreSession(await readSecret(BITKIT_SESSION_SECRET));
  if (session.info.publicKey.toString() !== seller.pubky) fail('the stored Bitkit seller session belongs to another identity; run: ./pubky-marketplace seller-auth');
  return session;
}

// The seller record for `--seller`: the headless seller (default), the Bitkit seller, or its approved pubky.
function pickSeller(fixture, which = STAGING ? 'bitkit' : 'headless') {
  if (which === 'headless') return fixture.seller;
  const bitkit = fixture.bitkit_seller;
  if (!bitkit) fail('no Bitkit seller; run: ./pubky-marketplace seller-auth');
  if (which === 'bitkit' || which === bitkit.pubky) return bitkit;
  fail(`--seller must be headless, bitkit or ${bitkit.pubky}`);
}

const sellerOf = (fixture, pubky) => [fixture.seller, fixture.bitkit_seller].find((entry) => entry?.pubky === pubky) ?? fixture.seller;

async function setupStatus(pubky) {
  const response = await signedPost('/setup/status', { creator: pubky });
  return response.status === 200 ? response.json.status : `unavailable_http_${response.status}`;
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
  PAYKIT_READER_APP_ID: BUYER_APP_ID,
  PAYKIT_READER_SERVER_PUBKY: seller,
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
  const config = STAGING ? stagingConfig(issuer) : `[http]
listen_addr = "0.0.0.0:3001"

[locks]
trusted_public_key = "${issuer}"

[setup]
allowed_origins = ["${SETUP_ORIGIN}"]

[paykit]
client_id = "${PAYKIT_CLIENT_ID}"
app_id = "paykit-server"
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
  const existing = existsSync(path) ? await readFile(path, 'utf8') : null;
  let written = config;
  if (STAGING) {
    // trust is merged, never replaced: keys a Locks connect or the service added stay across restarts (trust.mjs)
    const required = requiredKeys(issuer, await extraTrust());
    written = withTrust(config, mergeTrust(trustedKeys(existing), required));
  }
  if (existing !== written) {
    await writeFile(path, written, { mode: 0o644 });
  }
  if (STAGING) {
    const missing = missingTrust(await readFile(path, 'utf8'), requiredKeys(issuer, await extraTrust()));
    if (missing.length) throw new Error(`Paykit trust lost required keys: ${missing.join(', ')}`);
  }
  out({ status: 'initialized', issuer, trusted: STAGING ? trustedKeys(await readFile(path, 'utf8')) : [issuer] });
}

// Keys Paykit Server must trust besides the issuer: PAYKIT_TRUSTED_KEYS, and the shop-order profile's Lock Server signer and
// service key, which its keys step writes to /state/paykit/trusted-keys.
async function extraTrust() {
  const file = `${PAYKIT_DIR}/trusted-keys`;
  return `${process.env.PAYKIT_TRUSTED_KEYS ?? ''} ${existsSync(file) ? await readFile(file, 'utf8') : ''}`;
}

// Paykit Server rc11 (paykit-rs rc72): the trusted issuer moved to [signed_services], Pubky resolution is mainnet (the staging
// homeserver is published there), the chain is Blocktank's staging regtest, and the setup page is served through the quick tunnel
// (one Cloudflare hop appends X-Forwarded-For) to any origin a tester opens it from.
function stagingConfig(issuer) {
  return `[http]
listen_addr = "0.0.0.0:3001"
trusted_proxy_hops = 1

[signed_services]
trusted_public_keys = ["${issuer}"]

[setup]
allowed_origins = ["*"]

[paykit]
client_id = "${PAYKIT_CLIENT_ID}"
app_id = "paykit-server"
network = "mainnet"

[bitcoin]
network = "regtest"

[electrum]
endpoint = "${STAGING_ELECTRUM}"
poll_interval = "2s"

[outbox]
poll_interval = "500ms"
`;
}

async function tunnelUrl() {
  if (!TUNNEL_METRICS) return null;
  try {
    const { hostname } = await (await fetch(`${TUNNEL_METRICS}/quicktunnel`)).json();
    return hostname ? `https://${hostname}` : null;
  } catch {
    return null;
  }
}

async function completeSetup(flowId, seconds = 120) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const response = await fetch(`${PAYKIT_URL}/setup/${flowId}/complete`, { method: 'POST' });
    if (response.status === 200) return;
    if (![408, 425, 429, 502, 503, 504].includes(response.status)) {
      fail(`setup flow ended with HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    if (Date.now() > deadline) fail('setup flow did not complete in time');
    await sleep(1500);
  }
}

const authParams = (authUrl) => new URL(authUrl.replace('pubkyauth://', 'http://pubkyauth/')).searchParams;

async function beginSetup() {
  const state = `marketplace-${Date.now()}`;
  const response = await fetch(
    `${PAYKIT_URL}/setup?return_to=${encodeURIComponent(SETUP_ORIGIN)}&state=${state}`,
  );
  if (response.status !== 200) fail(`GET /setup returned HTTP ${response.status}`);
  const html = await response.text();
  // rc65 writes `const flowId="...";` and `<a class="bitkit-btn" href="...">`; rc11 may add attributes after href.
  const flow = html.match(/flowId=("(?:[^"\\]|\\.)*")/);
  const auth = html.match(/<a class="bitkit-btn" href="([^"]+)"/);
  if (!flow || !auth) fail('setup page has no flow id or auth URL');
  const authUrl = auth[1]
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
  // The apps' Paykit SDK accepts only the Pubky grant protocol. A server that emits the legacy
  // pubkyauth://signin URL (no cid or cpk) is the wrong pin, so stop here instead of at the wallet.
  const params = authParams(authUrl);
  if (!authUrl.startsWith('pubkyauth://signin_grant?') || !params.get('cid') || !params.get('cpk')) {
    fail('setup auth URL is not a Pubky grant URL with cid and cpk; check the Paykit Server pin');
  }
  return { flowId: JSON.parse(flow[1]), authUrl };
}

// The watch-only setup approval: the wallet's role in Paykit Server's /setup flow. The wallet gives the server
// its account xpub with the companion claim, then approves the setup grant with its Pubky identity.
async function approveSetupAs(authUrl, identitySeed, xpub, accountIndex) {
  // Paykit Server rc65 checks the identity's Paykit noise key authorization before it accepts the claim; a wallet publishes it
  // in its own Paykit setup, the headless identity publishes it here.
  const authorized = await runHelper('paykit-key-authorization', { version: 1, creator_secret: b64url(identitySeed) });
  if (authorized.code !== 0 || !authorized.stdout.includes('"published":true')) {
    fail(`Paykit key authorization failed: ${authorized.stderr || authorized.stdout}`);
  }
  const approval = await runHelper('paykit-companion-auth', {
    version: 1,
    auth_url: authUrl,
    creator_secret: b64url(identitySeed),
    account_xpub: xpub,
    account_index: accountIndex,
    key_generation: 1,
  });
  if (approval.code !== 0 || !approval.stdout.includes('"approved"')) {
    fail(`companion approval failed: ${approval.stderr || approval.stdout}`);
  }
}

async function setupUrl(args = []) {
  await waitForPaykit();
  const { flowId, authUrl } = await beginSetup();
  const params = authParams(authUrl);
  out({
    flow_id: flowId,
    auth_url: authUrl,
    // Android opens the grant URL directly. iOS has no pubkyauth handler: hand the same query to Bitkit as
    // bitkit://pubky-auth/setup?<query>.
    android: androidOpen(authUrl, flag(args, '--serial')),
    ios_url: `bitkit://pubky-auth/setup?${authUrl.slice(authUrl.indexOf('?') + 1)}`,
    client_id: params.get('cid'),
    claim: params.get('x-bitkit-claim'),
    ...(STAGING ? { setup_page: await tunnelUrl().then((url) => url && `${url}/setup`) } : {}),
    next: `./${STAGING ? 'shop-mixed' : 'pubky-marketplace'} setup-wait ${flowId}`,
  });
}

// When a Bitkit seller has approved the marketplace grant, the setup must have been approved by the same
// identity: Paykit Server reports the setup per creator.
async function setupWait(flowId) {
  if (!flowId) fail('usage: setup-wait <flow>');
  await completeSetup(flowId, 300);
  const fixture = await readJson(FIXTURE_FILE, {});
  const bitkit = fixture.bitkit_seller;
  if (!bitkit) {
    return out({
      flow_id: flowId,
      status: 'complete',
      next: './pubky-marketplace seller-auth (the marketplace grant, approved by the same wallet)',
    });
  }
  let status = await setupStatus(bitkit.pubky);
  for (let attempt = 0; status !== 'ready' && attempt < 10; attempt++) {
    await sleep(1500);
    status = await setupStatus(bitkit.pubky);
  }
  if (status !== 'ready') {
    fail(`setup completed but the Bitkit seller ${bitkit.pubky} is ${status}: the wallet that approved the setup is not the one that approved seller-auth`);
  }
  bitkit.setup_completed_at ??= new Date().toISOString();
  await writeJson(FIXTURE_FILE, fixture);
  out({ flow_id: flowId, status: 'complete', seller: bitkit.pubky, paykit_setup: 'ready' });
}

async function createBuyer(sellerPubky) {
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
    readerEnv(sellerPubky ?? fixture.seller.pubky),
  );
  if (prepared.code !== 0) fail(`buyer receiver marker failed: ${[prepared.stdout, prepared.stderr].filter(Boolean).join(' ')}`);
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
    await approveSetupAs(authUrl, identitySeed, xpub, ACCOUNT_INDEX);
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

async function stagingInfo() {
  const fixture = await readJson(FIXTURE_FILE, {});
  const purchases = await readJson(PURCHASES_FILE, []);
  return {
    backend: 'staging',
    homeserver: HOMESERVER,
    http_relay: LOCKS_RELAY,
    electrum: STAGING_ELECTRUM,
    paykit_server: { url: await tunnelUrl(), receiver_path: SERVER_PATH, network: 'regtest', ready: (await paykitReady()).ok },
    issuer: existsSync(`${SECRETS}/issuer.seed`) ? await issuerPubky() : null,
    bitkit_seller: fixture.bitkit_seller
      ? {
          pubky: fixture.bitkit_seller.pubky,
          marketplace_grant: `${fixture.bitkit_seller.client_id} ${fixture.bitkit_seller.capabilities}`,
          setup_completed_at: fixture.bitkit_seller.setup_completed_at ?? null,
        }
      : null,
    purchases: purchases.length,
    latest_purchase: purchases.at(-1) ?? null,
  };
}

async function publicInfo() {
  if (STAGING) return stagingInfo();
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
    paykit_server: { url: 'http://localhost:23101', receiver_path: SERVER_PATH, network: 'regtest' },
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
    bitkit_seller: fixture.bitkit_seller
      ? {
          pubky: fixture.bitkit_seller.pubky,
          kind: fixture.bitkit_seller.kind,
          marketplace_grant: `${fixture.bitkit_seller.client_id} ${fixture.bitkit_seller.capabilities}`,
          setup_completed_at: fixture.bitkit_seller.setup_completed_at ?? null,
          spending_authority: 'held only in the seller wallet; the fixture holds a marketplace grant session and no xpub',
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

async function expectedAddress(xpub, child) {
  const info = await rpc('getdescriptorinfo', [`wpkh(${xpub}/0/*)`]);
  const addresses = await rpc('deriveaddresses', [info.descriptor, [child, child]]);
  return addresses[0];
}

// Where a purchase is paid. A headless seller's address is derived from its xpub before the purchase is
// delivered. A Bitkit seller's xpub never leaves its wallet and Paykit Server exposes neither the xpub nor the
// derived address, so the fixture learns the address from the delivered Payment Request (`receive`), from the
// operator (`mine --address`) or from the transaction that pays the exact amount.
const paymentAddress = (purchase) => purchase.derived_address ?? purchase.payout_address ?? null;

async function validatePayoutAddress(address) {
  const info = await rpc('validateaddress', [address]);
  if (!info.isvalid || !info.iswitness || info.witness_version !== 0 || info.witness_program?.length !== 40) {
    fail(`${address} is not a regtest native SegWit (p2wpkh) address`);
  }
}

async function setPayoutAddress(purchases, purchase, address, source) {
  if (purchase.derived_address) {
    if (address !== purchase.derived_address) fail('the address is not the seller xpub child for this purchase');
    return;
  }
  if (purchase.payout_address === address) return;
  if (purchase.payout_address) fail(`the purchase already has payout address ${purchase.payout_address}`);
  await validatePayoutAddress(address);
  purchase.payout_address = address;
  purchase.payout_address_source = source;
  await writeJson(PURCHASES_FILE, purchases);
}

// The transaction that pays a purchase, whoever paid it. The headless buyer's `pay` records its txid; a
// Bitkit buyer pays from the app, so the ledger has none. Match on the purchase's address and amount
// instead: in the mempool first, then in the latest blocks (a confirmed payment is no longer in the mempool).
// Without a known address, match the one p2wpkh output of exactly the amount.
const RECENT_BLOCKS = 50;

async function findPaymentTx(purchase, { mempoolOnly = false } = {}) {
  const address = paymentAddress(purchase);
  const paid = (tx) =>
    tx.vout.find(
      (output) =>
        Math.round(output.value * 1e8) === purchase.amount_sats &&
        (address ? output.scriptPubKey?.address === address : output.scriptPubKey?.type === 'witness_v0_keyhash'),
    );
  const found = [];
  for (const txid of await rpc('getrawmempool')) {
    // A transaction can leave the mempool between the two calls; skip it then.
    const tx = await rpc('getrawtransaction', [txid, true]).catch(() => null);
    const output = tx && paid(tx);
    if (output) found.push({ txid, confirmed: false, address: output.scriptPubKey.address });
  }
  if (!found.length && !mempoolOnly) {
    const { height } = await chainInfo();
    for (let at = height; at > Math.max(0, height - RECENT_BLOCKS) && !found.length; at--) {
      const block = await rpc('getblock', [await rpc('getblockhash', [at]), 2]);
      for (const tx of block.tx) {
        const output = paid(tx);
        if (output) found.push({ txid: tx.txid, confirmed: true, height: at, address: output.scriptPubKey.address });
      }
    }
  }
  if (found.length > 1) {
    fail(`more than one transaction pays ${address ?? `${purchase.amount_sats} sats`} (${found.map((tx) => tx.txid).join(', ')}); pass --address <payout address>`);
  }
  return found[0] ?? null;
}

// Remember the payment transaction in the ledger. Returns it, or null when the payment is not on chain yet.
async function recordPaymentTx(purchases, purchase, options) {
  const tx = purchase.txid && !options?.mempoolOnly ? { txid: purchase.txid } : await findPaymentTx(purchase, options);
  if (!tx) return null;
  let changed = false;
  if (purchase.txid !== tx.txid) {
    purchase.txid = tx.txid;
    if (['created', 'delivered'].includes(purchase.state)) purchase.state = 'paid';
    changed = true;
  }
  if (tx.address && !paymentAddress(purchase)) {
    purchase.payout_address = tx.address;
    purchase.payout_address_source = 'amount_match';
    changed = true;
  }
  if (changed) await writeJson(PURCHASES_FILE, purchases);
  return tx;
}

async function purchase(args) {
  const sats = Number(flag(args, '--sats') ?? DEFAULT_SATS);
  if (!Number.isInteger(sats) || sats <= 0) fail('--sats must be a positive integer');
  const buyerArg = flag(args, '--buyer') ?? (STAGING ? fail('usage: purchase --buyer <the Bitkit buyer pubky> [--sats N]') : 'headless');
  const fixture = await readFixture();
  const seller = pickSeller(fixture, flag(args, '--seller'));
  await waitForPaykit();
  if (seller.kind !== 'headless') {
    const setup = await setupStatus(seller.pubky);
    if (setup !== 'ready') fail(`the Bitkit seller's Paykit setup is ${setup}; run: ./pubky-marketplace setup-url`);
  }
  let reader;
  if (buyerArg === 'headless') {
    if (!fixture.buyer) fail('no headless buyer; run: ./pubky-marketplace seed --buyer headless');
    reader = fixture.buyer.pubky;
  } else {
    reader = buyerArg;
  }
  const purchases = await readJson(PURCHASES_FILE, []);
  const childIndex = purchases.filter((entry) => entry.seller === seller.pubky).length;

  const lock = lockFor({ seller: seller.pubky, sats, issuer: await issuerPubky() });
  const lockText = canonical(lock);
  const lockId = crockford(blake3(Buffer.from(lockText)));
  const lockPath = `/pub/app.locks/${lockId}.json`;
  const session = await sellerSession(seller);
  await session.storage.putText(lockPath, lockText);

  const bundleId = newBundleId();
  const lockResource = `${seller.pubky}${lockPath}`;
  const response = await signedPost('/invoices', { bundle_id: bundleId, lock_resource: lockResource, reader });
  // Paykit Server answers 200 with invoice_created_at and payment_deadline (204 with no body before the Locks payment window)
  if (response.status !== 200 && response.status !== 204) {
    const code = response.json?.error?.code ? ` ${response.json.error.code}` : '';
    const hint =
      response.status === 503
        ? '; the buyer needs a Paykit receiver marker on this homeserver (Bitkit: enable contact payments)'
        : '';
    fail(`POST /invoices returned HTTP ${response.status}${code}${hint}`);
  }
  const record = {
    bundle_id: bundleId,
    seller: seller.pubky,
    seller_kind: seller.kind,
    reader,
    buyer_kind: buyerArg === 'headless' ? 'headless' : 'external',
    amount_sats: sats,
    asset: EXPECTED_ASSET,
    endpoint: EXPECTED_ENDPOINT,
    lock_resource: lockResource,
    // Only a seller whose xpub the fixture holds has a derived address it can check.
    derived_address: seller.kind === 'headless' ? await expectedAddress(seller.account_xpub, childIndex) : null,
    child_index: seller.kind === 'headless' ? childIndex : null,
    created_at: new Date().toISOString(),
    payment_deadline: response.json?.payment_deadline ?? null,
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
  const { purchases, purchase } = await findPurchase(args[0]);
  if (purchase.buyer_kind !== 'headless') fail('receive is for the headless buyer; a Bitkit buyer receives in the app');
  const seed = await readSecret('buyer-identity.seed');
  log('waiting for the Payment Request (up to 5 minutes)');
  const result = await runHelper(
    'paykit-reader-demo',
    { version: 1, operation: 'receive', reader_secret: seed },
    readerEnv(purchase.seller),
  );
  if (result.code !== 0) fail(`receive failed: ${[result.stdout, result.stderr].filter(Boolean).join(' ')}`);
  const request = JSON.parse(result.stdout);
  // The pinned reader rejects any endpoint other than btc-regtest-p2wpkh and any
  // payload that is not a JSON object with a string value before it projects.
  if (request.status !== 'received' || request.asset !== EXPECTED_ASSET) fail('Payment Request is not canonical lowercase btc');
  if (!request.address.startsWith('bcrt1')) fail('Payment Request address is not regtest');
  if (request.amount_sats !== String(purchase.amount_sats)) fail('Payment Request amount does not match the purchase');
  // A Bitkit seller's xpub is not here: the delivered address is checked to be a regtest p2wpkh address and
  // kept as the address the purchase must be paid to. Whether it belongs to the seller's wallet shows in the app.
  await setPayoutAddress(purchases, purchase, request.address, 'payment_request');
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
    address_derived_from_seller_xpub: purchase.derived_address ? true : null,
    address_check: purchase.derived_address
      ? 'equals the seller xpub child for this purchase'
      : 'regtest p2wpkh only; the fixture has no xpub for a Bitkit seller',
  });
}

async function pay(args) {
  const { purchases, purchase } = await findPurchase(args[0]);
  await ensureMatureCoins();
  const address = paymentAddress(purchase);
  if (!address) fail('the payment address is not known yet; run: ./pubky-marketplace receive <bundle>');
  const txid = await rpc('sendtoaddress', [address, satsToBtc(purchase.amount_sats)]);
  purchase.txid = txid;
  purchase.state = 'paid';
  await writeJson(PURCHASES_FILE, purchases);
  const mempool = await rpc('getrawmempool');
  const tx = await rpc('getrawtransaction', [txid, true]);
  const match = tx.vout.find((output) => output.scriptPubKey.address === address);
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
  // A Bitkit buyer pays from the app, so learn the txid from the chain (non-fatal: nothing to find before payment).
  if (!purchase.txid && !STAGING) await recordPaymentTx(purchases, purchase).catch((error) => log(`no payment txid yet: ${error.message}`));
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
    seller_kind: purchase.seller_kind ?? 'headless',
    derived_address: purchase.derived_address ?? null,
    payout_address: paymentAddress(purchase),
    payout_address_source: purchase.derived_address ? 'seller_xpub' : (purchase.payout_address_source ?? null),
    amount_sats: purchase.amount_sats,
    txid: purchase.txid ?? null,
    paykit_status: paykit,
    // Completed is the gate Locks applies with minimum_confirmations = 1.
    purchase_state: purchase.state,
  });
}

// Staging's chain is Blocktank's: mine through its regtest API, as the Bitkit E2E suite does.
async function stagingMine(args) {
  const count = Number(flag(args, '--count') ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 10) fail('--count must be 1 to 10');
  const response = await fetch(`${BLOCKTANK_REGTEST}/chain/mine`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ count }),
  });
  if (!response.ok) fail(`Blocktank regtest mine returned HTTP ${response.status}`);
  out({ mined: count, via: BLOCKTANK_REGTEST });
}

async function mine(args) {
  if (STAGING) return stagingMine(args);
  const bundle = flag(args, '--bundle');
  const before = await chainInfo();
  const mempoolBefore = await rpc('getrawmempool');
  let payment = null;
  let payoutAddress = null;
  if (bundle) {
    const { purchases, purchase } = await findPurchase(bundle);
    const address = flag(args, '--address');
    if (address) await setPayoutAddress(purchases, purchase, address, 'operator');
    // The headless buyer's txid is in the ledger; for any other buyer find the payment by address and amount.
    payment = purchase.txid && mempoolBefore.includes(purchase.txid)
      ? { txid: purchase.txid }
      : await recordPaymentTx(purchases, purchase, { mempoolOnly: true });
    if (!payment) fail('the purchase transaction is not in the mempool');
    payoutAddress = paymentAddress(purchase);
  }
  const [block] = await mineBlocks(1);
  const after = await chainInfo();
  if (after.height !== before.height + 1) fail(`expected exactly one new block, chain moved ${before.height} to ${after.height}`);
  out({
    mined: 1,
    height: after.height,
    block,
    ...(payment ? { bundle_id: bundle, txid: payment.txid, payout_address: payoutAddress } : {}),
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

// Linked-peer report for journey step 14: "the fixture reports the seller and buyer as linked peers".
// It reads what the fixture can see: each side's public Paykit receiver marker, the seller's setup
// authority, and Paykit Server's persisted peer state for a purchase's reader binding.
async function receiverMarker(pubky, receiverPath) {
  const path = `/pub/paykit/v0/app-registry.json`;
  const storage = pubkyClient().publicStorage;
  if (!(await storage.exists(`${pubky}${path}`))) return { path, present: false };
  return { path, present: true, marker: await storage.getJson(`${pubky}${path}`) };
}

async function peerReport({ fixture, purchases, buyerArg, bundleArg, sellerArg }) {
  // The seller is --seller, else the seller of the bundle or latest purchase, else the headless seller.
  const chosen = sellerArg ? pickSeller(fixture, sellerArg) : null;
  const ofSeller = (entry) => !chosen || entry.seller === chosen.pubky;
  // --bundle selects a purchase, whose reader is the buyer unless --buyer names another one.
  const bundlePurchase = bundleArg ? purchases.find((entry) => entry.bundle_id === bundleArg) : undefined;
  if (bundleArg && !bundlePurchase) fail(`unknown bundle ${bundleArg}`);
  const reader = buyerArg ?? bundlePurchase?.reader ?? purchases.filter(ofSeller).at(-1)?.reader ?? fixture.buyer?.pubky;
  if (!reader) fail('no buyer; pass --buyer <pubky> or run: ./pubky-marketplace seed --buyer headless');
  const purchase = bundlePurchase ?? purchases.filter((entry) => entry.reader === reader && ofSeller(entry)).at(-1);
  const seller = chosen ?? sellerOf(fixture, purchase?.seller);
  const headless = fixture.buyer?.pubky === reader;

  const setup = await signedPost('/setup/status', { creator: seller.pubky });
  let serverSide = 'no_purchase_yet';
  if (purchase) {
    const state = await signedPost('/connections/status', { creator: seller.pubky, bundle_id: purchase.bundle_id });
    serverSide = state.status === 200 ? state.json.state : `unavailable_http_${state.status}`;
  }
  // An app buyer holds its own end of the link inside the app; the fixture has no key for it and cannot inspect it.
  let buyerSide = 'not_observable';
  if (headless) {
    const inspected = await runHelper(
      'paykit-reader-demo',
      { version: 1, operation: 'inspect', reader_secret: await readSecret('buyer-identity.seed') },
      readerEnv(seller.pubky),
    );
    buyerSide = inspected.code === 0 ? JSON.parse(inspected.stdout).connection_state : 'unavailable';
  }
  const sellerMarker = await receiverMarker(seller.pubky, SERVER_PATH);
  const buyerMarker = await receiverMarker(reader, BUYER_PATH);
  const sellerReady = setup.status === 200 && setup.json?.status === 'ready' && sellerMarker.present;
  return {
    seller: {
      pubky: seller.pubky,
      kind: seller.kind,
      receiver_path: SERVER_PATH,
      setup: setup.status === 200 ? setup.json.status : `unavailable_http_${setup.status}`,
      receiver_marker: sellerMarker,
    },
    buyer: {
      pubky: reader,
      kind: headless ? 'headless' : 'external',
      receiver_path: BUYER_PATH,
      receiver_marker: buyerMarker,
    },
    link: {
      bundle_id: purchase?.bundle_id ?? null,
      // Paykit Server's view of its link to the buyer: none, handshake, connected, recovery_required or blocked.
      // The server keeps it per purchase, so before the first purchase for this buyer it reads no_purchase_yet.
      server_side: serverSide,
      // The headless buyer's own view of its link to the server. For an app buyer it reads not_observable: the app
      // shows that side (Linked), and `linked` below rests on Paykit Server's side alone.
      buyer_side: buyerSide,
    },
    // Both identities publish their receiver markers and the seller's setup authority is usable: a purchase can be delivered.
    ready_for_purchase: sellerReady && buyerMarker.present,
    // Paykit Server holds a live link to the buyer.
    linked: sellerReady && buyerMarker.present && serverSide === 'connected',
  };
}

async function peers(args) {
  const fixture = await readFixture();
  const purchases = await readJson(PURCHASES_FILE, []);
  const waitSeconds = Number(flag(args, '--wait') ?? 0);
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) fail('usage: peers [--seller headless|bitkit|<pubky>] [--buyer <pubky>] [--bundle <id>] [--wait <seconds>]');
  await waitForPaykit();
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    const report = await peerReport({
      fixture,
      purchases: await readJson(PURCHASES_FILE, purchases),
      buyerArg: flag(args, '--buyer'),
      bundleArg: flag(args, '--bundle'),
      sellerArg: flag(args, '--seller'),
    });
    if (report.linked || !waitSeconds || Date.now() > deadline) {
      out(report);
      if (waitSeconds && !report.linked) fail(`seller and buyer are not linked after ${waitSeconds}s`);
      return;
    }
    await sleep(2000);
  }
}

// Runs a command and records its JSON output in the evidence under `name`.
function evidenceCapture(evidence) {
  return async (name, run) => {
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
}

async function writeEvidence(evidence, suffix = '') {
  evidence.finished_at = new Date().toISOString();
  evidence.result = 'passed';
  if (existsSync(EVIDENCE_DIR)) {
    const dir = `${EVIDENCE_DIR}/${evidence.started_at.replace(/[:.]/g, '-')}${suffix}`;
    await mkdir(dir, { recursive: true });
    await writeJson(`${dir}/summary.json`, evidence);
    await handToHost(dir, `${dir}/summary.json`);
    evidence.evidence_dir = `.marketplace/evidence/${dir.split('/').pop()}`;
  }
  out(evidence);
}

// After the buyer received the Payment Request, the bundle's peers must read as linked.
async function assertLinked(capture, bundle) {
  const report = await capture('peers_linked', () => peers(['--bundle', bundle, '--wait', '30']));
  if (!report.linked || report.link.bundle_id !== bundle || report.link.server_side !== 'connected') {
    fail(`the peers are not linked after receive: ${JSON.stringify(report.link)}`);
  }
}

// The whole journey with the driver in every wallet role. Each step asserts.
async function verify() {
  const evidence = { started_at: new Date().toISOString(), steps: {} };
  const capture = evidenceCapture(evidence);

  await capture('seed', () => seed(['--buyer', 'none']));
  delete evidence.steps.seed; // public facts are recorded under seller and buyer
  const fixture = await readFixture();
  const buyer = await createBuyer();
  evidence.seller = { pubky: fixture.seller.pubky, account_xpub: fixture.seller.account_xpub, account_index: fixture.seller.account_index };
  evidence.buyer = { pubky: buyer.pubky };

  // ask about this run's buyer: without --buyer the report follows the latest purchase, which an earlier verify left
  const peersBefore = await capture('peers_before', () => peers(['--buyer', buyer.pubky]));
  if (!peersBefore.ready_for_purchase || peersBefore.linked) fail('before the purchase the peers must be ready for a purchase and not linked yet');

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
  await assertLinked(capture, bundle);
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

  await writeEvidence(evidence);
}

// ---------------------------------------------------------------- Bitkit seller

// adb joins the arguments after `shell` and the device shell splits them again, so a URL in single quotes
// outside the double quotes loses its quotes and is cut at the first `&`. The whole device command goes in one
// double-quoted string with the URL single-quoted inside it. With several devices or emulators pass --serial.
const androidOpen = (authUrl, serial) =>
  `adb${serial ? ` -s ${serial}` : ''} shell "am start -a android.intent.action.VIEW -d '${authUrl}'"`;

// The marketplace's request for a write grant on the seller's /pub/app.locks/, shown to the seller as a Pubky
// auth request (the role Locks plays). The flow polls the relay as long as this process runs.
async function startLocksGrant(relay) {
  const flow = await pubkyClient().startGrantAuthFlow(LOCKS_CAPS, AuthFlowKind.signin(), { clientId: LOCKS_CLIENT_ID, relay });
  const authUrl = flow.authorizationUrl;
  if (!authUrl.startsWith('pubkyauth://signin_grant?') || !authParams(authUrl).get('cpk')) {
    fail('the marketplace grant URL is not a Pubky grant URL with cpk; check the @synonymdev/pubky version');
  }
  return { flow, authUrl };
}

async function awaitGrant(flow, seconds) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const session = await flow.tryPollOnce();
    if (session) return session;
    if (Date.now() > deadline) fail(`no approval within ${seconds}s; run seller-auth again for a fresh request`);
    await sleep(1000);
  }
}

// A grant covers the lock directory when one of its capabilities is a write on that path or a parent of it.
const writesLocks = (capabilities) =>
  capabilities.some((cap) => {
    const at = cap.lastIndexOf(':');
    return cap.slice(at + 1).includes('w') && '/pub/app.locks/'.startsWith(cap.slice(0, at));
  });

// Keep the approved grant as the seller's write session and record the identity that approved it.
async function adoptBitkitSeller(session, kind) {
  const capabilities = session.info.capabilities;
  if (!writesLocks(capabilities)) fail(`the approved grant does not allow writing ${LOCKS_CAPS}: ${JSON.stringify(capabilities)}`);
  const pubky = session.info.publicKey.toString();
  const secret = await session.exportLocalSecret();
  const restored = await pubkyClient().restoreSession(secret);
  if (restored.info.publicKey.toString() !== pubky) fail('the exported grant session restores to another identity');
  await writeSecret(`${SECRETS}/${BITKIT_SESSION_SECRET}`, secret);
  // On staging the Bitkit seller is the first seller the fixture has.
  const fixture = STAGING ? await readJson(FIXTURE_FILE, {}) : await readFixture();
  const previous = fixture.bitkit_seller?.pubky === pubky ? fixture.bitkit_seller : {};
  const paykitSetup = await setupStatus(pubky);
  fixture.bitkit_seller = {
    ...previous,
    pubky,
    kind,
    client_id: LOCKS_CLIENT_ID,
    capabilities: LOCKS_CAPS,
    marketplace_grant_at: new Date().toISOString(),
    ...(paykitSetup === 'ready' ? { setup_completed_at: previous.setup_completed_at ?? new Date().toISOString() } : {}),
  };
  await writeJson(FIXTURE_FILE, fixture);
  return { seller: fixture.bitkit_seller, paykitSetup };
}

// Print the marketplace grant request for the Bitkit seller wallet, wait for its approval and keep the grant
// session that `purchase --seller bitkit` publishes the payment lock with.
async function sellerAuth(args) {
  const relay = flag(args, '--relay') ?? LOCKS_RELAY;
  const seconds = Number(flag(args, '--timeout') ?? 300);
  if (!Number.isFinite(seconds) || seconds <= 0) fail('usage: seller-auth [--relay <url>] [--timeout <seconds>] [--serial <adb-serial>]');
  if (!STAGING) await readFixture();
  const { flow, authUrl } = await startLocksGrant(relay);
  // One compact JSON object per line: the first line is the request, the last one the approval.
  outLine({
    status: 'awaiting_approval',
    client_id: LOCKS_CLIENT_ID,
    capabilities: LOCKS_CAPS,
    relay,
    auth_url: authUrl,
    android: androidOpen(authUrl, flag(args, '--serial')),
    // iOS registers no pubkyauth handler and bitkit://pubky-auth/setup accepts only the setup request: put
    // auth_url on the simulator's clipboard, then Scan QR Code, Paste QR Code (E2E builds: Enter QRCode String).
    ios: {
      clipboard: `printf %s '${authUrl}' | xcrun simctl pbcopy <simulator-id>`,
      in_app: 'Scan QR Code sheet, then Paste QR Code',
    },
    wait_seconds: seconds, // the relay keeps the request for about 5 minutes
  });
  const session = await awaitGrant(flow, seconds);
  const { seller, paykitSetup } = await adoptBitkitSeller(session, 'bitkit');
  outLine({
    status: 'approved',
    seller: seller.pubky,
    client_id: seller.client_id,
    capabilities: session.info.capabilities,
    paykit_setup: paykitSetup,
    next: paykitSetup === 'ready' ? './pubky-marketplace purchase --seller bitkit' : './pubky-marketplace setup-url',
  });
}

// The Bitkit seller path with a headless Pubky client standing in for the wallet: it approves the marketplace
// grant with approveAuthRequest from its own keypair and the Paykit setup with the companion claim, as the app
// does, then a headless buyer pays the purchase and the payout must land on the address derived from the
// stand-in's xpub. The fixture never uses that xpub to pick the address: it only checks the result.
async function verifyBitkitSeller() {
  const evidence = { mode: 'bitkit-seller-standin', started_at: new Date().toISOString(), steps: {} };
  const capture = evidenceCapture(evidence);

  await capture('seed', () => seed(['--buyer', 'none']));
  delete evidence.steps.seed;
  const existing = (await readFixture()).bitkit_seller;
  if (existing?.kind === 'bitkit') fail('a real Bitkit seller is recorded; run ./pubky-marketplace reset before the self-test');

  const identitySeed = randomBytes(32);
  const account = HDKey.fromMasterSeed(randomBytes(32), { private: 0x04358394, public: 0x043587cf }).derive(
    `m/84'/1'/${STANDIN_ACCOUNT_INDEX}'`,
  );
  const xpub = account.publicExtendedKey;
  const standin = await signUpIdentity(identitySeed);
  evidence.seller = { pubky: standin, account_xpub: xpub, account_index: STANDIN_ACCOUNT_INDEX, kind: 'standin' };

  // Approval 1: the marketplace grant, over the relay like a wallet's approval.
  const { flow, authUrl } = await startLocksGrant(LOCKS_RELAY);
  await pubkyClient().signer(Keypair.fromSecret(identitySeed)).approveAuthRequest(authUrl);
  const session = await awaitGrant(flow, 60);
  const adopted = await adoptBitkitSeller(session, 'standin');
  if (adopted.seller.pubky !== standin) fail('the grant was adopted for another identity');
  if (adopted.paykitSetup === 'ready') fail('a fresh seller must not have a Paykit setup yet');
  evidence.steps.marketplace_grant = { seller: standin, capabilities: session.info.capabilities, paykit_setup: adopted.paykitSetup };
  log('marketplace_grant: ok');

  // A purchase before the Paykit setup is refused.
  const refused = await purchase(['--seller', 'bitkit']).then(
    () => null,
    (error) => error.message,
  );
  if (!refused?.includes('setup')) fail(`a purchase without the Paykit setup must be refused, got: ${refused}`);
  evidence.steps.setup_required = { refused };
  log('setup_required: ok');

  // Approval 2: the watch-only setup by the same identity.
  const { flowId, authUrl: setupAuthUrl } = await beginSetup();
  await approveSetupAs(setupAuthUrl, identitySeed, xpub, STANDIN_ACCOUNT_INDEX);
  await capture('setup', () => setupWait(flowId));
  if ((await readFixture()).bitkit_seller.setup_completed_at === undefined) fail('setup was not recorded for the Bitkit seller');

  const buyer = await createBuyer(standin);
  evidence.buyer = { pubky: buyer.pubky };
  const peersBefore = await capture('peers_before', () => peers(['--seller', 'bitkit']));
  if (!peersBefore.ready_for_purchase || peersBefore.linked) fail('before the purchase the peers must be ready for a purchase and not linked yet');
  const created = await capture('purchase', () => purchase(['--seller', 'bitkit', '--buyer', 'headless']));
  if (created.seller !== standin || created.derived_address !== null) fail('a Bitkit seller purchase has no derived address in the ledger');
  if (created.paykit_status.status !== 'undetected') fail('a new purchase must start undetected');
  const bundle = created.bundle_id;
  const expected = await expectedAddress(xpub, 0);

  const received = await capture('receive', () => receive([bundle]));
  await assertLinked(capture, bundle);
  if (received.address !== expected) fail(`the Payment Request pays ${received.address}, not the stand-in xpub's ${expected}`);
  const heightBefore = (await chainInfo()).height;
  const paid = await capture('pay', () => pay([bundle]));
  const tx = await rpc('getrawtransaction', [paid.txid, true]);
  const output = tx.vout.find((entry) => entry.scriptPubKey.address === expected);
  if (Math.round(output?.value * 1e8) !== received.amount_sats || paid.mempool_entries !== 1) {
    fail('the mempool must hold exactly the purchase transaction paying the stand-in xpub address');
  }
  await capture('detected', () => waitFor([bundle, 'detected']));
  const mined = await capture('mine', () => mine(['--bundle', bundle]));
  if (mined.height !== heightBefore + 1) fail('exactly one block must confirm the payment');
  await capture('confirmed', () => waitFor([bundle, 'confirmed']));
  const final = await capture('status', () => statusCommand([bundle]));
  if (final.purchase_state !== 'completed' || final.payout_address !== expected) fail('purchase did not complete on the stand-in xpub address');
  evidence.payout = { address: expected, derived_from: 'stand-in seller xpub, external child 0/0', txid: paid.txid };

  await writeEvidence(evidence, '-bitkit-seller');
}

// `init`, then stay up: the shop-mixed profile's long-running driver service, so a project started with `up --wait` holds no
// exited one-shot container. The other commands run in their own `compose run` containers.
async function initAndStay() {
  await init();
  process.on('SIGTERM', () => process.exit(0));
  // A pending promise alone does not keep Node running (it exits 13 on an unsettled top-level await); a timer does.
  await new Promise(() => setInterval(() => {}, 2 ** 30));
}

const commands = {
  init: () => init(),
  'init-and-stay': initAndStay,
  seed,
  info: async () => out(await publicInfo()),
  'setup-url': (args) => setupUrl(args),
  'setup-wait': (args) => setupWait(args[0]),
  'seller-auth': sellerAuth,
  fund,
  purchase,
  receive,
  pay,
  status: statusCommand,
  mine,
  peers,
  wait: waitFor,
  verify: () => verify(),
  'verify-bitkit-seller': () => verifyBitkitSeller(),
};

// The headless wallet roles and the local chain do not exist on staging.
const LOCAL_ONLY = ['seed', 'fund', 'receive', 'pay', 'peers', 'verify', 'verify-bitkit-seller'];

const [command, ...args] = process.argv.slice(2);
if (!commands[command]) {
  process.stderr.write(`unknown driver command: ${command ?? '(none)'}\n`);
  process.exit(2);
}
if (STAGING && LOCAL_ONLY.includes(command)) {
  process.stderr.write(`FAIL: ${command} needs the local testnet and chain; on staging Bitkit wallets are the seller and the buyer\n`);
  process.exit(2);
}
try {
  await commands[command](args);
  // A grant flow keeps its relay poll pending; leave once stdout is flushed instead of waiting on it.
  await new Promise((resolve) => process.stdout.write('', resolve));
  process.exit(0);
} catch (error) {
  if (error instanceof DriverError) {
    process.stderr.write(`FAIL: ${error.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`FAIL: ${String(error?.message ?? error)}\n`);
  process.exit(1);
}
