const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const pins = require('./pins.json');

async function main() {
  const platform = `linux_${process.arch === 'x64' ? 'amd64' : process.arch}`;
  const digest = pins.anvilHashes[platform];
  if (!digest) throw new Error(`Unsupported container architecture ${platform}`);
  const response = await fetch(
    `https://github.com/foundry-rs/foundry/releases/download/v${pins.anvil}/foundry_v${pins.anvil}_${platform}.tar.gz`,
    { signal: AbortSignal.timeout(120_000) },
  );
  if (!response.ok) throw new Error(`Foundry download: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(archive).digest('hex') !== digest)
    throw new Error('Foundry checksum mismatch');
  writeFileSync('/tmp/foundry.tar.gz', archive);
  execFileSync('tar', ['-xzf', '/tmp/foundry.tar.gz', '-C', '/usr/local/bin', 'anvil']);
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
