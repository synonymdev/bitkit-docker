import assert from 'node:assert/strict';
import { Contract, HDNodeWallet, Interface, JsonRpcProvider, concat, toBeHex, zeroPadValue } from 'ethers';
const origin = process.env.FIXTURE_URL ?? 'http://127.0.0.1:8546';
const rpc = new JsonRpcProvider(origin, 42161, { staticNetwork: true, cacheTimeout: -1 });
const chain = new JsonRpcProvider(process.env.ANVIL_URL ?? 'http://127.0.0.1:8545', 42161, { staticNetwork: true, cacheTimeout: -1 });
const health = await (await fetch(`${origin}/health`)).json();
assert.equal(health.ready, true);
assert.equal(health.chainId, 42161);
const wallet = HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, "m/44'/60'/0'/0/5");
const recipient = HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, "m/44'/60'/0'/0/6").address;
const delegate = '0xe6Cae83BdE06E4c305530e199D7217f42808555B';
const token = new Contract(health.token, ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256)', 'function transfer(address,uint256)'], rpc);
const packedType = '(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)';
const entry = new Contract(health.entryPoint, [`function getUserOpHash(${packedType}) view returns (bytes32)`, 'function getNonce(address,uint192) view returns (uint256)'], chain);
const account = new Interface(['function executeBatch((address target,uint256 value,bytes data)[] calls)']);
await chain.send('anvil_setBalance', [wallet.address, '0x0']);
assert.equal(await rpc.send('test_fundWallet', [wallet.address]), true);
assert.equal(await token.balanceOf(wallet.address), 1_000_000_000n);
assert.equal(await rpc.send('eth_getBalance', [wallet.address, 'latest']), '0x0');
const quotes = await rpc.send('pimlico_getTokenQuotes', [{ tokens: [health.token] }]);
assert.equal(quotes.quotes[0].paymaster, health.paymaster);
function pack(op) {
  return {
    sender: op.sender, nonce: op.nonce, initCode: concat(['0x7702', toBeHex(0, 18)]), callData: op.callData,
    accountGasLimits: concat([toBeHex(op.verificationGasLimit, 16), toBeHex(op.callGasLimit, 16)]),
    preVerificationGas: op.preVerificationGas,
    gasFees: concat([toBeHex(op.maxPriorityFeePerGas, 16), toBeHex(op.maxFeePerGas, 16)]),
    paymasterAndData: concat([op.paymaster, toBeHex(op.paymasterVerificationGasLimit, 16), toBeHex(op.paymasterPostOpGasLimit, 16), op.paymasterData]), signature: op.signature,
  };
}
async function operation() {
  const nonce = await chain.send('eth_getTransactionCount', [wallet.address, 'latest']);
  const auth = await wallet.authorize({ address: delegate, chainId: 42161, nonce: BigInt(nonce) });
  const op = {
    sender: wallet.address, nonce: toBeHex(await entry.getNonce(wallet.address, 0)), factory: '0x7702', factoryData: '0x',
    callData: account.encodeFunctionData('executeBatch', [[
      { target: health.token, value: 0, data: token.interface.encodeFunctionData('approve', [health.paymaster, 100_000_000]) },
      { target: health.token, value: 0, data: token.interface.encodeFunctionData('transfer', [recipient, 1_000_000]) },
    ]]),
    maxFeePerGas: toBeHex(100_000_000), maxPriorityFeePerGas: toBeHex(1_000_000),
    signature: zeroPadValue('0x01', 65),
    eip7702Auth: { address: auth.address, chainId: toBeHex(auth.chainId), nonce: toBeHex(auth.nonce), r: auth.signature.r, s: auth.signature.s, yParity: toBeHex(auth.signature.yParity) },
  };
  Object.assign(op, await rpc.send('eth_estimateUserOperationGas', [op, health.entryPoint]));
  Object.assign(op, await rpc.send('pm_getPaymasterData', [op, health.entryPoint, '0xa4b1', {}]));
  const hash = await chain.send('eth_call', [
    { to: health.entryPoint, data: entry.interface.encodeFunctionData('getUserOpHash', [pack(op)]) }, 'latest',
    { [wallet.address]: { code: concat(['0xef0100', delegate]) } },
  ]);
  op.signature = wallet.signingKey.sign(hash).serialized;
  return { op, hash };
}
try {
  const recipientBefore = await token.balanceOf(recipient);
  const first = await operation();
  assert.equal(await rpc.send('eth_sendUserOperation', [first.op, health.entryPoint]), first.hash);
  assert.equal(await token.balanceOf(recipient), recipientBefore + 1_000_000n);
  let submissions = await (await fetch(`${origin}/fixture/submissions`)).json();
  const record = submissions.find(r => r.operation === first.hash);
  assert.equal(record.status, 'mined');
  const receipt = await rpc.send('eth_getTransactionReceipt', [record.transaction]);
  assert.equal(receipt.status, '0x1');
  assert(receipt.logs.length > 0);
  assert.deepEqual(await rpc.send('eth_getLogs', [{ fromBlock: '0x0', toBlock: toBeHex(health.forkBlock), address: health.token }]), []);
  await fetch(`${origin}/fixture`, { method: 'POST', body: JSON.stringify({ dropNextSubmissionResponse: true }) });
  const second = await operation();
  await assert.rejects(fetch(origin, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendUserOperation', params: [second.op, health.entryPoint] }) }));
  submissions = await (await fetch(`${origin}/fixture/submissions`)).json();
  assert.equal(submissions.filter(r => r.operation === second.hash && r.status === 'mined').length, 1);
  assert.equal(await token.balanceOf(recipient), recipientBefore + 2_000_000n);
  console.log(JSON.stringify({ ready: true, fundedUSDT: '1000', zeroAccountETH: true, bundledTransfers: 2, lostResponseMinedOnce: true, receiptsAvailable: true }));
} finally { rpc.destroy(); chain.destroy(); }
