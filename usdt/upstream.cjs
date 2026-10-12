const { parseEnv } = require('node:util');

// A public archive endpoint makes disposable forks usable without credentials.
const PUBLIC_UPSTREAM = 'https://arbitrum-one.public.blastapi.io';

function upstreamUrl(contents) {
  const upstream = parseEnv(contents).ARBITRUM_RPC_URL ?? PUBLIC_UPSTREAM;
  let url;
  try {
    url = new URL(upstream);
  } catch {
    throw new Error('Provide an HTTPS ARBITRUM_RPC_URL in USDT_TEST_ENV_FILE');
  }
  if (url.protocol !== 'https:')
    throw new Error('Provide an HTTPS ARBITRUM_RPC_URL in USDT_TEST_ENV_FILE');
  return upstream;
}

module.exports = { PUBLIC_UPSTREAM, upstreamUrl };
