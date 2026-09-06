const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const electronRoot = path.dirname(require.resolve('electron/package.json'));
const electronPackage = require(path.join(electronRoot, 'package.json'));
const executable = process.platform === 'win32'
  ? path.join(electronRoot, 'dist', 'electron.exe')
  : process.platform === 'darwin'
    ? path.join(electronRoot, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : path.join(electronRoot, 'dist', 'electron');
const versionFile = path.join(electronRoot, 'dist', 'version');

const installedVersion = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim().replace(/^v/, '') : '';
if (installedVersion === electronPackage.version && fs.existsSync(executable)) process.exit(0);

process.stdout.write(`[ensure-electron] 正在准备 Electron ${electronPackage.version} 运行时…\n`);
const result = spawnSync(process.execPath, [require.resolve('electron/install.js')], { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
