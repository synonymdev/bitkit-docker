const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { mkdirSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const pins = require('./pins.json');
const root = path.resolve(__dirname, '..');
const state = path.join(root, '.usdt');

function run(command, args, cwd = root) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}
function checkout(name, repository, revision) {
  const directory = path.join(state, name);
  if (!existsSync(directory)) {
    run('git', ['init', directory]);
    run('git', ['remote', 'add', 'origin', repository], directory);
  }
  if (execFileSync('git', ['status', '--porcelain'], { cwd: directory, encoding: 'utf8' }).trim()) {
    throw new Error(`Fixture ${name} checkout has edits; preserve or move it before setup`);
  }
  run('git', ['fetch', '--depth', '1', 'origin', revision], directory);
  run('git', ['checkout', '--detach', revision], directory);
  return directory;
}
async function setup() {
  mkdirSync(path.join(state, 'bin'), { recursive: true, mode: 0o700 });
  const platform = `${process.platform}_${process.arch === 'x64' ? 'amd64' : process.arch}`;
  const digest = pins.anvilHashes[platform];
  if (!digest) throw new Error(`Unsupported platform ${platform}`);
  const archive = path.join(state, `foundry-${pins.anvil}-${platform}.tar.gz`);
  if (!existsSync(archive)) {
    const url = `https://github.com/foundry-rs/foundry/releases/download/v${pins.anvil}/foundry_v${pins.anvil}_${platform}.tar.gz`;
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Foundry download: HTTP ${response.status}`);
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  }
  if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== digest) {
    throw new Error('Foundry archive checksum mismatch; remove the archive and retry setup');
  }
  run('tar', ['-xzf', archive, '-C', path.join(state, 'bin'), 'anvil']);
  const service = checkout(
    'service',
    'https://github.com/synonymdev/bitkit-usdt-service.git',
    pins.service,
  );
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], service);
  run('npm', ['run', 'build'], service);
  checkout('core', 'https://github.com/synonymdev/bitkit-core.git', pins.core);
  run('cargo', ['build', '--locked', '--manifest-path', 'usdt/wallet/Cargo.toml']);
  console.log(
    'USDT tools ready. Set ARBITRUM_RPC_URL (or USDT_TEST_ENV_FILE), then run ./usdt-fixture run.',
  );
}
module.exports = { setup, root, state };
