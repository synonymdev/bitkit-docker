import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import {
  AbiCoder,
  Contract,
  HDNodeWallet,
  JsonRpcProvider,
  concat,
  getBytes,
  keccak256,
  toBeHex,
  zeroPadValue,
  isAddress,
} from 'ethers';

// Adapted from synonymdev/bitkit-core tests/usdt-fork/provider.mjs (98bf9c6).
// A local service fixture using the deployed contracts with a test paymaster signer.
// It does not model Pimlico's pricing, gas estimation, or service acceptance policy.
const rpc = new JsonRpcProvider(process.env.ANVIL_URL ?? 'http://127.0.0.1:8545', 42161, {
  staticNetwork: true,
  cacheTimeout: -1,
});
assert.match(await rpc.send('web3_clientVersion', []), /anvil/i);
assert.equal(await rpc.send('eth_chainId', []), '0xa4b1');
const signer = HDNodeWallet.fromPhrase(
  'test test test test test test test test test test test junk',
  undefined,
  "m/44'/60'/0'/0/1",
);
const bundler = await rpc.getSigner(signer.address);
const account = HDNodeWallet.fromPhrase('test test test test test test test test test test test junk').address;
const delegate = '0xe6Cae83BdE06E4c305530e199D7217f42808555B';
const tokenAddress = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
const pmAddress = '0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402';
const entryAddress = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108';
const packedType =
  '(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)';
const token = new Contract(
  tokenAddress,
  ['function balanceOf(address) view returns (uint256)'],
  rpc,
);
const pm = new Contract(
  pmAddress,
  [
    `function getHash(uint8,${packedType}) view returns (bytes32)`,
    'function signers(address) view returns (bool)',
  ],
  rpc,
);
const entry = new Contract(
  entryAddress,
  [
    `function handleOps(${packedType}[],address)`,
    `function getUserOpHash(${packedType}) view returns (bytes32)`,
    'function depositTo(address) payable',
  ],
  bundler,
);
const coder = AbiCoder.defaultAbiCoder();

async function setMapping(contract, account, value, check) {
  for (let slot = 0; slot < 100; slot++) {
    const key = keccak256(coder.encode(['address', 'uint256'], [account, slot]));
    const previous = await rpc.send('eth_getStorageAt', [contract, key, 'latest']);
    await rpc.send('anvil_setStorageAt', [contract, key, toBeHex(value, 32)]);
    if (await check()) return slot;
    await rpc.send('anvil_setStorageAt', [contract, key, previous]);
  }
  throw Error('Could not locate fixture mapping');
}
const currentBlock = Number(BigInt(await rpc.send('eth_blockNumber', [])));
for (const address of [delegate, tokenAddress, pmAddress, entryAddress])
  assert.notEqual(await rpc.send('eth_getCode', [address, 'latest']), '0x', `Missing deployed contract ${address}`);
const statePath = process.env.STATE_PATH ?? '/data/submissions.json';
const saved = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
const metadata = await rpc.send('anvil_metadata', []);
const instanceId = metadata.instanceId;
assert(!saved || saved.instanceId === instanceId, 'Chain restarted; recreate the fixture volume and both services');
async function activeChain() {
  assert.equal((await rpc.send('anvil_metadata', [])).instanceId, instanceId, 'Chain restarted; recreate the fixture volume and both services');
}
const forkBlock = saved?.forkBlock ?? currentBlock;
assert(currentBlock >= forkBlock, 'Chain state was reset; reset both fixture volumes together');
const journal = saved?.submissions ?? [];
let balanceSlot = saved?.balanceSlot;
function saveJournal() {
  writeFileSync(`${statePath}.tmp`, JSON.stringify({ instanceId, forkBlock, balanceSlot, submissions: journal }));
  renameSync(`${statePath}.tmp`, statePath);
}
let controls = { dropNextSubmissionResponse: false };
let serial = Promise.resolve();
if (balanceSlot === undefined) balanceSlot = await setMapping(
  tokenAddress,
  '0x000000000000000000000000000000000000dEaD',
  1_000_000_000n,
  async () => (await token.balanceOf('0x000000000000000000000000000000000000dEaD')) === 1_000_000_000n,
);
if (!(await pm.signers(signer.address)))
  await setMapping(pmAddress, signer.address, 1n, async () => await pm.signers(signer.address));
if (!saved) {
  const key = keccak256(coder.encode(['address', 'uint256'], [account, balanceSlot]));
  await rpc.send('anvil_setStorageAt', [tokenAddress, key, toBeHex(1_000_000_000n, 32)]);
  await (await entry.depositTo(pmAddress, { value: 10n ** 18n })).wait();
}
saveJournal();

const gas = {
  callGasLimit: toBeHex(1_500_000),
  verificationGasLimit: toBeHex(800_000),
  preVerificationGas: toBeHex(100_000),
  paymasterVerificationGasLimit: toBeHex(100_000),
  paymasterPostOpGasLimit: toBeHex(100_000),
};
const rate = 3_000_000_000n;
function pack(op) {
  return {
    sender: op.sender,
    nonce: op.nonce,
    initCode: concat(['0x7702', toBeHex(0, 18)]),
    callData: op.callData,
    accountGasLimits: concat([toBeHex(op.verificationGasLimit, 16), toBeHex(op.callGasLimit, 16)]),
    preVerificationGas: op.preVerificationGas,
    gasFees: concat([toBeHex(op.maxPriorityFeePerGas, 16), toBeHex(op.maxFeePerGas, 16)]),
    paymasterAndData: concat([
      op.paymaster,
      toBeHex(op.paymasterVerificationGasLimit, 16),
      toBeHex(op.paymasterPostOpGasLimit, 16),
      op.paymasterData,
    ]),
    signature: op.signature,
  };
}
async function dispatch(method, params) {
  if (method === 'eth_estimateUserOperationGas' || method === 'eth_sendUserOperation') {
    const op = params[0];
    assert.equal(op.factory, '0x7702');
    assert.ok(op.eip7702Auth, 'The 7702 factory marker requires authorization');
    assert.equal(
      BigInt(op.eip7702Auth.nonce),
      BigInt(await rpc.send('eth_getTransactionCount', [op.sender, 'latest'])),
      'Authorization must use the current account nonce',
    );
  }
  if (method === 'test_fundWallet') {
    assert(isAddress(params[0]), 'Expected an EVM wallet address');
    const key = keccak256(coder.encode(['address', 'uint256'], [params[0], balanceSlot]));
    await rpc.send('anvil_setStorageAt', [tokenAddress, key, toBeHex(1_000_000_000n, 32)]);
    return true;
  }
  if (method === 'pimlico_getTokenQuotes')
    return {
      quotes: [
        {
          token: tokenAddress,
          paymaster: pmAddress,
          postOpGas: toBeHex(50000),
          exchangeRate: toBeHex(rate),
        },
      ],
    };
  if (method === 'pimlico_getUserOperationGasPrice')
    return {
      slow: { maxFeePerGas: toBeHex(90_000_000), maxPriorityFeePerGas: toBeHex(1_000_000) },
      fast: { maxFeePerGas: toBeHex(100_000_000), maxPriorityFeePerGas: toBeHex(1_000_000) },
    };
  if (method === 'eth_estimateUserOperationGas') return gas;
  if (method === 'pm_getPaymasterData' || method === 'pm_getPaymasterStubData') {
    const stub = method === 'pm_getPaymasterStubData';
    const limits = stub ? { paymasterPostOpGasLimit: gas.paymasterPostOpGasLimit } : {};
    const op = { ...params[0], paymaster: pmAddress, ...limits };
    const unsigned = concat([
      '0x0300',
      toBeHex(BigInt((await rpc.send('eth_getBlockByNumber', ['latest', false])).timestamp) + 600n, 6),
      toBeHex(0, 6),
      tokenAddress,
      toBeHex(50000, 16),
      toBeHex(rate, 32),
      toBeHex(100000, 16),
      signer.address,
    ]);
    op.paymasterData = concat([unsigned, zeroPadValue('0x01', 65)]);
    const signature = await signer.signMessage(getBytes(await pm.getHash(1, pack(op))));
    return { paymaster: pmAddress, paymasterData: concat([unsigned, signature]), ...limits };
  }
  if (method === 'eth_sendUserOperation') {
    const op = pack(params[0]);
    const hash = await rpc.send('eth_call', [
      { to: entryAddress, data: entry.interface.encodeFunctionData('getUserOpHash', [op]) },
      'latest',
      { [op.sender]: { code: concat(['0xef0100', delegate]) } },
    ]);
    const auth = params[0].eip7702Auth;
    const options = {
      gasLimit: 6_000_000,
      type: 4,
      authorizationList: [
        {
          address: auth.address,
          chainId: BigInt(auth.chainId),
          nonce: BigInt(auth.nonce),
          signature: { r: auth.r, s: auth.s, yParity: Number(BigInt(auth.yParity)) },
        },
      ],
    };
    const record = { operation: hash, sender: op.sender, receivedAt: new Date().toISOString(), status: 'received' };
    journal.push(record); saveJournal();
    const tx = await entry.handleOps([op], signer.address, options);
    record.transaction = tx.hash; record.status = 'submitted'; saveJournal();
    const receipt = await tx.wait();
    record.status = 'mined'; record.blockNumber = receipt.blockNumber; saveJournal();
    await rpc.send('anvil_mine', [3]);
    console.log(
      JSON.stringify({
        operation: hash,
        transaction: receipt.hash,
        gasUsed: receipt.gasUsed.toString(),
      }),
    );
    return hash;
  }
  if (method === 'bitkit_getBridgeMessages') return { data: [] };
  if (method === 'eth_getLogs') {
    const filter = { ...params[0] };
    if (!filter.blockHash) {
      const lower = filter.fromBlock && !['earliest', 'latest', 'pending'].includes(filter.fromBlock) ? Number(BigInt(filter.fromBlock)) : 0;
      const upper = filter.toBlock && !['latest', 'pending'].includes(filter.toBlock) ? Number(BigInt(filter.toBlock)) : Infinity;
      if (upper <= forkBlock) return [];
      filter.fromBlock = toBeHex(Math.max(lower, forkBlock + 1));
    }
    return rpc.send(method, [filter]);
  }
  return rpc.send(method, params);
}
const server = createServer(async (request, response) => {
  try {
    await activeChain();
    if (request.method === 'GET' && request.url === '/health') {
      assert.equal(await rpc.send('eth_chainId', []), '0xa4b1');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ready: true, chainId: 42161, forkBlock, account, token: tokenAddress, paymaster: pmAddress, entryPoint: entryAddress, controls, submissions: journal.length }));
      return;
    }
    if (request.method === 'GET' && request.url === '/fixture/submissions') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(journal)); return;
    }
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) throw Error('Request too large');
    }
    const call = JSON.parse(body);
    if (request.method === 'POST' && request.url === '/fixture') {
      assert.equal(typeof call.dropNextSubmissionResponse, 'boolean');
      controls = { dropNextSubmissionResponse: call.dropNextSubmissionResponse };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(controls)); return;
    }
    let result;
    try {
      if (call.method === 'eth_sendUserOperation') {
        const run = serial.then(() => dispatch(call.method, call.params ?? []));
        serial = run.catch(() => {});
        result = { jsonrpc: '2.0', id: call.id, result: await run };
        if (controls.dropNextSubmissionResponse) {
          controls.dropNextSubmissionResponse = false;
          response.destroy(); return;
        }
      } else result = { jsonrpc: '2.0', id: call.id, result: await dispatch(call.method, call.params ?? []) };
    } catch (error) {
      result = { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: error.shortMessage ?? error.message } };
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: error.message }));
  }
});
server.listen(Number(process.env.PORT ?? 8546), '0.0.0.0', () =>
  console.log('Arbitrum fork fixture ready; transactions execute only on Anvil.'),
);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => { rpc.destroy(); process.exit(0); }));
