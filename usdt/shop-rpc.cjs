const { serve, upstreamReader } = require('./rpc.cjs');
// Shares Paykit Server's network namespace so its existing localhost-only HTTP policy applies.
serve(23450, upstreamReader('http://usdt-fixture:23458')).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
