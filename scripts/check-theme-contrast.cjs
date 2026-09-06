const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');

function themeBlock(theme) {
  const marker = `.app-shell[data-theme='${theme}']`;
  const start = css.indexOf(marker);
  if (start < 0) throw new Error(`Missing ${theme} theme block`);
  const firstThemeToken = css.indexOf('--oc-sidebar:', start);
  if (firstThemeToken < 0) throw new Error(`Missing ${theme} theme tokens`);
  const open = css.lastIndexOf('{', firstThemeToken);
  const close = css.indexOf('}', firstThemeToken);
  return css.slice(open + 1, close);
}

function token(block, name) {
  const match = block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`Missing solid color token --${name}`);
  return match[1];
}

function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map((value) => Number.parseInt(value, 16) / 255).map((value) => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a, b) {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function channels(hex) {
  return hex.slice(1).match(/../g).map((value) => Number.parseInt(value, 16));
}

const failures = [];
for (const theme of ['dark', 'light']) {
  const block = themeBlock(theme);
  const surfaces = ['oc-sidebar', 'oc-canvas', 'oc-card', 'oc-raised'];
  for (const foreground of ['oc-text-muted', 'oc-text-caption']) {
    for (const surface of surfaces) {
      const ratio = contrast(token(block, foreground), token(block, surface));
      if (ratio < 4.5) failures.push(`${theme} --${foreground} on --${surface}: ${ratio.toFixed(2)}:1`);
    }
  }

  const accent = token(block, 'oc-accent');
  const onAccent = token(block, 'oc-on-accent');
  const accentSurfaceRatio = contrast(accent, token(block, 'oc-canvas'));
  const accentButtonRatio = contrast(onAccent, accent);
  const [red, green, blue] = channels(accent);
  if (accentSurfaceRatio < 3) failures.push(`${theme} --oc-accent on --oc-canvas: ${accentSurfaceRatio.toFixed(2)}:1`);
  if (accentButtonRatio < 4.5) failures.push(`${theme} --oc-on-accent on --oc-accent: ${accentButtonRatio.toFixed(2)}:1`);
  if (!(green > red && green > blue)) failures.push(`${theme} --oc-accent is not green-led: ${accent}`);
}

if (failures.length) {
  process.stderr.write(`Theme contrast budget failed:\n${failures.map((item) => `- ${item}`).join('\n')}\n`);
  process.exit(1);
}

process.stdout.write('Theme contrast budget passed for text, forest-green accents and primary controls.\n');
