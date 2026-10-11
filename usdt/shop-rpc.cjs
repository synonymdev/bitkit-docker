const { serve, upstreamReader } = require('./rpc.cjs');
// Shares Paykit Server's network namespace so its existing localhost-only HTTP policy applies.
serve(23450, upstreamReader('http://host.docker.internal:23450')).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
