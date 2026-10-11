const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  encodeFunctionData,
  parseAbi,
  decodeEventLog,
  encodeEventTopics,
  getAddress,
} = require('viem');
const { TOKEN, atomicAmount, transfer } = require('./contracts.cjs');
const { rpc } = require('./rpc.cjs');
const { providerMode } = require('./bridge-http.cjs');
const {
  sourceNetworks,
  bridgeNetworks,
  asset,
  addresses,
  evmAddress,
  digest,
  units,
  scale,
} = require('./bridge-assets.cjs');
const tokenAbi = parseAbi([
  'function transfer(address,uint256) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const id = (prefix) => `${prefix}_${randomUUID()}`;
const refFor = (owner) => `bitkit-arb-usdt-v1-${getAddress(owner).toLowerCase()}`;
function need(value) {
  if (!value) throw Object.assign(new Error('not_found'), { status: 404 });
  return value;
}
class OrchestraFixture {
  constructor(node) {
    this.node = node;
    this.reset();
  }
  reset() {
    this.mode = 'healthy';
    this.fee = 10000n;
    this.ttl = 120;
    this.accounts = new Map();
    this.quotes = new Map();
    this.deposits = new Map();
    this.keys = new Map();
  }
  output(amount) {
    const result = BigInt(amount) - this.fee;
    if (BigInt(amount) < 20000n || result <= 0n)
      throw Object.assign(new Error('amount_too_small'), { status: 409 });
    return result;
  }
  standing(ref, instruction) {
    let account = this.accounts.get(ref);
    if (instruction) {
      assert.equal(instruction.destination.chain, 'arbitrum');
      assert.equal(instruction.destination.asset, 'USDT');
      assert.equal(ref, refFor(instruction.destination.address));
      if (account) assert.deepEqual(account.instruction, instruction, 'instruction_conflict');
      else {
        account = {
          instruction,
          standingAddressId: id('standing'),
          addresses: addresses(ref),
          enabled: true,
        };
        this.accounts.set(ref, account);
      }
    }
    return need(account);
  }
  async quote(body, key) {
    assert(key, 'Missing idempotency key');
    const createdBlock = await rpc(this.node, 'eth_blockNumber');
    const previous = this.keys.get(key);
    if (previous) {
      assert.deepEqual(previous.body, body, 'idempotency_conflict');
      return previous.quote;
    }
    assert.equal(body.sourceChain, 'arbitrum');
    assert.equal(body.sourceAsset, 'USDT');
    assert.equal(body.destinationAsset, 'USDT');
    assert.equal(body.refundChain, 'arbitrum');
    assert(bridgeNetworks.includes(body.destinationChain), 'route_unavailable');
    const owner = getAddress(body.refundAddress);
    const quoteId = id('quote');
    const funding = evmAddress(quoteId);
    const quote = {
      quoteId,
      depositAddress: funding,
      amountIn: body.amount,
      estimatedOut: units(this.output(body.amount), body.destinationChain),
      expiresAt: new Date(Date.now() + this.ttl * 1000).toISOString(),
      transaction: {
        chainId: 42161,
        to: TOKEN,
        data: encodeFunctionData({
          abi: tokenAbi,
          functionName: 'transfer',
          args: [funding, BigInt(body.amount)],
        }),
        value: '0',
      },
      route: ['arbitrum:USDT', `${body.destinationChain}:USDT`],
      amountMode: 'exact_in',
    };
    const summary = {
      id: quoteId,
      sourceChain: 'arbitrum',
      sourceAsset: 'USDT',
      destinationChain: body.destinationChain,
      destinationAsset: 'USDT',
      amountIn: quote.amountIn,
      estimatedOut: quote.estimatedOut,
      depositAddress: funding,
      recipientAddress: body.recipientAddress,
      expiresAt: quote.expiresAt,
      slippageBps: 50,
    };
    this.quotes.set(quoteId, {
      id: quoteId,
      owner,
      quote,
      summary,
      createdBlock,
      order: null,
    });
    this.keys.set(key, { body, quote });
    return quote;
  }
  async funded(record) {
    if (record.order) return record.order;
    const logs = await rpc(this.node, 'eth_getLogs', [
      {
        address: TOKEN,
        fromBlock: record.createdBlock,
        toBlock: 'latest',
        topics: encodeEventTopics({
          abi: tokenAbi,
          eventName: 'Transfer',
          args: { from: record.owner, to: record.quote.depositAddress },
        }),
      },
    ]);
    for (const log of logs) {
      if (
        log.removed ||
        decodeEventLog({ abi: tokenAbi, ...log }).args.value !== BigInt(record.quote.amountIn)
      )
        continue;
      const receipt = await rpc(this.node, 'eth_getTransactionReceipt', [log.transactionHash]);
      if (receipt?.status !== '0x1' || receipt.blockHash !== log.blockHash) continue;
      if (record.order) return record.order;
      record.order = {
        ...record.summary,
        id: id('order'),
        type: 'order',
        quoteId: record.id,
        status: 'processing',
        sourceAddress: record.owner,
        sourceTxHash: receipt.transactionHash,
        destinationAddress: record.summary.recipientAddress,
        amountOut: record.quote.estimatedOut,
        destinationTxHash: null,
        refundTxHash: null,
        errorCode: null,
      };
      break;
    }
    return record.order;
  }
  async request(method, url, body, key) {
    const path = url.pathname;
    const query = url.searchParams;
    if (method === 'GET' && path === '/v2/orchestration/routes')
      return {
        assets: ['arbitrum', ...bridgeNetworks].map((chain) => ({
          ...asset(chain),
          id: `${chain}:USDT`,
          route: { to: 'all' },
        })),
      };
    if (method === 'GET' && path === '/v1/standing-deposit-addresses/destinations')
      return { destinations: [{ chain: 'arbitrum', asset: 'USDT' }] };
    if (method === 'GET' && path === '/v1/orchestration/limits')
      return {
        routes: [
          {
            sourceChain: query.get('sourceChain'),
            sourceAsset: 'USDT',
            destinationChain: 'arbitrum',
            destinationAsset: 'USDT',
            limits: {
              orderNotionalUsd: { minCents: '2', maxCents: '100000000' },
              exactIn: { supported: true },
            },
          },
        ],
      };
    if (method === 'GET' && path === '/v1/orchestration/estimate') {
      const network = query.get('sourceChain');
      assert(sourceNetworks.includes(network));
      return {
        estimatedOut: this.output(BigInt(query.get('amount')) / scale(network)).toString(),
        feeAsset: 'USDT',
        feeAssetDetails: asset(network),
        source: asset(network),
        destination: asset('arbitrum'),
        amountMode: 'exact_in',
      };
    }
    if (method === 'POST' && path === '/v1/orchestration/quote') return this.quote(body, key);
    if (method === 'GET' && path === '/v1/orchestration/order') {
      const record = need(this.quotes.get(query.get('quoteId')));
      return { quote: record.summary, order: await this.funded(record) };
    }
    if (method === 'GET' && path === '/v1/orchestration/status') {
      const record = [...this.deposits.values(), ...this.quotes.values()].find(
        (r) => r.order?.id === query.get('id'),
      );
      return { order: need(record).order };
    }
    const match = /^\/v1\/standing-deposit-addresses\/([^/]+)(?:\/(deposits|resolve))?$/.exec(path);
    assert(match, 'Unknown Orchestra fixture path');
    const [, ref, action] = match;
    if (!action && ['GET', 'PUT'].includes(method))
      return this.standing(ref, method === 'PUT' ? body : undefined);
    const account = need(this.accounts.get(ref));
    if (method === 'GET' && action === 'deposits') {
      const offset = Number(query.get('offset') ?? 0);
      assert(Number.isInteger(offset) && offset >= 0);
      const rows = [...this.deposits.values()]
        .filter((r) => r.ref === ref)
        .reverse()
        .map((r) => r.deposit);
      return {
        deposits: rows.slice(offset, offset + 50),
        nextOffset: offset + 50 < rows.length ? offset + 50 : null,
      };
    }
    if (method === 'POST' && action === 'resolve') {
      assert.equal(body.depositIds.length, 1);
      const record = need(this.deposits.get(body.depositIds[0]));
      assert.equal(record.ref, ref);
      assert(
        !record.effect && !['completed', 'refunded'].includes(record.deposit.status),
        'refund_not_available',
      );
      assert(
        body.refundAddress !== account.addresses[record.deposit.chain],
        'invalid_refund_address',
      );
      if (record.refundAddress)
        assert.equal(record.refundAddress, body.refundAddress, 'instruction_conflict');
      if (!record.refundAddress) {
        record.refundAddress = body.refundAddress;
        record.deposit.batchState = 'refund_requested';
      }
      return { batchId: `batch_${record.id}`, status: 'refund_requested' };
    }
    throw new Error('Unknown Orchestra fixture method');
  }
  addDeposit(owner, network, amount) {
    const ref = refFor(owner);
    const account = need(this.accounts.get(ref));
    assert(sourceNetworks.includes(network), 'Unsupported deposit network');
    const input = atomicAmount(amount);
    const received = this.output(input);
    const depositId = id('deposit');
    const deposit = {
      id: depositId,
      chain: network,
      asset: 'USDT',
      amount: units(input, network),
      sourceTxId: digest(depositId),
      status: 'held',
      code: 'standing_route_unavailable',
      orderId: null,
      batchState: null,
      refundTxId: null,
    };
    this.deposits.set(depositId, {
      id: depositId,
      ref,
      deposit,
      recipient: account.instruction.destination.address,
      received,
      order: null,
    });
    return deposit;
  }
  async advance(id, status) {
    assert(
      ['processing', 'needs_attention', 'failed', 'completed', 'refunding', 'refunded'].includes(
        status,
      ),
      'Unknown Orchestra status',
    );
    const record = need(this.quotes.get(id) ?? this.deposits.get(id));
    if (!record.deposit)
      assert(await this.funded(record), 'Quote has no matching on-chain funding transfer');
    if (record.deposit && ['refunding', 'refunded'].includes(status))
      assert(record.refundAddress, 'Request the deposit refund through the app first');
    if (record.deposit && status === 'completed')
      assert(!record.refundAddress, 'Refund already requested');
    if (record.effect) {
      assert.equal(record.effect.status, status, 'Settlement already selected');
      return record.effect.promise;
    }
    const settle = async () => {
      if (record.deposit) {
        const deposit = record.deposit;
        if (!record.order) {
          record.order = {
            id: `order_${id}`,
            status: 'processing',
            sourceChain: deposit.chain,
            sourceAsset: 'USDT',
            destinationChain: 'arbitrum',
            destinationAsset: 'USDT',
            recipientAddress: record.recipient,
            amountIn: deposit.amount,
            amountOut: record.received.toString(),
            destinationTxHash: null,
            refundTxHash: null,
            errorCode: null,
          };
          deposit.orderId = record.order.id;
        }
        if (status === 'completed') {
          record.order.destinationTxHash = await transfer(
            this.node,
            record.recipient,
            record.received,
          );
        }
        if (status === 'refunded')
          record.order.refundTxHash = deposit.refundTxId = digest(`refund_${id}`);
        deposit.status = status === 'needs_attention' ? 'held' : status;
        deposit.code =
          status === 'needs_attention' || status === 'failed' ? 'provider_review' : null;
        deposit.batchState = ['refunding', 'refunded'].includes(status) ? status : null;
      } else {
        const order = record.order;
        if (status === 'completed') order.destinationTxHash = digest(`destination_${id}`);
        if (status === 'refunded') {
          order.refundTxHash = await transfer(
            this.node,
            record.owner,
            BigInt(record.quote.amountIn),
          );
          order.refundAsset = 'USDT';
          order.refundAmount = record.quote.amountIn;
        }
      }
      record.order.status = status === 'needs_attention' ? 'processing' : status;
      record.order.errorCode = ['needs_attention', 'failed'].includes(status)
        ? 'provider_review'
        : null;
      return record.order;
    };
    // A repeated settlement command shares the same transfer, including while it is in flight.
    if (['completed', 'refunded'].includes(status)) {
      record.effect = { status, promise: settle() };
      return record.effect.promise;
    }
    return settle();
  }
  async control([command, ...args]) {
    switch (command) {
      case 'list':
        for (const record of this.quotes.values()) await this.funded(record);
        return {
          accounts: [...this.accounts.entries()].map(([ref, a]) => ({ ref, ...a })),
          quotes: [...this.quotes.values()].map(({ id, owner, summary, order }) => ({
            id,
            owner,
            ...summary,
            order,
          })),
          deposits: [...this.deposits.values()].map(({ deposit, order, refundAddress }) => ({
            deposit,
            order,
            refundAddress,
          })),
        };
      case 'deposit':
        return this.addDeposit(...args);
      case 'advance':
        return this.advance(...args);
      case 'mode':
        this.mode = providerMode(args[0]);
        return this.mode;
      case 'fee':
        this.fee = args[0] === '0' ? 0n : atomicAmount(args[0]);
        return this.fee.toString();
      case 'quote-ttl': {
        const ttl = Number(args[0]);
        assert(Number.isInteger(ttl) && ttl >= 1 && ttl <= 3600, 'Use 1-3600 seconds');
        this.ttl = ttl;
        return ttl;
      }
      default:
        throw new Error(
          'Use list, deposit OWNER NETWORK USDT, advance ID STATUS, mode, fee USDT or quote-ttl SECONDS',
        );
    }
  }
}
module.exports = { OrchestraFixture };
