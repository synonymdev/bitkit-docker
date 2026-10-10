import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeTrust, missingTrust, requiredKeys, trustedKeys, withTrust } from './trust.mjs';

const template = (issuer) => `[http]\nlisten_addr = "0.0.0.0:3001"\n\n[signed_services]\ntrusted_public_keys = ["${issuer}"]\n\n[setup]\nallowed_origins = ["*"]\n`;

// One init: what the driver writes from its template merged with what the file already trusts.
function init(existingFile, issuer, extra) {
  const required = requiredKeys(issuer, extra);
  return withTrust(template(issuer), mergeTrust(trustedKeys(existingFile), required));
}

test('a restart keeps the Lock Server signer and the service key it did not write itself', () => {
  let file = init(null, 'pubkyDRIVER', '');
  file = withTrust(file, mergeTrust(trustedKeys(file), ['pubkyLOCKS'])); // a Locks connect adds its signer
  file = withTrust(file, mergeTrust(trustedKeys(file), ['pubkySERVICE'])); // the service start adds its key
  file = init(file, 'pubkyDRIVER', ''); // restart
  file = init(file, 'pubkyDRIVER', ''); // and again
  assert.deepEqual(trustedKeys(file), ['pubkyDRIVER', 'pubkyLOCKS', 'pubkySERVICE']);
  assert.deepEqual(missingTrust(file, ['pubkyDRIVER', 'pubkyLOCKS', 'pubkySERVICE']), []);
});

test('keys named in PAYKIT_TRUSTED_KEYS are trusted from the first start', () => {
  const file = init(null, 'pubkyDRIVER', 'pubkyLOCKS, pubkySERVICE');
  assert.deepEqual(trustedKeys(file), ['pubkyDRIVER', 'pubkyLOCKS', 'pubkySERVICE']);
});

test('the read-back names a required key the file lost', () => {
  assert.deepEqual(missingTrust(template('pubkyDRIVER'), ['pubkyDRIVER', 'pubkyLOCKS']), ['pubkyLOCKS']);
});

test('the rest of the config is left as written', () => {
  const file = init(template('pubkyDRIVER'), 'pubkyDRIVER', 'pubkyLOCKS');
  assert.match(file, /allowed_origins = \["\*"\]/);
  assert.match(file, /trusted_public_keys = \["pubkyDRIVER", "pubkyLOCKS"\]/);
});
