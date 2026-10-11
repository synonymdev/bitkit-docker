const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const modes = ['healthy', 'unavailable', 'rate-limited', 'invalid-response'];
function providerMode(mode) {
  assert(modes.includes(mode), 'Unknown bridge provider mode');
  return mode;
}
async function serveProvider(port, fixture, key) {
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    try {
      assert(!req.headers.origin, 'Use a local client');
      if (key) assert.equal(req.headers.authorization, `Bearer ${key}`);
      if (fixture.mode === 'unavailable')
        throw Object.assign(new Error('provider_unavailable'), { status: 503 });
      if (fixture.mode === 'rate-limited') {
        res.setHeader('retry-after', '1');
        throw Object.assign(new Error('rate_limited'), { status: 429 });
      }
      if (fixture.mode === 'invalid-response') return res.end(JSON.stringify({ invalid: true }));
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        assert(raw.length <= 131072, 'Request too large');
      }
      const value = await fixture.request(
        req.method,
        new URL(req.url, 'http://localhost'),
        raw ? JSON.parse(raw) : undefined,
        req.headers['x-idempotency-key'],
      );
      res.end(JSON.stringify(value));
    } catch (error) {
      res.statusCode = error.status ?? 400;
      res.end(JSON.stringify({ error: { code: error.message } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}
module.exports = { serveProvider, providerMode };
