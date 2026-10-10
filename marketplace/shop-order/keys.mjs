// Every secret of the shop-order profile, made fresh on the first start and kept after it (SHOP_ORDER_FRESH=1 makes new ones), so
// a rerun keeps its database, the seller's Paykit setup and the Lock Server identity. Nothing here is committed or printed: the
// files live in the project's state volume, mode 0600. Formats follow each service's loader: the Lock Server seed is
// `keypair-seed:<base64url 32 bytes>`, its creator-authority key base64url without padding, the marketplace service's
// encryption keys 32-byte hex, its grant keyrings `{active: {epoch, kid, public_key}}` with an unpadded base64url key.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const DIR = '/state/order';
const PAYKIT_DIR = '/state/paykit';
const DONE = `${DIR}/keys.done`;

if (existsSync(DONE) && process.env.SHOP_ORDER_FRESH !== '1') {
  console.log('shop-order keys: kept');
  process.exit(0);
}
mkdirSync(DIR, { recursive: true, mode: 0o700 });
mkdirSync(PAYKIT_DIR, { recursive: true, mode: 0o755 });

const hex = () => randomBytes(32).toString('hex');
const b64 = () => randomBytes(32).toString('base64');
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const password = () => randomBytes(24).toString('hex');

const Z32 = 'ybndrfg8ejkmcpqxot1uwisza345h769';
function z32(bytes) {
  let bits = [...bytes].map((byte) => byte.toString(2).padStart(8, '0')).join('');
  bits += '0'.repeat((5 - (bits.length % 5)) % 5);
  let out = '';
  for (let at = 0; at < bits.length; at += 5) out += Z32[parseInt(bits.slice(at, at + 5), 2)];
  return out;
}

// An Ed25519 pair as its 32-byte seed and 32-byte public key.
function pair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    seed: privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32),
    public: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
  };
}

const ring = (key) => JSON.stringify({ active: { epoch: 1, kid: 'shop-order-1', public_key: b64url(key) } });

function write(name, values) {
  writeFileSync(`${DIR}/${name}`, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, { mode: 0o600 });
}

const pg = { POSTGRES_PASSWORD: password(), AUDIT_WRITER_PASSWORD: password(), AUDIT_RETENTION_PASSWORD: password() };
const locksKey = pair();
const paykitRequest = pair(); // the service signs its Paykit Server calls with it; Paykit trusts its public key
const assertion = pair(); // the Shop BFF signs grant assertions; the service verifies them
const request = pair(); // the Shop BFF signs its service requests; the service verifies them

write('postgres.env', pg);
writeFileSync(`${DIR}/locks-seed`, `keypair-seed:${b64url(locksKey.seed)}`, { mode: 0o600 });
write('locks.env', {
  LOCKS_PUBLIC_KEY: z32(locksKey.public),
  PUBKY_LOCK_DATABASE_URL: `postgres://shop:${pg.POSTGRES_PASSWORD}@shop-order-postgres:5432/locks`,
  PUBKY_LOCK_CREATOR_AUTH_ENCRYPTION_KEY: b64url(randomBytes(32)),
});
write('service.env', {
  DATABASE_URL: `postgres://shop:${pg.POSTGRES_PASSWORD}@shop-order-postgres:5432/marketplace`,
  REFUSAL_AUDIT_DATABASE_URL: `postgres://marketplace_refusal_audit_writer_login:${pg.AUDIT_WRITER_PASSWORD}@shop-order-postgres:5432/marketplace`,
  REFUSAL_AUDIT_RETENTION_DATABASE_URL: `postgres://marketplace_refusal_audit_retention:${pg.AUDIT_RETENTION_PASSWORD}@shop-order-postgres:5432/marketplace`,
  REFUSAL_AUDIT_HMAC_ROOT_B64: b64(),
  REFUSAL_AUDIT_HMAC_KEY_EPOCH: '1',
  PAYKIT_REQUEST_SIGNING_KEY: paykitRequest.seed.toString('hex'),
  STRIPE_KEY_ENCRYPTION_KEY: hex(),
  PRIV_DATA_KEY_ENCRYPTION_KEY: hex(),
  LOCKS_BUNDLE_ENCRYPTION_KEY: hex(),
  LOCKS_LOOKUP_HMAC_KEY: hex(),
  DIGITAL_DELIVERY_ENCRYPTION_KEY: hex(),
  GRANT_FLOW_ENCRYPTION_KEY_B64: b64(),
  GRANT_FLOW_KEY_EPOCH: '1',
  GRANT_RESULT_HMAC_ROOT_B64: b64(),
  GRANT_RESULT_HMAC_KEY_EPOCH: '1',
  SHOP_GRANT_ASSERTION_VERIFYING_KEYS_JSON: `'${ring(assertion.public)}'`,
  SHOP_BFF_REQUEST_VERIFYING_KEYS_JSON: `'${ring(request.public)}'`,
});
write('bff.env', {
  SHOP_BFF_GRANT_STATE_DATABASE_URL: `postgres://shop:${pg.POSTGRES_PASSWORD}@shop-order-postgres:5432/bff`,
  CRON_SECRET: hex(),
  SHOP_GRANT_ASSERTION_KEY_ID: 'shop-order-1',
  SHOP_GRANT_ASSERTION_KEY_EPOCH: '1',
  SHOP_GRANT_ASSERTION_SIGNING_KEY: assertion.seed.toString('hex'),
  MARKETPLACE_SERVICE_REQUEST_KEY_ID: 'shop-order-1',
  MARKETPLACE_SERVICE_REQUEST_KEY_EPOCH: '1',
  MARKETPLACE_SERVICE_REQUEST_SIGNING_KEY: request.seed.toString('hex'),
  SHOP_BFF_GRANT_STATE_ENCRYPTION_KEY_B64: b64(),
  SHOP_BFF_GRANT_STATE_KEY_EPOCH: '1',
});
// The keys Paykit Server must trust besides the driver's issuer; the driver's init merges them (trust.mjs).
writeFileSync(`${PAYKIT_DIR}/trusted-keys`, `pubky${z32(locksKey.public)}\npubky${z32(paykitRequest.public)}\n`, { mode: 0o644 });
writeFileSync(DONE, new Date().toISOString());
console.log(`shop-order keys: made (Lock Server ${z32(locksKey.public)}, service Paykit key pubky${z32(paykitRequest.public)})`);
