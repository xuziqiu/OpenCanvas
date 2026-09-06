const { spawnSync } = require('node:child_process');
const path = require('node:path');

const cli = path.resolve(__dirname, '..', 'node_modules', 'knip', 'bin', 'knip.js');
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: path.resolve(__dirname, '..'),
  env: { ...process.env, KNIP_DISABLE_RAW_TRANSFER: '1' },
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
