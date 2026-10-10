// Paykit Server's [signed_services] trust is merged, never replaced. The driver's issuer, the Lock Server's signer and the
// marketplace service's request key can each be added at a different step (init, a Locks connect, a service start), and a
// restart that rewrote the list from the driver's template dropped the others: the Lock Server's signer went missing after a
// restart on 10 Oct and every Locks invoice was refused. Keys already trusted keep their place and new required keys are appended.

const LIST = /^(\s*trusted_public_keys\s*=\s*)\[([^\]]*)\]/m;

export function trustedKeys(toml) {
  const match = (toml ?? '').match(LIST);
  return match ? [...match[2].matchAll(/"([^"]+)"/g)].map((key) => key[1]) : [];
}

export function mergeTrust(existing, required) {
  const keys = [];
  for (const key of [...existing, ...required]) {
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

export function withTrust(toml, keys) {
  if (!LIST.test(toml)) throw new Error('the Paykit config has no trusted_public_keys list');
  return toml.replace(LIST, (_, lead) => `${lead}[${keys.map((key) => JSON.stringify(key)).join(', ')}]`);
}

export function missingTrust(toml, required) {
  const have = trustedKeys(toml);
  return required.filter((key) => key && !have.includes(key));
}

// The keys a deployment requires besides the driver's issuer: PAYKIT_TRUSTED_KEYS, comma or space separated.
export function requiredKeys(issuer, extra) {
  return mergeTrust([], [issuer, ...String(extra ?? '').split(/[\s,]+/)]);
}
