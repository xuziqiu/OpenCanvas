const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const outputPath = path.join(root, 'THIRD_PARTY_NOTICES.md');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

const licenseNames = [
  'LICENSE', 'LICENSE.md', 'LICENSE.txt',
  'LICENCE', 'LICENCE.md', 'LICENCE.txt',
  'COPYING',
];

const normalize = (value) => value.replace(/\r\n/g, '\n').trim();
const escapeCell = (value) => String(value).replaceAll('|', '\\|');
const indent = (value) => normalize(value).split('\n').map((line) => `    ${line}`).join('\n');

function readInstalledPackage(packagePath) {
  const directory = path.join(root, packagePath);
  const metadataPath = path.join(directory, 'package.json');
  if (!fs.existsSync(metadataPath)) {
    throw new Error(`Missing installed package metadata: ${packagePath}`);
  }
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const licensePath = licenseNames.map((name) => path.join(directory, name)).find(fs.existsSync);
  if (!licensePath) {
    throw new Error(`Missing license notice for ${metadata.name}@${metadata.version}`);
  }
  return {
    name: metadata.name,
    version: metadata.version,
    license: metadata.license,
    notice: normalize(fs.readFileSync(licensePath, 'utf8')),
  };
}

const packages = Object.entries(lock.packages)
  .filter(([packagePath, metadata]) => packagePath && !metadata.dev)
  .map(([packagePath]) => readInstalledPackage(packagePath));

// Electron is a development dependency in package.json, but its runtime is
// redistributed with every desktop build and therefore belongs in the notice.
packages.push(readInstalledPackage('node_modules/electron'));

const interNotice = normalize(fs.readFileSync(path.join(root, 'src/assets/fonts/inter/LICENSE.txt'), 'utf8'));
packages.push({
  name: 'Inter font',
  version: 'bundled',
  license: 'OFL-1.1',
  notice: interNotice,
});

packages.sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`, 'en'));

const noticeGroups = new Map();
for (const item of packages) {
  const digest = crypto.createHash('sha256').update(item.notice).digest('hex');
  const group = noticeGroups.get(digest) ?? { license: item.license, notice: item.notice, packages: [] };
  group.packages.push(`${item.name}@${item.version}`);
  noticeGroups.set(digest, group);
}

const lines = [
  '# OpenCanvas third-party notices',
  '',
  'This file is generated from the locked production dependency graph. Do not edit it manually; run `npm run licenses:update` after changing dependencies.',
  '',
  'OpenCanvas itself is licensed under GPL-3.0-only. The packages and bundled font below remain under their respective licenses. Electron distributions also retain `LICENSE` and `LICENSES.chromium.html` from the upstream runtime.',
  '',
  '## Runtime inventory',
  '',
  '| Package | Version | License |',
  '| --- | --- | --- |',
  ...packages.map((item) => `| ${escapeCell(item.name)} | ${escapeCell(item.version)} | ${escapeCell(item.license)} |`),
  '',
  '## License texts and copyright notices',
  '',
];

[...noticeGroups.values()]
  .sort((left, right) => left.packages[0].localeCompare(right.packages[0], 'en'))
  .forEach((group, index) => {
    lines.push(`### Notice ${index + 1}: ${group.license}`);
    lines.push('');
    lines.push(`Applies to: ${group.packages.join(', ')}`);
    lines.push('');
    lines.push(indent(group.notice));
    lines.push('');
  });

const output = `${lines.join('\n').trim()}\n`;
const mode = process.argv[2] ?? '--check';

if (mode === '--write') {
  fs.writeFileSync(outputPath, output, 'utf8');
  console.log(`Updated ${path.relative(root, outputPath)} with ${packages.length} runtime entries and ${noticeGroups.size} unique notices.`);
} else if (mode === '--check') {
  const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  if (existing !== output) {
    console.error('THIRD_PARTY_NOTICES.md is stale. Run npm run licenses:update.');
    process.exitCode = 1;
  } else {
    console.log(`Third-party notices verified: ${packages.length} runtime entries and ${noticeGroups.size} unique notices.`);
  }
} else {
  throw new Error(`Unknown mode: ${mode}`);
}
