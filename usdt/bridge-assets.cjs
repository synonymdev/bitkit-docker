const { base58, createBase58check } = require('@scure/base');
const { getAddress, hexToBytes, keccak256, sha256, toHex } = require('viem');
const { TOKEN } = require('./contracts.cjs');
const pins = {
  arbitrum: ['42161', TOKEN],
  ethereum: ['1', '0xdAC17F958D2ee523a2206206994597C13D831ec7'],
  polygon: ['137', '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'],
  base: ['8453', '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2'],
  bsc: ['56', '0x55d398326f99059ff775485246999027b3197955'],
  plasma: ['9745', '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb'],
  tron: ['728126428', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'],
  solana: [
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  ],
};
const sourceNetworks = ['ethereum', 'polygon', 'base', 'bsc', 'tron', 'solana'];
const bridgeNetworks = [...sourceNetworks, 'plasma'];
const digest = (value) => keccak256(toHex(value));
const evmAddress = (value) => getAddress(`0x${digest(value).slice(-40)}`);
const tron = createBase58check((data) => hexToBytes(sha256(data)));
function addresses(ref) {
  const evm = evmAddress(ref);
  return Object.fromEntries(
    sourceNetworks.map((network) => [
      network,
      network === 'tron'
        ? tron.encode(hexToBytes(`0x41${evm.slice(2)}`))
        : network === 'solana'
          ? base58.encode(hexToBytes(digest(ref)))
          : evm,
    ]),
  );
}
function asset(chain) {
  if (!pins[chain]) throw new Error('Unsupported fixture network');
  return {
    chain,
    asset: 'USDT',
    chainId: pins[chain][0],
    contractAddress: pins[chain][1],
    decimals: chain === 'bsc' ? 18 : 6,
  };
}
const scale = (network) => (network === 'bsc' ? 1_000_000_000_000n : 1n);
const units = (amount, network) => (BigInt(amount) * scale(network)).toString();
module.exports = {
  sourceNetworks,
  bridgeNetworks,
  asset,
  addresses,
  evmAddress,
  digest,
  units,
  scale,
};
