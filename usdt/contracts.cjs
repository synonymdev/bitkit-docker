const assert = require('node:assert/strict');
const {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  toHex,
  getAddress,
  parseUnits,
} = require('viem');
const { mnemonicToAccount } = require('viem/accounts');
const { toPackedUserOperation } = require('viem/account-abstraction');
const { rpc } = require('./rpc.cjs');

const TOKEN = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
const ENTRY = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108';
const PAYMASTER = '0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402';
const DELEGATE = '0xe6Cae83BdE06E4c305530e199D7217f42808555B';
// Public Anvil test keys. Never fund these accounts on a public network.
const MNEMONIC = 'test test test test test test test test test test test junk';
const signer = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });
const executor = mnemonicToAccount(MNEMONIC);
const donor = mnemonicToAccount(MNEMONIC, { addressIndex: 2 });
const tokenAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
]);
const tuple =
  '(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)';
const paymasterAbi = parseAbi([
  `function getHash(uint8,${tuple}) view returns (bytes32)`,
  'function signers(address) view returns (bool)',
]);
const entryAbi = parseAbi(['function depositTo(address) payable']);
const RATE = 3_000_000_000n; // 3,000 USDT per ETH, expressed in USDT atomic units.
const BALANCE_SLOT = 51n;

function mappingKey(address, slot) {
  return keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [address, slot]),
  );
}
function atomicAmount(value) {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value))
    throw new Error('Use a positive USDT amount with at most six decimals');
  const amount = parseUnits(value, 6);
  if (amount <= 0n || amount > 1_000_000_000_000_000n)
    throw new Error('Fixture amount outside range');
  return amount;
}
async function balance(node, address) {
  return BigInt(
    await rpc(node, 'eth_call', [
      {
        to: TOKEN,
        data: encodeFunctionData({
          abi: tokenAbi,
          functionName: 'balanceOf',
          args: [getAddress(address)],
        }),
      },
      'latest',
    ]),
  );
}
async function seed(node, address, amount) {
  address = getAddress(address);
  await rpc(node, 'anvil_setStorageAt', [
    TOKEN,
    mappingKey(address, BALANCE_SLOT),
    toHex(amount, { size: 32 }),
  ]);
  assert.equal(await balance(node, address), amount, 'USDT balance storage layout changed');
}
async function receipt(node, hash) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await rpc(node, 'eth_getTransactionReceipt', [hash]);
    if (result) {
      assert.equal(result.status, '0x1', 'Fixture transaction reverted');
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Transaction receipt timed out');
}
async function transfer(node, recipient, amount) {
  await seed(node, donor.address, (await balance(node, donor.address)) + amount);
  const hash = await rpc(node, 'eth_sendTransaction', [
    {
      from: donor.address,
      to: TOKEN,
      data: encodeFunctionData({
        abi: tokenAbi,
        functionName: 'transfer',
        args: [getAddress(recipient), amount],
      }),
    },
  ]);
  await receipt(node, hash);
  await rpc(node, 'anvil_mine', [3]);
  return hash;
}
async function initialize(node) {
  assert.match(await rpc(node, 'web3_clientVersion'), /anvil/i);
  assert.equal(await rpc(node, 'eth_chainId'), '0xa4b1');
  for (const address of [TOKEN, ENTRY, PAYMASTER, DELEGATE]) {
    assert.notEqual(
      await rpc(node, 'eth_getCode', [address, 'latest']),
      '0x',
      `Missing contract ${address}`,
    );
  }
  // Locate the signer mapping with a reversible probe; check the contract getter.
  let found = false;
  for (let slot = 0n; slot < 20n; slot++) {
    const key = mappingKey(signer.address, slot);
    const previous = await rpc(node, 'eth_getStorageAt', [PAYMASTER, key, 'latest']);
    await rpc(node, 'anvil_setStorageAt', [PAYMASTER, key, toHex(1n, { size: 32 })]);
    const enabled = await rpc(node, 'eth_call', [
      {
        to: PAYMASTER,
        data: encodeFunctionData({
          abi: paymasterAbi,
          functionName: 'signers',
          args: [signer.address],
        }),
      },
      'latest',
    ]);
    if (BigInt(enabled) === 1n) {
      found = true;
      break;
    }
    await rpc(node, 'anvil_setStorageAt', [PAYMASTER, key, previous]);
  }
  assert(found, 'Paymaster signer storage layout changed');
  const hash = await rpc(node, 'eth_sendTransaction', [
    {
      from: executor.address,
      to: ENTRY,
      value: toHex(10n ** 19n),
      data: encodeFunctionData({ abi: entryAbi, functionName: 'depositTo', args: [PAYMASTER] }),
    },
  ]);
  await receipt(node, hash);
  await seed(node, donor.address, 1_000_000_000_000n);
  // A funded treasury matches normal token collection; zero-value estimation must not hide a new storage write.
  await seed(node, signer.address, 1_000_000n);
}
async function paymasterData(node, params, mode) {
  const [operation, entry, chain, context] = params;
  assert.equal(entry.toLowerCase(), ENTRY.toLowerCase());
  assert.equal(BigInt(chain), 42161n);
  assert.equal(context.token.toLowerCase(), TOKEN.toLowerCase());
  const latest = await rpc(node, 'eth_getBlockByNumber', ['latest', false]);
  const until = BigInt(latest.timestamp) + (mode === 'expired' ? -1n : 600n);
  const data = concat([
    '0x0300',
    toHex(until, { size: 6 }),
    toHex(0, { size: 6 }),
    TOKEN,
    toHex(50000, { size: 16 }),
    toHex(RATE, { size: 32 }),
    toHex(100000, { size: 16 }),
    signer.address,
  ]);
  const op = {
    ...operation,
    paymaster: PAYMASTER,
    paymasterVerificationGasLimit: BigInt(operation.paymasterVerificationGasLimit ?? 0) || 100000n,
    paymasterPostOpGasLimit: BigInt(operation.paymasterPostOpGasLimit ?? 0) || 150000n,
    paymasterData: concat([data, toHex(1n, { size: 65 })]),
  };
  // viem expects bigint quantities when packing the wire operation.
  for (const key of [
    'nonce',
    'callGasLimit',
    'verificationGasLimit',
    'preVerificationGas',
    'maxFeePerGas',
    'maxPriorityFeePerGas',
    'paymasterVerificationGasLimit',
    'paymasterPostOpGasLimit',
  ]) {
    op[key] = BigInt(op[key] ?? 0);
  }
  const packed = toPackedUserOperation(op);
  const hash = await rpc(node, 'eth_call', [
    {
      to: PAYMASTER,
      data: encodeFunctionData({ abi: paymasterAbi, functionName: 'getHash', args: [1, packed] }),
    },
    'latest',
  ]);
  const key = mode === 'invalid-signature' ? donor : signer;
  const signature = await key.signMessage({ message: { raw: hash } });
  return {
    paymaster: PAYMASTER,
    paymasterData: concat([data, signature]),
    paymasterVerificationGasLimit: toHex(op.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: toHex(op.paymasterPostOpGasLimit),
  };
}
module.exports = {
  TOKEN,
  ENTRY,
  PAYMASTER,
  MNEMONIC,
  executor,
  RATE,
  BALANCE_SLOT,
  atomicAmount,
  initialize,
  paymasterData,
  balance,
  seed,
  transfer,
  receipt,
};
