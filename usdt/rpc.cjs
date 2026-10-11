const { createServer } = require('node:http');

const READ_METHODS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getCode',
  'eth_getBalance',
  'eth_getTransactionCount',
  'eth_getStorageAt',
  'eth_call',
  'eth_getLogs',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'eth_getProof',
  'eth_gasPrice',
  'eth_feeHistory',
  'eth_maxPriorityFeePerGas',
  'net_version',
  'web3_clientVersion',
]);

async function rpc(url, method, params = []) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`RPC returned HTTP ${response.status}`), {
      httpStatus: response.status,
    });
  }
  const body = await response.json();
  if (body.error) {
    const error = new Error(body.error.message);
    error.code = body.error.code;
    error.data = body.error.data;
    throw error;
  }
  return body.result;
}

async function serve(port, dispatch, host = '127.0.0.1') {
  const server = createServer(async (req, res) => {
    let call;
    try {
      // Control ports are published only on host loopback; reject browser-origin requests.
      if (req.method !== 'POST' || req.headers.origin) throw new Error('Use a local RPC client');
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 131072) throw new Error('Request too large');
      }
      call = JSON.parse(body);
      if (!call || Array.isArray(call) || typeof call.method !== 'string') {
        throw new Error('Expected a JSON-RPC request');
      }
      const result = await dispatch(call.method, call.params ?? []);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id ?? null, result }));
    } catch (error) {
      res.statusCode = error.httpStatus ?? 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: call?.id ?? null,
          error: { code: error.code ?? -32000, message: error.message, data: error.data },
        }),
      );
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}

function upstreamReader(url) {
  return async (method, params) => {
    if (!READ_METHODS.has(method)) throw new Error('Upstream writes are disabled');
    try {
      return await rpc(url, method, params);
    } catch (cause) {
      const error = new Error(`Upstream read failed: ${method}`);
      // Preserve throttling for Anvil's retries without exposing provider diagnostics.
      if (cause.httpStatus === 429 || cause.code === 429) error.httpStatus = 429;
      throw error;
    }
  };
}
module.exports = { rpc, serve, upstreamReader };
