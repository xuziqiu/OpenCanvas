const fs = require('node:fs');
const path = require('node:path');

const assetDir = path.join(__dirname, '..', 'dist', 'assets');
const limit = 450 * 1024;
const bundles = fs.readdirSync(assetDir)
  .filter((name) => name.endsWith('.js'))
  .map((name) => ({ name, bytes: fs.statSync(path.join(assetDir, name)).size }))
  .sort((a, b) => b.bytes - a.bytes);
const oversized = bundles.filter((bundle) => bundle.bytes > limit);
if (oversized.length) {
  throw new Error(`JavaScript bundle budget exceeded (450 KiB): ${oversized.map((item) => `${item.name} ${(item.bytes / 1024).toFixed(1)} KiB`).join(', ')}`);
}
process.stdout.write(`Bundle budget passed: ${bundles[0]?.name ?? 'none'} ${(bundles[0]?.bytes / 1024).toFixed(1) ?? '0'} KiB max.\n`);
