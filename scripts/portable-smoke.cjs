const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { const value = await check(); if (value) return value; } catch {}
    await delay(120);
  }
  throw new Error(`便携版启动等待超过 ${timeout}ms`);
}

function clientFor(url) {
  const socket = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
  });
  return {
    ready: new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); }),
    send(method, params = {}) { return new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params })); }); },
    close() { socket.close(); },
  };
}

async function main() {
  if (process.platform !== 'win32') throw new Error('便携版验收当前只支持 Windows');
  const root = path.resolve(__dirname, '..');
  const executable = path.join(root, 'release', 'win-unpacked', 'OpenCanvas.exe');
  if (!fsSync.existsSync(executable)) throw new Error('找不到 release/win-unpacked/OpenCanvas.exe，请先运行 npm run pack');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'opencanvas-portable-smoke-'));
  const port = 9900 + Math.floor(Math.random() * 80);
  const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${path.join(temporary, 'profile')}`], {
    cwd: path.dirname(executable),
    env: { ...process.env, OPENCANVAS_E2E: '1', OPENCANVAS_VAULT_DIR: path.join(temporary, 'vault') },
    windowsHide: true,
    stdio: 'ignore',
  });
  let client;
  try {
    const target = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      return (await response.json()).find((item) => item.type === 'page');
    });
    client = clientFor(target.webSocketDebuggerUrl);
    await client.ready;
    const result = await waitFor(async () => {
      const response = await client.send('Runtime.evaluate', { expression: `({ shell: Boolean(document.querySelector('.app-shell')), nativeShell: document.querySelector('.app-shell')?.classList.contains('native-shell'), shellMarginTop: getComputedStyle(document.querySelector('.app-shell')).marginTop, themeApi: typeof window.openCanvasVault?.setWindowTheme, title: document.title, protocol: location.protocol, save: document.querySelector('.vault-status-button')?.innerText })`, returnByValue: true });
      return response.result?.value?.shell ? response.result.value : null;
    });
    if (result.protocol !== 'file:') throw new Error(`便携版错误地依赖了开发服务器：${JSON.stringify(result)}`);
    if (!result.nativeShell || result.shellMarginTop !== '32px') throw new Error(`原生标题栏占位没有生效：${JSON.stringify(result)}`);
    if (result.themeApi !== 'function') throw new Error(`窗口主题同步通道没有暴露：${JSON.stringify(result)}`);
    const themeResponse = await client.send('Runtime.evaluate', { expression: `window.openCanvasVault.setWindowTheme('light')`, awaitPromise: true, returnByValue: true });
    if (themeResponse.result?.value !== true) throw new Error('窗口主题同步通道没有响应');
    await client.send('Runtime.evaluate', { expression: 'window.close()' });
    await waitFor(() => child.exitCode !== null, 7000);
    process.stdout.write(`Portable smoke passed: ${result.title || 'OpenCanvas'}, file:// production bundle, isolated temporary vault.\n`);
  } finally {
    client?.close();
    if (child.exitCode === null) spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
