const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { strToU8, zipSync } = require('fflate');

const root = path.resolve(__dirname, '..');
const electronBinary = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WAIT_TIMEOUT_SCALE = process.env.CI ? 3 : 1;

function boxShadowProfile(value) {
  if (!value || value === 'none') return { layers: 0, maxOffsetY: 0, maxBlur: 0, maxAlpha: 0 };
  const layers = value.match(/(?:rgba?\([^)]*\)|#[\da-f]{3,8})[^,]*(?=,\s*(?:rgba?\(|#)|$)/gi) || [value];
  return layers.reduce((profile, layer) => {
    const color = layer.match(/rgba?\(([^)]*)\)/i)?.[1]?.split(',').map(part => Number(part.trim())) || [];
    const alpha = color.length >= 4 && Number.isFinite(color[3]) ? color[3] : 1;
    const tail = layer.replace(/rgba?\([^)]*\)|#[\da-f]{3,8}/i, '');
    const lengths = [...tail.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map(match => Number(match[1]));
    return {
      layers: profile.layers + 1,
      maxOffsetY: Math.max(profile.maxOffsetY, Math.abs(lengths[1] || 0)),
      maxBlur: Math.max(profile.maxBlur, Math.abs(lengths[2] || 0)),
      maxAlpha: Math.max(profile.maxAlpha, alpha),
    };
  }, { layers: 0, maxOffsetY: 0, maxBlur: 0, maxAlpha: 0 });
}

async function waitFor(check, timeout = 12000, interval = 120) {
  const started = Date.now();
  const effectiveTimeout = timeout * WAIT_TIMEOUT_SCALE;
  let lastError;
  while (Date.now() - started < effectiveTimeout) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(interval);
  }
  throw lastError || new Error(`Timed out after ${effectiveTimeout}ms`);
}

async function waitForProcessExit(child, timeout = 6000) {
  if (child.exitCode !== null) return true;
  return Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    delay(timeout).then(() => false),
  ]);
}

function cdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(timer);
    if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error('Chrome DevTools connection closed before the command completed'));
    }
    pending.clear();
  });
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return {
    ready,
    send(method, params = {}, timeout = 30000) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Chrome DevTools command timed out: ${method}`));
        }, timeout);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => socket.close(),
  };
}

async function main() {
  const progress = (message) => process.stdout.write(`[electron-smoke] ${message}\n`);
  if (!fsSync.existsSync(electronBinary)) throw new Error('Electron runtime is not installed; run npm install before the desktop smoke test.');
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencanvas-electron-smoke-'));
  const vault = path.join(testRoot, 'vault');
  const exchangeRoot = path.join(testRoot, 'exchange');
  const aclAccount = `${process.env.USERDOMAIN || os.hostname()}\\${process.env.USERNAME || os.userInfo().username}`;
  let deniedAclPath = null;
  const port = 9400 + Math.floor(Math.random() * 300);
  const vitePort = 10400 + Math.floor(Math.random() * 500);
  const devUrl = `http://127.0.0.1:${vitePort}`;
  const vite = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  await waitFor(async () => { try { return (await fetch(devUrl)).ok; } catch { return false; } }, 15000);
  await Promise.all([
    fs.mkdir(path.join(vault, 'attachments'), { recursive: true }),
    fs.mkdir(path.join(vault, 'notes'), { recursive: true }),
    fs.mkdir(path.join(vault, 'boards'), { recursive: true }),
    fs.mkdir(path.join(vault, '.opencanvas'), { recursive: true }),
    fs.mkdir(path.join(exchangeRoot, 'notes'), { recursive: true }),
  ]);
  await fs.writeFile(path.join(exchangeRoot, 'notes', 'canvas-source.md'), '# Canvas 来源\n\n真实 Markdown 文件。\n', 'utf8');
  const largeAttachmentPath = path.join(exchangeRoot, 'large-drop.bin');
  const largeAttachmentHandle = await fs.open(largeAttachmentPath, 'w');
  await largeAttachmentHandle.truncate(32 * 1024 * 1024);
  await largeAttachmentHandle.close();
  const canvasFixture = { nodes: [{ id: 'canvas-file-node', type: 'file', file: 'notes/canvas-source.md', x: 30, y: 40, width: 320, height: 210 }], edges: [] };
  const canvasFixturePath = path.join(exchangeRoot, 'fixture.canvas');
  await fs.writeFile(canvasFixturePath, JSON.stringify(canvasFixture), 'utf8');
  const unsafeZipPath = path.join(exchangeRoot, 'unsafe-path.zip');
  await fs.writeFile(unsafeZipPath, Buffer.from(zipSync({
    'manifest.json': strToU8(JSON.stringify({ format: 'opencanvas', version: 1, cards: [], boards: [] })),
    '../escape.txt': strToU8('must never escape'),
  })));
  const heptabaseMarkdownZipPath = path.join(exchangeRoot, 'heptabase-markdown-export.zip');
  await fs.writeFile(heptabaseMarkdownZipPath, Buffer.from(zipSync({
    'Heptabase Export/项目/卡片一.md': strToU8('---\ntitle: "迁移卡片"\n---\n\n# 迁移卡片\n\nHeptabase Markdown 正文。\n\n![迁移图片](../assets/迁移图片.png)\n'),
    'Heptabase Export/assets/迁移图片.png': new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  })));
  await fs.writeFile(path.join(vault, 'attachments', 'smoke.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>');
  const createdAt = '2026-01-01T00:00:00.000Z';
  const scrollingLines = Array.from({ length: 28 }, (_, index) => `第 ${index + 1} 行滚轮路由验证内容`).join('\n\n');
  const longDocumentLines = Array.from({ length: 1200 }, (_, index) => `第 ${index + 1} 段超长文档内容，用于验证编辑器滚动、输入延迟和卸载后的资源回收。`).join('\n\n');
  const longUnbrokenToken = `https://example.invalid/${'very-long-unbroken-segment-'.repeat(18)}`;
  const wideTableHeaders = Array.from({ length: 12 }, (_, index) => `列 ${index + 1}`);
  const wideTable = `| ${wideTableHeaders.join(' | ')} |\n| ${wideTableHeaders.map(() => '---').join(' | ')} |\n| ${wideTableHeaders.map((_, index) => index === 0 ? longUnbrokenToken : `宽表格内容 ${index + 1}`).join(' | ')} |`;
  const performanceNote = `---\nid: "performance-card"\ntitle: "五千节点性能验证"\ncreatedAt: "${createdAt}"\nupdatedAt: "${createdAt}"\n---\n\n## 轻量预览\n\n#### 四级标题颜色验证\n\n这张卡片在白板里被大量引用，未进入编辑时不应创建富文本编辑器。\n\n关联 [[归档/归档说明]]\n`;
  const scrollingNote = `---\nid: "scrolling-card"\ntitle: "滚轮路由边界验证"\ncreatedAt: "${createdAt}"\nupdatedAt: "${createdAt}"\n---\n\n## 长内容卡片\n\n${wideTable}\n\n${longUnbrokenToken}\n\n${scrollingLines}\n`;
  const longDocumentNote = `---\nid: "long-document-card"\ntitle: "超长文档压力测试"\ncreatedAt: "${createdAt}"\nupdatedAt: "${createdAt}"\n---\n\n# 超长文档压力测试\n\n${wideTable}\n\n${longUnbrokenToken}\n\n${longDocumentLines}\n`;
  await fs.writeFile(path.join(vault, 'notes', 'performance.md'), performanceNote, 'utf8');
  await fs.writeFile(path.join(vault, 'notes', 'scrolling.md'), scrollingNote, 'utf8');
  await fs.writeFile(path.join(vault, 'notes', 'long-document.md'), longDocumentNote, 'utf8');
  const bulkNotesDirectory = path.join(vault, 'notes', '批量文件');
  const archiveNotesDirectory = path.join(vault, 'notes', '归档');
  await fs.mkdir(bulkNotesDirectory, { recursive: true });
  await fs.mkdir(archiveNotesDirectory, { recursive: true });
  await fs.mkdir(path.join(vault, 'notes', 'rollback-source'), { recursive: true });
  await fs.writeFile(path.join(vault, 'notes', 'rollback-source', 'probe.txt'), 'rollback probe', 'utf8');
  await fs.writeFile(path.join(archiveNotesDirectory, '归档说明.md'), `---\nid: "archive-card"\ntitle: "归档说明"\ncreatedAt: "${createdAt}"\nupdatedAt: "${createdAt}"\n---\n\n用于验证拖动悬停展开目录。\n`, 'utf8');
  for (let offset = 0; offset < 5000; offset += 250) {
    await Promise.all(Array.from({ length: Math.min(250, 5000 - offset) }, (_, localIndex) => {
      const index = offset + localIndex;
      const suffix = String(index).padStart(4, '0');
      return fs.writeFile(path.join(bulkNotesDirectory, `bulk-${suffix}.md`), `---\nid: "bulk-card-${suffix}"\ntitle: "批量文件 ${suffix}"\ncreatedAt: "${createdAt}"\nupdatedAt: "${createdAt}"\n---\n\n虚拟文件树压力测试 ${suffix}\n`, 'utf8');
    }));
  }
  await fs.writeFile(path.join(vault, 'notes', `recovered.md.opencanvas-tmp-smoke`), `---\nid: "recovered-card"\ntitle: "异常写入恢复"\ncreatedAt: "${createdAt}"\nupdatedAt: "${createdAt}"\n---\n\n恢复成功\n`, 'utf8');
  const placements = Array.from({ length: 5000 }, (_, index) => ({
    id: `performance-placement-${index}`,
    kind: 'card',
    entityId: index === 1 ? 'scrolling-card' : index === 2 ? 'long-document-card' : 'performance-card',
    x: 80 + (index % 100) * 380,
    y: 80 + Math.floor(index / 100) * 270,
    width: 320,
    height: 210,
    color: '#ffffff',
  }));
  const performanceConnectors = Array.from({ length: placements.length - 1 }, (_, index) => ({
    id: `performance-edge-${index}`,
    from: `performance-placement-${index + 1}`,
    to: 'performance-placement-0',
    lineStyle: index % 7 === 0 ? 'orthogonal' : 'curve',
    arrow: 'end',
    width: 2,
    ...(index === 0 ? { label: '这是一个用于验证极长连接线标签不会破坏白板布局的自动化说明文字' } : {}),
  }));
  const performanceBoard = { version: 4, id: 'performance-board', fileName: 'performance.board.json', title: '五千节点白板', placements, connectors: performanceConnectors, attachments: [], viewport: { x: 0, y: 0, zoom: 1 }, createdAt, updatedAt: createdAt };
  await fs.writeFile(path.join(vault, 'boards', performanceBoard.fileName), JSON.stringify(performanceBoard), 'utf8');
  const invalidBoardPath = path.join(vault, 'boards', 'invalid.board.json');
  await fs.writeFile(invalidBoardPath, '{ this is intentionally invalid JSON', 'utf8');
  await fs.writeFile(path.join(vault, '.opencanvas', 'desktop.json'), JSON.stringify({ placements: [{ boardId: performanceBoard.id, x: 100, y: 100, width: 430, height: 270 }], viewport: { x: 0, y: 0, zoom: 1 } }), 'utf8');
  const simulatedTransactionRoot = path.join(vault, '.opencanvas', 'file-plan-transactions', 'simulated-crash');
  await fs.mkdir(path.join(simulatedTransactionRoot, 'backups'), { recursive: true });
  await fs.writeFile(path.join(simulatedTransactionRoot, 'backups', '00000-original.bak'), performanceNote, 'utf8');
  await fs.writeFile(path.join(simulatedTransactionRoot, 'journal.json'), JSON.stringify({ version: 1, id: 'simulated-crash', state: 'active', operations: [{ kind: 'write', targetRelative: 'notes/performance.md', existed: true, backupName: '00000-original.bak' }] }), 'utf8');
  await fs.writeFile(path.join(vault, 'notes', 'performance.md'), '模拟崩溃后的半成品', 'utf8');
  const electron = spawn(electronBinary, ['.', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(testRoot, 'profile')}`], {
    cwd: root,
    env: { ...process.env, OPENCANVAS_E2E: '1', OPENCANVAS_VAULT_DIR: vault, OPENCANVAS_DEV_URL: devUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  let completed = false;
  electron.stderr.on('data', (chunk) => { stderr += chunk; });
  let client;
  try {
    const target = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      return targets.find((item) => item.type === 'page' && item.url.startsWith(devUrl));
    }, 15000);
    client = cdpClient(target.webSocketDebuggerUrl);
    await client.ready;
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    const evaluate = async (expression, timeout = 30000) => {
      let result;
      try {
        result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeout * WAIT_TIMEOUT_SCALE);
      } catch (error) {
        throw new Error(`${error.message} while evaluating: ${expression.slice(0, 220)}`);
      }
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    const mouse = async (type, x, y, extra = {}) => {
      if (type === 'mousePressed') await client.send('Page.bringToFront');
      return client.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1, ...extra });
    };
    let syntheticPointerSequence = 700;
    const beginDomPointerDrag = async (selector, start, end, options = {}) => {
      const pointerId = ++syntheticPointerSequence;
      const steps = options.steps || 8;
      const altKey = Boolean(options.altKey);
      const pressed = await evaluate(`(() => {
        const target = document.querySelector(${JSON.stringify(selector)});
        if (!target) return false;
        target.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, composed: true,
          pointerId: ${pointerId}, pointerType: 'mouse', isPrimary: true,
          button: 0, buttons: 1, clientX: ${start.x}, clientY: ${start.y}, altKey: ${altKey}
        }));
        return true;
      })()`);
      if (!pressed) throw new Error(`Synthetic drag source was not available: ${selector}`);
      for (let step = 1; step <= steps; step += 1) {
        const x = start.x + (end.x - start.x) * step / steps;
        const y = start.y + (end.y - start.y) * step / steps;
        await evaluate(`window.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, composed: true,
          pointerId: ${pointerId}, pointerType: 'mouse', isPrimary: true,
          button: -1, buttons: 1, clientX: ${x}, clientY: ${y}, altKey: ${altKey}
        }))`);
      }
      await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      return pointerId;
    };
    const endDomPointerDrag = (pointerId, point, options = {}) => evaluate(`window.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, composed: true,
      pointerId: ${pointerId}, pointerType: 'mouse', isPrimary: true,
      button: 0, buttons: 0, clientX: ${point.x}, clientY: ${point.y}, altKey: ${Boolean(options.altKey)}
    }))`);
    const visualArtifactRoot = path.join(root, '.qa-artifacts', 'electron-smoke');
    await fs.mkdir(visualArtifactRoot, { recursive: true });
    const captureScreenshotWithRetry = async (params) => {
      let lastError;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await client.send('Page.captureScreenshot', params, 30000);
        } catch (error) {
          lastError = error;
          // Large composited SVG/DOM boards can miss one DevTools frame while
          // Chromium is rasterizing. A fresh animation frame plus bounded
          // retry keeps artifact capture reliable without relaxing any UI
          // assertion that precedes it.
          await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`).catch(() => {});
          await delay(400 * (attempt + 1));
        }
      }
      throw lastError;
    };
    const captureViewportScreenshot = async () => {
      let lastError;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const metrics = await client.send('Page.getLayoutMetrics');
          const viewport = metrics.cssVisualViewport || metrics.visualViewport;
          return await captureScreenshotWithRetry({
            format: 'jpeg',
            quality: 82,
            fromSurface: true,
            captureBeyondViewport: false,
            optimizeForSpeed: true,
            clip: {
              x: viewport.pageX || 0,
              y: viewport.pageY || 0,
              width: Math.min(viewport.clientWidth, 1280),
              height: Math.min(viewport.clientHeight, 900),
              scale: 1,
            },
          });
        } catch (error) {
          lastError = error;
          await delay(300);
        }
      }
      throw lastError;
    };
    const captureVisualArtifact = async (name) => {
      const screenshot = await captureViewportScreenshot();
      if (!screenshot?.data || screenshot.data.length < 20_000) throw new Error(`Visual artifact capture failed: ${name}`);
      await fs.writeFile(path.join(visualArtifactRoot, `${name}.jpg`), Buffer.from(screenshot.data, 'base64'));
      return screenshot;
    };
    const captureElementArtifact = async (name, selector) => {
      const rect = await evaluate(`(() => { const rect = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return rect && { x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: Math.min(innerWidth, rect.right) - Math.max(0, rect.left), height: Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top) }; })()`);
      if (!rect || rect.width < 200 || rect.height < 200) throw new Error(`Visual artifact surface missing: ${name}`);
      const screenshot = await captureScreenshotWithRetry({
        format: 'jpeg', quality: 86, fromSurface: true, captureBeyondViewport: false,
        clip: { ...rect, scale: 1 },
      });
      if (!screenshot?.data || screenshot.data.length < 12_000) throw new Error(`Visual artifact capture failed: ${name}`);
      await fs.writeFile(path.join(visualArtifactRoot, `${name}.jpg`), Buffer.from(screenshot.data, 'base64'));
      return screenshot;
    };
    const key = async (keyValue, code, windowsVirtualKeyCode, modifiers = 0) => {
      await client.send('Page.bringToFront');
      await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyValue, code, windowsVirtualKeyCode, modifiers });
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyValue, code, windowsVirtualKeyCode, modifiers });
    };
    try {
      // GitHub's fresh Windows runner occasionally needs more than 30 seconds
      // for Vite to transform the cold React/editor dependency graph. This is
      // startup infrastructure time, not the separately budgeted UI runtime.
      await waitFor(() => evaluate(`Boolean(document.querySelector('.app-shell') && window.openCanvasVault)`), 60000, 50);
    } catch (error) {
      const diagnostic = await evaluate(`({ readyState: document.readyState, url: location.href, body: document.body?.innerText?.slice(0, 500), hasVault: Boolean(window.openCanvasVault), scripts: [...document.scripts].map(script => script.src) })`);
      throw new Error(`Application shell did not mount: ${JSON.stringify(diagnostic)}; stderr=${stderr.slice(-1200)}; ${error.message}`);
    }
    const status = await waitFor(async () => {
      const text = await evaluate(`document.querySelector('.vault-status-button')?.innerText`);
      return text?.includes('已保存') ? text : null;
    }, 30000);
    if (!status) throw new Error('The initial workspace did not settle to saved state');
    await evaluate(`import('/src/store.ts').then(module => { window.__openCanvasQaStore = module.useWorkspaceStore; return true; })`);
    progress('workspace ready');

    const appInfoProfile = await evaluate(`window.openCanvasVault.getAppInfo()`);
    if (appInfoProfile.appVersion !== '1.0.10' || !appInfoProfile.electronVersion || !appInfoProfile.automatedTest || path.resolve(appInfoProfile.vaultPath) !== path.resolve(vault)) throw new Error(`Application diagnostics API returned an invalid profile: ${JSON.stringify(appInfoProfile)}`);
    if (await evaluate(`Boolean(document.querySelector('.welcome-tour-dialog'))`)) throw new Error('First-run tour blocked the automated Electron workspace');
    await evaluate(`document.querySelector('.vault-status-button')?.click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.workspace-vault-menu'))`), 2000);
    await evaluate(`([...document.querySelectorAll('.workspace-vault-menu button')].find(button => button.textContent?.includes('关于与诊断')))?.click()`);
    const aboutProfile = await waitFor(() => evaluate(`(() => { const dialog = document.querySelector('.about-dialog'); const copy = [...(dialog?.querySelectorAll('button') || [])].find(button => button.textContent?.includes('复制诊断信息')); return dialog && !copy?.disabled ? { text: dialog.textContent, focused: dialog.contains(document.activeElement) } : null; })()`), 3000);
    if (!aboutProfile.text.includes('1.0.10') || !aboutProfile.text.includes('不包含笔记正文') || !aboutProfile.focused) throw new Error(`About and diagnostics dialog was incomplete: ${JSON.stringify(aboutProfile)}`);
    await evaluate(`document.querySelector('.about-dialog [data-modal-close]')?.click()`);
    await waitFor(() => evaluate(`!document.querySelector('.about-dialog')`), 2000);
    progress('first-run isolation and about diagnostics passed');

    await evaluate(`window.__openCanvasQaStore.getState().focusCard('scrolling-card'); true`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.note-page'))`), 2000, 30);
    const fullPageSplitterStart = await waitFor(() => evaluate(`(() => {
      const splitter = document.querySelector('.workspace-panel-resizer-left');
      const sidebar = document.querySelector('.sidebar');
      const page = document.querySelector('.note-page');
      if (!splitter || !sidebar || !page) return null;
      const splitterRect = splitter.getBoundingClientRect();
      const sidebarRect = sidebar.getBoundingClientRect();
      const x = splitterRect.left + splitterRect.width / 2;
      const y = Math.min(innerHeight - 80, 180);
      return {
        x, y,
        width: sidebarRect.width,
        pageLeft: Number.parseFloat(getComputedStyle(page).left),
        hit: document.elementFromPoint(x, y)?.getAttribute('aria-label'),
        statusDots: document.querySelectorAll('.workspace-status').length,
        rightSplitters: document.querySelectorAll('.workspace-panel-resizer-right').length,
      };
    })()`), 5000);
    if (fullPageSplitterStart.hit !== '调整左侧栏宽度' || fullPageSplitterStart.statusDots !== 0 || fullPageSplitterStart.rightSplitters !== 0 || Math.abs(fullPageSplitterStart.pageLeft - fullPageSplitterStart.width) > 1) throw new Error(`Full-page workspace boundary was not cleanly draggable: ${JSON.stringify(fullPageSplitterStart)}`);
    await mouse('mousePressed', fullPageSplitterStart.x, fullPageSplitterStart.y);
    await mouse('mouseMoved', fullPageSplitterStart.x + 44, fullPageSplitterStart.y, { button: 'left', buttons: 1 });
    const fullPageSplitterDuringDrag = await waitFor(() => evaluate(`(() => {
      const shell = document.querySelector('.app-shell');
      const sidebar = document.querySelector('.sidebar');
      const page = document.querySelector('.note-page');
      const splitter = document.querySelector('.workspace-panel-resizer-left');
      if (!shell?.classList.contains('is-resizing-left-panel') || !sidebar || !page || !splitter) return null;
      const sidebarRect = sidebar.getBoundingClientRect();
      return { width: sidebarRect.width, pageLeft: Number.parseFloat(getComputedStyle(page).left), guideOpacity: getComputedStyle(splitter, '::before').opacity };
    })()`), 2000, 30);
    if (fullPageSplitterDuringDrag.width < fullPageSplitterStart.width + 30 || Math.abs(fullPageSplitterDuringDrag.pageLeft - fullPageSplitterDuringDrag.width) > 1) throw new Error(`Full-page sidebar did not resize continuously under the pointer: ${JSON.stringify({ fullPageSplitterStart, fullPageSplitterDuringDrag })}`);
    await mouse('mouseReleased', fullPageSplitterStart.x + 44, fullPageSplitterStart.y);
    const fullPageSplitterMoved = await waitFor(() => evaluate(`(() => {
      const shell = document.querySelector('.app-shell');
      const splitter = document.querySelector('.workspace-panel-resizer-left');
      const sidebar = document.querySelector('.sidebar');
      if (shell?.classList.contains('is-resizing-left-panel') || !splitter || !sidebar) return null;
      const rect = splitter.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, width: sidebar.getBoundingClientRect().width, stored: Number(localStorage.getItem('opencanvas:left-sidebar-width')) };
    })()`), 2000, 30);
    if (Math.abs(fullPageSplitterMoved.stored - fullPageSplitterMoved.width) > 1) throw new Error(`Full-page sidebar width was not persisted after pointer release: ${JSON.stringify(fullPageSplitterMoved)}`);
    await evaluate(`document.querySelector('.note-page [aria-label="返回白板"]')?.click()`);
    await waitFor(() => evaluate(`!document.querySelector('.note-page')`), 3000);
    progress('full-page left splitter, live resize guide, persistence, and removed status dot passed');

    if (process.env.OPENCANVAS_PROFILE_LONG_DOC === '1') {
      await client.send('Profiler.enable');
      await client.send('Profiler.start');
      const profileStarted = Date.now();
      await evaluate(`window.__openCanvasQaStore.getState().focusCard('long-document-card'); true`);
      const mounted = await client.send('Runtime.evaluate', {
        expression: `new Promise((resolve) => {
          const deadline = performance.now() + 10000;
          const check = () => {
            if (document.querySelector('.note-page .card-prosemirror')) return resolve(true);
            if (performance.now() >= deadline) return resolve(false);
            requestAnimationFrame(check);
          };
          check();
        })`,
        awaitPromise: true,
        returnByValue: true
      }, 125000);
      const profileResult = await client.send('Profiler.stop', {}, 120000);
      const diagnostics = await evaluate(`import('/src/store.ts').then(module => ({
        focusedCardId: module.useWorkspaceStore.getState().focusedCardId,
        notePage: Boolean(document.querySelector('.note-page')),
        structuredEditor: Boolean(document.querySelector('.note-page .structured-card-editor')),
        prosemirrorCount: document.querySelectorAll('.card-prosemirror').length,
        crash: document.querySelector('.app-crash-card')?.innerText || null,
        noteText: document.querySelector('.note-page')?.textContent?.slice(0, 300) || null,
        bodyText: document.body.innerText.slice(-500)
      }))`);
      const topFunctions = (profileResult.profile?.nodes || [])
        .map((node) => ({ functionName: node.callFrame?.functionName || '(anonymous)', url: node.callFrame?.url || '', line: node.callFrame?.lineNumber, hits: node.hitCount || 0 }))
        .sort((a, b) => b.hits - a.hits)
        .slice(0, 25);
      process.stdout.write(`[electron-long-doc-profile] ${JSON.stringify({ mounted: mounted.result?.value, durationMs: Date.now() - profileStarted, diagnostics, topFunctions }, null, 2)}\n`);
      return;
    }

    const unchangedCardPath = path.join(vault, 'notes', 'performance.md');
    const unchangedBoardPath = path.join(vault, 'boards', performanceBoard.fileName);
    const unchangedBefore = { card: (await fs.stat(unchangedCardPath)).mtimeMs, board: (await fs.stat(unchangedBoardPath)).mtimeMs };
    await evaluate(`window.openCanvasVault.applyFilePlan({ cards: [{ id: 'performance-card', fileName: 'performance.md', relativePath: 'performance.md', title: '五千节点性能验证', body: '', createdAt: ${JSON.stringify(createdAt)}, updatedAt: ${JSON.stringify(createdAt)} }], boards: [{ version: 4, id: 'performance-board', fileName: 'performance.board.json', title: '五千节点白板', placements: [], connectors: [], attachments: [], viewport: { x: 0, y: 0, zoom: 1 }, createdAt: ${JSON.stringify(createdAt)}, updatedAt: ${JSON.stringify(createdAt)} }], projects: [], folders: ['批量文件', '归档'], writeCardIds: [], writeBoardIds: [] })`);
    const unchangedAfter = { card: (await fs.stat(unchangedCardPath)).mtimeMs, board: (await fs.stat(unchangedBoardPath)).mtimeMs };
    if (unchangedAfter.card !== unchangedBefore.card || unchangedAfter.board !== unchangedBefore.board) throw new Error(`Selective file plan rewrote unchanged content: ${JSON.stringify({ unchangedBefore, unchangedAfter })}`);
    progress('selective file plan preserved unchanged Markdown and board mtimes');

    const invalidWindowsPathError = await evaluate(`window.openCanvasVault.applyFilePlan({ cards: [], boards: [], projects: [], folders: ['CON'], writeCardIds: [], writeBoardIds: [] }).then(() => null).catch(error => String(error?.message || error))`);
    if (!invalidWindowsPathError?.includes('Windows 无法使用这个路径片段')) throw new Error(`Native vault accepted a Windows device path: ${JSON.stringify(invalidWindowsPathError)}`);
    const duplicateTargetError = await evaluate(`window.openCanvasVault.applyFilePlan({ cards: [
      { id: 'duplicate-a', fileName: 'duplicate.md', relativePath: '冲突/duplicate.md', title: '重复 A', body: '', createdAt: ${JSON.stringify(createdAt)}, updatedAt: ${JSON.stringify(createdAt)} },
      { id: 'duplicate-b', fileName: 'duplicate.md', relativePath: '冲突/DUPLICATE.md', title: '重复 B', body: '', createdAt: ${JSON.stringify(createdAt)}, updatedAt: ${JSON.stringify(createdAt)} }
    ], boards: [], projects: [], folders: ['冲突'], writeCardIds: ['duplicate-a', 'duplicate-b'], writeBoardIds: [] }).then(() => null).catch(error => String(error?.message || error))`);
    if (!duplicateTargetError?.includes('卡片路径存在同名目标')) throw new Error(`Native vault accepted case-insensitive duplicate card targets: ${JSON.stringify(duplicateTargetError)}`);
    const longFolder = Array.from({ length: 5 }, (_, index) => `深层目录${index}-${'长'.repeat(48)}`).join('/');
    const longPathCard = { id: 'long-path-card', fileName: '长路径验证.md', relativePath: `${longFolder}/长路径验证.md`, title: '长路径验证', body: '超过传统 MAX_PATH 的真实写盘验证', createdAt, updatedAt: createdAt };
    await evaluate(`window.openCanvasVault.applyFilePlan({ cards: [${JSON.stringify(longPathCard)}], boards: [], projects: [], folders: [${JSON.stringify(longFolder)}], writeCardIds: ['long-path-card'], writeBoardIds: [] })`);
    const longPathTarget = path.join(vault, 'notes', ...longPathCard.relativePath.split('/'));
    if (longPathTarget.length <= 260 || !fsSync.existsSync(longPathTarget) || !(await fs.readFile(longPathTarget, 'utf8')).includes('超过传统 MAX_PATH')) throw new Error(`Real long-path Markdown write failed: ${JSON.stringify({ length: longPathTarget.length, exists: fsSync.existsSync(longPathTarget) })}`);
    const readOnlyDirectory = path.join(vault, 'notes', '只读权限验收');
    if (!path.resolve(readOnlyDirectory).startsWith(`${path.resolve(testRoot)}${path.sep}`)) throw new Error(`ACL test escaped its isolated root: ${readOnlyDirectory}`);
    await fs.mkdir(readOnlyDirectory, { recursive: true });
    const denyAcl = spawnSync('icacls.exe', [readOnlyDirectory, '/deny', `${aclAccount}:(OI)(CI)(W)`], { windowsHide: true, encoding: 'utf8' });
    if (denyAcl.status !== 0) throw new Error(`Could not establish the isolated read-only ACL: ${denyAcl.stderr || denyAcl.stdout}`);
    deniedAclPath = readOnlyDirectory;
    const readOnlyCard = { id: 'read-only-card', fileName: '权限失败.md', relativePath: '只读权限验收/权限失败.md', title: '权限失败', body: '修复权限后应可重试', createdAt, updatedAt: createdAt };
    const readOnlyFailure = await evaluate(`import('/src/domain/pathNaming.ts').then(async module => {
      try {
        await window.openCanvasVault.applyFilePlan({ cards: [${JSON.stringify(readOnlyCard)}], boards: [], projects: [], folders: ['只读权限验收'], writeCardIds: ['read-only-card'], writeBoardIds: [] });
        return null;
      } catch (error) {
        return { raw: String(error?.message || error), actionable: module.persistenceErrorMessage(error) };
      }
    })`);
    if (!readOnlyFailure?.actionable?.includes('只读或没有写入权限') || fsSync.existsSync(path.join(readOnlyDirectory, readOnlyCard.fileName))) throw new Error(`Real read-only ACL did not fail safely with an actionable message: ${JSON.stringify(readOnlyFailure)}`);
    const restoreAcl = spawnSync('icacls.exe', [readOnlyDirectory, '/remove:d', aclAccount], { windowsHide: true, encoding: 'utf8' });
    if (restoreAcl.status !== 0) throw new Error(`Could not restore the isolated read-only ACL: ${restoreAcl.stderr || restoreAcl.stdout}`);
    deniedAclPath = null;
    await evaluate(`window.openCanvasVault.applyFilePlan({ cards: [${JSON.stringify(readOnlyCard)}], boards: [], projects: [], folders: ['只读权限验收'], writeCardIds: ['read-only-card'], writeBoardIds: [] })`);
    if (!(await fs.readFile(path.join(readOnlyDirectory, readOnlyCard.fileName), 'utf8')).includes('修复权限后应可重试')) throw new Error('Retry after restoring write permission did not persist the Markdown card');
    progress(`Windows device-name rejection, duplicate-target rejection, ${longPathTarget.length}-character real path, and read-only ACL recovery passed`);

    if (!fsSync.existsSync(path.join(vault, 'notes', 'recovered.md')) || fsSync.existsSync(path.join(vault, 'notes', 'recovered.md.opencanvas-tmp-smoke'))) throw new Error('Interrupted atomic Markdown write was not recovered on startup');
    if ((await fs.readFile(path.join(vault, 'notes', 'performance.md'), 'utf8')) !== performanceNote) throw new Error('Interrupted file-plan transaction was not rolled back on startup');
    const recoveryNotice = await waitFor(() => evaluate(`document.body.innerText.includes('已自动恢复知识库')`), 3000).catch(() => false);
    if (!recoveryNotice) {
      const recoveryDiagnostic = await evaluate(`Promise.all([window.openCanvasVault.loadWorkspace(), import('/src/store.ts')]).then(([snapshot, module]) => ({ text: document.querySelector('.app-notification-stack')?.innerText, recovery: snapshot.recovery, notices: module.useWorkspaceStore.getState().notices }))`);
      throw new Error(`Successful crash recovery was not surfaced to the user: ${JSON.stringify(recoveryDiagnostic)}`);
    }
    await evaluate(`window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { promise: Promise.resolve(), reason: new Error('通知系统回归测试') }))`);
    await waitFor(() => evaluate(`document.body.innerText.includes('操作没有完成') && document.body.innerText.includes('通知系统回归测试')`), 3000);
    const integrity = await evaluate(`window.openCanvasVault.checkIntegrity()`);
    const invalidFileIssue = integrity?.issues?.find(issue => issue.kind === 'invalid-file' && issue.sourcePath === 'boards/invalid.board.json');
    if (!invalidFileIssue || integrity.issues.length !== 1) throw new Error(`Corrupted file quarantine was not deterministic: ${JSON.stringify(integrity?.issues)}`);
    if (!fsSync.existsSync(invalidBoardPath)) throw new Error('Corrupted source file was removed instead of being retained for repair');
    if (!integrity.recoveryEvents?.length) throw new Error('Recovery center did not persist the startup recovery event');
    const zipPath = path.join(exchangeRoot, 'roundtrip.zip');
    const canvasExportPath = path.join(exchangeRoot, 'roundtrip.canvas');
    const exportCard = { id: 'roundtrip-card', fileName: 'roundtrip.md', relativePath: 'roundtrip.md', title: '开放格式往返', body: '真实附件 ![](attachments/smoke.svg)', tags: [], createdAt, updatedAt: createdAt };
    const exportBoard = { version: 4, id: 'roundtrip-board', fileName: 'roundtrip.board.json', title: '开放格式往返', placements: [
      { id: 'roundtrip-section-outer', kind: 'text', text: '外层区块', isFrame: true, x: 0, y: 0, width: 700, height: 500, color: 'transparent', sectionBaseBounds: { x: 20, y: 20, width: 660, height: 460 } },
      { id: 'roundtrip-section-inner', kind: 'text', text: '内层区块', isFrame: true, x: 80, y: 80, width: 500, height: 320, color: 'transparent', sectionId: 'roundtrip-section-outer', sectionIds: ['roundtrip-section-outer'] },
      { id: 'roundtrip-placement', kind: 'card', entityId: exportCard.id, x: 160, y: 150, width: 320, height: 210, color: '#ffffff', sectionId: 'roundtrip-section-inner', sectionIds: ['roundtrip-section-inner', 'roundtrip-section-outer'] },
    ], connectors: [], attachments: [], viewport: { x: 0, y: 0, zoom: 1 }, createdAt, updatedAt: createdAt };
    const zipRoundtrip = await evaluate(`(async () => {
      const card = ${JSON.stringify(exportCard)};
      const board = ${JSON.stringify(exportBoard)};
      const output = await window.openCanvasVault.e2eExportOpenFormat({ format: 'opencanvas-zip', name: '往返验收', cards: [card], boards: [board] }, ${JSON.stringify(zipPath)});
      const preview = await window.openCanvasVault.e2ePreviewOpenFormat(output);
      const importedCard = { ...preview.bundle.cards[0], id: 'roundtrip-card-imported', fileName: 'roundtrip-imported.md', relativePath: 'roundtrip-imported.md' };
      const importedBoard = { ...preview.bundle.boards[0], id: 'roundtrip-board-imported', fileName: 'roundtrip-imported.board.json', placements: preview.bundle.boards[0].placements.map(item => ({ ...item, entityId: item.entityId === card.id ? importedCard.id : item.entityId })) };
      const commit = await window.openCanvasVault.commitOpenFormatImport({ sessionId: preview.sessionId, attachmentStrategy: 'rename', cards: [importedCard], boards: [importedBoard], desktop: { placements: [{ boardId: importedBoard.id, x: 80, y: 80, width: 430, height: 270 }], viewport: { x: 0, y: 0, zoom: 1 } } });
      const reloaded = await window.openCanvasVault.loadWorkspace();
      const persistedBoard = reloaded.boards.find(item => item.id === importedBoard.id);
      const previewMember = preview.bundle.boards[0].placements.find(item => item.id === 'roundtrip-placement');
      const persistedMember = persistedBoard?.placements.find(item => item.id === 'roundtrip-placement');
      const persistedOuter = persistedBoard?.placements.find(item => item.id === 'roundtrip-section-outer');
      return {
        output,
        summary: preview.summary,
        mappedAttachment: commit.attachmentPathMap['attachments/smoke.svg'],
        previewRelation: { sectionId: previewMember?.sectionId, sectionIds: previewMember?.sectionIds },
        persistedRelation: { sectionId: persistedMember?.sectionId, sectionIds: persistedMember?.sectionIds },
        persistedBase: persistedOuter?.sectionBaseBounds,
      };
    })()`);
    if (zipRoundtrip?.summary?.cards !== 1
      || zipRoundtrip.summary.boards !== 1
      || zipRoundtrip.summary.attachments !== 1
      || !zipRoundtrip.mappedAttachment
      || zipRoundtrip.previewRelation.sectionId !== 'roundtrip-section-inner'
      || JSON.stringify(zipRoundtrip.previewRelation.sectionIds) !== JSON.stringify(['roundtrip-section-inner', 'roundtrip-section-outer'])
      || JSON.stringify(zipRoundtrip.persistedRelation) !== JSON.stringify(zipRoundtrip.previewRelation)
      || JSON.stringify(zipRoundtrip.persistedBase) !== JSON.stringify({ x: 20, y: 20, width: 660, height: 460 })) throw new Error(`OpenCanvas ZIP roundtrip failed: ${JSON.stringify(zipRoundtrip)}`);
    if (!fsSync.existsSync(path.join(vault, 'notes', 'roundtrip-imported.md')) || !fsSync.existsSync(path.join(vault, 'boards', 'roundtrip-imported.board.json'))) throw new Error('ZIP import commit did not create real vault files');
    const canvasRoundtrip = await evaluate(`(async () => {
      const preview = await window.openCanvasVault.e2ePreviewOpenFormat(${JSON.stringify(canvasFixturePath)});
      const output = await window.openCanvasVault.e2eExportOpenFormat({ format: 'obsidian-canvas', name: 'Canvas 往返', cards: [], boards: [], canvasDocument: preview.canvasDocument }, ${JSON.stringify(canvasExportPath)});
      await window.openCanvasVault.cancelOpenFormatImport(preview.sessionId);
      return { source: preview.sourceFiles?.[0], warnings: preview.warnings, output };
    })()`);
    if (!canvasRoundtrip?.source?.content.includes('真实 Markdown 文件') || canvasRoundtrip.warnings.length || !fsSync.existsSync(canvasExportPath)) throw new Error(`Obsidian Canvas roundtrip failed: ${JSON.stringify(canvasRoundtrip)}`);
    const markdownImport = await evaluate(`(async () => {
      const preview = await window.openCanvasVault.e2ePreviewOpenFormat(${JSON.stringify(heptabaseMarkdownZipPath)});
      const current = await window.openCanvasVault.loadWorkspace();
      const commit = await window.openCanvasVault.commitOpenFormatImport({ sessionId: preview.sessionId, attachmentStrategy: 'rename', cards: preview.bundle.cards, boards: [], desktop: current.desktop });
      const reloaded = await window.openCanvasVault.loadWorkspace();
      const imported = reloaded.cards.find(card => card.title === '迁移卡片');
      return { format: preview.format, summary: preview.summary, warnings: preview.warnings, relativePath: imported?.relativePath, body: imported?.body, attachmentMap: commit.attachmentPathMap };
    })()`);
    if (markdownImport?.format !== 'markdown-zip'
      || markdownImport.summary?.cards !== 1
      || markdownImport.summary?.boards !== 0
      || markdownImport.summary?.attachments !== 1
      || markdownImport.warnings?.length !== 2
      || markdownImport.relativePath !== '项目/迁移卡片.md'
      || !markdownImport.body?.includes('Heptabase Markdown 正文')
      || !markdownImport.body?.includes('attachments/迁移图片.png')
      || !fsSync.existsSync(path.join(vault, 'notes', '项目', '迁移卡片.md'))
      || !fsSync.existsSync(path.join(vault, 'attachments', '迁移图片.png'))) throw new Error(`Heptabase Markdown ZIP migration failed: ${JSON.stringify(markdownImport)}`);
    const unsafeZipRejected = await evaluate(`window.openCanvasVault.e2ePreviewOpenFormat(${JSON.stringify(unsafeZipPath)}).then(() => false, error => String(error?.message || error).includes('不安全路径'))`);
    if (!unsafeZipRejected || fsSync.existsSync(path.join(testRoot, 'escape.txt'))) throw new Error('ZIP path traversal was not rejected before extraction');
    progress('OpenCanvas ZIP, Heptabase Markdown ZIP, and Obsidian Canvas real-file roundtrips passed');

    const boardOpenStarted = Date.now();
    const performanceBoardOpened = await evaluate(`(() => { const button = [...document.querySelectorAll('.tab-list button')].find(item => item.textContent.trim() === '五千节点白板'); button?.click(); return Boolean(button); })()`);
    if (!performanceBoardOpened) throw new Error('Performance board was not available in the board list');
    const renderProfile = await waitFor(() => evaluate(`(() => { const nodes = document.querySelectorAll('.canvas-node').length; const denseLayer = document.querySelector('.dense-connector-layer'); return nodes > 0 ? { nodes, detailedEdges: document.querySelectorAll('.edge-object:not(.edge-draft)').length, denseLayers: document.querySelectorAll('.dense-connector-layer').length, densePaths: document.querySelectorAll('.dense-connector-layer path').length, denseMeshVersion: denseLayer?.getAttribute('data-mesh-version'), denseAnimation: denseLayer && getComputedStyle(denseLayer).animationName, minimapObjects: document.querySelectorAll('.canvas-minimap .minimap-object').length, minimapPaths: document.querySelectorAll('.canvas-minimap .minimap-mesh-object').length, indicator: document.querySelector('.connector-lod-indicator')?.textContent, editors: document.querySelectorAll('.structured-card-editor').length } : null; })()`));
    const initialNode = await evaluate(`(() => { const node = document.querySelector('.canvas-node'); if (!node) return null; const rect = node.getBoundingClientRect(); return { id: node.getAttribute('data-placement-id'), x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })()`);
    if (!initialNode) throw new Error('No stable card node available for pointer regression');
    const boardOpenMs = Date.now() - boardOpenStarted;
    if (boardOpenMs > 4000) throw new Error(`5000-node board took too long to render its first viewport: ${boardOpenMs}ms`);
    if (!renderProfile || renderProfile.nodes > 100) throw new Error(`Viewport culling mounted too many nodes: ${JSON.stringify(renderProfile)}`);
    if (renderProfile.detailedEdges !== 0 || renderProfile.denseLayers !== 1 || renderProfile.densePaths > 12 || !renderProfile.indicator?.includes('4999')) throw new Error(`Star-topology connector LOD did not collapse route DOM: ${JSON.stringify(renderProfile)}`);
    if (renderProfile.denseAnimation !== 'oc-connector-lod-condense') throw new Error(`Dense connector LOD did not expose a softened transition: ${JSON.stringify(renderProfile)}`);
    if (renderProfile.minimapObjects !== 0 || renderProfile.minimapPaths > 5) throw new Error(`Minimap did not collapse 5000 objects into a bounded SVG mesh: ${JSON.stringify(renderProfile)}`);
    if (renderProfile.editors !== 0) throw new Error(`Read-only cards eagerly mounted rich-text editors: ${JSON.stringify(renderProfile)}`);
    if (await evaluate(`Boolean(document.querySelector('.dense-connector-layer.relationship-focus'))`)) throw new Error('Idle dense connectors incorrectly entered relationship-focus mode');
    await evaluate(`document.querySelector('[aria-label="打开图层面板"]')?.click()`);
    const layerPanelProfile = await waitFor(() => evaluate(`(() => { const panel = document.querySelector('.layers-panel'); const list = panel?.querySelector('.layers-list-viewport'); const rows = [...(panel?.querySelectorAll('.layer-row') || [])]; return panel && list && rows.length ? { rows: rows.length, total: panel.querySelector('header span')?.textContent, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight, firstPosition: rows[0].getAttribute('aria-posinset'), setSize: rows[0].getAttribute('aria-setsize') } : null; })()`), 3000);
    if (layerPanelProfile.rows > 32 || layerPanelProfile.total !== '5000' || layerPanelProfile.scrollHeight < 150000 || layerPanelProfile.firstPosition !== '1' || layerPanelProfile.setSize !== '5000') throw new Error(`5000-node layer panel did not stay virtualized and accessible: ${JSON.stringify(layerPanelProfile)}`);
    await evaluate(`(() => { const input = document.querySelector('.layers-search input'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, '滚轮路由边界验证'); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '滚轮路由边界验证' })); })()`);
    const filteredLayerProfile = await waitFor(() => evaluate(`(() => { const panel = document.querySelector('.layers-panel'); const rows = panel?.querySelectorAll('.layer-row'); return panel?.querySelector('header span')?.textContent === '1 / 5000' && rows?.length === 1 ? { title: rows[0].querySelector('strong')?.textContent, rows: rows.length } : null; })()`), 3000);
    if (filteredLayerProfile.title !== '滚轮路由边界验证') throw new Error(`Layer search did not expose the matching card: ${JSON.stringify(filteredLayerProfile)}`);
    await evaluate(`document.querySelector('[aria-label="清空图层搜索"]')?.click()`);
    // Clearing a 5000-item filter can miss a renderer frame on a busy Windows
    // host. The board-open performance budget above remains strict; this wait
    // only avoids treating scheduler jitter as a product regression.
    await waitFor(() => evaluate(`document.querySelector('.layers-panel header span')?.textContent === '5000' && document.querySelectorAll('.layers-panel .layer-row').length > 1`), 5000);
    await evaluate(`document.querySelector('.layers-panel .layer-row')?.focus()`);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
    const keyboardLayerProfile = await waitFor(() => evaluate(`(() => { const panel = document.querySelector('.layers-panel'); const row = panel?.querySelector('.layer-row[data-active="true"]'); const list = panel?.querySelector('.layers-list-viewport'); const profile = row?.getAttribute('aria-posinset') === '5000' ? { id: row.getAttribute('data-placement-id'), selected: row.getAttribute('aria-selected'), rows: panel.querySelectorAll('.layer-row').length, scrollTop: list.scrollTop, focused: document.activeElement === row } : null; return profile?.focused ? profile : null; })()`), 3000);
    if (keyboardLayerProfile.id !== 'performance-placement-4999' || keyboardLayerProfile.selected !== 'true' || keyboardLayerProfile.rows > 32 || keyboardLayerProfile.scrollTop < 150000 || !keyboardLayerProfile.focused) throw new Error(`Layer keyboard navigation did not reveal and select the final virtual row: ${JSON.stringify(keyboardLayerProfile)}`);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    const revealedLayerViewport = await waitFor(() => evaluate(`import('/src/store.ts').then(module => { const state = module.useWorkspaceStore.getState(); const viewport = state.boards.find(board => board.id === state.activeBoardId)?.viewport; return viewport && Math.abs(viewport.y) > 5000 ? viewport : null; })`), 3000);
    if (!revealedLayerViewport) throw new Error('Enter on a layer row did not center the corresponding canvas object');
    await evaluate(`(() => { const panel = document.querySelector('.layers-panel'); const qa = window.__layersPanelExitQa = { exiting: false }; const observer = new MutationObserver(() => { if (panel?.getAttribute('data-presence') === 'exiting') { qa.exiting = true; qa.animation = getComputedStyle(panel).animationName; qa.pointerEvents = getComputedStyle(panel).pointerEvents; qa.focusRestoredEarly = document.activeElement?.getAttribute('aria-label') === '打开图层面板'; } }); if (panel) observer.observe(panel, { attributes: true, attributeFilter: ['data-presence'] }); qa.disconnect = () => observer.disconnect(); })()`);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    const layersPanelExit = await waitFor(() => evaluate(`window.__layersPanelExitQa?.exiting ? window.__layersPanelExitQa : null`), 1000);
    await evaluate(`window.__layersPanelExitQa?.disconnect?.(); delete window.__layersPanelExitQa`);
    if (layersPanelExit.animation !== 'layers-panel-out' || layersPanelExit.pointerEvents !== 'none' || layersPanelExit.focusRestoredEarly) throw new Error(`Layers panel did not leave non-interactively before restoring toggle focus: ${JSON.stringify(layersPanelExit)}`);
    await waitFor(() => evaluate(`!document.querySelector('.layers-panel') && document.activeElement?.getAttribute('aria-label') === '打开图层面板'`), 3000);
    await evaluate(`void import('/src/store.ts').then(module => { const store = module.useWorkspaceStore; store.getState().setViewport({ x: 0, y: 0, zoom: 1 }); store.getState().setSelection(null); })`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('[data-placement-id="performance-placement-0"]'))`), 3000);
    const selfWriteConflict = await evaluate(`document.querySelector('.vault-conflict-files')?.innerText || null`);
    if (selfWriteConflict) throw new Error(`Navigating the layer panel misclassified an internal board save as an external edit: ${selfWriteConflict}`);
    progress('5000-node layer panel virtualization, search, keyboard navigation, reveal, and focus return passed');
    const densePickPoint = await evaluate(`(() => { const first = document.querySelector('[data-placement-id="performance-placement-0"]')?.getBoundingClientRect(); const second = document.querySelector('[data-placement-id="performance-placement-1"]')?.getBoundingClientRect(); return first && second ? { x: (first.right + second.left) / 2, y: (first.top + first.bottom) / 2, hit: document.elementFromPoint((first.right + second.left) / 2, (first.top + first.bottom) / 2)?.className?.baseVal || document.elementFromPoint((first.right + second.left) / 2, (first.top + first.bottom) / 2)?.className } : null; })()`);
    if (!densePickPoint || !String(densePickPoint.hit).includes('dense-edge-hitbox')) {
      const densePickConflict = await evaluate(`document.querySelector('.vault-conflict-files')?.innerText || null`);
      throw new Error(`Dense connector hit surface was not exposed between neighboring cards: ${JSON.stringify({ densePickPoint, conflict: densePickConflict })}`);
    }
    await evaluate(`(() => { const target = document.querySelector('.dense-edge-hitbox'); target?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true, button: 2, buttons: 2, clientX: ${densePickPoint.x}, clientY: ${densePickPoint.y} })); })()`);
    const denseContextMenu = await waitFor(() => evaluate(`(() => { const menu = document.querySelector('.canvas-context-menu.connector-menu[aria-label="连接线设置"]'); const rect = menu?.getBoundingClientRect(); return rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, selectedEdges: document.querySelectorAll('.edge-object.selected').length, denseMeshVersion: document.querySelector('.dense-connector-layer')?.getAttribute('data-mesh-version') } : null; })()`), 3000);
    if (denseContextMenu.selectedEdges !== 1 || densePickPoint.x < denseContextMenu.left - 30 || densePickPoint.x > denseContextMenu.right + 30 || Math.min(Math.abs(denseContextMenu.bottom - densePickPoint.y), Math.abs(denseContextMenu.top - densePickPoint.y)) > 90) throw new Error(`Dense connector right-click did not open its compact menu near the picked route: ${JSON.stringify({ densePickPoint, denseContextMenu })}`);
    if (denseContextMenu.denseMeshVersion !== renderProfile.denseMeshVersion) throw new Error(`Selecting one dense connector rebuilt the entire aggregate mesh: ${JSON.stringify({ before: renderProfile.denseMeshVersion, after: denseContextMenu.denseMeshVersion })}`);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await evaluate(`void import('/src/store.ts').then(module => module.useWorkspaceStore.getState().setSelection(null))`);
    await waitFor(() => evaluate(`!document.querySelector('.canvas-context-menu') && document.querySelectorAll('.edge-object:not(.edge-draft)').length === 0 && !document.querySelector('.edge-object.selected')`), 3000);
    await evaluate(`(() => { const target = document.querySelector('.dense-edge-hitbox'); target?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, pointerId: 404, pointerType: 'mouse', isPrimary: true, clientX: ${densePickPoint.x}, clientY: ${densePickPoint.y} })); })()`);
    const longLabelProfile = await waitFor(() => evaluate(`(() => { const group = document.querySelector('.edge-object.selected .edge-label-group'); return group ? { visible: group.querySelector('.edge-label')?.textContent, full: group.querySelector('title')?.textContent, detailedEdges: document.querySelectorAll('.edge-object:not(.edge-draft)').length, denseLayers: document.querySelectorAll('.dense-connector-layer').length } : null; })()`), 3000);
    if (!longLabelProfile?.visible?.endsWith('…') || longLabelProfile.full === longLabelProfile.visible) throw new Error(`Long connector label did not truncate visually while preserving its full tooltip: ${JSON.stringify(longLabelProfile)}`);
    if (longLabelProfile.detailedEdges !== 1 || longLabelProfile.denseLayers !== 1) throw new Error(`Selecting a dense connector did not restore exactly one detailed route: ${JSON.stringify(longLabelProfile)}`);
    await delay(120);
    const stableDenseSelection = await evaluate(`import('/src/store.ts').then(module => ({ selection: module.useWorkspaceStore.getState().selection, interaction: document.querySelector('.infinite-canvas')?.className, menu: Boolean(document.querySelector('.connector-menu')), detailedEdges: document.querySelectorAll('.edge-object:not(.edge-draft)').length, selectedEdges: document.querySelectorAll('.edge-object.selected').length }))`);
    if (!stableDenseSelection.selectedEdges) throw new Error(`Dense connector selection did not remain stable after pointer release: ${JSON.stringify(stableDenseSelection)}`);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await evaluate(`void import('/src/store.ts').then(module => module.useWorkspaceStore.getState().setSelection(null))`);
    progress(`5000-node viewport ready in ${boardOpenMs}ms with ${renderProfile.nodes} mounted nodes`);
    const dragStart = { x: initialNode.x + 24, y: initialNode.y + 12 };
    await evaluate(`import('/src/store.ts').then(module => { const store = module.useWorkspaceStore; window.__pointerBurstQa = { count: 0, unsubscribe: store.subscribe((next, previous) => { const nextBoard = next.boards.find(board => board.id === next.activeBoardId); const previousBoard = previous.boards.find(board => board.id === previous.activeBoardId); if (nextBoard !== previousBoard) window.__pointerBurstQa.count += 1; }) }; return true; })`);
    await evaluate(`(() => { const node = document.querySelector('[data-placement-id="${initialNode.id}"]'); node?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, pointerId: 200, pointerType: 'mouse', isPrimary: true, clientX: ${dragStart.x}, clientY: ${dragStart.y} })); for (let index = 1; index <= 80; index += 1) window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, composed: true, button: -1, buttons: 1, pointerId: 200, pointerType: 'mouse', isPrimary: true, clientX: ${dragStart.x} - 60 * index / 80, clientY: ${dragStart.y} + 44 * index / 80 })); })()`);
    const dragFeedback = await waitFor(() => evaluate(`(() => { const canvas = document.querySelector('.infinite-canvas'); const node = document.querySelector('[data-placement-id="${initialNode.id}"]'); if (!canvas?.classList.contains('interaction-moving') || !node) return null; const style = getComputedStyle(node); return { shadow: style.boxShadow, willChange: style.willChange, transitionDuration: style.transitionDuration }; })()`), 2000);
    const dragShadow = boxShadowProfile(dragFeedback.shadow);
    if (!dragFeedback.shadow || dragFeedback.shadow === 'none' || !dragFeedback.willChange.includes('transform') || parseFloat(dragFeedback.transitionDuration || '1') > .08
      || dragShadow.maxOffsetY > 3.1 || dragShadow.maxBlur > 10.1 || dragShadow.maxAlpha > .151) throw new Error(`Active card drag did not expose the restrained lift feedback: ${JSON.stringify({ dragFeedback, dragShadow })}`);
    await captureVisualArtifact('dark-card-drag');
    await evaluate(`window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 0, pointerId: 200, pointerType: 'mouse', isPrimary: true, clientX: ${dragStart.x - 60}, clientY: ${dragStart.y + 44} }))`);
    const movedNode = await waitFor(() => evaluate(`(() => { const rect = document.querySelector('[data-placement-id="${initialNode.id}"]')?.getBoundingClientRect(); return rect && ${initialNode.x} - rect.x > 40 ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null; })()`), 2000);
    const releasedDragFeedback = await waitFor(async () => {
      const feedback = await evaluate(`(() => { const canvas = document.querySelector('.infinite-canvas'); const node = document.querySelector('[data-placement-id="${initialNode.id}"]'); return node ? { moving: canvas?.classList.contains('interaction-moving'), shadow: getComputedStyle(node).boxShadow } : null; })()`);
      const shadow = boxShadowProfile(feedback?.shadow);
      return feedback && !feedback.moving && shadow.maxOffsetY <= 1.1 && shadow.maxBlur <= 3.1 && shadow.maxAlpha <= .111 ? { ...feedback, shadowProfile: shadow } : null;
    }, 1000, 20);
    const dragBurstCommits = await evaluate(`(() => { const count = window.__pointerBurstQa?.count; window.__pointerBurstQa?.unsubscribe?.(); delete window.__pointerBurstQa; return count; })()`);
    if (!movedNode || initialNode.x - movedNode.x < 40 || movedNode.y - initialNode.y < 20) throw new Error('Pointer drag did not move the canvas node');
    if (!releasedDragFeedback) throw new Error('Released card did not settle back to its selected elevation');
    if (dragBurstCommits > 2) throw new Error(`High-frequency pointer drag committed ${dragBurstCommits} board updates in one display frame`);

    const resizeHandle = await evaluate(`(() => { const node = document.querySelector('[data-placement-id="${initialNode.id}"]'); const handle = node?.querySelector('.resize-handle-se'); if (!node || !handle) return null; const rect = handle.getBoundingClientRect(); const x = rect.x + rect.width / 2; const y = rect.y + rect.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, hitHandle: hit?.closest('.resize-handle')?.className, hitPlacement: hit?.closest('.canvas-node')?.getAttribute('data-placement-id'), selectedZ: getComputedStyle(node).zIndex }; })()`);
    if (!resizeHandle) throw new Error('Eight-direction resize handles were not exposed after selection');
    if (!String(resizeHandle.hitHandle).includes('resize-handle-se') || resizeHandle.hitPlacement !== initialNode.id) throw new Error(`Selected card resize handle was occluded by an overlapping node: ${JSON.stringify(resizeHandle)}`);
    await evaluate(`import('/src/store.ts').then(module => { const store = module.useWorkspaceStore; window.__pointerBurstQa = { count: 0, unsubscribe: store.subscribe((next, previous) => { const nextBoard = next.boards.find(board => board.id === next.activeBoardId); const previousBoard = previous.boards.find(board => board.id === previous.activeBoardId); if (nextBoard !== previousBoard) window.__pointerBurstQa.count += 1; }) }; return true; })`);
    await evaluate(`(() => { const handle = document.querySelector('[data-placement-id="${initialNode.id}"] .resize-handle-se'); handle?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, pointerId: 201, pointerType: 'mouse', isPrimary: true, clientX: ${resizeHandle.x}, clientY: ${resizeHandle.y} })); for (let index = 1; index <= 80; index += 1) window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, composed: true, button: -1, buttons: 1, pointerId: 201, pointerType: 'mouse', isPrimary: true, altKey: true, clientX: ${resizeHandle.x} + 45 * index / 80, clientY: ${resizeHandle.y} + 32 * index / 80 })); })()`);
    const resizeFeedback = await waitFor(() => evaluate(`(() => { const canvas = document.querySelector('.infinite-canvas'); const node = document.querySelector('[data-placement-id="${initialNode.id}"]'); if (!canvas?.classList.contains('interaction-resizing') || !node) return null; const style = getComputedStyle(node); return { shadow: style.boxShadow, willChange: style.willChange, transitionDuration: style.transitionDuration }; })()`), 2000);
    const resizeShadow = boxShadowProfile(resizeFeedback.shadow);
    if (!resizeFeedback.willChange.includes('width') || !resizeFeedback.willChange.includes('height') || parseFloat(resizeFeedback.transitionDuration || '1') > .08
      || resizeShadow.maxOffsetY > 2.1 || resizeShadow.maxBlur > 7.1 || resizeShadow.maxAlpha > .131) throw new Error(`Active card resize did not preserve the restrained state profile: ${JSON.stringify({ resizeFeedback, resizeShadow })}`);
    await captureVisualArtifact('dark-card-resize');
    await evaluate(`window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 0, pointerId: 201, pointerType: 'mouse', isPrimary: true, altKey: true, clientX: ${resizeHandle.x + 45}, clientY: ${resizeHandle.y + 32} }))`);
    const resizedNode = await waitFor(() => evaluate(`(() => { const rect = document.querySelector('[data-placement-id="${initialNode.id}"]')?.getBoundingClientRect(); return rect && rect.width > ${movedNode.width} && rect.height > ${movedNode.height} ? { width: rect.width, height: rect.height } : null; })()`), 2000);
    const releasedResizeFeedback = await waitFor(async () => {
      const feedback = await evaluate(`(() => { const canvas = document.querySelector('.infinite-canvas'); const node = document.querySelector('[data-placement-id="${initialNode.id}"]'); return node ? { resizing: canvas?.classList.contains('interaction-resizing'), shadow: getComputedStyle(node).boxShadow } : null; })()`);
      const shadow = boxShadowProfile(feedback?.shadow);
      return feedback && !feedback.resizing && shadow.maxOffsetY <= 1.1 && shadow.maxBlur <= 3.1 && shadow.maxAlpha <= .111 ? { ...feedback, shadowProfile: shadow } : null;
    }, 1000, 20);
    const resizeBurstCommits = await evaluate(`(() => { const count = window.__pointerBurstQa?.count; window.__pointerBurstQa?.unsubscribe?.(); delete window.__pointerBurstQa; return count; })()`);
    if (!resizedNode || resizedNode.width <= movedNode.width || resizedNode.height <= movedNode.height) throw new Error('Pointer resize did not change both node dimensions');
    if (!releasedResizeFeedback) throw new Error('Released card did not settle back from its resize elevation');
    if (resizeBurstCommits > 2) throw new Error(`High-frequency pointer resize committed ${resizeBurstCommits} board updates in one display frame`);
    progress('pointer drag and resize passed with per-frame high-frequency input coalescing');

    const gestureSnapshot = (ids) => evaluate(`(() => { const store = window.__openCanvasQaStore; const state = store.getState(); const board = state.boards.find(item => item.id === state.activeBoardId); const wanted = ${JSON.stringify(ids)}; return { placements: wanted.map(id => { const item = board?.placements.find(placement => placement.id === id); return item && { id: item.id, x: item.x, y: item.y, width: item.width, height: item.height }; }), selection: state.selection, viewport: board?.viewport, moving: document.querySelector('.infinite-canvas')?.classList.contains('interaction-moving'), resizing: document.querySelector('.infinite-canvas')?.classList.contains('interaction-resizing'), editing: [...document.querySelectorAll('.canvas-node.card-editing')].map(item => item.getAttribute('data-placement-id')), guides: document.querySelectorAll('.alignment-guide').length, marquee: Boolean(document.querySelector('.selection-marquee')) }; })()`);
    const assertGestureRollback = (label, before, after, options = {}) => {
      if (JSON.stringify(before.placements) !== JSON.stringify(after.placements)
        || JSON.stringify(before.selection) !== JSON.stringify(after.selection)
        || (options.viewport && JSON.stringify(before.viewport) !== JSON.stringify(after.viewport))
        || after.moving || after.resizing || after.guides || after.marquee
        || (options.editing && JSON.stringify(before.editing) !== JSON.stringify(after.editing))) {
        throw new Error(`${label} did not fully roll back: ${JSON.stringify({ before, after })}`);
      }
    };

    await evaluate(`window.__openCanvasQaStore.getState().setSelection({ kind: 'connector', id: 'performance-edge-0' })`);
    await delay(60);
    const cancelDragPoint = await evaluate(`(() => { const node = document.querySelector('[data-placement-id="${initialNode.id}"]'); const rect = node?.getBoundingClientRect(); return rect && { x: rect.left + 30, y: rect.top + 18 }; })()`);
    const pendingClickBefore = await gestureSnapshot([initialNode.id]);
    await evaluate(`document.querySelector('[data-placement-id="${initialNode.id}"]')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 210, clientX: ${cancelDragPoint.x}, clientY: ${cancelDragPoint.y} }))`);
    await key('Escape', 'Escape', 27);
    await evaluate(`window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, buttons: 0, pointerId: 210, clientX: ${cancelDragPoint.x}, clientY: ${cancelDragPoint.y} }))`);
    await delay(80);
    const pendingClickAfter = await gestureSnapshot([initialNode.id]);
    assertGestureRollback('Escape before the card drag threshold', pendingClickBefore, pendingClickAfter);

    await evaluate(`(() => { const node = document.querySelector('[data-placement-id="${initialNode.id}"]'); node?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 211, clientX: ${cancelDragPoint.x}, clientY: ${cancelDragPoint.y} })); window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 211, clientX: ${cancelDragPoint.x + 58}, clientY: ${cancelDragPoint.y + 36} })); })()`);
    await waitFor(() => evaluate(`document.querySelector('.infinite-canvas')?.classList.contains('interaction-moving')`), 2000);
    await key('Escape', 'Escape', 27);
    await evaluate(`window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, buttons: 0, pointerId: 211, clientX: ${cancelDragPoint.x + 58}, clientY: ${cancelDragPoint.y + 36} }))`);
    await delay(80);
    const cancelledDragAfter = await gestureSnapshot([initialNode.id]);
    assertGestureRollback('Escape during card drag', pendingClickBefore, cancelledDragAfter);

    await evaluate(`window.__openCanvasQaStore.getState().setSelection({ kind: 'placement', id: '${initialNode.id}', ids: ['${initialNode.id}'] })`);
    await delay(60);
    const editPoint = await evaluate(`(() => { const content = document.querySelector('[data-placement-id="${initialNode.id}"] .card-content-shell'); const rect = content?.getBoundingClientRect(); return rect && { x: rect.left + Math.min(70, rect.width / 2), y: rect.top + Math.min(72, rect.height / 2) }; })()`);
    await evaluate(`(() => { const content = document.querySelector('[data-placement-id="${initialNode.id}"] .card-content-shell'); content?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 212, clientX: ${editPoint.x}, clientY: ${editPoint.y} })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, buttons: 0, pointerId: 212, clientX: ${editPoint.x}, clientY: ${editPoint.y} })); })()`);
    await waitFor(() => evaluate(`document.querySelector('[data-placement-id="${initialNode.id}"]')?.classList.contains('card-editing')`), 3000);
    const cancelResizeHandle = await evaluate(`(() => { const handle = document.querySelector('[data-placement-id="${initialNode.id}"] .resize-handle-se'); const rect = handle?.getBoundingClientRect(); return rect && { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
    const resizeCancelBefore = await gestureSnapshot([initialNode.id]);
    await mouse('mousePressed', cancelResizeHandle.x, cancelResizeHandle.y);
    await evaluate(`window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1, buttons: 1, clientX: ${cancelResizeHandle.x + 47}, clientY: ${cancelResizeHandle.y + 31} }))`);
    await waitFor(() => evaluate(`document.querySelector('.infinite-canvas')?.classList.contains('interaction-resizing')`), 2000);
    await evaluate(`window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, cancelable: true, pointerId: 1 }))`);
    await mouse('mouseReleased', cancelResizeHandle.x + 47, cancelResizeHandle.y + 31);
    await delay(80);
    const resizeCancelAfter = await gestureSnapshot([initialNode.id]);
    assertGestureRollback('Pointer cancellation during card resize', resizeCancelBefore, resizeCancelAfter, { editing: true });

    const secondPlacementId = 'performance-placement-1';
    await evaluate(`window.__openCanvasQaStore.getState().setSelection({ kind: 'placement', id: '${initialNode.id}', ids: ['${initialNode.id}', '${secondPlacementId}'] })`);
    await delay(60);
    const groupResizeHandle = await evaluate(`(() => { const handle = document.querySelector('.multi-selection-bounds .resize-handle-se'); const rect = handle?.getBoundingClientRect(); return rect && { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
    if (!groupResizeHandle) throw new Error('Multi-selection resize handle was not mounted for cancellation regression');
    const groupResizeBefore = await gestureSnapshot([initialNode.id, secondPlacementId]);
    await mouse('mousePressed', groupResizeHandle.x, groupResizeHandle.y);
    await evaluate(`window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1, buttons: 1, clientX: ${groupResizeHandle.x + 34}, clientY: ${groupResizeHandle.y + 24} }))`);
    await waitFor(() => evaluate(`document.querySelector('.infinite-canvas')?.classList.contains('interaction-resizing')`), 2000);
    await key('Escape', 'Escape', 27);
    await mouse('mouseReleased', groupResizeHandle.x + 34, groupResizeHandle.y + 24);
    await delay(80);
    const groupResizeAfter = await gestureSnapshot([initialNode.id, secondPlacementId]);
    assertGestureRollback('Escape during multi-selection resize', groupResizeBefore, groupResizeAfter);

    await evaluate(`window.__openCanvasQaStore.getState().updateConnector('performance-edge-0', { controlPoints: [{ id: 'performance-label-anchor', x: 410, y: 190 }] })`);
    await evaluate(`window.__openCanvasQaStore.getState().frameSelection()`);
    const sectionProfile = await waitFor(() => evaluate(`(() => { const store = window.__openCanvasQaStore; const state = store.getState(); const board = state.boards.find(item => item.id === state.activeBoardId); const frameId = state.selection?.kind === 'placement' ? state.selection.id : null; const frame = board?.placements.find(item => item.id === frameId && item.isFrame); const node = frame && document.querySelector('[data-placement-id="' + frame.id + '"]'); const rect = node?.getBoundingClientRect(); return frame && rect ? { id: frame.id, x: rect.left + 28, y: rect.top + 18 } : null; })()`), 3000);
    const sectionBefore = await gestureSnapshot([sectionProfile.id, initialNode.id, secondPlacementId]);
    const internalConnectorBefore = await evaluate(`window.__openCanvasQaStore.getState().boards.find(item => item.id === window.__openCanvasQaStore.getState().activeBoardId)?.connectors.find(item => item.id === 'performance-edge-0')?.controlPoints`);
    await mouse('mousePressed', sectionProfile.x, sectionProfile.y);
    await mouse('mouseMoved', sectionProfile.x + 52, sectionProfile.y + 39, { buttons: 1 });
    await waitFor(() => evaluate(`document.querySelector('.infinite-canvas')?.classList.contains('interaction-moving')`), 2000);
    const sectionDuring = await gestureSnapshot([sectionProfile.id, initialNode.id, secondPlacementId]);
    if (JSON.stringify(sectionDuring.placements) === JSON.stringify(sectionBefore.placements)) throw new Error('Section members did not move synchronously during the drag before cancellation');
    const internalConnectorDuring = await evaluate(`window.__openCanvasQaStore.getState().boards.find(item => item.id === window.__openCanvasQaStore.getState().activeBoardId)?.connectors.find(item => item.id === 'performance-edge-0')?.controlPoints`);
    const sectionDuringDelta = {
      x: sectionDuring.placements[1].x - sectionBefore.placements[1].x,
      y: sectionDuring.placements[1].y - sectionBefore.placements[1].y,
    };
    if (!internalConnectorBefore?.length
      || internalConnectorDuring[0].x - internalConnectorBefore[0].x !== sectionDuringDelta.x
      || internalConnectorDuring[0].y - internalConnectorBefore[0].y !== sectionDuringDelta.y) {
      throw new Error(`Internal connector did not move synchronously with its Section members: ${JSON.stringify({ internalConnectorBefore, internalConnectorDuring, sectionDuringDelta })}`);
    }
    await evaluate(`window.dispatchEvent(new Event('blur'))`);
    await mouse('mouseReleased', sectionProfile.x + 52, sectionProfile.y + 39);
    await delay(150);
    const sectionAfter = await gestureSnapshot([sectionProfile.id, initialNode.id, secondPlacementId]);
    assertGestureRollback('Window blur during Section drag', sectionBefore, sectionAfter);
    const internalConnectorAfterCancel = await evaluate(`window.__openCanvasQaStore.getState().boards.find(item => item.id === window.__openCanvasQaStore.getState().activeBoardId)?.connectors.find(item => item.id === 'performance-edge-0')?.controlPoints`);
    if (JSON.stringify(internalConnectorAfterCancel) !== JSON.stringify(internalConnectorBefore)) throw new Error(`Cancelling a Section drag did not restore its internal connector: ${JSON.stringify({ internalConnectorBefore, internalConnectorAfterCancel })}`);

    await evaluate(`window.__openCanvasQaStore.getState().setSelection({ kind: 'placement', id: '${initialNode.id}', ids: ['${initialNode.id}'] })`);
    const additiveSectionPoint = { x: sectionProfile.x, y: sectionProfile.y };
    await mouse('mousePressed', additiveSectionPoint.x, additiveSectionPoint.y, { modifiers: 2 });
    await mouse('mouseReleased', additiveSectionPoint.x, additiveSectionPoint.y, { modifiers: 2 });
    const additiveSectionSelection = await waitFor(() => evaluate(`(() => { const selection = window.__openCanvasQaStore.getState().selection; const ids = selection?.kind === 'placement' ? (selection.ids?.length ? selection.ids : [selection.id]) : []; return ids.includes('${initialNode.id}') && ids.includes('${sectionProfile.id}') && ids.length === 2 && !document.querySelector('.selection-marquee') ? ids : null; })()`), 2000);
    if (!additiveSectionSelection) throw new Error('Ctrl-clicking a Section label did not add it to the current placement selection');
    const sectionMultiDragBefore = await gestureSnapshot([sectionProfile.id, initialNode.id, secondPlacementId]);
    await mouse('mousePressed', additiveSectionPoint.x, additiveSectionPoint.y);
    await mouse('mouseMoved', additiveSectionPoint.x + 46, additiveSectionPoint.y + 34, { buttons: 1 });
    await waitFor(() => evaluate(`document.querySelector('.infinite-canvas')?.classList.contains('interaction-moving')`), 2000);
    await mouse('mouseReleased', additiveSectionPoint.x + 46, additiveSectionPoint.y + 34);
    const sectionMultiDragAfter = await waitFor(async () => {
      const snapshot = await gestureSnapshot([sectionProfile.id, initialNode.id, secondPlacementId]);
      const deltas = snapshot.placements.map((item, index) => ({ x: item.x - sectionMultiDragBefore.placements[index].x, y: item.y - sectionMultiDragBefore.placements[index].y }));
      return deltas[0].x !== 0 && deltas.every((delta) => delta.x === deltas[0].x && delta.y === deltas[0].y) ? { snapshot, deltas } : null;
    }, 2500, 20);
    const selectedAfterSectionMultiDrag = sectionMultiDragAfter.snapshot.selection?.kind === 'placement'
      ? (sectionMultiDragAfter.snapshot.selection.ids?.length ? sectionMultiDragAfter.snapshot.selection.ids : [sectionMultiDragAfter.snapshot.selection.id])
      : [];
    if (selectedAfterSectionMultiDrag.length !== 2 || !selectedAfterSectionMultiDrag.includes(initialNode.id) || !selectedAfterSectionMultiDrag.includes(sectionProfile.id)) throw new Error(`Dragging a multi-selected Section changed the explicit selection: ${JSON.stringify(sectionMultiDragAfter)}`);
    const internalConnectorAfterCommit = await evaluate(`window.__openCanvasQaStore.getState().boards.find(item => item.id === window.__openCanvasQaStore.getState().activeBoardId)?.connectors.find(item => item.id === 'performance-edge-0')?.controlPoints`);
    if (internalConnectorAfterCommit[0].x - internalConnectorBefore[0].x !== sectionMultiDragAfter.deltas[1].x
      || internalConnectorAfterCommit[0].y - internalConnectorBefore[0].y !== sectionMultiDragAfter.deltas[1].y) {
      throw new Error(`Committed Section drag left its internal connector behind: ${JSON.stringify({ internalConnectorBefore, internalConnectorAfterCommit, deltas: sectionMultiDragAfter.deltas })}`);
    }
    await evaluate(`window.__openCanvasQaStore.getState().undo()`);
    await waitFor(async () => {
      const snapshot = await gestureSnapshot([sectionProfile.id, initialNode.id, secondPlacementId]);
      const connector = await evaluate(`window.__openCanvasQaStore.getState().boards.find(item => item.id === window.__openCanvasQaStore.getState().activeBoardId)?.connectors.find(item => item.id === 'performance-edge-0')?.controlPoints`);
      return JSON.stringify(snapshot.placements) === JSON.stringify(sectionMultiDragBefore.placements)
        && JSON.stringify(connector) === JSON.stringify(internalConnectorBefore) ? true : null;
    }, 2000, 20);
    await evaluate(`window.__openCanvasQaStore.getState().setSelection({ kind: 'placement', id: '${sectionProfile.id}', ids: ['${sectionProfile.id}'] })`);
    await evaluate(`window.__openCanvasQaStore.getState().removeSelection()`);
    await waitFor(() => evaluate(`!document.querySelector('[data-placement-id="${sectionProfile.id}"]')`), 2000);

    const panBefore = await gestureSnapshot([]);
    const panPoint = await evaluate(`(() => { const rect = document.querySelector('.infinite-canvas')?.getBoundingClientRect(); return rect && { x: rect.right - 90, y: rect.bottom - 90 }; })()`);
    await evaluate(`(() => { const canvas = document.querySelector('.infinite-canvas'); canvas?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 1, buttons: 4, pointerId: 215, clientX: ${panPoint.x}, clientY: ${panPoint.y} })); window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, button: 1, buttons: 4, pointerId: 215, clientX: ${panPoint.x - 65}, clientY: ${panPoint.y - 45} })); })()`);
    await waitFor(() => evaluate(`document.querySelector('.infinite-canvas')?.classList.contains('interaction-panning')`), 2000);
    await evaluate(`window.dispatchEvent(new Event('blur'))`);
    await evaluate(`window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 1, buttons: 0, pointerId: 215, clientX: ${panPoint.x - 65}, clientY: ${panPoint.y - 45} }))`);
    await delay(80);
    const panAfter = await gestureSnapshot([]);
    assertGestureRollback('Window blur during canvas pan', panBefore, panAfter, { viewport: true });
    progress('card, multi-selection, additive Section selection/drag, internal connector motion, and canvas gestures fully rolled back on Escape, pointer cancellation, and window blur');

    await client.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 640, deviceScaleFactor: 1.5, mobile: false, screenWidth: 900, screenHeight: 640 });
    await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await delay(120);
    const compactPlacementId = await evaluate(`(() => { const node = [...document.querySelectorAll('.canvas-node.node-note')].find(item => { const rect = item.getBoundingClientRect(); return rect.right > 220 && rect.left < innerWidth && rect.bottom > 58 && rect.top < innerHeight; }); return node?.getAttribute('data-placement-id') || null; })()`);
    if (!compactPlacementId) throw new Error('No visible card was available after compact/high-DPI emulation');
    await evaluate(`window.__openCanvasQaStore.getState().setSelection({ kind: 'placement', id: ${JSON.stringify(compactPlacementId)}, ids: [${JSON.stringify(compactPlacementId)}] })`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.canvas-node.selected [aria-label="展开右侧栏"]'))`), 3000);
    await evaluate(`document.querySelector('.canvas-node.selected [aria-label="展开右侧栏"]')?.click()`);
    try {
      await waitFor(() => evaluate(`(() => { const panel = document.querySelector('.card-side-panel'); const rect = panel?.getBoundingClientRect(); return panel?.getAttribute('aria-hidden') === 'false' && rect && rect.left < innerWidth && rect.right <= innerWidth + 1; })()`), 3000);
    } catch (error) {
      const panelOpenDiagnostic = await evaluate(`import('/src/store.ts').then(module => { const panel = document.querySelector('.card-side-panel'); const rect = panel?.getBoundingClientRect(); const state = module.useWorkspaceStore.getState(); return { ariaHidden: panel?.getAttribute('aria-hidden'), className: panel?.className, rect: rect?.toJSON(), viewport: { width: innerWidth, height: innerHeight }, stateOpen: state.sidePanelOpen, stateCardId: state.sidePanelCardId, selected: state.selection, conflict: document.querySelector('.vault-conflict-files')?.innerText || null }; })`);
      throw new Error(`Compact side panel did not settle inside the viewport: ${JSON.stringify(panelOpenDiagnostic)}; ${error.message}`);
    }
    const compactLayout = await evaluate(`(() => { const panel = document.querySelector('.card-side-panel'); const canvas = document.querySelector('.canvas-panel'); const topbar = document.querySelector('.canvas-topbar'); const panelRect = panel?.getBoundingClientRect(); const canvasRect = canvas?.getBoundingClientRect(); const topbarRect = topbar?.getBoundingClientRect(); const panelStyle = panel && getComputedStyle(panel); return { viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth, panelClass: panel?.className, panelAriaHidden: panel?.getAttribute('aria-hidden'), panel: panelRect && { left: panelRect.left, right: panelRect.right, width: panelRect.width }, canvas: canvasRect && { width: canvasRect.width, right: canvasRect.right }, topbar: topbarRect && { left: topbarRect.left, right: topbarRect.right }, transitionDuration: panelStyle?.transitionDuration, animationDuration: panelStyle?.animationDuration }; })()`);
    await evaluate(`void import('/src/store.ts').then(async module => { const store = module.useWorkspaceStore; const ids = ['performance-card', 'scrolling-card']; for (let index = 0; index < 10; index += 1) { store.getState().openCardInSidePanel(ids[index % ids.length]); await new Promise(resolve => setTimeout(resolve, 35)); } window.__panelSwitchQa = { cardId: store.getState().sidePanelCardId, open: store.getState().sidePanelOpen }; }).catch(error => { window.__panelSwitchQa = { error: String(error?.stack || error) }; })`);
    const panelSwitch = await waitFor(() => evaluate(`window.__panelSwitchQa ?? null`), 10000);
    await evaluate(`delete window.__panelSwitchQa`);
    const panelSwitchUi = await waitFor(() => evaluate(`(() => {
      const profile = { title: document.querySelector('.card-side-panel-title')?.value, editors: document.querySelectorAll('.card-side-panel .structured-card-editor').length, visible: document.querySelector('.card-side-panel')?.getAttribute('aria-hidden') === 'false' };
      return profile.title === '滚轮路由边界验证' && profile.editors === 1 && profile.visible ? profile : null;
    })()`), 3000);
    if (panelSwitch.error || panelSwitch.cardId !== 'scrolling-card' || !panelSwitch.open || panelSwitchUi.title !== '滚轮路由边界验证' || panelSwitchUi.editors !== 1 || !panelSwitchUi.visible) throw new Error(`Rapid side-panel card switching flashed or leaked editors: ${JSON.stringify({ panelSwitch, panelSwitchUi })}`);
    await evaluate(`document.querySelector('.card-side-panel [aria-label="展开卡片"]')?.click()`);
    const reducedMotionExpandedPage = await waitFor(() => evaluate(`(() => {
      const page = document.querySelector('.note-page');
      const panel = document.querySelector('.card-side-panel');
      return page && panel?.getAttribute('aria-hidden') === 'true' ? {
        source: page.className,
        pageEditors: page.querySelectorAll('.structured-card-editor').length,
        retainedPanelEditors: panel.querySelectorAll('.structured-card-editor').length,
      } : null;
    })()`), 3000);
    if (!reducedMotionExpandedPage.source.includes('note-page-from-side-panel') || reducedMotionExpandedPage.pageEditors !== 1 || reducedMotionExpandedPage.retainedPanelEditors !== 1) throw new Error(`Reduced-motion side-panel expansion lost its visual source or retained editor: ${JSON.stringify(reducedMotionExpandedPage)}`);
    await evaluate(`document.querySelector('.note-page [aria-label="返回右侧栏"]')?.click()`);
    const reducedMotionReturnedPanel = await waitFor(() => evaluate(`(() => {
      const panel = document.querySelector('.card-side-panel');
      const style = panel && getComputedStyle(panel);
      return !document.querySelector('.note-page') && panel?.getAttribute('aria-hidden') === 'false' ? {
        editors: panel.querySelectorAll('.structured-card-editor').length,
        title: panel.querySelector('.card-side-panel-title')?.value,
        transitionDuration: style?.transitionDuration,
        animationDuration: style?.animationDuration,
      } : null;
    })()`), 1000);
    if (reducedMotionReturnedPanel.editors !== 1 || reducedMotionReturnedPanel.title !== '滚轮路由边界验证' || parseFloat(reducedMotionReturnedPanel.transitionDuration || '1') > .001 || parseFloat(reducedMotionReturnedPanel.animationDuration || '1') > .001) throw new Error(`Reduced-motion full-page return retained a hidden transition or lost the panel editor: ${JSON.stringify(reducedMotionReturnedPanel)}`);
    await evaluate(`document.querySelector('.card-side-panel [aria-label="关闭卡片侧栏"]')?.click()`);
    await waitFor(() => evaluate(`document.querySelector('.card-side-panel')?.getAttribute('aria-hidden') === 'true'`), 3000);
    await evaluate(`void import('/src/store.ts').then(module => { const store = module.useWorkspaceStore; store.getState().setSelection({ kind: 'placement', id: 'performance-placement-0', ids: ['performance-placement-0'] }); window.__manualPanelQa = { open: store.getState().sidePanelOpen, cardId: store.getState().sidePanelCardId }; }).catch(error => { window.__manualPanelQa = { error: String(error?.stack || error) }; })`);
    const manuallyCollapsedPanel = await waitFor(() => evaluate(`window.__manualPanelQa ? ({ ...window.__manualPanelQa, hidden: document.querySelector('.card-side-panel')?.getAttribute('aria-hidden') }) : null`), 3000);
    await evaluate(`delete window.__manualPanelQa`);
    if (manuallyCollapsedPanel.open || manuallyCollapsedPanel.cardId !== 'scrolling-card' || manuallyCollapsedPanel.hidden !== 'true') throw new Error(`Selecting a new card reopened a manually collapsed side panel: ${JSON.stringify(manuallyCollapsedPanel)}`);
    const compactCanvasWidthAfterClose = await evaluate(`document.querySelector('.canvas-panel')?.getBoundingClientRect().width`);
    if (compactLayout.viewport.width !== 900 || compactLayout.viewport.dpr !== 1.5 || compactLayout.overflowX || !compactLayout.panel || compactLayout.panel.left < 220 || compactLayout.panel.right > 901 || compactLayout.panel.width > 680 || !compactLayout.canvas || Math.abs(compactLayout.canvas.width - compactCanvasWidthAfterClose) > 1 || !compactLayout.topbar || compactLayout.topbar.right > 901 || parseFloat(compactLayout.transitionDuration || '1') > .001 || parseFloat(compactLayout.animationDuration || '1') > .001) throw new Error(`Compact/high-DPI/reduced-motion layout regressed: ${JSON.stringify({ ...compactLayout, compactCanvasWidthAfterClose })}`);
    await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await client.send('Emulation.clearDeviceMetricsOverride');
    await delay(120);
    progress('compact window, 150% display scale, overlay panel, and reduced-motion mode passed');

    for (const displayScale of [1.25, 1.75]) {
      await client.send('Emulation.setDeviceMetricsOverride', { width: 1120, height: 760, deviceScaleFactor: displayScale, mobile: false, screenWidth: 1120, screenHeight: 760 });
      await delay(100);
      const scaledLayout = await evaluate(`(() => { const shell = document.querySelector('.app-shell')?.getBoundingClientRect(); const sidebar = document.querySelector('.sidebar')?.getBoundingClientRect(); const canvas = document.querySelector('.canvas-panel')?.getBoundingClientRect(); const topbar = document.querySelector('.canvas-topbar')?.getBoundingClientRect(); return { dpr: devicePixelRatio, viewport: { width: innerWidth, height: innerHeight }, overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth, shell: shell?.toJSON(), sidebar: sidebar?.toJSON(), canvas: canvas?.toJSON(), topbar: topbar?.toJSON() }; })()`);
      if (Math.abs(scaledLayout.dpr - displayScale) > .0001 || scaledLayout.overflowX || !scaledLayout.shell || Math.abs(scaledLayout.shell.width - 1120) > 1 || Math.abs(scaledLayout.shell.height - (760 - scaledLayout.shell.top)) > 1 || Math.abs(scaledLayout.shell.bottom - 760) > 1 || !scaledLayout.sidebar || !scaledLayout.canvas || Math.abs(scaledLayout.sidebar.right - scaledLayout.canvas.left) > 1 || !scaledLayout.topbar || scaledLayout.topbar.right > 1121) throw new Error(`Scaled layout regressed at ${displayScale * 100}%: ${JSON.stringify(scaledLayout)}`);
      await evaluate(`document.querySelector('.canvas-node')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1112, clientY: 752, button: 2 }))`);
      await waitFor(() => evaluate(`Boolean(document.querySelector('.canvas-context-menu'))`), 2000);
      const scaledMenu = await evaluate(`document.querySelector('.canvas-context-menu')?.getBoundingClientRect().toJSON()`);
      if (!scaledMenu || scaledMenu.left < 0 || scaledMenu.top < 0 || scaledMenu.right > 1120 || scaledMenu.bottom > 760) throw new Error(`Context menu escaped at ${displayScale * 100}%: ${JSON.stringify(scaledMenu)}`);
      await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    }
    await client.send('Emulation.clearDeviceMetricsOverride');
    await delay(120);
    progress('125% and 175% display scale geometry and menu containment passed');

    await client.send('Emulation.setDeviceMetricsOverride', { width: 480, height: 360, deviceScaleFactor: 1, mobile: false, screenWidth: 480, screenHeight: 360 });
    await delay(120);
    await evaluate(`document.querySelector('.canvas-node.node-note:not(.node-frame)')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 472, clientY: 352, button: 2 }))`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.canvas-context-menu[role="menu"]'))`), 2000);
    const tinyPlacementMenu = await evaluate(`(() => { const menu = document.querySelector('.canvas-context-menu[role="menu"]'); const rect = menu?.getBoundingClientRect(); return menu && rect && { rect: rect.toJSON(), scrollable: menu.scrollHeight > menu.clientHeight, overflowY: getComputedStyle(menu).overflowY }; })()`);
    if (!tinyPlacementMenu || tinyPlacementMenu.rect.left < 0 || tinyPlacementMenu.rect.top < 0 || tinyPlacementMenu.rect.right > 480 || tinyPlacementMenu.rect.bottom > 360 || !tinyPlacementMenu.scrollable || tinyPlacementMenu.overflowY !== 'auto') throw new Error(`Placement menu escaped a tiny viewport: ${JSON.stringify(tinyPlacementMenu)}`);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await evaluate(`[...document.querySelectorAll('.global-nav button')].find(button => button.textContent.trim() === '文件')?.click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.file-tree-root'))`), 2000);
    await evaluate(`document.querySelector('.file-tree-root')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 472, clientY: 352, button: 2 }))`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.file-context-menu'))`), 2000);
    const tinyFileMenu = await evaluate(`(() => { const menu = document.querySelector('.file-context-menu'); const rect = menu?.getBoundingClientRect(); return rect?.toJSON(); })()`);
    if (!tinyFileMenu || tinyFileMenu.left < 0 || tinyFileMenu.top < 0 || tinyFileMenu.right > 480 || tinyFileMenu.bottom > 360) throw new Error(`File menu escaped a tiny viewport: ${JSON.stringify(tinyFileMenu)}`);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await client.send('Emulation.clearDeviceMetricsOverride');
    await delay(120);
    progress('tiny-window context and file menu containment passed');

    await waitFor(() => evaluate(`window.__openCanvasQaStore?.getState().cards.length >= 5001`), 30000, 50);
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false, screenWidth: 1280, screenHeight: 720 });
    await delay(160);
    await evaluate(`[...document.querySelectorAll('.global-nav button')].find(button => button.textContent.trim() === '文件')?.click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.file-tree'))`), 3000);
    const bulkFolderOpened = await evaluate(`(() => { const row = [...document.querySelectorAll('.file-folder-row')].find(item => item.textContent.includes('批量文件')); if (row?.getAttribute('aria-expanded') !== 'true') row?.querySelector('.file-row-main')?.click(); return Boolean(row); })()`);
    if (!bulkFolderOpened) throw new Error('The 5000-file fixture folder was not visible in the Notes tree');
    let largeFileTreeProfile;
    try {
      largeFileTreeProfile = await waitFor(() => evaluate(`(() => { const tree = document.querySelector('.file-tree'); const spacer = tree?.querySelector('.file-tree-virtual-spacer'); const items = [...(tree?.querySelectorAll('[role="treeitem"]') || [])]; const folder = items.find(item => item.textContent.includes('批量文件')); const height = Number.parseFloat(spacer?.style.height || '0'); return height > 150000 && items.length > 2 ? { mounted: items.length, height, scrollHeight: tree.scrollHeight, clientHeight: tree.clientHeight, folderExpanded: folder?.getAttribute('aria-expanded'), legacyBranches: tree.querySelectorAll('.file-tree-branch').length, nestedRenameInputs: tree.querySelectorAll('button input').length } : null; })()`), 10000);
    } catch (error) {
      const debug = await evaluate(`(() => { const tree = document.querySelector('.file-tree'); const spacer = tree?.querySelector('.file-tree-virtual-spacer'); const items = [...(tree?.querySelectorAll('[role="treeitem"]') || [])]; const folder = items.find(item => item.textContent.includes('批量文件')); return { storeCards: window.__openCanvasQaStore?.getState().cards.length, query: document.querySelector('.sidebar-search input')?.value, height: spacer?.style.height, mounted: items.length, folderExpanded: folder?.getAttribute('aria-expanded'), activeNav: document.querySelector('.global-nav button.active')?.textContent }; })()`);
      throw new Error(`5000-file tree did not reach its expanded virtualized state: ${JSON.stringify(debug)}; ${error.message}`);
    }
    if (largeFileTreeProfile.mounted > 40 || largeFileTreeProfile.folderExpanded !== 'true' || largeFileTreeProfile.legacyBranches || largeFileTreeProfile.nestedRenameInputs || largeFileTreeProfile.scrollHeight <= largeFileTreeProfile.clientHeight) throw new Error(`5000-file tree was not virtualized into a valid, scrollable hierarchy: ${JSON.stringify(largeFileTreeProfile)}`);
    const dragHoverStarted = await evaluate(`(() => { const source = [...document.querySelectorAll('.file-card-row')].find(item => item.textContent.includes('批量文件 0000')); const target = [...document.querySelectorAll('.file-folder-row')].find(item => item.textContent.includes('归档')); if (!source || !target || typeof DataTransfer !== 'function') return false; const transfer = window.__fileTreeDragTransfer = new DataTransfer(); source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer })); return true; })()`);
    if (!dragHoverStarted) throw new Error('File drag-hover fixtures were not available in the virtual tree');
    const dragPreviewProfile = await waitFor(() => evaluate(`(() => { const source = [...document.querySelectorAll('.file-card-row.is-dragging')].find(item => item.textContent.includes('批量文件 0000')); const preview = document.querySelector('.file-drag-preview'); return source && preview ? { text: preview.textContent, kind: preview.getAttribute('data-kind'), hidden: preview.getAttribute('aria-hidden'), shadow: getComputedStyle(preview).boxShadow } : null; })()`), 2000);
    if (!dragPreviewProfile.text?.includes('批量文件 0000') || dragPreviewProfile.kind !== 'card' || dragPreviewProfile.hidden !== 'true' || dragPreviewProfile.shadow === 'none') throw new Error(`File drag did not replace the browser ghost with a themed preview: ${JSON.stringify(dragPreviewProfile)}`);
    await evaluate(`(() => { const target = [...document.querySelectorAll('.file-folder-row')].find(item => item.textContent.includes('批量文件')); const rect = target?.getBoundingClientRect(); target?.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: rect?.left + 30, clientY: rect?.top + 15, dataTransfer: window.__fileTreeDragTransfer })); })()`);
    const noopDropProfile = await waitFor(() => evaluate(`(() => { const target = [...document.querySelectorAll('.file-folder-row')].find(item => item.textContent.includes('批量文件')); const status = document.querySelector('.file-drag-status'); return target?.classList.contains('file-drop-noop') ? { label: target.getAttribute('data-drop-label'), status: status?.textContent?.trim() } : null; })()`), 2000);
    if (noopDropProfile.label !== '已在这里' || !noopDropProfile.status?.includes('保持在原目录')) throw new Error(`No-op file drop did not explain itself: ${JSON.stringify(noopDropProfile)}`);
    await evaluate(`(() => { const target = [...document.querySelectorAll('.file-folder-row')].find(item => item.textContent.includes('归档')); const rect = target?.getBoundingClientRect(); target?.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: rect?.left + 30, clientY: rect?.top + 15, dataTransfer: window.__fileTreeDragTransfer })); })()`);
    const pendingExpandProfile = await waitFor(() => evaluate(`(() => { const target = [...document.querySelectorAll('.file-folder-row')].find(item => item.textContent.includes('归档')); const status = document.querySelector('.file-drag-status'); const progress = target && getComputedStyle(target, '::before'); return target?.classList.contains('file-drop-expand-pending') ? { label: target.getAttribute('data-drop-label'), status: status?.textContent?.trim(), animation: progress?.animationName, duration: progress?.animationDuration } : null; })()`), 2000);
    if (pendingExpandProfile.label !== '移到这里' || !pendingExpandProfile.status?.includes('移动到归档') || pendingExpandProfile.animation !== 'file-hover-expand-progress' || Math.abs(parseFloat(pendingExpandProfile.duration || '0') - .56) > .01) throw new Error(`Folder hover did not expose destination and timed expansion feedback: ${JSON.stringify(pendingExpandProfile)}`);
    const dragHoverProfile = await waitFor(() => evaluate(`(() => { const target = [...document.querySelectorAll('.file-folder-row')].find(item => item.textContent.includes('归档')); return target?.getAttribute('aria-expanded') === 'true' ? { expanded: true, feedback: target.classList.contains('file-drop-move'), sourceDimmed: Boolean(document.querySelector('.file-card-row.is-dragging')) } : null; })()`), 2000);
    if (!dragHoverProfile.feedback || !dragHoverProfile.sourceDimmed) throw new Error(`Drag-hover expansion did not retain source and target feedback: ${JSON.stringify(dragHoverProfile)}`);
    const autoScrollStart = await evaluate(`(() => { const tree = document.querySelector('.file-tree'); const rect = tree?.getBoundingClientRect(); const target = rect && document.elementFromPoint(rect.left + Math.min(120, rect.width / 2), rect.bottom - 4); if (!tree || !rect || !target) return null; const start = tree.scrollTop; target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: rect.left + 80, clientY: rect.bottom - 4, dataTransfer: window.__fileTreeDragTransfer })); return { start, hit: target.className }; })()`);
    let autoScrollProfile;
    try {
      // Hidden Electron windows throttle requestAnimationFrame heavily. More
      // than one legacy 13px dragover step proves the loop continued without
      // requiring foreground-only 60fps timing.
      autoScrollProfile = await waitFor(() => evaluate(`(() => { const tree = document.querySelector('.file-tree'); return tree?.scrollTop > ${autoScrollStart?.start ?? 0} + 20 ? { top: tree.scrollTop, direction: tree.classList.contains('file-auto-scroll-down') } : null; })()`), 2500);
    } catch (error) {
      const diagnostic = await evaluate(`(() => { const tree = document.querySelector('.file-tree'); const rect = tree?.getBoundingClientRect(); return { start: ${JSON.stringify(autoScrollStart)}, top: tree?.scrollTop, scrollHeight: tree?.scrollHeight, clientHeight: tree?.clientHeight, className: tree?.className, bottomHit: rect && document.elementFromPoint(rect.left + 80, rect.bottom - 4)?.className, conflict: document.querySelector('.vault-conflict-files')?.innerText || null }; })()`);
      throw new Error(`File drag edge auto-scroll did not advance: ${JSON.stringify(diagnostic)}; ${error.message}`);
    }
    if (!autoScrollStart || !autoScrollProfile.direction) throw new Error(`File drag edge did not enter continuous down-scroll feedback: ${JSON.stringify({ autoScrollStart, autoScrollProfile })}`);
    await evaluate(`(() => { const tree = document.querySelector('.file-tree'); tree.dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: null, dataTransfer: window.__fileTreeDragTransfer })); tree.scrollTop = 0; tree.dispatchEvent(new Event('scroll', { bubbles: true })); })()`);
    await waitFor(() => evaluate(`Boolean([...document.querySelectorAll('.file-card-row.is-dragging')].find(item => item.textContent.includes('批量文件 0000')))`), 2000);
    await evaluate(`(() => { const source = document.querySelector('.file-card-row.is-dragging'); source?.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__fileTreeDragTransfer })); delete window.__fileTreeDragTransfer; })()`);
    await waitFor(() => evaluate(`!document.querySelector('.file-card-row.is-dragging, .file-drop-move, .file-drop-invalid, .file-drop-noop, .file-drop-expand-pending, .file-drag-preview') && !document.querySelector('.file-auto-scroll-up, .file-auto-scroll-down') && !document.querySelector('.file-drag-status')?.textContent?.trim()`), 2000);
    const fileTreeEndDispatch = await evaluate(`(() => { const row = document.querySelector('.file-folder-row[aria-expanded="true"]'); row?.focus(); const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'End', code: 'End' }); const dispatched = row?.dispatchEvent(event); return { dispatched, prevented: event.defaultPrevented, focusedBefore: document.activeElement === row }; })()`);
    await delay(500);
    const fileTreeEndProfile = await evaluate(`(() => { const tree = document.querySelector('.file-tree'); const active = document.activeElement?.matches('[role="treeitem"]') ? document.activeElement : null; const current = tree.querySelector('.tree-current'); const treeRect = tree?.getBoundingClientRect(); const activeRect = active?.getBoundingClientRect(); return { key: active?.getAttribute('data-tree-key'), level: active?.getAttribute('aria-level'), position: active?.getAttribute('aria-posinset'), setSize: active?.getAttribute('aria-setsize'), currentKey: current?.getAttribute('data-tree-key'), currentTabIndex: current?.getAttribute('tabindex'), mounted: tree.querySelectorAll('[role="treeitem"]').length, scrollTop: tree.scrollTop, scrollHeight: tree.scrollHeight, clientHeight: tree.clientHeight, activeVisible: Boolean(treeRect && activeRect && activeRect.top >= treeRect.top - 1 && activeRect.bottom <= treeRect.bottom + 1), activeTag: document.activeElement?.tagName, activeClass: document.activeElement?.className }; })()`);
    if (fileTreeEndProfile.mounted > 40 || !fileTreeEndProfile.key || !fileTreeEndProfile.position || fileTreeEndProfile.position !== fileTreeEndProfile.setSize || !fileTreeEndProfile.activeVisible) throw new Error(`End navigation did not retain accessible virtual-tree metadata: ${JSON.stringify({ fileTreeEndDispatch, fileTreeEndProfile })}`);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F10', code: 'F10', windowsVirtualKeyCode: 121, modifiers: 8 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F10', code: 'F10', windowsVirtualKeyCode: 121, modifiers: 8 });
    await waitFor(() => evaluate(`Boolean(document.querySelector('.file-context-menu [role="menuitem"]:focus'))`), 3000);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor(() => evaluate(`!document.querySelector('.file-context-menu') && document.activeElement?.getAttribute('data-tree-key') === ${JSON.stringify(fileTreeEndProfile.key)}`), 3000);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 });
    const fileRenameProfile = await waitFor(() => evaluate(`(() => { const input = document.querySelector('.file-inline-input'); const profile = input ? { label: input.getAttribute('aria-label'), nestedInButton: Boolean(input.closest('button')), selected: input.selectionStart === 0 && input.selectionEnd === input.value.length } : null; return profile?.selected ? profile : null; })()`), 3000);
    if (fileRenameProfile.nestedInButton || !fileRenameProfile.selected) throw new Error(`Virtual file rename did not expose a valid selected inline editor: ${JSON.stringify(fileRenameProfile)}`);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await evaluate(`(() => { const input = document.querySelector('.sidebar-search input'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, '批量文件 4999'); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '批量文件 4999' })); })()`);
    const fileSearchProfile = await waitFor(() => evaluate(`(() => { const tree = document.querySelector('.file-tree'); const cards = [...(tree?.querySelectorAll('.file-card-row') || [])]; return cards.length === 1 && cards[0].textContent.includes('批量文件 4999') ? { items: tree.querySelectorAll('[role="treeitem"]').length, title: cards[0].textContent, folderExpanded: tree.querySelector('.file-folder-row')?.getAttribute('aria-expanded') } : null; })()`), 5000);
    if (fileSearchProfile.items !== 3 || fileSearchProfile.folderExpanded !== 'true') throw new Error(`File search did not retain only the match and its expanded ancestor: ${JSON.stringify(fileSearchProfile)}`);
    await evaluate(`document.querySelector('.sidebar-search input')?.focus()`);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor(() => evaluate(`document.querySelector('.sidebar-search input')?.value === '' && !document.querySelector('.sidebar-search-clear')`), 3000);
    await delay(120);
    await evaluate(`(() => { const tree = document.querySelector('.file-tree'); tree.scrollTop = 0; tree.dispatchEvent(new Event('scroll', { bubbles: true })); })()`);
    await waitFor(() => evaluate(`Boolean([...document.querySelectorAll('.file-folder-row')].find(item => item.textContent.includes('批量文件')))`), 3000);
    await evaluate(`[...document.querySelectorAll('.file-folder-row')].find(item => item.textContent.includes('批量文件'))?.querySelector('.file-row-main')?.click()`);
    await waitFor(() => evaluate(`[...document.querySelectorAll('.file-folder-row')].find(item => item.textContent.includes('批量文件'))?.getAttribute('aria-expanded') === 'false'`), 3000);
    const denseFileLayout = await evaluate(`(() => { const shell = document.querySelector('.app-shell'); const sidebar = document.querySelector('.sidebar'); const canvas = document.querySelector('.canvas-panel'); const shellRect = shell?.getBoundingClientRect(); const sidebarRect = sidebar?.getBoundingClientRect(); const canvasRect = canvas?.getBoundingClientRect(); return { viewportHeight: innerHeight, row: shell && getComputedStyle(shell).gridTemplateRows, shell: shellRect?.toJSON(), sidebar: sidebarRect?.toJSON(), canvas: canvasRect?.toJSON() }; })()`);
    const denseWithinViewport = Boolean(denseFileLayout.shell)
      && Math.abs(denseFileLayout.shell.bottom - denseFileLayout.viewportHeight) < 1
      && [denseFileLayout.sidebar, denseFileLayout.canvas].every((rect) => rect
        && Math.abs(rect.top - denseFileLayout.shell.top) < 1
        && Math.abs(rect.height - denseFileLayout.shell.height) < 1);
    if (largeFileTreeProfile.scrollHeight <= largeFileTreeProfile.clientHeight || !denseWithinViewport) throw new Error(`Dense file tree expanded the main grid beyond the viewport: ${JSON.stringify({ denseFileLayout, largeFileTreeProfile })}`);
    const fileScrollBeforeCards = await evaluate(`document.querySelector('.file-tree')?.scrollTop`);
    await evaluate(`[...document.querySelectorAll('.global-nav button')].find(button => button.textContent.trim() === '卡片库')?.click()`);
    const largeCardListProfile = await waitFor(() => evaluate(`(() => { const list = document.querySelector('[role="listbox"][aria-label="卡片列表"]'); const spacer = list?.querySelector('.sidebar-entity-spacer'); const rows = [...(list?.querySelectorAll('.sidebar-entity-row') || [])]; const height = Number.parseFloat(spacer?.style.height || '0'); return height > 160000 && rows.length ? { mounted: rows.length, height, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight, directButtons: list.querySelectorAll(':scope > button').length, nestedRenameInputs: list.querySelectorAll('button input').length } : null; })()`), 5000);
    if (largeCardListProfile.mounted > 40 || largeCardListProfile.directButtons || largeCardListProfile.nestedRenameInputs || largeCardListProfile.scrollHeight <= largeCardListProfile.clientHeight) throw new Error(`5000-card library did not stay virtualized and structurally valid: ${JSON.stringify(largeCardListProfile)}`);
    const entityEndDispatch = await evaluate(`(() => { const row = document.querySelector('.sidebar-entity-row'); row?.focus(); const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'End', code: 'End' }); const dispatched = row?.dispatchEvent(event); return { dispatched, prevented: event.defaultPrevented }; })()`);
    await delay(500);
    const entityEndProfile = await evaluate(`(() => { const list = document.querySelector('[aria-label="卡片列表"]'); const active = document.activeElement?.matches('.sidebar-entity-row') ? document.activeElement : null; const current = list?.querySelector('.list-current'); return { key: active?.getAttribute('data-entity-key'), currentKey: current?.getAttribute('data-entity-key'), position: active?.getAttribute('aria-posinset'), setSize: active?.getAttribute('aria-setsize'), mounted: list?.querySelectorAll('.sidebar-entity-row').length, scrollTop: list?.scrollTop, scrollHeight: list?.scrollHeight, clientHeight: list?.clientHeight }; })()`);
    if (!entityEndDispatch.prevented || !entityEndProfile.key || entityEndProfile.key !== entityEndProfile.currentKey || !entityEndProfile.position || entityEndProfile.position !== entityEndProfile.setSize || entityEndProfile.mounted > 40 || entityEndProfile.scrollTop < entityEndProfile.scrollHeight - entityEndProfile.clientHeight - 34) throw new Error(`Card-library End navigation lost its virtual focus contract: ${JSON.stringify({ entityEndDispatch, entityEndProfile })}`);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F10', code: 'F10', windowsVirtualKeyCode: 121, modifiers: 8 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F10', code: 'F10', windowsVirtualKeyCode: 121, modifiers: 8 });
    await waitFor(() => evaluate(`Boolean(document.querySelector('.file-context-menu [role="menuitem"]:focus'))`), 3000);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor(() => evaluate(`!document.querySelector('.file-context-menu') && document.activeElement?.getAttribute('data-entity-key') === ${JSON.stringify(entityEndProfile.key)}`), 3000);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 });
    const entityRenameProfile = await waitFor(() => evaluate(`(() => { const input = document.querySelector('.sidebar-entity-row .file-inline-input'); const profile = input ? { nestedInButton: Boolean(input.closest('button')), selected: input.selectionStart === 0 && input.selectionEnd === input.value.length } : null; return profile?.selected ? profile : null; })()`), 3000);
    if (entityRenameProfile.nestedInButton) throw new Error(`Card-library rename nested an input inside a button: ${JSON.stringify(entityRenameProfile)}`);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await evaluate(`(() => { const input = document.querySelector('.sidebar-search input'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, '批量文件 4999'); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '批量文件 4999' })); })()`);
    const cardSearchProfile = await waitFor(() => evaluate(`(() => { const list = document.querySelector('[aria-label="空间搜索结果"]'); const rows = [...(list?.querySelectorAll('.sidebar-entity-row') || [])]; return rows.length === 1 && rows[0].textContent.includes('批量文件 4999') ? { rows: rows.length, height: Number.parseFloat(list.querySelector('.sidebar-entity-spacer')?.style.height || '0') } : null; })()`), 5000);
    if (cardSearchProfile.height !== 34) throw new Error(`Card-library search retained an oversized virtual surface: ${JSON.stringify(cardSearchProfile)}`);
    await evaluate(`(() => { const input = document.querySelector('.sidebar-search input'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, ''); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })); })()`);
    await delay(160);
    const restoredCardScroll = await evaluate(`document.querySelector('[aria-label="卡片列表"]')?.scrollTop`);
    if (restoredCardScroll < 160000) throw new Error(`Clearing card search did not restore its previous browsing position: ${restoredCardScroll}`);
    await evaluate(`[...document.querySelectorAll('.global-nav button')].find(button => button.textContent.trim() === '白板')?.click()`);
    await evaluate(`(() => { const input = document.querySelector('.sidebar-search input'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, '五千节点'); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '五千节点' })); })()`);
    const mixedSearchProfile = await waitFor(() => evaluate(`(() => { const list = document.querySelector('[aria-label="空间搜索结果"]'); const rows = [...(list?.querySelectorAll('.sidebar-entity-row') || [])]; return rows.some(row => row.classList.contains('entity-board') && row.textContent.includes('五千节点白板')) && rows.some(row => row.classList.contains('entity-card') && row.textContent.includes('五千节点性能验证')) ? { order: rows.map(row => row.classList.contains('entity-board') ? 'board' : 'card'), addButtons: document.querySelectorAll('.tabs-heading button').length } : null; })()`), 5000);
    if (mixedSearchProfile.order[0] !== 'board' || mixedSearchProfile.addButtons) throw new Error(`Global search did not preserve ranked mixed results and compact search chrome: ${JSON.stringify(mixedSearchProfile)}`);
    await evaluate(`document.querySelector('.sidebar-search-clear')?.click()`);
    await waitFor(() => evaluate(`document.querySelector('.sidebar-search input')?.value === '' && Boolean(document.querySelector('[aria-label="白板列表"]'))`), 3000);
    await evaluate(`[...document.querySelectorAll('.global-nav button')].find(button => button.textContent.trim() === '文件')?.click()`);
    const restoredFileScroll = await waitFor(() => evaluate(`(() => { const tree = document.querySelector('.file-tree'); return tree && Math.abs(tree.scrollTop - ${fileScrollBeforeCards}) < 2 ? { top: tree.scrollTop } : null; })()`), 3000);
    if (Math.abs(restoredFileScroll.top - fileScrollBeforeCards) > 2) throw new Error(`Sidebar mode switching lost the file-tree scroll position: ${JSON.stringify({ fileScrollBeforeCards, restoredFileScroll })}`);
    progress('5000-file tree and 5000-card library virtualization, search, keyboard menus, rename, drag-hover, and per-mode scroll memory passed');
    await client.send('Emulation.clearDeviceMetricsOverride');
    await delay(120);

    await evaluate(`window.__longDocumentOpenStarted = performance.now(); window.__openCanvasQaStore.getState().focusCard('long-document-card'); true`);
    const longDocumentOpenMs = await waitFor(() => evaluate(`document.querySelector('.note-page .card-prosemirror') ? performance.now() - window.__longDocumentOpenStarted : null`), 10000);
    const longDocumentProfile = await evaluate(`(() => { const editor = document.querySelector('.note-page .card-prosemirror'); const table = editor?.querySelector('.tableWrapper'); const tableRect = table?.getBoundingClientRect(); const editorRect = editor?.getBoundingClientRect(); return { paragraphs: editor?.querySelectorAll('p').length, textLength: editor?.textContent?.length, editors: document.querySelectorAll('.structured-card-editor').length, wideTable: table && tableRect && editorRect ? { clientWidth: table.clientWidth, scrollWidth: table.scrollWidth, contained: tableRect.left >= editorRect.left - 1 && tableRect.right <= editorRect.right + 1 } : null }; })()`);
    // The full smoke intentionally runs after 5000-node/5000-file interaction
    // pressure. Keep a 30% scheduling margin over the focused ~5s mount while
    // still catching a return to the historical 14s eager-editor regression.
    if (longDocumentOpenMs > 6500 || longDocumentProfile.paragraphs < 1000 || longDocumentProfile.editors !== 1 || !longDocumentProfile.wideTable?.contained || longDocumentProfile.wideTable.scrollWidth <= longDocumentProfile.wideTable.clientWidth) throw new Error(`Long document mount or wide-table containment regressed: ${JSON.stringify({ longDocumentOpenMs, longDocumentProfile })}`);
    await evaluate(`(() => { const editor = document.querySelector('.note-page .card-prosemirror'); const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); editor.focus(); })()`);
    const longDocumentEditStarted = Date.now();
    await client.send('Input.insertText', { text: '超长文档输入延迟标记' });
    await waitFor(() => evaluate(`document.querySelector('.note-page .card-prosemirror')?.textContent.includes('超长文档输入延迟标记')`), 3000);
    const longDocumentEditMs = Date.now() - longDocumentEditStarted;
    if (longDocumentEditMs > 2000) throw new Error(`Long document input was not responsive enough: ${longDocumentEditMs}ms`);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
    await waitFor(() => evaluate(`!document.querySelector('.note-page .card-prosemirror')?.textContent.includes('超长文档输入延迟标记')`), 3000);
    await evaluate(`document.querySelector('.note-page [aria-label="返回白板"]')?.click()`);
    await waitFor(() => evaluate(`document.querySelectorAll('.structured-card-editor').length === 0`), 3000);
    for (let cycle = 0; cycle < 4; cycle += 1) {
      await evaluate(`[...document.querySelectorAll('.file-card-row')].find(button => button.textContent.trim() === '超长文档压力测试')?.click()`);
      await waitFor(() => evaluate(`document.querySelectorAll('.structured-card-editor').length === 1`), 7000);
      await evaluate(`document.querySelector('.note-page [aria-label="返回白板"]')?.click()`);
      await waitFor(() => evaluate(`document.querySelectorAll('.structured-card-editor').length === 0`), 3000);
    }
    await evaluate(`[...document.querySelectorAll('.global-nav button')].find(button => button.textContent.trim() === '白板')?.click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.canvas-node.node-note'))`), 3000);
    await evaluate(`(() => { const node = document.querySelector('.canvas-node.node-note'); const rect = node?.getBoundingClientRect(); if (!node || !rect) return false; const x = rect.left + rect.width / 2; const y = rect.top + 18; node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 89, clientX: x, clientY: y })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 89, clientX: x, clientY: y })); return true; })()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.canvas-node.selected .card-markdown-preview'))`), 3000);
    progress(`long document opened in ${longDocumentOpenMs}ms, edited in ${longDocumentEditMs}ms, and released all editor instances across repeated cycles`);

    const readCompactHeadingMetrics = (selector) => evaluate(`(() => {
      const root = document.querySelector(${JSON.stringify(selector)});
      if (!root) return null;
      return Object.fromEntries(['h2', 'h4'].map(tag => {
        const element = root.querySelector(tag);
        if (!element) return [tag, null];
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return [tag, { top: rect.top, height: rect.height, width: rect.width, fontWeight: style.fontWeight, letterSpacing: style.letterSpacing, lineHeight: style.lineHeight, marginTop: style.marginTop, marginBottom: style.marginBottom }];
      }));
    })()`);
    const previewHeadingMetrics = await readCompactHeadingMetrics('.canvas-node.selected .card-markdown-preview');
    await evaluate(`(() => { const heading = document.querySelector('.canvas-node.selected .card-markdown-preview h2'); const rect = heading?.getBoundingClientRect(); if (!heading || !rect) return false; const x = rect.left + Math.min(24, rect.width / 2); const y = rect.top + Math.min(8, rect.height / 2); heading.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 90, clientX: x, clientY: y })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 90, clientX: x, clientY: y })); return true; })()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.canvas-node.selected.card-editing .structured-card-editor.compact .tiptap h4'))`), 3000);
    const editingHeadingMetrics = await readCompactHeadingMetrics('.canvas-node.selected .structured-card-editor.compact .tiptap');
    for (const tag of ['h2', 'h4']) {
      const preview = previewHeadingMetrics?.[tag];
      const editing = editingHeadingMetrics?.[tag];
      if (!preview || !editing || Math.abs(preview.top - editing.top) > 1 || Math.abs(preview.height - editing.height) > 1 || Math.abs(preview.width - editing.width) > 1 || preview.fontWeight !== editing.fontWeight || preview.letterSpacing !== editing.letterSpacing || preview.lineHeight !== editing.lineHeight || preview.marginTop !== editing.marginTop || preview.marginBottom !== editing.marginBottom) throw new Error(`Compact ${tag} typography changed between preview and edit states: ${JSON.stringify({ preview, editing })}`);
    }
    await evaluate(`(() => { const toolbar = document.querySelector('.canvas-node.selected .card-selection-toolbar'); const rect = toolbar?.getBoundingClientRect(); if (!toolbar || !rect) return false; const x = rect.left + rect.width / 2; const y = rect.top + rect.height / 2; toolbar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 92, clientX: x, clientY: y })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 92, clientX: x, clientY: y })); return true; })()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.canvas-node.selected .card-markdown-preview'))`), 3000);

    const selectedTypography = await waitFor(() => evaluate(`(() => { const title = document.querySelector('.canvas-node .card-inline-title'); const body = document.querySelector('.canvas-node .card-prosemirror'); const toolbar = document.querySelector('.canvas-node .card-selection-toolbar'); if (!title || !body || !toolbar) return null; const titleRect = title.getBoundingClientRect(); const bodyRect = body.getBoundingClientRect(); const titleStyle = getComputedStyle(title); const bodyStyle = getComputedStyle(body); return { titleWidth: titleRect.width, titleTop: titleRect.top, bodyWidth: bodyRect.width, bodyTop: bodyRect.top, toolbarHeight: toolbar.getBoundingClientRect().height, titleFont: titleStyle.font, titleSpacing: titleStyle.letterSpacing, bodyFont: bodyStyle.font, bodySpacing: bodyStyle.letterSpacing }; })()`));
    const blankPoint = await evaluate(`(() => { const rect = document.querySelector('.infinite-canvas')?.getBoundingClientRect(); if (!rect) return null; for (let y = rect.top + 50; y < rect.bottom - 40; y += 22) for (let x = rect.left + 50; x < rect.right - 40; x += 22) if (!document.elementFromPoint(x, y)?.closest('.canvas-node, .canvas-toolbar, .zoom-controls')) return { x, y }; return { x: rect.right - 30, y: rect.bottom - 30 }; })()`);
    await evaluate(`(() => { const canvas = document.querySelector('.infinite-canvas'); canvas?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: ${blankPoint.x}, clientY: ${blankPoint.y} })); canvas?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: ${blankPoint.x}, clientY: ${blankPoint.y} })); })()`);
    const idleTypography = await waitFor(() => evaluate(`(() => { if (document.querySelector('.canvas-node.selected')) return null; const title = document.querySelector('.canvas-node .card-inline-title'); const body = document.querySelector('.canvas-node .card-prosemirror'); const toolbar = document.querySelector('.canvas-node .card-selection-toolbar'); if (!title || !body || !toolbar) return null; const titleRect = title.getBoundingClientRect(); const bodyRect = body.getBoundingClientRect(); const titleStyle = getComputedStyle(title); const bodyStyle = getComputedStyle(body); return { titleWidth: titleRect.width, titleTop: titleRect.top, bodyWidth: bodyRect.width, bodyTop: bodyRect.top, toolbarHeight: toolbar.getBoundingClientRect().height, titleFont: titleStyle.font, titleSpacing: titleStyle.letterSpacing, bodyFont: bodyStyle.font, bodySpacing: bodyStyle.letterSpacing }; })()`));
    if (!selectedTypography || !idleTypography || selectedTypography.toolbarHeight < 20 || Math.abs(selectedTypography.toolbarHeight - idleTypography.toolbarHeight) > 1 || Math.abs(selectedTypography.titleTop - idleTypography.titleTop) > 1 || Math.abs(selectedTypography.bodyTop - idleTypography.bodyTop) > 1 || Math.abs(selectedTypography.titleWidth - idleTypography.titleWidth) > 1 || Math.abs(selectedTypography.bodyWidth - idleTypography.bodyWidth) > 1 || selectedTypography.titleFont !== idleTypography.titleFont || selectedTypography.titleSpacing !== idleTypography.titleSpacing || selectedTypography.bodyFont !== idleTypography.bodyFont || selectedTypography.bodySpacing !== idleTypography.bodySpacing) throw new Error(`Card typography or vertical layout changed between selected and idle states: ${JSON.stringify({ selectedTypography, idleTypography })}`);
    const multiSelectionIds = await evaluate(`(() => { const store = window.__openCanvasQaStore; const state = store.getState(); const board = state.boards.find(item => item.id === state.activeBoardId); const ids = board.placements.filter(item => item.kind === 'card' && !item.locked).slice(0, 3).map(item => item.id); if (ids.length < 3) return []; store.getState().setSelection({ kind: 'placement', id: ids[0], ids }); return ids; })()`);
    if (multiSelectionIds.length < 3) throw new Error('Multi-selection capsule fixture did not contain three cards');
    const darkMultiSelectionProfile = await waitFor(() => evaluate(`(() => { const canvas = document.querySelector('.infinite-canvas'); const toolbar = document.querySelector('.multi-selection-toolbar'); const bounds = document.querySelector('.multi-selection-bounds'); if (!canvas || !toolbar || !bounds) return null; const canvasRect = canvas.getBoundingClientRect(); const toolbarRect = toolbar.getBoundingClientRect(); const labels = [...toolbar.querySelectorAll('button')].map(button => button.getAttribute('aria-label')); const style = getComputedStyle(toolbar); return { label: toolbar.getAttribute('aria-label'), labels, height: toolbarRect.height, inside: toolbarRect.left >= canvasRect.left + 7 && toolbarRect.right <= canvasRect.right - 7 && toolbarRect.top >= canvasRect.top + 7 && toolbarRect.bottom <= canvasRect.bottom - 7, background: style.backgroundColor, shadow: style.boxShadow, animation: style.animationName, selected: document.querySelectorAll('.canvas-node.selected').length }; })()`), 3000);
    if (darkMultiSelectionProfile.label !== '已选择 3 个对象' || darkMultiSelectionProfile.selected !== 3 || darkMultiSelectionProfile.height < 36 || darkMultiSelectionProfile.height > 40 || !darkMultiSelectionProfile.inside || darkMultiSelectionProfile.shadow === 'none' || darkMultiSelectionProfile.animation !== 'oc-toolbar-in' || !['为选择创建区块', '整理选择', '创建选择的分身', '更多多选操作', '从白板移除所选对象'].every(label => darkMultiSelectionProfile.labels.includes(label))) throw new Error(`Multi-selection action capsule was incomplete or out of viewport: ${JSON.stringify(darkMultiSelectionProfile)}`);
    const preTidyXs = await evaluate(`(() => { const ids = ${JSON.stringify(multiSelectionIds)}; const state = window.__openCanvasQaStore.getState(); const board = state.boards.find(item => item.id === state.activeBoardId); return ids.map(id => board.placements.find(item => item.id === id)?.x); })()`);
    const multiCapsuleTidyTriggerPoint = await evaluate(`(() => { const rect = document.querySelector('.multi-selection-toolbar [aria-label="整理选择"]')?.getBoundingClientRect(); return rect && { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
    await mouse('mousePressed', multiCapsuleTidyTriggerPoint.x, multiCapsuleTidyTriggerPoint.y);
    await mouse('mouseReleased', multiCapsuleTidyTriggerPoint.x, multiCapsuleTidyTriggerPoint.y);
    const tidyCapsuleProfile = await waitFor(() => evaluate(`(() => { const menu = document.querySelector('.multi-selection-tidy[role="menu"]'); const labels = [...(menu?.querySelectorAll('[role="menuitem"]') || [])].map(item => item.getAttribute('aria-label')); return labels.length === 11 ? { labels, menuCount: document.querySelectorAll('.multi-selection-tidy').length } : null; })()`), 3000);
    if (tidyCapsuleProfile.menuCount !== 1 || !tidyCapsuleProfile.labels.includes('左对齐') || !tidyCapsuleProfile.labels.includes('网格整理')) throw new Error(`Multi-selection tidy flyout was incomplete: ${JSON.stringify(tidyCapsuleProfile)}`);
    const multiCapsuleTidyLeftPoint = await evaluate(`(() => { const rect = document.querySelector('.multi-selection-tidy [aria-label="左对齐"]')?.getBoundingClientRect(); return rect && { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
    await mouse('mousePressed', multiCapsuleTidyLeftPoint.x, multiCapsuleTidyLeftPoint.y);
    await mouse('mouseReleased', multiCapsuleTidyLeftPoint.x, multiCapsuleTidyLeftPoint.y);
    await waitFor(() => evaluate(`(() => { const ids = ${JSON.stringify(multiSelectionIds)}; const state = window.__openCanvasQaStore.getState(); const board = state.boards.find(item => item.id === state.activeBoardId); const xs = ids.map(id => board.placements.find(item => item.id === id)?.x); return xs.every(value => value === xs[0]); })()`), 3000);
    await evaluate(`window.__openCanvasQaStore.getState().undo()`);
    await waitFor(() => evaluate(`(() => { const ids = ${JSON.stringify(multiSelectionIds)}; const expected = ${JSON.stringify(preTidyXs)}; const state = window.__openCanvasQaStore.getState(); const board = state.boards.find(item => item.id === state.activeBoardId); const selectedIds = state.selection?.kind === 'placement' ? (state.selection.ids?.length ? state.selection.ids : [state.selection.id]) : []; return ids.map(id => board.placements.find(item => item.id === id)?.x).every((value, index) => value === expected[index]) && JSON.stringify(selectedIds) === JSON.stringify(ids); })()`), 3000);
    await evaluate(`window.__openCanvasQaStore.getState().redo()`);
    await waitFor(() => evaluate(`(() => { const ids = ${JSON.stringify(multiSelectionIds)}; const state = window.__openCanvasQaStore.getState(); const board = state.boards.find(item => item.id === state.activeBoardId); const xs = ids.map(id => board.placements.find(item => item.id === id)?.x); const selectedIds = state.selection?.kind === 'placement' ? (state.selection.ids?.length ? state.selection.ids : [state.selection.id]) : []; return xs.every(value => value === xs[0]) && JSON.stringify(selectedIds) === JSON.stringify(ids); })()`), 3000);
    await evaluate(`window.__openCanvasQaStore.getState().undo()`);
    await waitFor(() => evaluate(`(() => { const ids = ${JSON.stringify(multiSelectionIds)}; const expected = ${JSON.stringify(preTidyXs)}; const state = window.__openCanvasQaStore.getState(); const board = state.boards.find(item => item.id === state.activeBoardId); return ids.map(id => board.placements.find(item => item.id === id)?.x).every((value, index) => value === expected[index]); })()`), 3000);
    await waitFor(() => evaluate(`document.activeElement?.getAttribute('aria-label') === '左对齐' && Boolean(document.querySelector('.multi-selection-tidy'))`), 2000);
    await key('Escape', 'Escape', 27);
    const multiTidyEscapeProfile = await waitFor(() => evaluate(`(() => { const profile = { tidy: Boolean(document.querySelector('.multi-selection-tidy')), toolbar: Boolean(document.querySelector('.multi-selection-toolbar')), selected: document.querySelectorAll('.canvas-node.selected').length, activeLabel: document.activeElement?.getAttribute('aria-label'), activeTag: document.activeElement?.tagName, activeClass: document.activeElement?.className }; return !profile.tidy && profile.activeLabel === '整理选择' ? profile : null; })()`), 2500, 20);
    if (multiTidyEscapeProfile.tidy || !multiTidyEscapeProfile.toolbar || multiTidyEscapeProfile.selected !== 3 || multiTidyEscapeProfile.activeLabel !== '整理选择') throw new Error(`Escape did not close only the tidy flyout and return focus: ${JSON.stringify(multiTidyEscapeProfile)}`);
    await evaluate(`document.querySelector('.multi-selection-toolbar [aria-label="更多多选操作"]')?.click()`);
    const multiContextHeading = await waitFor(() => evaluate(`document.querySelector('.canvas-context-menu .context-menu-heading')?.textContent`), 2000);
    if (multiContextHeading !== '3 个对象') throw new Error(`Multi-selection capsule did not open the shared object menu: ${multiContextHeading}`);
    await key('Escape', 'Escape', 27);
    await waitFor(() => evaluate(`!document.querySelector('.canvas-context-menu')`), 2000);
    const darkMultiScreenshot = await captureVisualArtifact('dark-multi-selection-capsule');
    if (!darkMultiScreenshot?.data || darkMultiScreenshot.data.length < 20_000) throw new Error('Dark multi-selection capsule screenshot capture failed');
    await evaluate(`window.__openCanvasQaStore.getState().setSelection(null)`);
    await waitFor(() => evaluate(`!document.querySelector('.multi-selection-toolbar')`), 2000);
    progress('multi-selection capsule, tidy flyout, shared menu, undo, keyboard return, and viewport clamping passed');
    const darkScreenshot = await captureVisualArtifact('dark-card-overview');
    if (!darkScreenshot?.data || darkScreenshot.data.length < 20_000) throw new Error('Dark-theme visual regression screenshot capture failed');
    await evaluate(`document.querySelector('button[aria-label="切换到亮色模式"]')?.click()`);
    await waitFor(() => evaluate(`document.querySelector('.app-shell')?.getAttribute('data-theme') === 'light'`), 2000);
    await evaluate(`window.__openCanvasQaStore.getState().setSelection({ kind: 'placement', id: ${JSON.stringify(multiSelectionIds[0])}, ids: ${JSON.stringify(multiSelectionIds)} })`);
    const lightMultiSelectionProfile = await waitFor(() => evaluate(`(() => { const toolbar = document.querySelector('.multi-selection-toolbar'); const canvas = document.querySelector('.infinite-canvas'); if (!toolbar || !canvas) return null; const style = getComputedStyle(toolbar); const canvasStyle = getComputedStyle(canvas); return { background: style.backgroundColor, canvas: canvasStyle.backgroundColor, color: style.color, border: style.borderColor, buttons: toolbar.querySelectorAll('button').length }; })()`), 3000);
    if (lightMultiSelectionProfile.buttons !== 5 || lightMultiSelectionProfile.background === lightMultiSelectionProfile.canvas || lightMultiSelectionProfile.border === 'rgba(0, 0, 0, 0)') throw new Error(`Light-theme multi-selection capsule lost surface separation: ${JSON.stringify(lightMultiSelectionProfile)}`);
    const lightMultiScreenshot = await captureVisualArtifact('light-multi-selection-capsule');
    if (!lightMultiScreenshot?.data || lightMultiScreenshot.data.length < 20_000) throw new Error('Light multi-selection capsule screenshot capture failed');
    await evaluate(`window.__openCanvasQaStore.getState().setSelection(null)`);
    await waitFor(() => evaluate(`!document.querySelector('.multi-selection-toolbar')`), 2000);
    const lightIdleHeading = await evaluate(`getComputedStyle(document.querySelector('.canvas-node .card-prosemirror h4')).color`);
    await evaluate(`(() => { const node = document.querySelector('.canvas-node.node-note:not(.node-frame)'); const rect = node?.getBoundingClientRect(); if (!node || !rect) return; node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 91, clientX: rect.left + 24, clientY: rect.top + 12 })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 91, clientX: rect.left + 24, clientY: rect.top + 12 })); })()`);
    const lightSelectedHeading = await waitFor(() => evaluate(`document.querySelector('.canvas-node.selected') && getComputedStyle(document.querySelector('.canvas-node.selected .card-prosemirror h4')).color`), 2000);
    if (lightIdleHeading !== lightSelectedHeading || lightSelectedHeading === 'rgb(255, 255, 255)') throw new Error(`Light theme heading color changed on selection: ${lightIdleHeading} -> ${lightSelectedHeading}`);
    await evaluate(`(() => { const node = document.querySelector('.canvas-node.selected'); const rect = node?.getBoundingClientRect(); if (!node || !rect) return false; node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: rect.left + 30, clientY: rect.top + 30 })); return true; })()`);
    const colorMenuState = await waitFor(() => evaluate(`(() => { const options = [...document.querySelectorAll('.context-color-row [role="menuitemradio"]')]; const checked = options.filter(item => item.getAttribute('aria-checked') === 'true'); return options.length === 8 && checked.length === 1 ? { count: options.length, checked: checked[0].getAttribute('aria-label') } : null; })()`), 2000);
    if (!colorMenuState.checked?.includes('当前颜色')) throw new Error(`Object color menu did not expose its current color: ${JSON.stringify(colorMenuState)}`);
    await evaluate(`document.querySelector('.context-color-row [aria-checked="true"]')?.focus()`);
    await key('ArrowDown', 'ArrowDown', 40);
    const colorKeyboardFocus = await evaluate(`({ role: document.activeElement?.getAttribute('role'), label: document.activeElement?.getAttribute('aria-label') })`);
    if (colorKeyboardFocus.role !== 'menuitemradio' || colorKeyboardFocus.label === colorMenuState.checked) throw new Error(`Arrow navigation skipped object color choices: ${JSON.stringify({ colorMenuState, colorKeyboardFocus })}`);
    await evaluate(`document.querySelector('.context-color-row [aria-label^="墨色"]')?.click()`);
    await waitFor(() => evaluate(`document.querySelector('.canvas-node.selected')?.classList.contains('node-color-ink')`), 2000);
    const lightInkPreview = await evaluate(`(() => { const node = document.querySelector('.canvas-node.selected'); const title = node?.querySelector('.card-inline-title'); const body = node?.querySelector('.card-markdown-preview'); const heading = body?.querySelector('h4'); if (!node || !title || !body || !heading) return null; const rgb = value => (value.match(/[\\d.]+/g) || []).slice(0, 3).map(Number); const luminance = value => { const values = rgb(value).map(channel => { const normalized = channel / 255; return normalized <= .03928 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4; }); return .2126 * values[0] + .7152 * values[1] + .0722 * values[2]; }; const foreground = getComputedStyle(body).color; const background = getComputedStyle(node).backgroundColor; const ratio = (Math.max(luminance(foreground), luminance(background)) + .05) / (Math.min(luminance(foreground), luminance(background)) + .05); return { foreground, background, heading: getComputedStyle(heading).color, title: getComputedStyle(title).color, ratio }; })()`);
    if (!lightInkPreview || lightInkPreview.ratio < 4.5 || lightInkPreview.heading !== lightInkPreview.title) throw new Error(`Light-theme ink card lost readable local contrast: ${JSON.stringify(lightInkPreview)}`);
    await evaluate(`(() => { const heading = document.querySelector('.canvas-node.selected .card-markdown-preview h4'); const rect = heading?.getBoundingClientRect(); if (!heading || !rect) return false; heading.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 191, clientX: rect.left + 8, clientY: rect.top + 8 })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 191, clientX: rect.left + 8, clientY: rect.top + 8 })); return true; })()`);
    const lightInkEditing = await waitFor(() => evaluate(`(() => { const node = document.querySelector('.canvas-node.selected.card-editing'); const body = node?.querySelector('.structured-card-editor.compact .tiptap'); const heading = body?.querySelector('h4'); const title = node?.querySelector('.card-inline-title'); return node && body && heading && title ? { foreground: getComputedStyle(body).color, heading: getComputedStyle(heading).color, title: getComputedStyle(title).color } : null; })()`), 3000);
    if (lightInkEditing.foreground !== lightInkPreview.foreground || lightInkEditing.heading !== lightInkPreview.heading || lightInkEditing.title !== lightInkPreview.title) throw new Error(`Ink card changed palette between preview and edit states: ${JSON.stringify({ lightInkPreview, lightInkEditing })}`);
    await evaluate(`(() => { const toolbar = document.querySelector('.canvas-node.selected .card-selection-toolbar'); const rect = toolbar?.getBoundingClientRect(); if (!toolbar || !rect) return false; toolbar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 192, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 192, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 })); return true; })()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.canvas-node.selected .card-markdown-preview'))`), 2000);
    await evaluate(`void import('/src/store.ts').then(module => module.useWorkspaceStore.getState().setSelectionColor('paper'))`);
    const lightScreenshot = await captureVisualArtifact('light-card-overview');
    if (!lightScreenshot?.data || lightScreenshot.data.length < 20_000) throw new Error('Light-theme visual regression screenshot capture failed');
    await evaluate(`void import('/src/store.ts').then(module => module.useWorkspaceStore.getState().setSelection(null))`);
    await waitFor(() => evaluate(`!document.querySelector('.canvas-node.selected')`), 2000);

    const visualStateTarget = await waitFor(() => evaluate(`(() => {
      for (const node of document.querySelectorAll('.canvas-node.node-note:not(.node-frame)')) {
        const toolbar = node.querySelector('.card-selection-toolbar');
        const spacer = toolbar?.querySelector(':scope > span');
        const body = node.querySelector('.card-markdown-preview');
        const toolbarRect = spacer?.getBoundingClientRect();
        const bodyRect = body?.getBoundingClientRect();
        if (!toolbarRect || !bodyRect) continue;
        const toolbarPoint = { x: toolbarRect.left + toolbarRect.width / 2, y: toolbarRect.top + toolbarRect.height / 2 };
        const bodyPoint = { x: bodyRect.left + Math.min(28, bodyRect.width / 3), y: bodyRect.top + Math.min(18, bodyRect.height / 3) };
        if (document.elementFromPoint(toolbarPoint.x, toolbarPoint.y)?.closest('.canvas-node') !== node) continue;
        if (document.elementFromPoint(bodyPoint.x, bodyPoint.y)?.closest('.canvas-node') !== node) continue;
        return { id: node.getAttribute('data-placement-id'), toolbarPoint, bodyPoint };
      }
      return null;
    })()`), 3000);
    const readVisualCardState = (placementId) => evaluate(`(() => {
      const node = document.querySelector('[data-placement-id="${placementId}"]');
      const canvas = document.querySelector('.infinite-canvas');
      const toolbar = node?.querySelector('.card-selection-toolbar');
      const toolbarContent = toolbar?.querySelector(':scope > span');
      if (!node || !canvas || !toolbar || !toolbarContent) return null;
      const nodeStyle = getComputedStyle(node);
      const canvasStyle = getComputedStyle(canvas);
      const toolbarStyle = getComputedStyle(toolbar);
      const toolbarContentStyle = getComputedStyle(toolbarContent);
      return {
        theme: document.querySelector('.app-shell')?.getAttribute('data-theme'),
        selected: node.classList.contains('selected'),
        editing: node.classList.contains('card-editing'),
        moving: canvas.classList.contains('interaction-moving'),
        resizing: canvas.classList.contains('interaction-resizing'),
        cardBackground: nodeStyle.backgroundColor,
        canvasBackground: canvasStyle.backgroundColor,
        shadow: nodeStyle.boxShadow,
        selectionRing: getComputedStyle(node, '::after').boxShadow,
        transitionDuration: nodeStyle.transitionDuration,
        ringTransitionDuration: getComputedStyle(node, '::after').transitionDuration,
        toolbarBackground: toolbarStyle.backgroundColor,
        toolbarOpacity: toolbarContentStyle.opacity,
        toolbarVisibility: toolbarContentStyle.visibility,
      };
    })()`);
    await mouse('mouseMoved', blankPoint.x, blankPoint.y);
    const lightIdleVisual = await waitFor(async () => {
      const state = await readVisualCardState(visualStateTarget.id);
      const shadow = boxShadowProfile(state?.shadow);
      return state && !state.selected && state.toolbarOpacity !== '1' && shadow.maxBlur <= 2.1 && shadow.maxAlpha <= .036 ? state : null;
    }, 1500, 20);
    await mouse('mouseMoved', visualStateTarget.toolbarPoint.x, visualStateTarget.toolbarPoint.y);
    await waitFor(async () => {
      const state = await readVisualCardState(visualStateTarget.id);
      return state?.toolbarOpacity === '1' && state.toolbarVisibility === 'visible' ? state : null;
    }, 5000);
    await delay(110);
    const lightHoverVisual = await readVisualCardState(visualStateTarget.id);
    await mouse('mousePressed', visualStateTarget.toolbarPoint.x, visualStateTarget.toolbarPoint.y);
    await delay(80);
    const lightPressedVisual = await readVisualCardState(visualStateTarget.id);
    await mouse('mouseReleased', visualStateTarget.toolbarPoint.x, visualStateTarget.toolbarPoint.y);
    const lightSelectedVisual = await waitFor(async () => {
      const state = await readVisualCardState(visualStateTarget.id);
      const shadow = boxShadowProfile(state?.shadow);
      return state?.selected && !state.editing && shadow.maxOffsetY <= 1.1 && shadow.maxBlur <= 3.1 && shadow.maxAlpha <= .061 ? state : null;
    }, 1500, 20);
    await mouse('mousePressed', visualStateTarget.bodyPoint.x, visualStateTarget.bodyPoint.y);
    await mouse('mouseReleased', visualStateTarget.bodyPoint.x, visualStateTarget.bodyPoint.y);
    const lightEditingVisual = await waitFor(async () => {
      const state = await readVisualCardState(visualStateTarget.id);
      const shadow = boxShadowProfile(state?.shadow);
      return state?.editing && shadow.maxOffsetY <= 1.1 && shadow.maxBlur <= 3.1 && shadow.maxAlpha <= .061 ? state : null;
    }, 3000, 20);
    const lightVisualShadows = {
      idle: boxShadowProfile(lightIdleVisual?.shadow),
      hover: boxShadowProfile(lightHoverVisual?.shadow),
      pressed: boxShadowProfile(lightPressedVisual?.shadow),
      selected: boxShadowProfile(lightSelectedVisual?.shadow),
      editing: boxShadowProfile(lightEditingVisual?.shadow),
    };
    if (!lightIdleVisual || lightIdleVisual.theme !== 'light' || lightIdleVisual.cardBackground === lightIdleVisual.canvasBackground
      || lightIdleVisual.selected || lightIdleVisual.editing
      || lightHoverVisual.selected || lightHoverVisual.moving || lightHoverVisual.resizing
      || lightPressedVisual.selected || lightPressedVisual.moving || lightPressedVisual.resizing
      || !lightSelectedVisual.selectionRing.includes('inset') || lightSelectedVisual.editing
      || !lightEditingVisual.selected || !lightEditingVisual.editing
      || lightEditingVisual.selectionRing === lightSelectedVisual.selectionRing
      || !lightIdleVisual.transitionDuration.startsWith('0.075s') || lightSelectedVisual.transitionDuration !== '0.075s'
      || lightSelectedVisual.ringTransitionDuration !== '0.075s'
      || lightVisualShadows.idle.maxOffsetY > 1.1 || lightVisualShadows.idle.maxBlur > 2.1 || lightVisualShadows.idle.maxAlpha > .036
      || lightVisualShadows.hover.maxOffsetY > 3.1 || lightVisualShadows.hover.maxBlur > 10.1 || lightVisualShadows.hover.maxAlpha > .068
      || lightVisualShadows.pressed.maxOffsetY > 3.1 || lightVisualShadows.pressed.maxBlur > 10.1 || lightVisualShadows.pressed.maxAlpha > .068
      || lightVisualShadows.selected.maxOffsetY > 1.1 || lightVisualShadows.selected.maxBlur > 3.1 || lightVisualShadows.selected.maxAlpha > .061
      || lightVisualShadows.editing.maxOffsetY > 1.1 || lightVisualShadows.editing.maxBlur > 3.1 || lightVisualShadows.editing.maxAlpha > .061) {
      throw new Error(`Light-theme card visual state matrix regressed: ${JSON.stringify({ lightIdleVisual, lightHoverVisual, lightPressedVisual, lightSelectedVisual, lightEditingVisual, lightVisualShadows })}`);
    }
    await evaluate(`void import('/src/store.ts').then(module => module.useWorkspaceStore.getState().setSelection(null))`);
    await evaluate(`document.querySelector('button[aria-label="切换到深色模式"]')?.click()`);
    await waitFor(() => evaluate(`document.querySelector('.app-shell')?.getAttribute('data-theme') === 'dark'`), 2000);
    await mouse('mouseMoved', blankPoint.x, blankPoint.y);
    let darkIdleObserved = null;
    const darkIdleVisual = await waitFor(async () => {
      const state = await readVisualCardState(visualStateTarget.id);
      const shadow = boxShadowProfile(state?.shadow);
      darkIdleObserved = { state, shadow };
      return state?.theme === 'dark' && !state.selected && state.toolbarOpacity !== '1'
        && state.cardBackground !== lightIdleVisual.cardBackground && state.canvasBackground !== lightIdleVisual.canvasBackground
        && shadow.maxOffsetY <= 1.1 && shadow.maxBlur <= 2.1 && shadow.maxAlpha <= .102 ? state : null;
    }, 8000, 30).catch((error) => {
      throw new Error(`Dark idle visual state did not settle: ${JSON.stringify(darkIdleObserved)}; ${error.message}`);
    });
    await evaluate(`(() => { window.__openCanvasQaStore.getState().setSelection({ kind: 'placement', id: ${JSON.stringify(visualStateTarget.id)}, ids: [${JSON.stringify(visualStateTarget.id)}] }); return true; })()`);
    const darkSelectedVisual = await waitFor(async () => {
      const state = await readVisualCardState(visualStateTarget.id);
      const shadow = boxShadowProfile(state?.shadow);
      return state?.selected && shadow.maxOffsetY <= 1.1 && shadow.maxBlur <= 3.1 && shadow.maxAlpha <= .111 ? state : null;
    }, 1500, 20);
    const darkVisualShadows = { idle: boxShadowProfile(darkIdleVisual?.shadow), selected: boxShadowProfile(darkSelectedVisual?.shadow) };
    if (!darkIdleVisual || darkIdleVisual.theme !== 'dark' || darkIdleVisual.cardBackground === darkIdleVisual.canvasBackground
      || darkIdleVisual.cardBackground === lightIdleVisual.cardBackground
      || darkIdleVisual.canvasBackground === lightIdleVisual.canvasBackground
      || !darkSelectedVisual.selectionRing.includes('inset')
      || darkVisualShadows.idle.maxOffsetY > 1.1 || darkVisualShadows.idle.maxBlur > 2.1 || darkVisualShadows.idle.maxAlpha > .101
      || darkVisualShadows.selected.maxOffsetY > 1.1 || darkVisualShadows.selected.maxBlur > 3.1 || darkVisualShadows.selected.maxAlpha > .111) {
      throw new Error(`Dark-theme card visual state matrix regressed: ${JSON.stringify({ lightIdleVisual, darkIdleVisual, darkSelectedVisual, darkVisualShadows })}`);
    }
    await evaluate(`void import('/src/store.ts').then(module => module.useWorkspaceStore.getState().setSelection(null))`);
    await evaluate(`document.querySelector('button[aria-label="切换到亮色模式"]')?.click()`);
    await waitFor(() => evaluate(`document.querySelector('.app-shell')?.getAttribute('data-theme') === 'light'`), 2000);
    progress('light/dark idle, hover, press, selection, and editing visual state matrix passed');

    const scrollingCardPoint = await evaluate(`(() => { const id = 'performance-placement-1'; const node = document.querySelector('[data-placement-id="' + id + '"]'); const rect = node?.getBoundingClientRect(); if (!rect) return null; for (let y = rect.top + 10; y < Math.min(rect.bottom, rect.top + 54); y += 10) for (let x = rect.left + 18; x < rect.right - 18; x += 24) if (document.elementFromPoint(x, y)?.closest('.canvas-node')?.getAttribute('data-placement-id') === id) return { x, y }; return { x: rect.left + rect.width / 2, y: rect.top + 16, hit: document.elementFromPoint(rect.left + rect.width / 2, rect.top + 16)?.closest('.canvas-node')?.getAttribute('data-placement-id') || 'none' }; })()`);
    if (!scrollingCardPoint) throw new Error('Dedicated scrolling card was not mounted in the first viewport');
    if (scrollingCardPoint.hit) throw new Error(`Dedicated scrolling card was fully occluded by another selected card: ${JSON.stringify(scrollingCardPoint)}`);
    await mouse('mousePressed', scrollingCardPoint.x, scrollingCardPoint.y);
    await mouse('mouseReleased', scrollingCardPoint.x, scrollingCardPoint.y);
    await waitFor(() => evaluate(`document.querySelector('[data-placement-id="performance-placement-1"]')?.classList.contains('selected')`), 2000);
    await evaluate(`(() => { const preview = document.querySelector('[data-placement-id="performance-placement-1"] .card-markdown-preview'); const rect = preview?.getBoundingClientRect(); if (!preview || !rect) return false; const x = rect.left + Math.min(24, rect.width / 2); const y = rect.top + Math.min(20, rect.height / 2); preview.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 193, clientX: x, clientY: y })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 193, clientX: x, clientY: y })); return true; })()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('[data-placement-id="performance-placement-1"].card-editing .structured-card-editor.compact .tiptap'))`), 3000);
    const compactWideTable = await evaluate(`(() => { const node = document.querySelector('[data-placement-id="performance-placement-1"]'); const editor = node?.querySelector('.card-inline-editor'); const wrapper = node?.querySelector('.tableWrapper'); const wrapperRect = wrapper?.getBoundingClientRect(); const editorRect = editor?.getBoundingClientRect(); if (!wrapper || !wrapperRect || !editor || !editorRect) return null; wrapper.scrollLeft = 140; return { clientWidth: wrapper.clientWidth, scrollWidth: wrapper.scrollWidth, scrollLeft: wrapper.scrollLeft, contained: wrapperRect.left >= editorRect.left - 1 && wrapperRect.right <= editorRect.right + 1, editorOverflow: editor.scrollWidth - editor.clientWidth }; })()`);
    if (!compactWideTable?.contained || compactWideTable.scrollWidth <= compactWideTable.clientWidth || compactWideTable.scrollLeft <= 0 || compactWideTable.editorOverflow > 2) throw new Error(`Compact card did not contain wide table scrolling locally: ${JSON.stringify(compactWideTable)}`);
    const innerScroll = await evaluate(`(() => { const editor = document.querySelector('[data-placement-id="performance-placement-1"] .card-inline-editor'); const rect = editor?.getBoundingClientRect(); return editor && rect && { x: rect.left + rect.width / 2, y: rect.top + Math.min(rect.height / 2, 120), scrollTop: editor.scrollTop, max: editor.scrollHeight - editor.clientHeight, zoom: document.querySelector('.zoom-controls button')?.textContent }; })()`);
    if (!innerScroll || innerScroll.max < 80) throw new Error(`Selected card did not expose a meaningful inner scroll range: ${JSON.stringify(innerScroll)}`);
    let innerScrolled = null;
    for (let attempt = 0; attempt < 3 && !innerScrolled; attempt += 1) {
      await client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: innerScroll.x, y: innerScroll.y, deltaX: 0, deltaY: 420 });
      try {
        innerScrolled = await waitFor(() => evaluate(`(() => { const editor = document.querySelector('[data-placement-id="performance-placement-1"] .card-inline-editor'); return editor?.scrollTop > 0 ? { scrollTop: editor.scrollTop, zoom: document.querySelector('.zoom-controls button')?.textContent } : null; })()`), 2000);
      } catch (error) {
        if (attempt === 2) throw error;
        await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      }
    }
    for (let index = 0; index < 4; index += 1) {
      await client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: innerScroll.x, y: innerScroll.y, deltaX: 0, deltaY: 420 });
      await delay(25);
    }
    await delay(120);
    const innerBoundary = await evaluate(`(() => { const editor = document.querySelector('[data-placement-id="performance-placement-1"] .card-inline-editor'); return { scrollTop: editor?.scrollTop, max: (editor?.scrollHeight || 0) - (editor?.clientHeight || 0), zoom: document.querySelector('.zoom-controls button')?.textContent }; })()`);
    if (innerScrolled.zoom !== innerScroll.zoom || innerBoundary.zoom !== innerScroll.zoom || Math.abs(innerBoundary.scrollTop - innerBoundary.max) > 1) throw new Error(`Selected-card wheel routing leaked into canvas zoom: ${JSON.stringify({ innerScroll, innerScrolled, innerBoundary })}`);
    await evaluate(`(() => { const canvas = document.querySelector('.infinite-canvas'); canvas?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: ${blankPoint.x}, clientY: ${blankPoint.y} })); canvas?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: ${blankPoint.x}, clientY: ${blankPoint.y} })); })()`);
    progress('stable typography and dark/light screenshot checks passed');

    const zoomBefore = await evaluate(`document.querySelector('.zoom-controls button')?.textContent`);
    const canvasBlank = blankPoint;
    await evaluate(`document.querySelector('.infinite-canvas')?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: ${canvasBlank.x}, clientY: ${canvasBlank.y}, deltaY: 180 }))`);
    const zoomAfter = await waitFor(async () => {
      const value = await evaluate(`document.querySelector('.zoom-controls button')?.textContent`);
      return value !== zoomBefore ? value : null;
    }, 2000);
    if (!zoomBefore || zoomAfter === zoomBefore) {
      const wheelTarget = await evaluate(`document.elementFromPoint(${canvasBlank.x}, ${canvasBlank.y})?.className`);
      throw new Error(`Canvas wheel zoom did not update the viewport (${zoomBefore} -> ${zoomAfter}, target: ${wheelTarget})`);
    }
    await evaluate(`document.querySelector('.infinite-canvas')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: ${canvasBlank.x}, clientY: ${canvasBlank.y} }))`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.canvas-context-menu[role="menu"]'))`), 2000);
    await evaluate(`import('/src/store.ts').then(module => { const store = module.useWorkspaceStore; const state = store.getState(); const start = state.boards.find(board => board.id === state.activeBoardId)?.viewport.zoom; window.__wheelBurstQa = { count: 0, start, last: start, unsubscribe: store.subscribe((next, previous) => { const nextViewport = next.boards.find(board => board.id === next.activeBoardId)?.viewport; const previousViewport = previous.boards.find(board => board.id === previous.activeBoardId)?.viewport; if (nextViewport !== previousViewport) { window.__wheelBurstQa.count += 1; window.__wheelBurstQa.last = nextViewport?.zoom; } }) }; return true; })`);
    await evaluate(`(() => { const canvas = document.querySelector('.infinite-canvas'); const controls = document.querySelector('.zoom-controls'); const minimap = document.querySelector('.canvas-minimap'); const result = window.__wheelFeedbackQa = { canvas: false, controls: false, minimap: false }; const record = () => { result.canvas ||= Boolean(canvas?.classList.contains('is-wheel-zooming')); result.controls ||= Boolean(controls?.classList.contains('is-zooming')); result.minimap ||= Boolean(minimap?.classList.contains('is-zooming')); }; const observer = new MutationObserver(record); [canvas, controls, minimap].forEach(element => element && observer.observe(element, { attributes: true, attributeFilter: ['class'] })); record(); for (let index = 0; index < 40; index += 1) canvas?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: ${canvasBlank.x}, clientY: ${canvasBlank.y}, deltaY: .7 })); setTimeout(() => { record(); observer.disconnect(); }, 1000); })()`);
    await waitFor(() => evaluate(`window.__wheelBurstQa?.count > 0`), 2000);
    const wheelFeedback = await waitFor(() => evaluate(`window.__wheelFeedbackQa?.canvas && window.__wheelFeedbackQa?.controls && window.__wheelFeedbackQa?.minimap ? window.__wheelFeedbackQa : null`), 2000);
    const wheelBurst = await evaluate(`(() => { const result = { count: window.__wheelBurstQa?.count, start: window.__wheelBurstQa?.start, last: window.__wheelBurstQa?.last }; window.__wheelBurstQa?.unsubscribe?.(); delete window.__wheelBurstQa; return result; })()`);
    const expectedBurstZoom = wheelBurst.start * Math.exp(-40 * .7 * .0018);
    if (wheelBurst.count > 2 || Math.abs(wheelBurst.last - expectedBurstZoom) > .000001) throw new Error(`Touchpad delta coalescing lost precision or committed too often: ${JSON.stringify({ wheelBurst, expectedBurstZoom })}`);
    if (!wheelFeedback.canvas || !wheelFeedback.controls || !wheelFeedback.minimap) throw new Error(`Touchpad zoom did not expose coherent visual feedback: ${JSON.stringify(wheelFeedback)}`);
    await delay(220);
    const wheelFeedbackSettled = await evaluate(`(() => { const result = { canvas: document.querySelector('.infinite-canvas')?.classList.contains('is-wheel-zooming'), controls: document.querySelector('.zoom-controls')?.classList.contains('is-zooming'), minimap: document.querySelector('.canvas-minimap')?.classList.contains('is-zooming') }; delete window.__wheelFeedbackQa; return result; })()`);
    if (wheelFeedbackSettled.canvas || wheelFeedbackSettled.controls || wheelFeedbackSettled.minimap) throw new Error(`Touchpad zoom feedback did not settle after the gesture: ${JSON.stringify(wheelFeedbackSettled)}`);
    if (await evaluate(`Boolean(document.querySelector('.canvas-context-menu[role="menu"]'))`)) throw new Error('Touchpad zoom did not dismiss the open canvas menu');
    const wheelCommandRace = await evaluate(`import('/src/store.ts').then(module => new Promise(resolve => { const store = module.useWorkspaceStore; const canvas = document.querySelector('.infinite-canvas'); for (let index = 0; index < 30; index += 1) canvas?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: ${canvasBlank.x}, clientY: ${canvasBlank.y}, deltaY: .8 })); document.querySelector('.zoom-value')?.click(); const read = () => ({ ...store.getState().boards.find(board => board.id === store.getState().activeBoardId)?.viewport }); const immediate = read(); setTimeout(() => resolve({ immediate, settled: read() }), 90); }))`);
    if (Math.abs(wheelCommandRace.immediate.zoom - .8) > .000001 || ['x', 'y', 'zoom'].some(key => Math.abs(wheelCommandRace.immediate[key] - wheelCommandRace.settled[key]) > .000001)) throw new Error(`A pending wheel frame overwrote the explicit zoom command: ${JSON.stringify(wheelCommandRace)}`);

    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: canvasBlank.x, y: canvasBlank.y, button: 'right', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: canvasBlank.x, y: canvasBlank.y, button: 'right', clickCount: 1 });
    try {
      await waitFor(() => evaluate(`Boolean(document.querySelector('.canvas-context-menu[role="menu"]'))`), 2000);
    } catch (error) {
      const contextDiagnostic = await evaluate(`({ point: ${JSON.stringify(canvasBlank)}, hit: document.elementFromPoint(${canvasBlank.x}, ${canvasBlank.y})?.className, selected: document.querySelectorAll('.canvas-node.selected').length, mode: document.querySelector('.infinite-canvas')?.className })`);
      throw new Error(`Canvas context menu did not open: ${JSON.stringify(contextDiagnostic)} (${error.message})`);
    }
    const menuFocus = await waitFor(() => evaluate(`(() => { const items = [...document.querySelectorAll('.canvas-context-menu[role="menu"] [role="menuitem"]')]; if (!items.length || document.activeElement !== items[0]) return null; const first = items[0]?.textContent; items[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); return { first, active: document.activeElement?.textContent }; })()`), 2000);
    if (!menuFocus.first || !menuFocus.active || menuFocus.first === menuFocus.active) throw new Error(`Context-menu autofocus or roving focus failed: ${JSON.stringify(menuFocus)}`);
    await captureVisualArtifact('light-context-menu-open');
    await evaluate(`(() => {
      const menu = document.querySelector('.canvas-context-menu[role="menu"]');
      const qa = window.__contextMenuExitQa = { exiting: false, menu };
      const observer = new MutationObserver(() => {
        if (menu?.getAttribute('data-presence') !== 'exiting') return;
        qa.exiting = true;
        qa.animation = getComputedStyle(menu).animationName;
        qa.pointerEvents = getComputedStyle(menu).pointerEvents;
        menu.style.animationPlayState = 'paused';
        const clone = menu.cloneNode(true);
        clone.classList.add('qa-context-menu-exit-clone');
        clone.setAttribute('aria-hidden', 'true');
        clone.style.animationDelay = '-45ms';
        clone.style.animationPlayState = 'paused';
        document.body.appendChild(clone);
        qa.clone = clone;
      });
      if (menu) observer.observe(menu, { attributes: true, attributeFilter: ['data-presence'] });
      qa.disconnect = () => observer.disconnect();
    })()`);
    await client.send('Page.bringToFront');
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    // Page.captureScreenshot can temporarily take activation away from a hidden
    // Electron WebContents. Keep the native key path, then deliver the same
    // focused DOM key only when the first animation frame proves it was lost.
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => {
      if (!window.__contextMenuExitQa?.exiting) {
        const target = window.__contextMenuExitQa?.menu?.querySelector('[role="menuitem"][tabindex="0"]') || document.activeElement || document;
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      }
      requestAnimationFrame(resolve);
    }))`);
    const contextMenuExit = await waitFor(() => evaluate(`window.__contextMenuExitQa?.exiting ? { animation: window.__contextMenuExitQa.animation, pointerEvents: window.__contextMenuExitQa.pointerEvents, cloneConnected: window.__contextMenuExitQa.clone?.isConnected } : null`), 2000);
    if (contextMenuExit.animation !== 'oc-menu-out' || contextMenuExit.pointerEvents !== 'none' || !contextMenuExit.cloneConnected) throw new Error(`Context menu did not expose a non-interactive exit frame: ${JSON.stringify(contextMenuExit)}`);
    await captureVisualArtifact('light-context-menu-exit');
    await evaluate(`(() => { const qa = window.__contextMenuExitQa; qa?.menu?.style.removeProperty('animation-play-state'); qa?.clone?.remove(); qa?.disconnect?.(); delete window.__contextMenuExitQa; })()`);
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor(() => evaluate(`!document.querySelector('.canvas-context-menu[role="menu"]')`), 2000);

    await evaluate(`document.querySelector('[aria-label="平移工具"]')?.click()`);
    const panToolProfile = await waitFor(() => evaluate(`import('/src/store.ts').then(module => { const canvas = document.querySelector('.infinite-canvas'); const button = document.querySelector('[aria-label="平移工具"]'); return module.useWorkspaceStore.getState().tool === 'pan' && button?.classList.contains('active') ? { cursor: getComputedStyle(canvas).cursor, pannable: canvas.classList.contains('is-pannable') } : null; })`), 2000);
    if (!panToolProfile.pannable || panToolProfile.cursor !== 'grab') throw new Error(`Persistent pan tool lacked visible active or grab feedback: ${JSON.stringify(panToolProfile)}`);
    await evaluate(`(() => { const select = document.querySelector('[aria-label="选择工具"]'); select?.click(); select?.focus(); })()`);
    await key('h', 'KeyH', 72);
    const focusedControlShortcut = await evaluate(`import('/src/store.ts').then(module => ({ tool: module.useWorkspaceStore.getState().tool, active: document.querySelector('.canvas-toolbar button.active')?.getAttribute('aria-label') }))`);
    if (focusedControlShortcut.tool !== 'select' || focusedControlShortcut.active !== '选择工具') throw new Error(`A focused command control leaked its keypress into canvas shortcuts: ${JSON.stringify(focusedControlShortcut)}`);
    await key(' ', 'Space', 32);
    if (await evaluate(`document.querySelector('.infinite-canvas')?.classList.contains('is-pannable')`)) throw new Error('Space on a focused toolbar control incorrectly entered transient pan mode');

    await evaluate(`document.querySelector('.infinite-canvas')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: ${canvasBlank.x}, clientY: ${canvasBlank.y} }))`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.canvas-context-menu[role="menu"]'))`), 2000);
    const projectMenuActivated = await evaluate(`(() => { const button = [...document.querySelectorAll('.canvas-context-menu[role="menu"] [role="menuitem"]')].find(item => /整理为项目|查看项目目录/.test(item.textContent)); button?.click(); return Boolean(button); })()`);
    if (!projectMenuActivated) throw new Error('Canvas context menu did not expose its project command');
    await waitFor(() => evaluate(`Boolean(document.querySelector('.project-dialog[aria-modal="true"]'))`), 2000);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor(() => evaluate(`!document.querySelector('.project-dialog[aria-modal="true"]')`), 2000);

    const modalShortcutBaseline = await evaluate(`(() => { const node = document.querySelector('.canvas-node'); const rect = node?.getBoundingClientRect(); if (!node || !rect) return null; const x = rect.left + rect.width / 2; const y = rect.top + 18; node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 96, clientX: x, clientY: y })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 96, clientX: x, clientY: y })); return { id: node.getAttribute('data-placement-id') }; })()`);
    if (!modalShortcutBaseline?.id) throw new Error('No card was available for modal shortcut isolation');
    await waitFor(() => evaluate(`document.querySelector('[data-placement-id="${modalShortcutBaseline.id}"]')?.classList.contains('selected')`), 2000);
    await evaluate(`(() => { const button = document.querySelector('[aria-label="查看快捷键"]'); button?.focus(); button?.click(); })()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.shortcut-help-dialog')) && document.body.innerText.includes('临时关闭吸附')`), 2000);
    await waitFor(() => evaluate(`document.querySelector('.shortcut-help-dialog')?.contains(document.activeElement)`), 2000);
    const guideOpened = await evaluate(`(() => { const button = [...document.querySelectorAll('.shortcut-help-dialog button')].find(item => item.textContent?.includes('完整用户手册')); button?.click(); return Boolean(button); })()`);
    if (!guideOpened) throw new Error('Shortcut help did not expose the complete user manual');
    await waitFor(() => evaluate(`Boolean(document.querySelector('.user-guide-dialog')) && document.body.innerText.includes('升级、卸载与备份')`), 3000);
    const guideProfile = await evaluate(`(() => ({ searchFocused: document.activeElement?.getAttribute('aria-label') === '搜索用户手册', chapters: document.querySelectorAll('.user-guide-navigation nav button').length, contentScrollable: (document.querySelector('.user-guide-content')?.scrollHeight || 0) > (document.querySelector('.user-guide-content')?.clientHeight || 0) }))()`);
    if (!guideProfile.searchFocused || guideProfile.chapters < 20 || !guideProfile.contentScrollable) throw new Error(`Complete user manual did not render as an accessible navigable document: ${JSON.stringify(guideProfile)}`);
    await evaluate(`(() => { const input = document.querySelector('[aria-label="搜索用户手册"]'); if (!input) return; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; setter?.call(input, '备份'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor(() => evaluate(`document.querySelectorAll('.user-guide-search-results button').length > 0`), 2000);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor(() => evaluate(`!document.querySelector('.user-guide-dialog')`), 2000);
    await evaluate(`(() => { const button = document.querySelector('[aria-label="查看快捷键"]'); button?.focus(); button?.click(); })()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.shortcut-help-dialog'))`), 2000);
    await key('Delete', 'Delete', 46);
    const modalShortcutResult = await evaluate(`(() => { const node = document.querySelector('[data-placement-id="${modalShortcutBaseline.id}"]'); return { exists: Boolean(node), selected: Boolean(node?.classList.contains('selected')) }; })()`);
    if (!modalShortcutResult.exists || !modalShortcutResult.selected) throw new Error(`Delete escaped an open modal and changed the canvas: ${JSON.stringify({ modalShortcutBaseline, modalShortcutResult })}`);
    for (let index = 0; index < 12; index += 1) {
      await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: index === 11 ? 8 : 0 });
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: index === 11 ? 8 : 0 });
    }
    if (!await evaluate(`document.querySelector('.shortcut-help-dialog')?.contains(document.activeElement)`)) throw new Error('Modal focus escaped into the canvas during Tab navigation');
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor(() => evaluate(`!document.querySelector('.shortcut-help-dialog')`), 2000);
    await waitFor(() => evaluate(`document.activeElement?.getAttribute('aria-label') === '查看快捷键'`), 2000);
    progress('context-menu keyboard navigation, pan feedback, modal shortcut isolation, Escape dismissal, and focus restoration passed');

    const selectOnlyActivated = await evaluate(`(() => { const node = document.querySelector('.canvas-node.node-note'); const rect = node?.getBoundingClientRect(); if (!node || !rect) return false; const x = rect.left + rect.width / 2; const y = rect.top + 18; node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 91, clientX: x, clientY: y })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 91, clientX: x, clientY: y })); return true; })()`);
    if (!selectOnlyActivated) throw new Error('Card selection surface was not rendered');
    await waitFor(() => evaluate(`Boolean(document.querySelector('.canvas-node.selected .card-selection-toolbar'))`), 2000);
    const selectOnlyProfile = await waitFor(() => evaluate(`(() => { const selected = document.querySelector('.canvas-node.selected'); const activeTool = document.querySelector('.canvas-toolbar button.active'); const style = selected && getComputedStyle(selected); const outline = selected && getComputedStyle(selected, '::after'); const profile = { selected: document.querySelectorAll('.canvas-node.selected').length, editors: document.querySelectorAll('.canvas-node [contenteditable="true"]').length, editing: document.querySelectorAll('.canvas-node.card-editing').length, border: style?.borderColor, borderWidth: style?.borderTopWidth, outline: outline?.boxShadow, outlineOpacity: outline?.opacity, accent: activeTool && getComputedStyle(activeTool).color, activeTool: activeTool?.getAttribute('aria-label') }; return profile.selected === 1 && profile.editors === 0 && profile.editing === 0 && parseFloat(profile.borderWidth || '0') > 0 && profile.outline && profile.outline !== 'none' && profile.outlineOpacity === '1' && profile.activeTool ? profile : null; })()`), 3000);
    if (selectOnlyProfile.selected !== 1 || selectOnlyProfile.editors !== 0 || selectOnlyProfile.editing !== 0 || selectOnlyProfile.outline === 'none' || selectOnlyProfile.outlineOpacity !== '1' || !selectOnlyProfile.activeTool) throw new Error(`Top selection surface entered editing or lost its visible selection outline: ${JSON.stringify(selectOnlyProfile)}`);
    const selectionExtremeZoom = await evaluate(`import('/src/store.ts').then(async module => {
      const store = module.useWorkspaceStore;
      const state = store.getState();
      const board = state.boards.find(item => item.id === state.activeBoardId);
      const placementId = state.selection?.kind === 'placement' ? state.selection.id : null;
      const placement = board?.placements.find(item => item.id === placementId);
      const canvas = document.querySelector('.infinite-canvas');
      const rect = canvas?.getBoundingClientRect();
      if (!board || !placement || !rect) return null;
      const original = { ...board.viewport };
      const center = { x: placement.x + placement.width / 2, y: placement.y + placement.height / 2 };
      const samples = [];
      for (const zoom of [.2, 2.4]) {
        store.getState().setViewport({ zoom, x: rect.width / 2 - center.x * zoom, y: rect.height / 2 - center.y * zoom });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const selected = document.querySelector('.canvas-node.selected');
        const outline = selected && getComputedStyle(selected, '::after');
        const spread = outline?.boxShadow.match(/0px 0px 0px ([0-9.]+)px/)?.[1];
        samples.push({ zoom, worldWidth: parseFloat(spread || '0'), screenWidth: parseFloat(spread || '0') * zoom, opacity: outline?.opacity, shadow: outline?.boxShadow });
      }
      store.getState().setViewport(original);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { samples, original, restored: store.getState().boards.find(item => item.id === board.id)?.viewport };
    })`);
    if (!selectionExtremeZoom || selectionExtremeZoom.samples.some(sample => sample.screenWidth < 1.9 || sample.screenWidth > 2.5 || sample.opacity !== '1') || JSON.stringify(selectionExtremeZoom.restored) !== JSON.stringify(selectionExtremeZoom.original)) throw new Error(`Selection outline changed thickness or lagged at extreme zoom: ${JSON.stringify(selectionExtremeZoom)}`);

    const editableActivated = await evaluate(`(() => { const body = document.querySelector('.canvas-node .card-markdown-preview'); const rect = body?.getBoundingClientRect(); if (!body || !rect) return false; body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 92, clientX: rect.left + 70, clientY: rect.top + 45 })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 92, clientX: rect.left + 70, clientY: rect.top + 45 })); return true; })()`);
    if (!editableActivated) throw new Error('Lightweight Markdown preview was not rendered');
    await waitFor(() => evaluate(`document.querySelectorAll('.structured-card-editor').length === 1`), 3000);
    const editorProfile = await waitFor(() => evaluate(`(() => { const editing = document.querySelector('.canvas-node.card-editing'); const style = editing && getComputedStyle(editing); const outline = editing && getComputedStyle(editing, '::after'); const profile = { editors: document.querySelectorAll('.structured-card-editor').length, nodes: document.querySelectorAll('.canvas-node').length, border: style?.borderColor, outline: outline?.boxShadow }; return profile.editors === 1 && profile.outline && profile.outline !== ${JSON.stringify(selectOnlyProfile?.outline)} ? profile : null; })()`), 3000);
    if (editorProfile.editors !== 1 || editorProfile.nodes > 100 || editorProfile.outline === selectOnlyProfile.outline) throw new Error(`Lazy editor activation, culling, or neutral editing outline regressed: ${JSON.stringify({ editorProfile, selectOnlyProfile })}`);
    const titleComposition = await evaluate(`(() => { const title = document.querySelector('.canvas-node .card-inline-title'); if (!title) return null; title.focus(); const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, isComposing: true }); title.dispatchEvent(event); return { titleStillFocused: document.activeElement === title, prevented: event.defaultPrevented }; })()`);
    if (!titleComposition?.titleStillFocused || titleComposition.prevented) throw new Error(`Composing Enter prematurely completed the card title: ${JSON.stringify(titleComposition)}`);
    const editorInsertPoint = await evaluate(`(() => { const editor = document.querySelector('.structured-card-editor [contenteditable="true"]'); const rect = editor?.getBoundingClientRect(); if (!editor || !rect) return null; const maxX = Math.min(innerWidth - 8, rect.right - 8); const maxY = Math.min(innerHeight - 8, rect.bottom - 8); for (let y = Math.max(8, rect.top + 8); y <= maxY; y += 18) for (let x = Math.max(256, rect.left + 12); x <= maxX; x += 24) if (document.elementFromPoint(x, y)?.closest('[contenteditable="true"]') === editor) return { x, y }; const x = rect.left + Math.min(70, rect.width / 2); const y = rect.top + Math.min(55, rect.height / 2); return { x, y, hit: document.elementFromPoint(x, y)?.className || 'none' }; })()`);
    if (!editorInsertPoint) throw new Error('Editable card body did not expose a caret target');
    if (editorInsertPoint.hit) throw new Error(`Editable card body was fully occluded at drag-and-drop time: ${JSON.stringify(editorInsertPoint)}`);
    const largeDragData = { items: [], files: [largeAttachmentPath], dragOperationsMask: 1 };
    await client.send('Input.dispatchDragEvent', { type: 'dragEnter', x: editorInsertPoint.x, y: editorInsertPoint.y, data: largeDragData });
    await client.send('Input.dispatchDragEvent', { type: 'dragOver', x: editorInsertPoint.x, y: editorInsertPoint.y, data: largeDragData });
    await client.send('Input.dispatchDragEvent', { type: 'drop', x: editorInsertPoint.x, y: editorInsertPoint.y, data: largeDragData });
    const largeAttachment = await waitFor(() => evaluate(`window.openCanvasVault.listAttachments().then(entries => entries.find(entry => entry.name.startsWith('large-drop--') && entry.size === 32 * 1024 * 1024))`), 20000);
    if (!largeAttachment) throw new Error('Large drag-and-drop attachment did not use the native path-copy channel');
    await waitFor(() => evaluate(`document.querySelector('.structured-card-editor [contenteditable="true"]')?.innerHTML.includes('large-drop.bin')`), 3000);
    progress('32 MB drag-and-drop attachment copied without renderer Base64 buffering');
    const editorCaretReady = await evaluate(`(() => { const editor = document.querySelector('.structured-card-editor [contenteditable="true"]'); if (!editor) return false; const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); editor.focus(); return selection.rangeCount === 1 && document.activeElement === editor; })()`);
    if (!editorCaretReady) throw new Error('Could not restore the editor caret after the large attachment changed document geometry');
    // A leading space makes the slash trigger independent of the activation caret's
    // exact paragraph position while still exercising the real input/update path.
    await client.send('Input.insertText', { text: ' /' });
    try {
      await waitFor(() => evaluate(`Boolean(document.querySelector('.editor-command-menu'))`), 2000);
    } catch (error) {
      const slashDebug = await evaluate(`(() => { const editor = document.querySelector('.structured-card-editor [contenteditable="true"]'); return { active: document.activeElement === editor, text: editor?.textContent?.slice(-80), html: editor?.innerHTML?.slice(-240), editors: document.querySelectorAll('.structured-card-editor').length, menus: document.querySelectorAll('.editor-command-menu').length }; })()`);
      throw new Error(`Slash command menu did not open: ${JSON.stringify(slashDebug)} (${error.message})`);
    }
    const lightCommandMenuStyle = await evaluate(`(() => { const menu = document.querySelector('.editor-command-menu'); const active = menu?.querySelector('button.active'); if (!menu || !active) return null; const menuStyle = getComputedStyle(menu); const activeStyle = getComputedStyle(active); return { theme: document.querySelector('.app-shell')?.getAttribute('data-theme'), menuBackground: menuStyle.backgroundColor, activeBackground: activeStyle.backgroundColor, activeColor: activeStyle.color, activeShadow: activeStyle.boxShadow }; })()`);
    if (!lightCommandMenuStyle || lightCommandMenuStyle.theme !== 'light' || lightCommandMenuStyle.activeBackground === 'rgb(58, 59, 64)' || lightCommandMenuStyle.activeBackground === 'rgba(0, 0, 0, 0)' || lightCommandMenuStyle.activeColor === lightCommandMenuStyle.activeBackground || !lightCommandMenuStyle.activeShadow.includes('inset')) throw new Error(`Light-theme slash command active state lost theme contrast: ${JSON.stringify(lightCommandMenuStyle)}`);
    const compositionMenuStayedOpen = await evaluate(`(() => { const editor = document.querySelector('.structured-card-editor [contenteditable="true"]'); if (!editor) return false; editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' })); editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, isComposing: true })); const stayedOpen = Boolean(document.querySelector('.editor-command-menu')); editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' })); return stayedOpen; })()`);
    if (!compositionMenuStayedOpen) throw new Error('Composing Enter selected a slash command before the IME committed its text');
    await evaluate(`(() => { const menu = document.querySelector('.editor-command-menu'); const qa = window.__editorMenuExitQa = { exiting: false }; const observer = new MutationObserver(() => { if (menu?.getAttribute('data-presence') === 'exiting') { qa.exiting = true; qa.animation = getComputedStyle(menu).animationName; qa.pointerEvents = getComputedStyle(menu).pointerEvents; } }); if (menu) observer.observe(menu, { attributes: true, attributeFilter: ['data-presence'] }); qa.disconnect = () => observer.disconnect(); })()`);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    const editorMenuExit = await waitFor(() => evaluate(`window.__editorMenuExitQa?.exiting ? window.__editorMenuExitQa : null`), 1000);
    await evaluate(`window.__editorMenuExitQa?.disconnect?.(); delete window.__editorMenuExitQa`);
    if (editorMenuExit.animation !== 'oc-menu-out' || editorMenuExit.pointerEvents !== 'none') throw new Error(`Editor command menu did not use the shared exit motion: ${JSON.stringify(editorMenuExit)}`);
    await waitFor(() => evaluate(`!document.querySelector('.editor-command-menu') && document.activeElement === document.querySelector('.structured-card-editor [contenteditable="true"]')`), 2000);
    await client.send('Input.insertText', { text: ' /' });
    await waitFor(() => evaluate(`Boolean(document.querySelector('.editor-command-menu'))`), 2000);
    await delay(80);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await waitFor(() => evaluate(`!document.querySelector('.editor-command-menu') && Boolean(document.querySelector('.structured-card-editor h1'))`), 2000);
    await delay(650);
    const richUndoBefore = await evaluate(`import('/src/store.ts').then(module => { const state = module.useWorkspaceStore.getState(); const editor = document.querySelector('.structured-card-editor [contenteditable="true"]'); const placement = document.querySelector('.canvas-node.card-editing')?.getAttribute('data-placement-id'); const entityId = state.boards.find(board => board.id === state.activeBoardId)?.placements.find(item => item.id === placement)?.entityId; return { body: state.cards.find(card => card.id === entityId)?.body, historyPast: state.commandHistory.past.length, historyFuture: state.commandHistory.future.length, text: editor?.textContent }; })`);
    const crossBlockSelected = await evaluate(`(() => { const editor = document.querySelector('.structured-card-editor [contenteditable="true"]'); if (!editor) return false; const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT); const texts = []; while (walker.nextNode()) if (walker.currentNode.textContent) texts.push(walker.currentNode); if (texts.length < 2) return false; const range = document.createRange(); range.setStart(texts[0], 0); range.setEnd(texts.at(-1), texts.at(-1).textContent.length); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); editor.focus(); return selection.toString().length > 0; })()`);
    if (!crossBlockSelected) throw new Error('Could not create a cross-block rich-text selection');
    await client.send('Input.insertText', { text: '跨段撤销边界验证' });
    await waitFor(() => evaluate(`document.querySelector('.structured-card-editor [contenteditable="true"]')?.textContent.includes('跨段撤销边界验证')`), 2000);
    const synchronizedPreviews = await waitFor(() => evaluate(`[...document.querySelectorAll('.canvas-node .card-markdown-preview')].filter(preview => preview.textContent.includes('跨段撤销边界验证')).length`), 2000);
    if (synchronizedPreviews < 1) throw new Error('Shared card instances did not update while another placement was being edited');
    const richUndoDuring = await evaluate(`import('/src/store.ts').then(module => ({ historyPast: module.useWorkspaceStore.getState().commandHistory.past.length, historyFuture: module.useWorkspaceStore.getState().commandHistory.future.length }))`);
    if (richUndoDuring.historyPast !== richUndoBefore.historyPast || richUndoDuring.historyFuture !== richUndoBefore.historyFuture) throw new Error(`Rich-text edit leaked into canvas command history: ${JSON.stringify({ richUndoBefore, richUndoDuring })}`);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
    await waitFor(() => evaluate(`!document.querySelector('.structured-card-editor [contenteditable="true"]')?.textContent.includes('跨段撤销边界验证')`), 2000);
    await waitFor(() => evaluate(`![...document.querySelectorAll('.canvas-node .card-markdown-preview')].some(preview => preview.textContent.includes('跨段撤销边界验证'))`), 2000);
    const richUndoRestored = await evaluate(`import('/src/store.ts').then(module => { const state = module.useWorkspaceStore.getState(); const placement = document.querySelector('.canvas-node.card-editing')?.getAttribute('data-placement-id'); const entityId = state.boards.find(board => board.id === state.activeBoardId)?.placements.find(item => item.id === placement)?.entityId; return { body: state.cards.find(card => card.id === entityId)?.body, historyPast: state.commandHistory.past.length, historyFuture: state.commandHistory.future.length }; })`);
    if (richUndoRestored.body !== richUndoBefore.body || richUndoRestored.historyPast !== richUndoBefore.historyPast || richUndoRestored.historyFuture !== richUndoBefore.historyFuture) throw new Error(`Editor undo did not restore content locally: ${JSON.stringify({ richUndoBefore, richUndoRestored })}`);
    await evaluate(`document.querySelector('[aria-label="展开卡片"]')?.click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.note-page .card-prosemirror'))`), 3000);
    const noteTextSelected = await evaluate(`(() => { const editor = document.querySelector('.note-page .card-prosemirror')?.editor; if (!editor || editor.isDestroyed) return false; const to = Math.min(editor.state.doc.content.size, 5); if (to <= 1) return false; editor.chain().focus().setTextSelection({ from: 1, to }).run(); return !editor.state.selection.empty; })()`);
    if (!noteTextSelected) throw new Error('Could not create the full-page text selection for the contextual toolbar');
    await waitFor(() => evaluate(`Boolean(document.querySelector('.note-page .editor-bubble-menu [title="链接"]'))`), 3000);
    await evaluate(`document.querySelector('.note-page .editor-bubble-menu [title="链接"]')?.click()`);
    const linkPopover = await waitFor(() => evaluate(`(() => { const popover = document.querySelector('.editor-link-popover'); const input = popover?.querySelector('input[aria-label="链接地址"]'); if (!popover || !input) return null; const rect = popover.getBoundingClientRect(); return { position: getComputedStyle(popover).position, visible: rect.width > 0 && rect.height > 0, insideViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight }; })()`), 2000);
    if (!linkPopover.visible || !linkPopover.insideViewport || linkPopover.position !== 'absolute') throw new Error(`Inline link popover layout regressed: ${JSON.stringify(linkPopover)}`);
    await waitFor(() => evaluate(`document.activeElement?.getAttribute('aria-label') === '链接地址'`), 2000);
    await evaluate(`(() => { const popover = document.querySelector('.editor-link-popover'); const qa = window.__linkPopoverExitQa = { exiting: false }; const observer = new MutationObserver(() => { if (popover?.getAttribute('data-presence') === 'exiting') { qa.exiting = true; qa.animation = getComputedStyle(popover).animationName; qa.pointerEvents = getComputedStyle(popover).pointerEvents; } }); if (popover) observer.observe(popover, { attributes: true, attributeFilter: ['data-presence'] }); qa.disconnect = () => observer.disconnect(); })()`);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    const linkPopoverExit = await waitFor(() => evaluate(`window.__linkPopoverExitQa?.exiting ? window.__linkPopoverExitQa : null`), 1000);
    await evaluate(`window.__linkPopoverExitQa?.disconnect?.(); delete window.__linkPopoverExitQa`);
    if (linkPopoverExit.animation !== 'oc-menu-out' || linkPopoverExit.pointerEvents !== 'none') throw new Error(`Inline link popover did not use the shared exit motion: ${JSON.stringify(linkPopoverExit)}`);
    await waitFor(() => evaluate(`!document.querySelector('.editor-link-popover') && Boolean(document.querySelector('.note-page'))`), 2000);
    const editorToolbarAccessibility = await evaluate(`(() => { const toolbar = document.querySelector('.note-page .editor-bubble-menu'); const buttons = [...(toolbar?.querySelectorAll(':scope > button, :scope > span > button') || [])]; return { permanentToolbar: Boolean(document.querySelector('.note-page .editor-format-bar')), count: buttons.length, unnamed: buttons.filter(button => !button.getAttribute('aria-label')).length, sourceButton: Boolean(toolbar?.querySelector('[aria-label="Markdown 源码模式"]')), blockButton: Boolean(toolbar?.querySelector('[aria-label="转换块类型"]')) }; })()`);
    if (editorToolbarAccessibility.permanentToolbar || !editorToolbarAccessibility.sourceButton || !editorToolbarAccessibility.blockButton || editorToolbarAccessibility.count < 10 || editorToolbarAccessibility.unnamed) throw new Error(`Contextual editor toolbar lost accessible names or became permanently pinned: ${JSON.stringify(editorToolbarAccessibility)}`);
    await evaluate(`document.querySelector('.note-page [aria-label="转换块类型"]')?.click()`);
    const blockMenuProfile = await waitFor(() => evaluate(`(() => { const menu = document.querySelector('.note-page .editor-block-menu'); if (!menu) return null; return { items: menu.querySelectorAll('[role="menuitemradio"]').length, checked: menu.querySelectorAll('[aria-checked="true"]').length, trigger: document.querySelector('.note-page [aria-label="转换块类型"]')?.textContent?.trim() }; })()`), 2000);
    const coherentBlockSelection = blockMenuProfile.checked === 1 || (blockMenuProfile.checked === 0 && blockMenuProfile.trigger?.includes('多种格式'));
    if (blockMenuProfile.items < 11 || !coherentBlockSelection) throw new Error(`Editor block conversion menu is incomplete: ${JSON.stringify(blockMenuProfile)}`);
    await evaluate(`document.querySelector('.note-page [aria-label="转换块类型"]')?.click()`);
    await evaluate(`(() => { const block = document.querySelector('.note-page .card-prosemirror')?.firstElementChild; const rect = block?.getBoundingClientRect(); if (!block || !rect) return false; block.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: rect.left + 8, clientY: rect.top + Math.min(8, rect.height / 2) })); return true; })()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.editor-block-drag-handle'))`), 2000);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.note-page .editor-bubble-menu [title="Markdown 源码模式"]'))`), 2000);
    await evaluate(`document.querySelector('.note-page .editor-bubble-menu [title="Markdown 源码模式"]')?.click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.note-page textarea[aria-label="Markdown 源码"]'))`), 2000);
    const sourceSurfaceAnimation = await evaluate(`getComputedStyle(document.querySelector('.note-page textarea[aria-label="Markdown 源码"]')).animationName`);
    if (sourceSurfaceAnimation !== 'oc-editor-surface-in') throw new Error(`Markdown source surface changed abruptly: ${sourceSurfaceAnimation}`);
    await evaluate(`document.querySelector('.note-page [title="返回所见即所得编辑"]')?.click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.note-page .card-prosemirror')) && !document.querySelector('.note-page textarea[aria-label="Markdown 源码"]')`), 2000);
    const visualSurfaceAnimation = await evaluate(`getComputedStyle(document.querySelector('.note-page .card-prosemirror')).animationName`);
    if (visualSurfaceAnimation !== 'oc-editor-surface-in') throw new Error(`Visual editor surface changed abruptly: ${visualSurfaceAnimation}`);
    await evaluate(`document.querySelector('.note-page-topbar button')?.click()`);
    await waitFor(() => evaluate(`!document.querySelector('.note-page')`), 3000);
    await evaluate(`document.querySelector('.canvas-node.selected [aria-label="展开右侧栏"]')?.click()`);
    await waitFor(() => evaluate(`document.querySelector('.card-side-panel')?.getAttribute('aria-hidden') === 'false'`), 3000);
    await evaluate(`void import('/src/store.ts').then(module => module.useWorkspaceStore.getState().openCardInSidePanel('scrolling-card'))`);
    await waitFor(() => evaluate(`document.querySelector('.card-side-panel-title')?.value === '滚轮路由边界验证'`), 3000);
    await waitFor(() => evaluate(`(() => { const panel = document.querySelector('.card-side-panel-document'); return Boolean(panel?.querySelector('.card-prosemirror')) && panel.scrollHeight - panel.clientHeight >= 60; })()`), 5000);
    const panelContinuityStart = await evaluate(`(() => { const panel = document.querySelector('.card-side-panel-document'); if (!panel) return null; const maximum = Math.max(0, panel.scrollHeight - panel.clientHeight); panel.scrollTop = Math.min(180, maximum); panel.dispatchEvent(new Event('scroll', { bubbles: true })); return { scrollTop: panel.scrollTop, maximum, selection: null }; })()`);
    if (!panelContinuityStart || panelContinuityStart.maximum < 60 || panelContinuityStart.scrollTop < 50) throw new Error(`Side-panel fixture could not establish a meaningful reading position: ${JSON.stringify(panelContinuityStart)}`);
    const panelToPageMotion = await evaluate(`new Promise(resolve => { document.querySelector('.card-side-panel [aria-label="展开卡片"]')?.click(); requestAnimationFrame(() => requestAnimationFrame(() => { const page = document.querySelector('.note-page'); const documentPane = page?.querySelector('.note-page-document'); const panel = document.querySelector('.card-side-panel'); resolve({ pageClass: page?.className, pageAnimation: page && getComputedStyle(page).animationName, contentAnimation: documentPane && getComputedStyle(documentPane).animationName, clipPath: page && getComputedStyle(page).clipPath, panelClass: panel?.className, panelHidden: panel?.getAttribute('aria-hidden'), panelDocumentMounted: Boolean(panel?.querySelector('.card-side-panel-document')) }); })); })`);
    if (!panelToPageMotion.pageClass?.includes('note-page-from-side-panel') || panelToPageMotion.pageAnimation !== 'oc-page-from-side-panel' || panelToPageMotion.contentAnimation !== 'oc-page-content-from-side' || panelToPageMotion.clipPath === 'none' || panelToPageMotion.panelHidden !== 'true' || !panelToPageMotion.panelClass?.includes('card-side-panel-collapsed') || !panelToPageMotion.panelDocumentMounted) throw new Error(`Side-panel to page transition lost spatial continuity: ${JSON.stringify(panelToPageMotion)}`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.note-page .card-prosemirror'))`), 3000);
    const pageContinuity = await waitFor(() => evaluate(`(() => { const page = document.querySelector('.note-page-document'); const active = document.activeElement; if (!page || Math.abs(page.scrollTop - ${panelContinuityStart.scrollTop}) > 2 || active?.getAttribute('aria-label') !== '返回右侧栏') return null; const maximum = Math.max(0, page.scrollHeight - page.clientHeight); const nextScrollTop = Math.min(maximum, page.scrollTop + 120); page.scrollTop = nextScrollTop; page.dispatchEvent(new Event('scroll', { bubbles: true })); return { entryScrollTop: ${panelContinuityStart.scrollTop}, exitScrollTop: page.scrollTop, maximum, activeLabel: active.getAttribute('aria-label') }; })()`), 3000);
    if (!pageContinuity || pageContinuity.exitScrollTop <= pageContinuity.entryScrollTop) throw new Error(`Side-panel reading position or entry focus did not carry into the full editor: ${JSON.stringify(pageContinuity)}`);
    const pageToPanelMotion = await evaluate(`new Promise(resolve => { const page = document.querySelector('.note-page'); if (!page) return resolve({ missing: true }); const capture = () => { const documentPane = page.querySelector('.note-page-document'); resolve({ closing: page.classList.contains('is-closing'), pageAnimation: getComputedStyle(page).animationName, contentAnimation: documentPane && getComputedStyle(documentPane).animationName, panelHidden: document.querySelector('.card-side-panel')?.getAttribute('aria-hidden') }); }; const observer = new MutationObserver(() => { if (page.classList.contains('is-closing')) { observer.disconnect(); capture(); } }); observer.observe(page, { attributes: true, attributeFilter: ['class'] }); document.querySelector('.note-page-topbar button')?.click(); if (page.classList.contains('is-closing')) { observer.disconnect(); capture(); } })`);
    if (!pageToPanelMotion.closing || pageToPanelMotion.pageAnimation !== 'oc-page-to-side-panel' || pageToPanelMotion.contentAnimation !== 'oc-page-content-to-side' || pageToPanelMotion.panelHidden !== 'false') throw new Error(`Page to side-panel transition lost spatial continuity: ${JSON.stringify(pageToPanelMotion)}`);
    await waitFor(() => evaluate(`!document.querySelector('.note-page')`), 3000);
    await delay(180);
    const returnedPanelContinuity = await evaluate(`import('/src/store.ts').then(module => { const panel = document.querySelector('.card-side-panel-document'); const active = document.activeElement; const state = module.useWorkspaceStore.getState(); return { scrollTop: panel?.scrollTop, expectedScrollTop: ${pageContinuity.exitScrollTop}, scrollDifference: panel ? Math.abs(panel.scrollTop - ${pageContinuity.exitScrollTop}) : null, activeLabel: active?.getAttribute('aria-label'), activeClass: active?.className, panelHidden: document.querySelector('.card-side-panel')?.getAttribute('aria-hidden'), panelCardId: state.sidePanelCardId, panelOpen: state.sidePanelOpen }; })`);
    if (returnedPanelContinuity.scrollDifference === null || returnedPanelContinuity.scrollDifference > 2 || returnedPanelContinuity.activeLabel !== '展开卡片' || returnedPanelContinuity.panelHidden !== 'false' || returnedPanelContinuity.panelCardId !== 'scrolling-card' || !returnedPanelContinuity.panelOpen) throw new Error(`Full editor did not restore its current reading position and keyboard focus to the side panel: ${JSON.stringify(returnedPanelContinuity)}`);
    const interruptedPanelTransitions = await evaluate(`(async () => {
      let peakPages = 0;
      let peakPageEditors = 0;
      for (let index = 0; index < 6; index += 1) {
        document.querySelector('.card-side-panel [aria-label="展开卡片"]')?.click();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        peakPages = Math.max(peakPages, document.querySelectorAll('.note-page').length);
        peakPageEditors = Math.max(peakPageEditors, document.querySelectorAll('.note-page .structured-card-editor').length);
        document.querySelector('.note-page-topbar button')?.click();
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      await new Promise(resolve => setTimeout(resolve, 360));
      const state = (await import('/src/store.ts')).useWorkspaceStore.getState();
      return {
        peakPages,
        peakPageEditors,
        pages: document.querySelectorAll('.note-page').length,
        panelHidden: document.querySelector('.card-side-panel')?.getAttribute('aria-hidden'),
        panelDocuments: document.querySelectorAll('.card-side-panel-document').length,
        pageEditors: document.querySelectorAll('.note-page .structured-card-editor').length,
        focusedCardId: state.focusedCardId,
        focusTransitionSource: state.focusTransitionSource,
        sidePanelOpen: state.sidePanelOpen,
      };
    })()`);
    if (interruptedPanelTransitions.peakPages !== 1 || interruptedPanelTransitions.peakPageEditors !== 1 || interruptedPanelTransitions.pages || interruptedPanelTransitions.panelHidden !== 'false' || interruptedPanelTransitions.panelDocuments !== 1 || interruptedPanelTransitions.pageEditors || interruptedPanelTransitions.focusedCardId || interruptedPanelTransitions.focusTransitionSource || !interruptedPanelTransitions.sidePanelOpen) throw new Error(`Interrupted side-panel/page transitions leaked visual or editor state: ${JSON.stringify(interruptedPanelTransitions)}`);
    await evaluate(`document.querySelector('.card-side-panel [aria-label="关闭卡片侧栏"]')?.click()`);
    await waitFor(() => evaluate(`document.querySelector('.card-side-panel')?.getAttribute('aria-hidden') === 'true'`), 3000);
    await evaluate(`(() => { const canvas = document.querySelector('.infinite-canvas'); canvas?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 93, clientX: ${blankPoint.x}, clientY: ${blankPoint.y} })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 93, clientX: ${blankPoint.x}, clientY: ${blankPoint.y} })); })()`);
    await waitFor(() => evaluate(`document.querySelectorAll('.structured-card-editor').length === 0`), 3000);
    progress('wheel zoom, lazy editor, IME guards, local rich-text undo, inline link popover, keyboard command menu, and interrupted panel/page transitions passed');

    await evaluate(`document.querySelector('.vault-status-button')?.focus()`);
    await key('k', 'KeyK', 75, 2);
    const quickOpenProfile = await waitFor(() => evaluate(`(() => {
      const dialog = document.querySelector('.quick-open-dialog');
      const input = dialog?.querySelector('input[role="combobox"]');
      const list = dialog?.querySelector('[role="listbox"]');
      const activeId = input?.getAttribute('aria-activedescendant');
      return dialog && input && list && document.activeElement === input && activeId ? {
        controls: input.getAttribute('aria-controls'),
        listId: list.id,
        activeExists: Boolean(document.getElementById(activeId)),
        resultCount: list.querySelectorAll('[role="option"]').length,
        firstBadge: list.querySelector('.quick-open-result-badge')?.textContent,
      } : null;
    })()`), 3000);
    if (quickOpenProfile.controls !== quickOpenProfile.listId || !quickOpenProfile.activeExists || quickOpenProfile.resultCount < 20 || !quickOpenProfile.firstBadge) throw new Error(`Quick open semantics or recent-content presentation regressed: ${JSON.stringify(quickOpenProfile)}`);
    await evaluate(`(() => { const input = document.querySelector('.quick-open-dialog input'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, '批量文件'); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '批量文件' })); })()`);
    await waitFor(() => evaluate(`document.querySelectorAll('.quick-open-results [role="option"]').length === 40`), 3000);
    await key('End', 'End', 35);
    const quickOpenEnd = await waitFor(() => evaluate(`(() => {
      const input = document.querySelector('.quick-open-dialog input');
      const list = document.querySelector('.quick-open-results');
      const active = document.getElementById(input?.getAttribute('aria-activedescendant'));
      if (!list || !active) return null;
      const listRect = list.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      return { text: active.textContent, visible: activeRect.top >= listRect.top - 1 && activeRect.bottom <= listRect.bottom + 1, scrollTop: list.scrollTop };
    })()`), 3000);
    if (!quickOpenEnd.visible || quickOpenEnd.scrollTop < 200) throw new Error(`Quick open keyboard navigation did not reveal the active result: ${JSON.stringify(quickOpenEnd)}`);
    await evaluate(`document.querySelector('.quick-open-results [role="option"]')?.focus()`);
    await evaluate(`(() => { const backdrop = document.querySelector('.quick-open-backdrop'); window.__quickOpenExitQa = null; window.__quickOpenExitObserver = new MutationObserver(() => { if (backdrop?.getAttribute('data-presence') !== 'exiting') return; const dialog = backdrop.querySelector('.quick-open-dialog'); window.__quickOpenExitQa = { backdropAnimation: getComputedStyle(backdrop).animationName, dialogAnimation: dialog && getComputedStyle(dialog).animationName, pointerEvents: getComputedStyle(backdrop).pointerEvents, stillMounted: Boolean(dialog), focusRestoredEarly: document.activeElement?.classList.contains('vault-status-button') }; }); if (backdrop) window.__quickOpenExitObserver.observe(backdrop, { attributes: true, attributeFilter: ['data-presence'] }); })()`);
    await key('Escape', 'Escape', 27);
    const quickOpenExit = await waitFor(() => evaluate(`window.__quickOpenExitQa`), 1000);
    await evaluate(`window.__quickOpenExitObserver?.disconnect(); delete window.__quickOpenExitObserver; delete window.__quickOpenExitQa`);
    if (quickOpenExit.backdropAnimation !== 'oc-backdrop-out' || quickOpenExit.dialogAnimation !== 'oc-dialog-out' || quickOpenExit.pointerEvents !== 'none' || !quickOpenExit.stillMounted || quickOpenExit.focusRestoredEarly) throw new Error(`Quick open did not preserve a non-interactive exit transition before restoring focus: ${JSON.stringify(quickOpenExit)}`);
    await waitFor(() => evaluate(`!document.querySelector('.quick-open-dialog') && document.activeElement?.classList.contains('vault-status-button')`), 2000);
    await key('k', 'KeyK', 75, 2);
    await waitFor(() => evaluate(`(() => { const input = document.querySelector('.quick-open-dialog input'); return Boolean(input && document.activeElement === input); })()`), 2000);
    await evaluate(`(() => { const input = document.querySelector('.quick-open-dialog input'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, '批量文件 4999'); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '批量文件 4999' })); })()`);
    await waitFor(() => evaluate(`document.querySelector('.quick-open-results [role="option"]')?.textContent.includes('批量文件 4999')`), 3000);
    await key('Enter', 'Enter', 13);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.note-page'))`), 3000);
    await waitFor(() => evaluate(`!document.querySelector('.quick-open-dialog')`), 3000);
    await evaluate(`document.querySelector('.note-page-topbar button')?.click()`);
    await waitFor(() => evaluate(`!document.querySelector('.note-page')`), 3000);
    progress('quick open recent items, ARIA semantics, toggle focus restoration, and 5000-card keyboard navigation passed');

    await evaluate(`(() => { const node = document.querySelector('.canvas-node'); const rect = node?.getBoundingClientRect(); if (!node || !rect) return false; node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: rect.left + 30, clientY: rect.top + 20 })); return true; })()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.canvas-context-menu'))`), 2000);
    const boardSwitchProfile = await evaluate(`import('/src/store.ts').then(async module => {
      const store = module.useWorkspaceStore;
      const original = store.getState().activeBoardId;
      const first = store.getState().createBoard('快速切换甲');
      const second = store.getState().createBoard('快速切换乙');
      const empty = store.getState().createBoard('空白引导验收');
      for (let index = 0; index < 24; index += 1) {
        store.getState().openBoard(index % 2 ? first.id : second.id);
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      store.getState().openBoard(original);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const state = store.getState();
      return { original, first: first.id, second: second.id, empty: empty.id, active: state.activeBoardId, selection: state.selection, tool: state.tool, history: state.boardHistory };
    })`, 60000);
    const boardSwitchUi = await evaluate(`({ title: document.querySelector('[aria-label="白板名称"]')?.value, menus: document.querySelectorAll('.canvas-context-menu, .connector-menu').length, editors: document.querySelectorAll('.structured-card-editor').length, selected: document.querySelectorAll('.canvas-node.selected').length, drafts: document.querySelectorAll('.edge-draft').length })`);
    if (boardSwitchProfile.active !== boardSwitchProfile.original || boardSwitchProfile.selection || boardSwitchProfile.tool !== 'select' || boardSwitchProfile.history.length || boardSwitchUi.title !== '五千节点白板' || boardSwitchUi.menus || boardSwitchUi.editors || boardSwitchUi.selected || boardSwitchUi.drafts) throw new Error(`Rapid board switching leaked transient UI state: ${JSON.stringify({ boardSwitchProfile, boardSwitchUi })}`);
    progress('24-frame rapid board switching preserved navigation and cleared transient interaction state');

    await evaluate(`void import('/src/store.ts').then(module => module.useWorkspaceStore.getState().openBoard(${JSON.stringify(boardSwitchProfile.empty)}))`);
    const emptyBoardProfile = await waitFor(() => evaluate(`(() => { const hint = document.querySelector('.empty-board-hint'); const buttons = [...(hint?.querySelectorAll('button') || [])]; const rect = hint?.getBoundingClientRect(); return hint && buttons.length === 2 && rect ? { labels: buttons.map(button => button.textContent.trim()), width: rect.width, inside: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 58 && rect.bottom <= innerHeight } : null; })()`), 2000);
    if (!emptyBoardProfile.inside || emptyBoardProfile.width > 380 || !emptyBoardProfile.labels.includes('新建卡片') || !emptyBoardProfile.labels.includes('嵌套白板')) throw new Error(`Empty board onboarding was not compact and actionable: ${JSON.stringify(emptyBoardProfile)}`);
    await evaluate(`document.querySelector('.empty-board-actions button')?.click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.canvas-node.node-note')) && !document.querySelector('.empty-board-hint')`), 3000);
    await evaluate(`void import('/src/store.ts').then(module => module.useWorkspaceStore.getState().openBoard(${JSON.stringify(boardSwitchProfile.original)}))`);
    await waitFor(() => evaluate(`document.querySelector('[aria-label="白板名称"]')?.value === '五千节点白板'`), 2000);
    progress('empty board onboarding exposed real first actions without starting a canvas gesture');

    await evaluate(`void import('/src/store.ts').then(module => {
      const store = module.useWorkspaceStore;
      const first = ${JSON.stringify(boardSwitchProfile.first)};
      const second = ${JSON.stringify(boardSwitchProfile.second)};
      const original = ${JSON.stringify(boardSwitchProfile.original)};
      store.getState().openBoard(first);
      store.getState().addTextPlacement({ x: 10, y: 10 });
      store.getState().openBoard(second);
      store.getState().addTextPlacement({ x: 20, y: 20 });
      store.getState().undo();
      const secondAfterUndo = store.getState().boards.find(board => board.id === second)?.placements.length;
      store.getState().openBoard(first);
      store.getState().undo();
      const firstAfterUndo = store.getState().boards.find(board => board.id === first)?.placements.length;
      store.getState().redo();
      const firstAfterRedo = store.getState().boards.find(board => board.id === first)?.placements.length;
      store.getState().openBoard(second);
      store.getState().redo();
      const secondAfterRedo = store.getState().boards.find(board => board.id === second)?.placements.length;
      store.getState().openBoard(original);
      window.__perBoardHistoryQa = { firstAfterUndo, secondAfterUndo, firstAfterRedo, secondAfterRedo, active: store.getState().activeBoardId };
    }).catch(error => { window.__perBoardHistoryQa = { error: String(error?.stack || error) }; })`);
    const perBoardHistory = await waitFor(() => evaluate(`window.__perBoardHistoryQa ?? null`), 3000);
    await evaluate(`delete window.__perBoardHistoryQa`);
    if (perBoardHistory.error) throw new Error(`Per-board undo/redo integration errored: ${perBoardHistory.error}`);
    if (perBoardHistory.firstAfterUndo !== 0 || perBoardHistory.secondAfterUndo !== 0 || perBoardHistory.firstAfterRedo !== 1 || perBoardHistory.secondAfterRedo !== 1 || perBoardHistory.active !== boardSwitchProfile.original) throw new Error(`Per-board undo/redo isolation failed: ${JSON.stringify(perBoardHistory)}`);
    await waitFor(() => evaluate(`document.querySelector('[aria-label="白板名称"]')?.value === '五千节点白板'`), 2000);
    progress('interleaved per-board undo and redo remained independent');

    const nestedFixture = await evaluate(`(async () => {
      const store = window.__openCanvasQaStore;
      const chain = ['嵌套层级一', '嵌套层级二', '嵌套层级三', '嵌套层级四', '共享层级五'].map(title => store.getState().createBoard(title));
      const placementIds = [];
      for (let index = 0; index < chain.length - 1; index += 1) {
        store.getState().openBoard(chain[index].id);
        placementIds.push(store.getState().addBoardPlacement(chain[index + 1].id, { x: 120, y: 100 })?.id);
      }
      const alternate = store.getState().createBoard('另一条父路径');
      store.getState().openBoard(alternate.id);
      const alternatePlacement = store.getState().addBoardPlacement(chain[4].id, { x: 120, y: 100 });
      await store.getState().flushPendingSaves();
      store.getState().openBoard(chain[0].id);
      return { chain: chain.map(item => ({ id: item.id, title: item.title })), placementIds, alternate: { id: alternate.id, placementId: alternatePlacement?.id } };
    })()`);
    await waitFor(() => evaluate(`document.querySelector('[aria-label="白板名称"]')?.value === '嵌套层级一'`), 3000);
    for (let level = 1; level < nestedFixture.chain.length; level += 1) {
      const expected = nestedFixture.chain[level].title;
      await evaluate(`(() => { const node = document.querySelector('.canvas-node.node-board'); const rect = node?.getBoundingClientRect(); node?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0, clientX: rect?.left + 40, clientY: rect?.top + 30 })); })()`);
      await waitFor(() => evaluate(`document.querySelector('[aria-label="白板名称"]')?.value === ${JSON.stringify(expected)}`), 3000);
    }
    const fiveLevelPath = await evaluate(`(() => ({ parents: [...document.querySelectorAll('.board-path-parent button')].map(item => item.textContent), current: document.querySelector('[aria-label="白板名称"]')?.value, history: window.__openCanvasQaStore.getState().boardHistory }))()`);
    if (JSON.stringify(fiveLevelPath.parents) !== JSON.stringify(nestedFixture.chain.slice(0, 4).map(item => item.title)) || fiveLevelPath.current !== nestedFixture.chain[4].title || JSON.stringify(fiveLevelPath.history) !== JSON.stringify(nestedFixture.chain.slice(0, 4).map(item => item.id))) throw new Error(`Five-level occurrence path did not render or persist exactly: ${JSON.stringify({ nestedFixture, fiveLevelPath })}`);

    const nestedDeletion = await evaluate(`(async () => {
      const store = window.__openCanvasQaStore;
      const deleted = await store.getState().deleteBoard(${JSON.stringify(nestedFixture.chain[2].id)});
      const state = store.getState();
      return {
        deleted,
        active: state.activeBoardId,
        history: state.boardHistory,
        deletedStillExists: state.boards.some(item => item.id === ${JSON.stringify(nestedFixture.chain[2].id)}),
        fourthStillExists: state.boards.some(item => item.id === ${JSON.stringify(nestedFixture.chain[3].id)}),
        fifthStillExists: state.boards.some(item => item.id === ${JSON.stringify(nestedFixture.chain[4].id)}),
        secondStillReferencesDeleted: state.boards.find(item => item.id === ${JSON.stringify(nestedFixture.chain[1].id)})?.placements.some(item => item.entityId === ${JSON.stringify(nestedFixture.chain[2].id)}),
      };
    })()`);
    if (!nestedDeletion.deleted || nestedDeletion.active !== nestedFixture.chain[4].id || JSON.stringify(nestedDeletion.history) !== JSON.stringify([nestedFixture.chain[3].id]) || nestedDeletion.deletedStillExists || !nestedDeletion.fourthStillExists || !nestedDeletion.fifthStillExists || nestedDeletion.secondStillReferencesDeleted) throw new Error(`Deleting an ancestor did not preserve descendants and trim the occurrence prefix: ${JSON.stringify(nestedDeletion)}`);
    const trimmedBreadcrumb = await waitFor(() => evaluate(`(() => { const parents = [...document.querySelectorAll('.board-path-parent button')].map(item => item.textContent); return document.querySelector('[aria-label="白板名称"]')?.value === '共享层级五' ? parents : null; })()`), 3000);
    if (JSON.stringify(trimmedBreadcrumb) !== JSON.stringify(['嵌套层级四'])) throw new Error(`Breadcrumb did not update after ancestor deletion: ${JSON.stringify(trimmedBreadcrumb)}`);
    await evaluate(`document.querySelector('.board-path-back')?.click()`);
    await waitFor(() => evaluate(`document.querySelector('[aria-label="白板名称"]')?.value === '嵌套层级四'`), 3000);
    await evaluate(`document.querySelector('.board-path-back')?.click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.desktop-infinite-canvas'))`), 3000);

    await evaluate(`window.__openCanvasQaStore.getState().openBoard(${JSON.stringify(nestedFixture.alternate.id)})`);
    await waitFor(() => evaluate(`document.querySelector('[aria-label="白板名称"]')?.value === '另一条父路径'`), 3000);
    await evaluate(`(() => { const node = document.querySelector('.canvas-node.node-board'); const rect = node?.getBoundingClientRect(); node?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0, clientX: rect?.left + 40, clientY: rect?.top + 30 })); })()`);
    const alternatePath = await waitFor(() => evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); return document.querySelector('[aria-label="白板名称"]')?.value === '共享层级五' ? { history: state.boardHistory, parents: [...document.querySelectorAll('.board-path-parent button')].map(item => item.textContent) } : null; })()`), 3000);
    if (JSON.stringify(alternatePath.history) !== JSON.stringify([nestedFixture.alternate.id]) || JSON.stringify(alternatePath.parents) !== JSON.stringify(['另一条父路径'])) throw new Error(`Shared child lost its alternate occurrence path: ${JSON.stringify(alternatePath)}`);
    await evaluate(`document.querySelector('.board-path-back')?.click()`);
    await waitFor(() => evaluate(`document.querySelector('[aria-label="白板名称"]')?.value === '另一条父路径'`), 3000);
    const occurrenceRemoval = await evaluate(`(() => { const store = window.__openCanvasQaStore; store.getState().setSelection({ kind: 'placement', id: ${JSON.stringify(nestedFixture.alternate.placementId)}, ids: [${JSON.stringify(nestedFixture.alternate.placementId)}] }); store.getState().removeSelection(); const state = store.getState(); return { sharedExists: state.boards.some(item => item.id === ${JSON.stringify(nestedFixture.chain[4].id)}), alternateHasReference: state.boards.find(item => item.id === ${JSON.stringify(nestedFixture.alternate.id)})?.placements.some(item => item.id === ${JSON.stringify(nestedFixture.alternate.placementId)}), fourthHasReference: state.boards.find(item => item.id === ${JSON.stringify(nestedFixture.chain[3].id)})?.placements.some(item => item.entityId === ${JSON.stringify(nestedFixture.chain[4].id)}) }; })()`);
    if (!occurrenceRemoval.sharedExists || occurrenceRemoval.alternateHasReference || !occurrenceRemoval.fourthHasReference) throw new Error(`Removing one shared-board occurrence affected the entity or another parent: ${JSON.stringify(occurrenceRemoval)}`);

    const nestedCopyProfile = await evaluate(`(() => {
      const store = window.__openCanvasQaStore;
      const parent = store.getState().createBoard('嵌套实例复制组合验收');
      store.getState().openBoard(parent.id);
      const section = store.getState().addSectionPlacement({ x: 100, y: 90, width: 1000, height: 650 });
      const nested = store.getState().createNestedBoardPlacement({ x: 190, y: 180, width: 360, height: 220, sectionId: section.id, sectionIds: [section.id] });
      const peer = store.getState().addTextPlacement({ x: 650, y: 210, sectionId: section.id, sectionIds: [section.id] });
      store.getState().connectPlacements(nested.id, peer.id, { label: '实例连接' });
      const sourceConnector = store.getState().boards.find(item => item.id === parent.id)?.connectors[0];
      const alternate = store.getState().createBoard('嵌套实例另一父级');
      store.getState().openBoard(alternate.id);
      const alternateOccurrence = store.getState().addBoardPlacement(nested.entityId, { x: 160, y: 140 });
      store.getState().openBoard(parent.id);
      store.getState().setSelection({ kind: 'placement', id: nested.id, ids: [nested.id, peer.id] });
      store.getState().duplicateSelection();
      let state = store.getState();
      let board = state.boards.find(item => item.id === parent.id);
      const copyIds = state.selection?.kind === 'placement' ? state.selection.ids : [];
      const copiedNested = board?.placements.find(item => copyIds?.includes(item.id) && item.kind === 'board');
      const copiedPeer = board?.placements.find(item => copyIds?.includes(item.id) && item.kind === 'text' && !item.isFrame);
      const copiedConnector = board?.connectors.find(item => item.id !== sourceConnector?.id && copyIds?.includes(item.from) && copyIds?.includes(item.to));
      const afterCopy = {
        copyIds,
        sameEntity: copiedNested?.entityId === nested.entityId,
        nestedSection: copiedNested?.sectionId,
        peerSection: copiedPeer?.sectionId,
        copiedConnector: copiedConnector && { from: copiedConnector.from, to: copiedConnector.to },
        sharedEntityCount: state.boards.filter(item => item.id === nested.entityId).length,
      };
      store.getState().connectPlacements(section.id, peer.id);
      store.getState().connectPlacements('missing-instance', peer.id);
      const connectorsAfterInvalidAttempts = store.getState().boards.find(item => item.id === parent.id)?.connectors.length;
      store.getState().undo();
      state = store.getState();
      board = state.boards.find(item => item.id === parent.id);
      const afterUndo = { selection: state.selection, hasCopies: copyIds?.some(id => board?.placements.some(item => item.id === id)), connectors: board?.connectors.length };
      store.getState().redo();
      state = store.getState();
      board = state.boards.find(item => item.id === parent.id);
      const afterRedo = { selection: state.selection, hasCopies: copyIds?.every(id => board?.placements.some(item => item.id === id)), connectors: board?.connectors.length };
      store.getState().setSelection({ kind: 'placement', id: copiedNested.id, ids: [copiedNested.id] });
      store.getState().removeSelection();
      state = store.getState();
      board = state.boards.find(item => item.id === parent.id);
      return {
        parentId: parent.id,
        sectionId: section.id,
        sourceIds: [nested.id, peer.id],
        alternateId: alternate.id,
        alternateOccurrenceId: alternateOccurrence.id,
        afterCopy,
        connectorsAfterInvalidAttempts,
        afterUndo,
        afterRedo,
        afterRemoval: {
          entityExists: state.boards.some(item => item.id === nested.entityId),
          alternateReferenceExists: state.boards.find(item => item.id === alternate.id)?.placements.some(item => item.id === alternateOccurrence.id && item.entityId === nested.entityId),
          copiedOccurrenceExists: board?.placements.some(item => item.id === copiedNested.id),
          sourceConnectorExists: board?.connectors.some(item => item.id === sourceConnector.id),
          copiedConnectorExists: board?.connectors.some(item => item.id === copiedConnector.id),
        },
      };
    })()`);
    const copiedIds = nestedCopyProfile.afterCopy.copyIds;
    if (copiedIds?.length !== 2 || !nestedCopyProfile.afterCopy.sameEntity || nestedCopyProfile.afterCopy.sharedEntityCount !== 1 || nestedCopyProfile.afterCopy.nestedSection !== nestedCopyProfile.sectionId || nestedCopyProfile.afterCopy.peerSection !== nestedCopyProfile.sectionId || !copiedIds.includes(nestedCopyProfile.afterCopy.copiedConnector?.from) || !copiedIds.includes(nestedCopyProfile.afterCopy.copiedConnector?.to)) throw new Error(`Duplicating a nested-board occurrence forked its entity, Section, or connector identity: ${JSON.stringify(nestedCopyProfile)}`);
    if (nestedCopyProfile.connectorsAfterInvalidAttempts !== 2 || nestedCopyProfile.afterUndo.hasCopies || nestedCopyProfile.afterUndo.connectors !== 1 || JSON.stringify(nestedCopyProfile.afterUndo.selection?.ids) !== JSON.stringify(nestedCopyProfile.sourceIds) || !nestedCopyProfile.afterRedo.hasCopies || nestedCopyProfile.afterRedo.connectors !== 2 || JSON.stringify(nestedCopyProfile.afterRedo.selection?.ids) !== JSON.stringify(copiedIds)) throw new Error(`Nested occurrence duplicate undo/redo did not preserve instance selection semantics: ${JSON.stringify(nestedCopyProfile)}`);
    if (!nestedCopyProfile.afterRemoval.entityExists || !nestedCopyProfile.afterRemoval.alternateReferenceExists || nestedCopyProfile.afterRemoval.copiedOccurrenceExists || !nestedCopyProfile.afterRemoval.sourceConnectorExists || nestedCopyProfile.afterRemoval.copiedConnectorExists) throw new Error(`Removing a copied nested occurrence damaged its entity, another parent, or unrelated connector: ${JSON.stringify(nestedCopyProfile)}`);

    const nestedDropFixture = await evaluate(`(() => {
      const store = window.__openCanvasQaStore;
      const source = store.getState().createBoard('嵌套白板拖放源');
      const target = store.getState().createBoard('嵌套白板拖放目标');
      const card = store.getState().createCard('跨白板拖放卡片', '卡片实体必须保持共享。');
      store.getState().openBoard(source.id);
      store.getState().setViewport({ x: 0, y: 0, zoom: 1 });
      const cardPlacement = store.getState().addCardPlacement(card.id, { x: 90, y: 130, width: 320, height: 180 });
      const targetPlacement = store.getState().addBoardPlacement(target.id, { x: 610, y: 110, width: 430, height: 270 });
      return { sourceId: source.id, targetId: target.id, cardId: card.id, cardPlacementId: cardPlacement.id, targetPlacementId: targetPlacement.id };
    })()`);
    await waitFor(() => evaluate(`document.querySelector('[aria-label="白板名称"]')?.value === '嵌套白板拖放源' && Boolean(document.querySelector('[data-placement-id="${nestedDropFixture.cardPlacementId}"]')) && Boolean(document.querySelector('[data-placement-id="${nestedDropFixture.targetPlacementId}"]'))`), 3000);
    await evaluate(`(() => { const store = window.__openCanvasQaStore; store.getState().setTool('select'); store.getState().setSelection({ kind: 'placement', id: ${JSON.stringify(nestedDropFixture.cardPlacementId)}, ids: [${JSON.stringify(nestedDropFixture.cardPlacementId)}] }); document.querySelector('[data-placement-id="${nestedDropFixture.cardPlacementId}"] .card-selection-toolbar')?.getAnimations().forEach(animation => animation.finish()); })()`);
    await waitFor(() => evaluate(`document.querySelector('[data-placement-id="${nestedDropFixture.cardPlacementId}"]')?.classList.contains('selected')`), 2000);
    const nestedDropRects = await evaluate(`(() => ({
      card: document.querySelector('[data-placement-id="${nestedDropFixture.cardPlacementId}"]')?.getBoundingClientRect().toJSON(),
      target: document.querySelector('[data-placement-id="${nestedDropFixture.targetPlacementId}"]')?.getBoundingClientRect().toJSON(),
    }))()`);
    const nestedDropStart = { x: nestedDropRects.card.left + nestedDropRects.card.width / 2, y: nestedDropRects.card.top + 18 };
    const nestedDropEnd = { x: nestedDropRects.target.left + nestedDropRects.target.width / 2, y: nestedDropRects.target.top + nestedDropRects.target.height / 2 };
    const nestedMovePointerId = await beginDomPointerDrag(`[data-placement-id="${nestedDropFixture.cardPlacementId}"]`, nestedDropStart, nestedDropEnd);
    const liveNestedDropTarget = await waitFor(() => evaluate(`(() => { const node = document.querySelector('[data-placement-id="${nestedDropFixture.targetPlacementId}"]'); return node?.classList.contains('nested-board-drop-target') ? { aria: node.getAttribute('aria-label'), sourceSelected: document.querySelector('[data-placement-id="${nestedDropFixture.cardPlacementId}"]')?.classList.contains('selected') } : null; })()`), 3000);
    if (!liveNestedDropTarget.aria?.includes('释放后移入这里') || !liveNestedDropTarget.sourceSelected) throw new Error(`Nested whiteboard did not expose a live drop target: ${JSON.stringify(liveNestedDropTarget)}`);
    await captureVisualArtifact('dark-nested-whiteboard-live-drop-target');
    await endDomPointerDrag(nestedMovePointerId, nestedDropEnd);
    const movedIntoNested = await waitFor(() => evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); const source = state.boards.find(item => item.id === ${JSON.stringify(nestedDropFixture.sourceId)}); const target = state.boards.find(item => item.id === ${JSON.stringify(nestedDropFixture.targetId)}); const preview = document.querySelector('[data-placement-id="${nestedDropFixture.targetPlacementId}"]'); return !source?.placements.some(item => item.id === ${JSON.stringify(nestedDropFixture.cardPlacementId)}) && target?.placements.some(item => item.id === ${JSON.stringify(nestedDropFixture.cardPlacementId)}) ? { targetCount: target.placements.length, previewText: preview?.textContent, targetActive: preview?.classList.contains('nested-board-drop-target') } : null; })()`), 3000);
    if (movedIntoNested.targetCount !== 1 || !movedIntoNested.previewText?.includes('1 张卡片') || movedIntoNested.targetActive) throw new Error(`Nested whiteboard move did not commit and clear feedback: ${JSON.stringify(movedIntoNested)}`);
    await evaluate(`window.__openCanvasQaStore.getState().undo()`);
    await waitFor(() => evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); return state.boards.find(item => item.id === ${JSON.stringify(nestedDropFixture.sourceId)})?.placements.some(item => item.id === ${JSON.stringify(nestedDropFixture.cardPlacementId)}) && state.boards.find(item => item.id === ${JSON.stringify(nestedDropFixture.targetId)})?.placements.length === 0; })()`), 3000);
    await evaluate(`window.__openCanvasQaStore.getState().setSelection({ kind: 'placement', id: ${JSON.stringify(nestedDropFixture.cardPlacementId)}, ids: [${JSON.stringify(nestedDropFixture.cardPlacementId)}] })`);
    await waitFor(() => evaluate(`document.querySelector('[data-placement-id="${nestedDropFixture.cardPlacementId}"]')?.classList.contains('selected')`), 2000);

    const restoredDropRects = await evaluate(`(() => ({
      card: document.querySelector('[data-placement-id="${nestedDropFixture.cardPlacementId}"]')?.getBoundingClientRect().toJSON(),
      target: document.querySelector('[data-placement-id="${nestedDropFixture.targetPlacementId}"]')?.getBoundingClientRect().toJSON(),
    }))()`);
    const altDropStart = { x: restoredDropRects.card.left + restoredDropRects.card.width / 2, y: restoredDropRects.card.top + 18 };
    const altDropEnd = { x: restoredDropRects.target.left + restoredDropRects.target.width / 2, y: restoredDropRects.target.top + restoredDropRects.target.height / 2 };
    const nestedCopyPointerId = await beginDomPointerDrag(`[data-placement-id="${nestedDropFixture.cardPlacementId}"]`, altDropStart, altDropEnd);
    await waitFor(() => evaluate(`document.querySelector('[data-placement-id="${nestedDropFixture.targetPlacementId}"]')?.getAttribute('aria-label')?.includes('释放后移入这里')`), 3000);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, modifiers: 1 });
    const liveNestedCopyTarget = await waitFor(() => evaluate(`(() => { const node = document.querySelector('[data-placement-id="${nestedDropFixture.targetPlacementId}"]'); return node?.classList.contains('nested-board-drop-copy-target') ? { aria: node.getAttribute('aria-label') } : null; })()`), 3000);
    if (!liveNestedCopyTarget.aria?.includes('释放后复制到这里')) throw new Error(`Alt-drag did not expose copy-specific nested-board feedback: ${JSON.stringify(liveNestedCopyTarget)}`);
    await endDomPointerDrag(nestedCopyPointerId, altDropEnd, { altKey: true });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18 });
    const copiedIntoNested = await waitFor(() => evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); const source = state.boards.find(item => item.id === ${JSON.stringify(nestedDropFixture.sourceId)}); const target = state.boards.find(item => item.id === ${JSON.stringify(nestedDropFixture.targetId)}); const original = source?.placements.find(item => item.id === ${JSON.stringify(nestedDropFixture.cardPlacementId)}); const copy = target?.placements.find(item => item.entityId === ${JSON.stringify(nestedDropFixture.cardId)}); return original && copy ? { original: { id: original.id, x: original.x, y: original.y }, copy: { id: copy.id, x: copy.x, y: copy.y }, targetCount: target.placements.length } : null; })()`), 3000);
    if (copiedIntoNested.original.id !== nestedDropFixture.cardPlacementId || copiedIntoNested.original.x !== 90 || copiedIntoNested.original.y !== 130 || copiedIntoNested.copy.id === nestedDropFixture.cardPlacementId || copiedIntoNested.targetCount !== 1) throw new Error(`Alt-drop did not copy into the nested whiteboard while restoring the source: ${JSON.stringify(copiedIntoNested)}`);
    await evaluate(`window.__openCanvasQaStore.getState().undo()`);
    await waitFor(() => evaluate(`window.__openCanvasQaStore.getState().boards.find(item => item.id === ${JSON.stringify(nestedDropFixture.targetId)})?.placements.length === 0`), 3000);

    const invalidNestedDropFixture = await evaluate(`(() => {
      const store = window.__openCanvasQaStore;
      const ancestor = store.getState().createBoard('循环嵌套祖先');
      store.getState().openBoard(ancestor.id);
      store.getState().addBoardPlacement(${JSON.stringify(nestedDropFixture.targetId)}, { x: 100, y: 100, width: 430, height: 270 });
      store.getState().openBoard(${JSON.stringify(nestedDropFixture.sourceId)});
      const occurrence = store.getState().addBoardPlacement(ancestor.id, { x: 100, y: 430, width: 430, height: 270 });
      return { ancestorId: ancestor.id, occurrenceId: occurrence.id };
    })()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('[data-placement-id="${invalidNestedDropFixture.occurrenceId}"]'))`), 3000);
    await evaluate(`window.__openCanvasQaStore.getState().setSelection({ kind: 'placement', id: ${JSON.stringify(invalidNestedDropFixture.occurrenceId)}, ids: [${JSON.stringify(invalidNestedDropFixture.occurrenceId)}] })`);
    await waitFor(() => evaluate(`document.querySelector('[data-placement-id="${invalidNestedDropFixture.occurrenceId}"]')?.classList.contains('selected')`), 2000);
    const invalidNestedDropRects = await evaluate(`(() => ({
      source: document.querySelector('[data-placement-id="${invalidNestedDropFixture.occurrenceId}"]')?.getBoundingClientRect().toJSON(),
      target: document.querySelector('[data-placement-id="${nestedDropFixture.targetPlacementId}"]')?.getBoundingClientRect().toJSON(),
    }))()`);
    const invalidDropStart = { x: invalidNestedDropRects.source.left + invalidNestedDropRects.source.width / 2, y: invalidNestedDropRects.source.top + 18 };
    const invalidDropEnd = { x: invalidNestedDropRects.target.left + invalidNestedDropRects.target.width / 2, y: invalidNestedDropRects.target.top + invalidNestedDropRects.target.height / 2 };
    const invalidNestedPointerId = await beginDomPointerDrag(`[data-placement-id="${invalidNestedDropFixture.occurrenceId}"]`, invalidDropStart, invalidDropEnd);
    const invalidNestedTarget = await waitFor(() => evaluate(`(() => { const node = document.querySelector('[data-placement-id="${nestedDropFixture.targetPlacementId}"]'); return node?.classList.contains('nested-board-drop-invalid-target') ? { aria: node.getAttribute('aria-label'), validClass: node.classList.contains('nested-board-drop-target') } : null; })()`), 3000);
    if (!invalidNestedTarget.aria?.includes('不能移入') || invalidNestedTarget.validClass) throw new Error(`Circular nested-board target did not expose invalid feedback: ${JSON.stringify(invalidNestedTarget)}`);
    await captureVisualArtifact('dark-nested-whiteboard-invalid-cycle-target');
    await endDomPointerDrag(invalidNestedPointerId, invalidDropEnd);
    const invalidDropRestored = await waitFor(() => evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); const source = state.boards.find(item => item.id === ${JSON.stringify(nestedDropFixture.sourceId)}); const target = state.boards.find(item => item.id === ${JSON.stringify(nestedDropFixture.targetId)}); const occurrence = source?.placements.find(item => item.id === ${JSON.stringify(invalidNestedDropFixture.occurrenceId)}); const targetNode = document.querySelector('[data-placement-id="${nestedDropFixture.targetPlacementId}"]'); return occurrence && occurrence.x === 100 && occurrence.y === 430 && !target?.placements.some(item => item.entityId === ${JSON.stringify(invalidNestedDropFixture.ancestorId)}) ? { invalidClass: targetNode?.classList.contains('nested-board-drop-invalid-target'), notice: state.notices.at(-1)?.title } : null; })()`), 3000);
    if (invalidDropRestored.invalidClass || invalidDropRestored.notice !== '无法移入这个白板') throw new Error(`Invalid nested-board drop did not restore the source and clear feedback: ${JSON.stringify(invalidDropRestored)}`);
    progress('live nested-whiteboard move/copy/invalid targets, preview count, cycle rejection, and atomic cross-board undo passed');

    await evaluate(`window.__openCanvasQaStore.getState().openBoard(${JSON.stringify(boardSwitchProfile.original)})`);
    await waitFor(() => evaluate(`document.querySelector('[aria-label="白板名称"]')?.value === '五千节点白板'`), 3000);
    progress('five-level nesting, multi-parent paths, occurrence duplication, connector identity, undo/redo, and occurrence-only removal passed');

    await evaluate(`[...document.querySelectorAll('.sidebar button')].find(button => button.textContent.trim() === '桌面')?.click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.desktop-spatial-view .desktop-board-more'))`), 3000);

    const desktopVisualFixture = await evaluate(`(() => {
      const store = window.__openCanvasQaStore;
      const state = store.getState();
      const boardId = ${JSON.stringify(boardSwitchProfile.first)};
      const board = state.boards.find(item => item.id === boardId);
      const placement = state.desktop.placements.find(item => item.boardId === boardId);
      const canvas = document.querySelector('.desktop-infinite-canvas')?.getBoundingClientRect();
      if (!board || !placement || !canvas) return null;
      const before = { title: board.title, placement: { ...placement }, viewport: { ...state.desktop.viewport } };
      const title = '这是一个用于验证桌面白板预览卡在非常非常长的中文项目名称下仍然保持图标、标题、统计信息和更多按钮完整对齐的视觉验收白板';
      state.updateBoard(boardId, { title });
      state.updateDesktopPlacement(boardId, { x: 3000, y: 1000, width: 560, height: 330 });
      state.setDesktopViewport({ zoom: 1, x: canvas.width / 2 - 3280, y: canvas.height / 2 - 1165 });
      return { boardId, title, before };
    })()`);
    if (!desktopVisualFixture) throw new Error('Could not establish the isolated long-title desktop visual fixture');
    const desktopLongTitleProfile = await waitFor(() => evaluate(`(() => {
      const fixture = ${JSON.stringify(desktopVisualFixture)};
      const node = [...document.querySelectorAll('.desktop-board-node')].find(item => item.getAttribute('aria-label')?.includes(fixture.title));
      const preview = node?.querySelector('.shared-board-preview');
      const heading = preview?.querySelector('.shared-board-preview-heading');
      const title = heading?.querySelector('strong');
      const actions = preview?.querySelector('.shared-board-preview-actions');
      const nodeRect = node?.getBoundingClientRect();
      const previewRect = preview?.getBoundingClientRect();
      const headingRect = heading?.getBoundingClientRect();
      const titleRect = title?.getBoundingClientRect();
      const actionsRect = actions?.getBoundingClientRect();
      if (!nodeRect || !previewRect || !headingRect || !titleRect || !actionsRect) return null;
      const style = getComputedStyle(title);
      return {
        node: nodeRect.toJSON(),
        preview: previewRect.toJSON(),
        heading: headingRect.toJSON(),
        title: titleRect.toJSON(),
        actions: actionsRect.toJSON(),
        scrollWidth: title.scrollWidth,
        clientWidth: title.clientWidth,
        overflow: style.overflow,
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })()`), 3000);
    if (desktopLongTitleProfile.scrollWidth <= desktopLongTitleProfile.clientWidth
      || desktopLongTitleProfile.overflow !== 'hidden'
      || desktopLongTitleProfile.textOverflow !== 'ellipsis'
      || desktopLongTitleProfile.whiteSpace !== 'nowrap'
      || desktopLongTitleProfile.heading.right > desktopLongTitleProfile.actions.left + 1
      || desktopLongTitleProfile.preview.left < desktopLongTitleProfile.node.left - 1
      || desktopLongTitleProfile.preview.right > desktopLongTitleProfile.node.right + 1
      || desktopLongTitleProfile.pageOverflow > 1) {
      throw new Error(`Long desktop board title escaped or displaced the shared preview header: ${JSON.stringify(desktopLongTitleProfile)}`);
    }
    await captureElementArtifact('light-desktop-long-title', '.desktop-infinite-canvas');
    await evaluate(`window.__openCanvasQaStore.getState().toggleDarkMode()`);
    await waitFor(() => evaluate(`document.querySelector('.app-shell')?.getAttribute('data-theme') === 'dark'`), 2000);
    await captureElementArtifact('dark-desktop-long-title', '.desktop-infinite-canvas');
    await evaluate(`window.__openCanvasQaStore.getState().toggleDarkMode()`);
    await waitFor(() => evaluate(`document.querySelector('.app-shell')?.getAttribute('data-theme') === 'light'`), 2000);

    const deepFileFixture = await evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const card = state.createCardInFolder('层级视觉验收笔记', '视觉验收/研究项目/资料/访谈');
      return { cardId: card.id, title: card.title, path: card.relativePath };
    })()`);
    await evaluate(`[...document.querySelectorAll('.global-nav button')].find(button => button.textContent.trim() === '文件')?.click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.file-tree'))`), 3000);
    await evaluate(`(() => {
      const input = document.querySelector('.sidebar-search input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify('层级视觉验收笔记')});
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify('层级视觉验收笔记')} }));
    })()`);
    const deepFileTreeProfile = await waitFor(() => evaluate(`(() => {
      const expected = ['视觉验收', '研究项目', '资料', '访谈', '层级视觉验收笔记'];
      const rows = [...document.querySelectorAll('.file-tree [role="treeitem"]')].filter(row => expected.some(label => row.textContent.includes(label)));
      if (rows.length !== expected.length) return null;
      return rows.map(row => {
        const rect = row.getBoundingClientRect();
        const contentAnchor = row.querySelector('.file-row-main svg, :scope > svg') ?? row;
        const contentRect = contentAnchor.getBoundingClientRect();
        return {
          text: expected.find(label => row.textContent.includes(label)),
          level: Number(row.getAttribute('aria-level')),
          depth: Number(getComputedStyle(row).getPropertyValue('--file-depth')),
          left: rect.left,
          contentLeft: contentRect.left,
          guides: Boolean(row.querySelector('.file-tree-indent-guides')),
        };
      });
    })()`), 5000);
    const expectedDeepLevels = [2, 3, 4, 5, 6];
    if (deepFileTreeProfile.some((item, index) => item.level !== expectedDeepLevels[index]
      || item.depth !== index
      || (index > 0 && !item.guides)
      || (index > 0 && item.contentLeft < deepFileTreeProfile[index - 1].contentLeft + 15))) {
      throw new Error(`Deep file hierarchy lost its level, indentation, or guide contract: ${JSON.stringify(deepFileTreeProfile)}`);
    }
    await captureElementArtifact('light-deep-file-tree', '.sidebar');
    await evaluate(`window.__openCanvasQaStore.getState().toggleDarkMode()`);
    await waitFor(() => evaluate(`document.querySelector('.app-shell')?.getAttribute('data-theme') === 'dark'`), 2000);
    await captureElementArtifact('dark-deep-file-tree', '.sidebar');
    await evaluate(`window.__openCanvasQaStore.getState().toggleDarkMode()`);
    await waitFor(() => evaluate(`document.querySelector('.app-shell')?.getAttribute('data-theme') === 'light'`), 2000);
    await evaluate(`document.querySelector('.sidebar-search-clear')?.click()`);
    await evaluate(`[...document.querySelectorAll('.global-nav button')].find(button => button.textContent.trim() === '桌面')?.click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.desktop-spatial-view'))`), 3000);
    await evaluate(`(() => {
      const fixture = ${JSON.stringify(desktopVisualFixture)};
      const state = window.__openCanvasQaStore.getState();
      state.updateBoard(fixture.boardId, { title: fixture.before.title });
      state.updateDesktopPlacement(fixture.boardId, fixture.before.placement);
      state.setDesktopViewport(fixture.before.viewport);
      return true;
    })()`);
    progress('light/dark long-title desktop preview and four-level file-tree indentation artifacts passed');

    await evaluate(`document.querySelector('.desktop-spatial-view .desktop-board-more')?.click()`);
    const desktopMenu = await waitFor(() => evaluate(`(() => { const items = [...document.querySelectorAll('.desktop-board-menu [role="menuitem"]')]; if (items.length < 4 || document.activeElement !== items[0]) return null; return { labels: items.map(item => item.textContent?.trim()), active: document.activeElement?.textContent?.trim() }; })()`), 3000);
    if (!desktopMenu.labels.includes('打开白板') || !desktopMenu.labels.includes('重命名') || !desktopMenu.labels.includes('删除白板')) throw new Error(`Desktop board overflow menu lost actions: ${JSON.stringify(desktopMenu)}`);
    await evaluate(`(() => { const menu = document.querySelector('.desktop-board-menu'); const qa = window.__desktopMenuExitQa = { exiting: false }; const observer = new MutationObserver(() => { if (menu?.getAttribute('data-presence') === 'exiting') { qa.exiting = true; qa.animation = getComputedStyle(menu).animationName; qa.pointerEvents = getComputedStyle(menu).pointerEvents; } }); if (menu) observer.observe(menu, { attributes: true, attributeFilter: ['data-presence'] }); qa.disconnect = () => observer.disconnect(); })()`);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    const desktopMenuExit = await waitFor(() => evaluate(`window.__desktopMenuExitQa?.exiting ? window.__desktopMenuExitQa : null`), 1000);
    await evaluate(`window.__desktopMenuExitQa?.disconnect?.(); delete window.__desktopMenuExitQa`);
    if (desktopMenuExit.animation !== 'oc-menu-out' || desktopMenuExit.pointerEvents !== 'none') throw new Error(`Desktop menu did not leave through the shared non-interactive exit motion: ${JSON.stringify(desktopMenuExit)}`);
    await waitFor(() => evaluate(`!document.querySelector('.desktop-board-menu')`), 2000);
    const desktopGestureCancellation = await evaluate(`(async () => {
      const store = window.__openCanvasQaStore;
      const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
      const pointer = (target, type, init) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, ...init }));
      const snapshot = () => {
        const state = store.getState();
        return {
          selected: [...document.querySelectorAll('.desktop-board-node.selected')].map(item => item.getAttribute('aria-label')),
          placements: state.desktop.placements.map(item => ({ boardId: item.boardId, x: item.x, y: item.y, width: item.width, height: item.height })),
          viewport: { ...state.desktop.viewport },
          marquee: Boolean(document.querySelector('.desktop-selection-marquee')),
          guides: document.querySelectorAll('.desktop-alignment-guide').length,
        };
      };
      const nodes = () => [...document.querySelectorAll('.desktop-board-node')];
      if (nodes().length < 2) return { error: 'two root boards required' };
      const clickNode = async (index, pointerId) => {
        const node = nodes()[index];
        const rect = node.getBoundingClientRect();
        pointer(node, 'pointerdown', { pointerId, clientX: rect.left + 34, clientY: rect.top + 18 });
        pointer(window, 'pointerup', { pointerId, clientX: rect.left + 34, clientY: rect.top + 18 });
        await frame();
      };

      await clickNode(1, 301);
      const dragBefore = snapshot();
      let node = nodes()[0];
      let rect = node.getBoundingClientRect();
      pointer(node, 'pointerdown', { pointerId: 302, clientX: rect.left + 34, clientY: rect.top + 18 });
      pointer(window, 'pointermove', { pointerId: 302, clientX: rect.left + 98, clientY: rect.top + 56 });
      await frame();
      window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape', code: 'Escape' }));
      pointer(window, 'pointerup', { pointerId: 302, clientX: rect.left + 98, clientY: rect.top + 56 });
      await wait(150);
      const dragAfter = snapshot();

      await clickNode(0, 303);
      const resizeBefore = snapshot();
      const handle = document.querySelector('.desktop-board-node.selected .desktop-resize-se');
      rect = handle?.getBoundingClientRect();
      if (!handle || !rect) return { error: 'resize handle missing', dragBefore, dragAfter };
      pointer(handle, 'pointerdown', { pointerId: 304, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
      pointer(window, 'pointermove', { pointerId: 304, clientX: rect.left + rect.width / 2 + 42, clientY: rect.top + rect.height / 2 + 28 });
      await frame();
      window.dispatchEvent(new Event('blur'));
      pointer(window, 'pointerup', { pointerId: 304, clientX: rect.left + rect.width / 2 + 42, clientY: rect.top + rect.height / 2 + 28 });
      await wait(150);
      const resizeAfter = snapshot();

      const canvas = document.querySelector('.desktop-infinite-canvas');
      rect = canvas?.getBoundingClientRect();
      if (!canvas || !rect) return { error: 'desktop canvas missing', dragBefore, dragAfter, resizeBefore, resizeAfter };
      const panBefore = snapshot();
      pointer(canvas, 'pointerdown', { pointerId: 305, button: 1, buttons: 4, clientX: rect.right - 80, clientY: rect.bottom - 80 });
      pointer(window, 'pointermove', { pointerId: 305, button: 1, buttons: 4, clientX: rect.right - 135, clientY: rect.bottom - 118 });
      await frame();
      pointer(window, 'pointercancel', { pointerId: 305 });
      pointer(window, 'pointerup', { pointerId: 305, button: 1, buttons: 0, clientX: rect.right - 135, clientY: rect.bottom - 118 });
      await wait(150);
      const panAfter = snapshot();

      const marqueeBefore = snapshot();
      pointer(canvas, 'pointerdown', { pointerId: 306, clientX: rect.left + 20, clientY: rect.top + 90 });
      pointer(window, 'pointermove', { pointerId: 306, clientX: rect.right - 20, clientY: rect.bottom - 20 });
      await frame();
      pointer(window, 'pointercancel', { pointerId: 306 });
      pointer(window, 'pointerup', { pointerId: 306, clientX: rect.right - 20, clientY: rect.bottom - 20 });
      await wait(150);
      const marqueeAfter = snapshot();
      return { dragBefore, dragAfter, resizeBefore, resizeAfter, panBefore, panAfter, marqueeBefore, marqueeAfter };
    })()`);
    if (desktopGestureCancellation.error) throw new Error(`Desktop cancellation fixture failed: ${desktopGestureCancellation.error}`);
    for (const kind of ['drag', 'resize', 'pan', 'marquee']) {
      if (JSON.stringify(desktopGestureCancellation[`${kind}Before`]) !== JSON.stringify(desktopGestureCancellation[`${kind}After`])) throw new Error(`Desktop ${kind} cancellation did not fully roll back: ${JSON.stringify(desktopGestureCancellation)}`);
    }
    progress('desktop drag, resize, pan, and marquee gestures fully rolled back on Escape, pointer cancellation, and window blur');
    await evaluate(`(() => { const canvas = document.querySelector('.desktop-infinite-canvas'); const controls = document.querySelector('.desktop-zoom-controls'); const rect = canvas?.getBoundingClientRect(); if (!canvas || !controls || !rect) return false; const qa = window.__desktopWheelFeedbackQa = { canvas: false, controls: false }; const record = () => { qa.canvas ||= canvas.classList.contains('is-wheel-zooming'); qa.controls ||= controls.classList.contains('is-zooming'); }; const observer = new MutationObserver(record); observer.observe(canvas, { attributes: true, attributeFilter: ['class'] }); observer.observe(controls, { attributes: true, attributeFilter: ['class'] }); for (let index = 0; index < 40; index += 1) canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, deltaY: .7 })); setTimeout(() => { record(); observer.disconnect(); }, 1000); return true; })()`);
    const desktopWheelFeedback = await waitFor(() => evaluate(`window.__desktopWheelFeedbackQa?.canvas && window.__desktopWheelFeedbackQa?.controls ? window.__desktopWheelFeedbackQa : null`), 2000);
    await delay(240);
    const desktopWheelSettled = await evaluate(`(() => { const result = { canvas: document.querySelector('.desktop-infinite-canvas')?.classList.contains('is-wheel-zooming'), controls: document.querySelector('.desktop-zoom-controls')?.classList.contains('is-zooming') }; delete window.__desktopWheelFeedbackQa; return result; })()`);
    if (!desktopWheelFeedback.canvas || !desktopWheelFeedback.controls || desktopWheelSettled.canvas || desktopWheelSettled.controls) throw new Error(`Desktop touchpad feedback was inconsistent or did not settle: ${JSON.stringify({ desktopWheelFeedback, desktopWheelSettled })}`);
    const desktopWheelCommandRace = await evaluate(`import('/src/store.ts').then(module => new Promise(resolve => { const store = module.useWorkspaceStore; const canvas = document.querySelector('.desktop-infinite-canvas'); const rect = canvas?.getBoundingClientRect(); const read = () => ({ ...store.getState().desktop.viewport }); const worldCenter = viewport => ({ x: (rect.width / 2 - viewport.x) / viewport.zoom, y: (rect.height / 2 - viewport.y) / viewport.zoom }); const start = read(); for (let index = 0; index < 30; index += 1) canvas?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, deltaY: .8 })); document.querySelector('.desktop-zoom-value')?.click(); const immediate = read(); setTimeout(() => resolve({ start, immediate, settled: read(), startCenter: worldCenter(start), immediateCenter: worldCenter(immediate) }), 90); }))`);
    const desktopCenterDrift = Math.hypot(desktopWheelCommandRace.startCenter.x - desktopWheelCommandRace.immediateCenter.x, desktopWheelCommandRace.startCenter.y - desktopWheelCommandRace.immediateCenter.y);
    if (Math.abs(desktopWheelCommandRace.immediate.zoom - .9) > .000001 || desktopCenterDrift > .25 || ['x', 'y', 'zoom'].some(key => Math.abs(desktopWheelCommandRace.immediate[key] - desktopWheelCommandRace.settled[key]) > .000001)) throw new Error(`Desktop zoom command was overwritten or shifted the world center: ${JSON.stringify({ desktopWheelCommandRace, desktopCenterDrift })}`);
    await evaluate(`[...document.querySelectorAll('.sidebar button')].find(button => button.textContent.trim() === '五千节点白板')?.click()`);
    await waitFor(() => evaluate(`document.querySelector('[aria-label="白板名称"]')?.value === '五千节点白板' && Boolean(document.querySelector('.infinite-canvas'))`), 3000);
    const toolbarDiscovery = await evaluate(`([...document.querySelectorAll('.canvas-toolbar button')].map(button => ({ label: button.getAttribute('aria-label'), shortcut: button.getAttribute('aria-keyshortcuts'), tooltip: button.getAttribute('data-tooltip') })))`);
    if (!toolbarDiscovery.some(item => item.label === '选择工具' && item.shortcut === 'V' && item.tooltip?.includes('V')) || !toolbarDiscovery.some(item => item.label === '连接工具' && item.shortcut === 'C' && item.tooltip?.includes('C'))) throw new Error(`Canvas toolbar did not expose discoverable real shortcuts: ${JSON.stringify(toolbarDiscovery)}`);
    await client.send('DOM.enable');
    await client.send('CSS.enable');
    const toolbarDocument = await client.send('DOM.getDocument', { depth: 1 });
    const toolbarButtonNode = await client.send('DOM.querySelector', { nodeId: toolbarDocument.root.nodeId, selector: '.canvas-toolbar [aria-label="选择工具"]' });
    await client.send('CSS.forcePseudoState', { nodeId: toolbarButtonNode.nodeId, forcedPseudoClasses: ['hover'] });
    const hoverTooltipDelay = await evaluate(`getComputedStyle(document.querySelector('.canvas-toolbar [aria-label="选择工具"]'), '::after').transitionDelay`);
    await client.send('CSS.forcePseudoState', { nodeId: toolbarButtonNode.nodeId, forcedPseudoClasses: [] });
    await mouse('mouseMoved', 320, 80);
    const keyboardFocusProfile = await evaluate(`(() => { const button = document.querySelector('.canvas-toolbar [aria-label="选择工具"]'); button?.focus(); const style = button && getComputedStyle(button); const tip = button && getComputedStyle(button, '::after'); return button ? { focused: document.activeElement === button, outline: style.outlineStyle, shadow: style.boxShadow, tooltipDelay: tip.transitionDelay } : null; })()`);
    if (hoverTooltipDelay !== '0.36s' || !keyboardFocusProfile.focused || keyboardFocusProfile.outline !== 'none' || keyboardFocusProfile.shadow === 'none' || keyboardFocusProfile.tooltipDelay !== '0.08s') throw new Error(`Toolbar tooltip rhythm or shared keyboard focus ring regressed: ${JSON.stringify({ hoverTooltipDelay, keyboardFocusProfile })}`);
    await evaluate(`document.querySelector('.infinite-canvas')?.focus?.()`);

    await evaluate(`void import('/src/store.ts').then(module => module.useWorkspaceStore.getState().pushNotice({ tone: 'info', title: '通知离场验收', message: '关闭后应平滑离场且立即停止交互。' }))`);
    await waitFor(() => evaluate(`Boolean([...document.querySelectorAll('.app-notification')].find(item => item.textContent.includes('通知离场验收') && item.getAttribute('data-presence') === 'open'))`), 2000);
    await evaluate(`(() => { const notice = [...document.querySelectorAll('.app-notification')].find(item => item.textContent.includes('通知离场验收')); const qa = window.__notificationExitQa = { exiting: false }; const observer = new MutationObserver(() => { if (notice?.getAttribute('data-presence') === 'exiting') { qa.exiting = true; qa.animation = getComputedStyle(notice).animationName; qa.pointerEvents = getComputedStyle(notice).pointerEvents; qa.ariaHidden = notice.getAttribute('aria-hidden'); } }); if (notice) { observer.observe(notice, { attributes: true, attributeFilter: ['data-presence', 'aria-hidden'] }); notice.querySelector('[aria-label="关闭通知"]')?.click(); } qa.disconnect = () => observer.disconnect(); })()`);
    const notificationExit = await waitFor(() => evaluate(`window.__notificationExitQa?.exiting ? window.__notificationExitQa : null`), 1000);
    await evaluate(`window.__notificationExitQa?.disconnect?.(); delete window.__notificationExitQa`);
    if (notificationExit.animation !== 'oc-notification-out' || notificationExit.pointerEvents !== 'none' || notificationExit.ariaHidden !== 'true') throw new Error(`Application notification did not leave as a non-interactive, hidden announcement: ${JSON.stringify(notificationExit)}`);
    await waitFor(() => evaluate(`![...document.querySelectorAll('.app-notification')].some(item => item.textContent.includes('通知离场验收'))`), 2000);
    progress('desktop menu, center-stable touchpad zoom, pending-frame cancellation, and toolbar shortcut discovery passed');

    const minimapDrag = await evaluate(`import('/src/store.ts').then(module => { const store = module.useWorkspaceStore; const minimap = document.querySelector('.canvas-minimap'); const viewport = minimap?.querySelector('.minimap-viewport'); const mapRect = minimap?.getBoundingClientRect(); const viewportRect = viewport?.getBoundingClientRect(); if (!minimap || !mapRect || !viewportRect) return null; const start = { x: viewportRect.left + viewportRect.width / 2, y: viewportRect.top + viewportRect.height / 2 }; const dx = start.x < mapRect.left + mapRect.width / 2 ? 42 : -42; const dy = start.y < mapRect.top + mapRect.height / 2 ? 22 : -22; const state = store.getState(); const board = state.boards.find(item => item.id === state.activeBoardId); const qa = window.__minimapDragQa = { count: 0, startViewport: { ...board.viewport }, sawDragging: false }; const observer = new MutationObserver(() => { qa.sawDragging ||= minimap.classList.contains('is-dragging'); }); observer.observe(minimap, { attributes: true, attributeFilter: ['class'] }); qa.unsubscribe = store.subscribe((next, previous) => { const nextViewport = next.boards.find(item => item.id === next.activeBoardId)?.viewport; const previousViewport = previous.boards.find(item => item.id === previous.activeBoardId)?.viewport; if (nextViewport !== previousViewport) qa.count += 1; }); qa.stopObserver = () => observer.disconnect(); return { start, end: { x: start.x + dx, y: start.y + dy }, hit: document.elementFromPoint(start.x, start.y)?.className, saveState: state.saveState, externalChangePaths: state.externalChangePaths, conflictText: document.querySelector('.vault-conflict-dialog')?.textContent?.trim() }; })`);
    if (!minimapDrag || !String(minimapDrag.hit).includes('minimap-viewport')) throw new Error(`Minimap viewport did not expose a draggable hit surface: ${JSON.stringify(minimapDrag)}`);
    await mouse('mousePressed', minimapDrag.start.x, minimapDrag.start.y);
    await evaluate(`(() => { for (let index = 1; index <= 60; index += 1) window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1, clientX: ${minimapDrag.start.x} + (${minimapDrag.end.x} - ${minimapDrag.start.x}) * index / 60, clientY: ${minimapDrag.start.y} + (${minimapDrag.end.y} - ${minimapDrag.start.y}) * index / 60 })); })()`);
    await mouse('mouseReleased', minimapDrag.end.x, minimapDrag.end.y);
    const minimapDragResult = await waitFor(() => evaluate(`import('/src/store.ts').then(module => { const qa = window.__minimapDragQa; const state = module.useWorkspaceStore.getState(); const viewport = state.boards.find(item => item.id === state.activeBoardId)?.viewport; return qa && viewport && (Math.abs(viewport.x - qa.startViewport.x) > 1 || Math.abs(viewport.y - qa.startViewport.y) > 1) ? { count: qa.count, sawDragging: qa.sawDragging, start: qa.startViewport, end: { ...viewport } } : null; })`), 3000);
    const minimapDragCleanup = await evaluate(`(() => { const qa = window.__minimapDragQa; qa?.unsubscribe?.(); qa?.stopObserver?.(); delete window.__minimapDragQa; return { dragging: document.querySelector('.canvas-minimap')?.classList.contains('is-dragging') }; })()`);
    if (minimapDragResult.count > 2 || !minimapDragResult.sawDragging || minimapDragCleanup.dragging) throw new Error(`Minimap drag was not frame-batched or did not settle cleanly: ${JSON.stringify({ minimapDragResult, minimapDragCleanup })}`);
    const minimapCancel = await evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); const board = state.boards.find(item => item.id === state.activeBoardId); const target = document.querySelector('.canvas-minimap .minimap-viewport'); const rect = target?.getBoundingClientRect(); return rect && { before: { ...board.viewport }, start: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, end: { x: rect.left + rect.width / 2 - 31, y: rect.top + rect.height / 2 + 17 } }; })()`);
    await mouse('mousePressed', minimapCancel.start.x, minimapCancel.start.y);
    minimapCancel.afterPress = await evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); return { ...state.boards.find(item => item.id === state.activeBoardId).viewport }; })()`);
    await evaluate(`window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1, buttons: 1, clientX: ${minimapCancel.end.x}, clientY: ${minimapCancel.end.y} }))`);
    await waitFor(() => evaluate(`document.querySelector('.canvas-minimap')?.classList.contains('is-dragging')`), 2000);
    minimapCancel.afterMove = await evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); return { ...state.boards.find(item => item.id === state.activeBoardId).viewport }; })()`);
    await key('Escape', 'Escape', 27);
    minimapCancel.afterEscape = await evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); return { ...state.boards.find(item => item.id === state.activeBoardId).viewport }; })()`);
    await mouse('mouseReleased', minimapCancel.end.x, minimapCancel.end.y);
    await delay(150);
    const minimapCancelAfter = await evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); const board = state.boards.find(item => item.id === state.activeBoardId); return { viewport: { ...board.viewport }, dragging: document.querySelector('.canvas-minimap')?.classList.contains('is-dragging') }; })()`);
    if (JSON.stringify(minimapCancelAfter.viewport) !== JSON.stringify(minimapCancel.before) || minimapCancelAfter.dragging) throw new Error(`Escape during minimap navigation did not restore the viewport: ${JSON.stringify({ minimapCancel, minimapCancelAfter })}`);
    const minimapKeyboardBefore = await evaluate(`import('/src/store.ts').then(module => { document.querySelector('.canvas-minimap')?.focus(); const state = module.useWorkspaceStore.getState(); return { focused: document.activeElement?.classList.contains('canvas-minimap'), viewport: { ...state.boards.find(item => item.id === state.activeBoardId)?.viewport } }; })`);
    // A hidden Electron window can report the correct DOM activeElement before
    // Chromium has routed native keyboard input back to its WebContents. The
    // first directional input activates that native route on some CI hosts;
    // the second verifies the same real minimap keyboard command.
    await key('ArrowRight', 'ArrowRight', 39);
    await key('ArrowRight', 'ArrowRight', 39);
    await delay(250);
    const minimapNativeKeyRouted = await evaluate(`import('/src/store.ts').then(module => {
      const state = module.useWorkspaceStore.getState();
      const viewport = state.boards.find(item => item.id === state.activeBoardId)?.viewport;
      return Boolean(viewport?.x < ${minimapKeyboardBefore.viewport.x} - 1);
    })`);
    if (!minimapNativeKeyRouted) {
      const minimapDomFallbackFocused = await evaluate(`(() => {
        const minimap = document.querySelector('.canvas-minimap');
        if (document.activeElement !== minimap) return false;
        minimap.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true }));
        minimap.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true }));
        return true;
      })()`);
      if (!minimapDomFallbackFocused) throw new Error('Hidden-window keyboard fallback refused to target an unfocused minimap');
    }
    const minimapKeyboardAfter = await waitFor(() => evaluate(`import('/src/store.ts').then(module => { const state = module.useWorkspaceStore.getState(); const viewport = state.boards.find(item => item.id === state.activeBoardId)?.viewport; return viewport?.x < ${minimapKeyboardBefore.viewport.x} - 1 ? { ...viewport } : null; })`), 2000);
    if (!minimapKeyboardBefore.focused || minimapKeyboardAfter.x >= minimapKeyboardBefore.viewport.x) throw new Error(`Keyboard minimap navigation did not pan right: ${JSON.stringify({ minimapKeyboardBefore, minimapKeyboardAfter })}`);
    const minimapPoint = await evaluate(`(() => { const rect = document.querySelector('.canvas-minimap')?.getBoundingClientRect(); return rect && { x: rect.left + 12, y: rect.top + 12 }; })()`);
    await mouse('mousePressed', minimapPoint.x, minimapPoint.y);
    await mouse('mouseReleased', minimapPoint.x, minimapPoint.y);
    await delay(250);
    const connectorNodes = await evaluate(`[...document.querySelectorAll('.canvas-node')].map(node => { const rect = node.getBoundingClientRect(); const point = { x: rect.left + 35, y: rect.top + 18 }; return { ...point, id: node.getAttribute('data-placement-id'), usable: point.x > 248 && point.x < innerWidth && point.y > 0 && point.y < innerHeight && document.elementFromPoint(point.x, point.y)?.closest('.canvas-node') === node }; }).filter(item => item.usable).slice(0, 2)`);
    if (connectorNodes.length < 2) {
      const connectorDiagnostic = await evaluate(`({ conflict: document.querySelector('.vault-conflict-files')?.innerText, viewport: document.querySelector('.infinite-canvas')?.getBoundingClientRect().toJSON(), nodes: [...document.querySelectorAll('.canvas-node')].slice(0, 5).map(node => { const rect = node.getBoundingClientRect(); const x = rect.left + 35; const y = rect.top + 18; return { rect: rect.toJSON(), hit: document.elementFromPoint(x, y)?.className }; }), minimap: document.querySelector('.canvas-minimap')?.getBoundingClientRect().toJSON() })`);
      throw new Error(`Not enough visible nodes for connector UI regression: ${JSON.stringify(connectorDiagnostic)}`);
    }
    await mouse('mousePressed', connectorNodes[0].x, connectorNodes[0].y);
    await mouse('mouseReleased', connectorNodes[0].x, connectorNodes[0].y);
    await waitFor(() => evaluate(`Boolean(document.querySelector('[aria-label="从此卡片开始连线"]'))`), 3000);
    const cardToolbarProfile = await waitFor(() => evaluate(`(() => { const visible = document.querySelector('.card-selection-toolbar.is-visible'); const visibleGroup = document.querySelector('.card-selection-toolbar.is-visible > div'); const hidden = document.querySelector('.card-selection-toolbar:not(.is-visible)'); const hiddenGroup = document.querySelector('.card-selection-toolbar:not(.is-visible) > div'); const hiddenButtons = [...(hidden?.querySelectorAll('button') ?? [])]; if (!visible || !visibleGroup || !hidden || !hiddenGroup) return null; const visibleBefore = getComputedStyle(visibleGroup); const leftLabels = [...visible.querySelectorAll(':scope > div:first-child > button')].map(button => button.getAttribute('aria-label')); const rightLabels = [...visible.querySelectorAll(':scope > .card-toolbar-right > button')].map(button => button.getAttribute('aria-label')); const more = visible.querySelector('[aria-haspopup="menu"]'); const profile = { visibleToolbars: document.querySelectorAll('.card-selection-toolbar.is-visible').length, hiddenToolbars: document.querySelectorAll('.card-selection-toolbar:not(.is-visible)').length, hiddenButtons: hiddenButtons.length, hiddenButtonTabIndexes: hiddenButtons.map(button => button.tabIndex), leftLabels, rightLabels, moreTabIndex: more?.tabIndex, moreExpanded: more?.getAttribute('aria-expanded'), hiddenPointerEvents: getComputedStyle(hidden).pointerEvents, hiddenGroupPointerEvents: getComputedStyle(hiddenGroup).pointerEvents, hiddenOpacity: getComputedStyle(hiddenGroup).opacity, hiddenVisibility: getComputedStyle(hiddenGroup).visibility, visibleStartOpacity: visibleBefore.opacity, visibleVisibility: visibleBefore.visibility, transitionDuration: visibleBefore.transitionDuration, animations: visibleGroup.getAnimations().length }; visibleGroup.getAnimations().forEach(animation => animation.finish()); profile.visibleSettledOpacity = getComputedStyle(visibleGroup).opacity; return profile; })()`), 2000);
    if (cardToolbarProfile.visibleToolbars !== 1 || cardToolbarProfile.hiddenToolbars < 1 || cardToolbarProfile.hiddenButtons !== 5 || cardToolbarProfile.hiddenButtonTabIndexes.some(value => value !== -1) || JSON.stringify(cardToolbarProfile.leftLabels) !== JSON.stringify(['折叠卡片内容', '展开卡片', '展开右侧栏']) || cardToolbarProfile.rightLabels.length !== 2 || !cardToolbarProfile.rightLabels[0]?.endsWith('更多操作') || cardToolbarProfile.rightLabels[1] !== '从此卡片开始连线' || cardToolbarProfile.moreTabIndex !== 0 || cardToolbarProfile.moreExpanded !== 'false' || cardToolbarProfile.hiddenPointerEvents !== 'auto' || cardToolbarProfile.hiddenGroupPointerEvents !== 'none' || cardToolbarProfile.hiddenOpacity !== '0' || cardToolbarProfile.hiddenVisibility !== 'hidden' || cardToolbarProfile.visibleVisibility !== 'visible' || cardToolbarProfile.visibleSettledOpacity !== '1') throw new Error(`Reserved card toolbar lost Heptabase action order, hover target, or hidden-control isolation: ${JSON.stringify(cardToolbarProfile)}`);
    await evaluate(`document.querySelector('.card-selection-toolbar.is-visible [aria-haspopup="menu"]')?.click()`);
    const cardToolbarObjectMenu = await waitFor(() => evaluate(`(() => { const menu = document.querySelector('.canvas-context-menu[role="menu"]'); const button = document.querySelector('.card-selection-toolbar.is-visible [aria-haspopup="menu"]'); const labels = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])].map(item => item.textContent.trim()); return menu && labels.includes('在右侧栏打开') && labels.some(label => label.startsWith('从白板移除')) ? { labels, expanded: button?.getAttribute('aria-expanded') } : null; })()`), 3000);
    if (cardToolbarObjectMenu.expanded !== 'true') throw new Error(`Card toolbar More did not expose the shared object-menu state: ${JSON.stringify(cardToolbarObjectMenu)}`);
    await key('Escape', 'Escape', 27);
    await waitFor(() => evaluate(`!document.querySelector('.canvas-context-menu[role="menu"]') && document.querySelector('.card-selection-toolbar.is-visible [aria-haspopup="menu"]')?.getAttribute('aria-expanded') === 'false'`), 2000);
    const cardToolbarDoubleClickTarget = await evaluate(`(() => { const toolbar = document.querySelector('.card-selection-toolbar.is-visible'); const spacer = toolbar?.querySelector(':scope > span'); const rect = spacer?.getBoundingClientRect(); const cardId = toolbar?.closest('.canvas-node')?.getAttribute('data-card-id'); return rect && rect.width > 8 && cardId ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, cardId } : null; })()`);
    if (!cardToolbarDoubleClickTarget) throw new Error('Selected card toolbar did not retain a blank drag/double-click surface');
    await evaluate(`(() => { const target = document.elementFromPoint(${cardToolbarDoubleClickTarget.x}, ${cardToolbarDoubleClickTarget.y}); const init = { bubbles: true, cancelable: true, button: 0, clientX: ${cardToolbarDoubleClickTarget.x}, clientY: ${cardToolbarDoubleClickTarget.y} }; target.dispatchEvent(new MouseEvent('click', { ...init, detail: 1 })); target.dispatchEvent(new MouseEvent('click', { ...init, detail: 2 })); target.dispatchEvent(new MouseEvent('dblclick', { ...init, detail: 2 })); })()`);
    const cardToolbarDoubleClickPanel = await waitFor(() => evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); const panel = document.querySelector('.card-side-panel'); return state.sidePanelOpen && state.sidePanelCardId === ${JSON.stringify(cardToolbarDoubleClickTarget.cardId)} && panel?.getAttribute('aria-hidden') === 'false' ? { cardId: state.sidePanelCardId, selection: state.selection } : null; })()`), 3000);
    if (cardToolbarDoubleClickPanel.selection?.kind !== 'placement' || cardToolbarDoubleClickPanel.selection.id !== connectorNodes[0].id) throw new Error(`Card toolbar double click opened the panel but lost the selected instance: ${JSON.stringify(cardToolbarDoubleClickPanel)}`);
    await evaluate(`window.__openCanvasQaStore.getState().openCardInSidePanel(null)`);
    await waitFor(() => evaluate(`document.querySelector('.card-side-panel')?.getAttribute('aria-hidden') === 'true'`), 3000);
    await evaluate(`document.querySelector('.card-selection-toolbar.is-visible [aria-label="从此卡片开始连线"]')?.click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.edge-draft'))`), 3000);
    await mouse('mouseMoved', connectorNodes[1].x, connectorNodes[1].y);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.canvas-node.connection-target [aria-label="自动连接点"]'))`), 3000);
    const targetPort = await evaluate(`(() => { const node = document.querySelector('.canvas-node.connection-target'); const port = node?.querySelector('[aria-label="自动连接点"]'); const sidePort = node?.querySelector('[aria-label="上侧连接点"]'); const nodeRect = node?.getBoundingClientRect(); const rect = port?.getBoundingClientRect(); const sideRect = sidePort?.getBoundingClientRect(); const visual = port && getComputedStyle(port, '::before'); const sideVisual = sidePort && getComputedStyle(sidePort, '::before'); const canvasScale = nodeRect && parseFloat(node.style.width) ? nodeRect.width / parseFloat(node.style.width) : 1; return rect && sideRect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, hitWidth: rect.width, hitHeight: rect.height, sideHitWidth: sideRect.width, visualWidth: parseFloat(visual.width) * canvasScale, sideVisualWidth: parseFloat(sideVisual.width) * canvasScale } : null; })()`);
    if (!targetPort || targetPort.hitWidth < 22 || targetPort.hitWidth > 26 || targetPort.hitHeight < 22 || targetPort.hitHeight > 26 || targetPort.sideHitWidth < 22 || targetPort.sideHitWidth > 26 || targetPort.visualWidth < 12 || targetPort.visualWidth > 14 || targetPort.sideVisualWidth < 10 || targetPort.sideVisualWidth > 12) throw new Error(`Connector ports did not separate a generous hit target from their compact visual dot: ${JSON.stringify(targetPort)}`);
    await mouse('mousePressed', targetPort.x, targetPort.y);
    await mouse('mouseReleased', targetPort.x, targetPort.y);
    const createdConnectorId = await waitFor(() => evaluate(`(() => { const store = window.__openCanvasQaStore; const state = store.getState(); const connector = state.boards.find(item => item.id === state.activeBoardId)?.connectors.find(item => item.from === ${JSON.stringify(connectorNodes[0].id)} && item.to === ${JSON.stringify(connectorNodes[1].id)}); if (!connector) return null; store.getState().setSelection({ kind: 'connector', id: connector.id }); return connector.id; })()`), 6000).catch(async () => {
      const diagnostic = await evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); const board = state.boards.find(item => item.id === state.activeBoardId); const hit = document.elementFromPoint(${targetPort.x}, ${targetPort.y}); return { activeBoardId: state.activeBoardId, tool: state.tool, interaction: document.querySelector('.infinite-canvas')?.className, hit: hit?.getAttribute('aria-label') || hit?.className || hit?.tagName, sourceExists: board?.placements.some(item => item.id === ${JSON.stringify(connectorNodes[0].id)}), targetExists: board?.placements.some(item => item.id === ${JSON.stringify(connectorNodes[1].id)}), connectors: board?.connectors.filter(item => item.from === ${JSON.stringify(connectorNodes[0].id)} || item.to === ${JSON.stringify(connectorNodes[1].id)}).map(item => ({ id: item.id, from: item.from, to: item.to })), draft: Boolean(document.querySelector('.edge-draft')), targetClass: document.querySelector('[data-placement-id=${JSON.stringify(connectorNodes[1].id)}]')?.className }; })()`);
      throw new Error(`Connector target click did not create the requested route: ${JSON.stringify({ connectorNodes, targetPort, diagnostic })}`);
    });
    if (typeof createdConnectorId !== 'string') throw new Error(`Connector creation did not add the requested dense-board route: ${JSON.stringify({ connectorNodes, createdConnectorId })}`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.edge-object:not(.edge-draft) .edge-hitbox'))`), 3000);
    const openConnectorMenu = async () => {
      await evaluate(`(() => { const hitbox = document.querySelector('.edge-object:not(.edge-draft) .edge-hitbox'); const rect = hitbox?.getBoundingClientRect(); if (!hitbox || !rect) return false; hitbox.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 })); return true; })()`);
      await waitFor(() => evaluate(`Boolean(document.querySelector('.connector-menu'))`), 3000);
    };
    await openConnectorMenu();
    const connectorMenuInitialFocus = await waitFor(() => evaluate(`(() => { const menu = document.querySelector('.connector-menu[role="menu"]'); const active = document.activeElement; return menu?.contains(active) && active?.getAttribute('aria-label') === '标签文字' ? { orientation: menu.getAttribute('aria-orientation'), role: active.getAttribute('role') } : null; })()`), 3000);
    if (connectorMenuInitialFocus.orientation !== 'horizontal' || connectorMenuInitialFocus.role !== 'menuitem') throw new Error(`Connector menu did not enter its first keyboard command: ${JSON.stringify(connectorMenuInitialFocus)}`);
    await key('ArrowRight', 'ArrowRight', 39);
    await waitFor(() => evaluate(`document.activeElement?.getAttribute('aria-label') === '线条颜色'`), 2000);
    await key(' ', 'Space', 32);
    const connectorSubmenuFocus = await waitFor(() => evaluate(`(() => { const panel = document.querySelector('.connector-compact-panel[role="group"]'); const active = document.activeElement; return panel?.contains(active) ? { panel: panel.getAttribute('aria-label'), active: active.getAttribute('aria-label'), pressed: active.getAttribute('aria-pressed') } : null; })()`), 2000);
    if (connectorSubmenuFocus.panel !== '选择线条颜色' || !connectorSubmenuFocus.active?.startsWith('线条颜色 ')) throw new Error(`Connector submenu did not move focus into its options: ${JSON.stringify(connectorSubmenuFocus)}`);
    await evaluate(`(() => { const panel = document.querySelector('.connector-compact-panel'); const qa = window.__connectorSubmenuExitQa = { exiting: false }; const observer = new MutationObserver(() => { if (panel?.getAttribute('data-presence') === 'exiting') { qa.exiting = true; qa.animation = getComputedStyle(panel).animationName; qa.pointerEvents = getComputedStyle(panel).pointerEvents; } }); if (panel) observer.observe(panel, { attributes: true, attributeFilter: ['data-presence'] }); qa.disconnect = () => observer.disconnect(); })()`);
    await key('Escape', 'Escape', 27);
    const connectorSubmenuExit = await waitFor(() => evaluate(`window.__connectorSubmenuExitQa?.exiting ? window.__connectorSubmenuExitQa : null`), 1000);
    await evaluate(`window.__connectorSubmenuExitQa?.disconnect?.(); delete window.__connectorSubmenuExitQa`);
    if (connectorSubmenuExit.animation !== 'oc-menu-out' || connectorSubmenuExit.pointerEvents !== 'none') throw new Error(`Connector submenu did not use the shared exit motion: ${JSON.stringify(connectorSubmenuExit)}`);
    const connectorSubmenuClosed = await waitFor(() => evaluate(`!document.querySelector('.connector-compact-panel') && document.querySelector('.connector-menu') && document.activeElement?.getAttribute('aria-label') === '线条颜色'`), 2000);
    if (!connectorSubmenuClosed) throw new Error('Escape did not collapse the connector submenu while preserving the main menu');
    const connectorPanelContinuity = await evaluate(`(async () => {
      const menu = document.querySelector('.connector-menu');
      const click = label => menu?.querySelector('[aria-label="' + label + '"]')?.click();
      click('线条颜色');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const panel = document.querySelector('.connector-compact-panel');
      if (!menu || !panel) return null;
      panel.getAnimations({ subtree: false }).forEach(animation => animation.finish());
      menu.getAnimations({ subtree: false }).forEach(animation => animation.finish());
      await new Promise(resolve => requestAnimationFrame(resolve));
      let panelReentries = 0;
      let menuReentries = 0;
      panel.addEventListener('animationstart', event => { if (event.target === panel && event.animationName === 'oc-menu-in') panelReentries += 1; });
      menu.addEventListener('animationstart', event => { if (event.target === menu && event.animationName === 'oc-menu-in') menuReentries += 1; });
      const samples = [];
      for (const [trigger, expected] of [['线条粗细与虚线', 'width'], ['箭头方向', 'arrow'], ['线条类型', 'line'], ['线条颜色', 'color']]) {
        click(trigger);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const current = document.querySelector('.connector-compact-panel');
        const rect = current?.getBoundingClientRect();
        samples.push({
          expected,
          panel: current?.getAttribute('data-panel'),
          samePanel: current === panel,
          sameMenu: document.querySelector('.connector-menu') === menu,
          count: document.querySelectorAll('.connector-compact-panel').length,
          inside: Boolean(rect && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight),
        });
      }
      let exitPhase = null;
      const exitObserver = new MutationObserver(() => {
        if (panel.getAttribute('data-presence') === 'exiting') exitPhase = 'exiting';
      });
      exitObserver.observe(panel, { attributes: true, attributeFilter: ['data-presence'] });
      click('线条颜色');
      for (let frame = 0; frame < 8 && exitPhase !== 'exiting'; frame += 1) {
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      click('线条粗细与虚线');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      exitObserver.disconnect();
      const reopened = document.querySelector('.connector-compact-panel');
      const immediate = {
        exitPhase,
        count: document.querySelectorAll('.connector-compact-panel').length,
        panel: reopened?.getAttribute('data-panel'),
        presence: reopened?.getAttribute('data-presence'),
        pointerEvents: reopened && getComputedStyle(reopened).pointerEvents,
      };
      await new Promise(resolve => setTimeout(resolve, 140));
      const settled = document.querySelector('.connector-compact-panel');
      return {
        samples,
        panelReentries,
        menuReentries,
        immediate,
        settled: { count: document.querySelectorAll('.connector-compact-panel').length, panel: settled?.getAttribute('data-panel'), presence: settled?.getAttribute('data-presence') },
      };
    })()`);
    if (!connectorPanelContinuity
      || connectorPanelContinuity.samples.some(sample => sample.panel !== sample.expected || !sample.samePanel || !sample.sameMenu || sample.count !== 1 || !sample.inside)
      || connectorPanelContinuity.panelReentries !== 0 || connectorPanelContinuity.menuReentries !== 0
      || connectorPanelContinuity.immediate.exitPhase !== 'exiting' || connectorPanelContinuity.immediate.count !== 1 || connectorPanelContinuity.immediate.panel !== 'width' || connectorPanelContinuity.immediate.presence !== 'open' || connectorPanelContinuity.immediate.pointerEvents === 'none'
      || connectorPanelContinuity.settled.count !== 1 || connectorPanelContinuity.settled.panel !== 'width' || connectorPanelContinuity.settled.presence !== 'open') {
      throw new Error(`Connector submenu remounted, replayed its shell motion, or left an exit ghost during rapid switching: ${JSON.stringify(connectorPanelContinuity)}`);
    }
    await evaluate(`document.querySelector('.connector-menu [aria-label="线条粗细与虚线"]')?.click()`);
    await waitFor(() => evaluate(`!document.querySelector('.connector-compact-panel')`), 2000);
    const connectorHandles = await evaluate(`(() => { const endpoints = [...document.querySelectorAll('.edge-endpoint-control')]; const insertions = document.querySelectorAll('.edge-insertion-control'); const route = document.querySelector('.edge-object.selected'); const line = route?.querySelector('.edge-line'); const controls = document.querySelector('.edge-controls-layer'); const menu = document.querySelector('.connector-menu'); const lineStyle = line && getComputedStyle(line); return { endpoints: endpoints.length, insertions: insertions.length, endpointSizes: endpoints.map(item => item.getBoundingClientRect().width), topmost: endpoints.every(item => { const rect = item.getBoundingClientRect(); const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('.edge-control-target'); return Boolean(target?.querySelector('.edge-endpoint-control')); }), routeBelowControls: Number(getComputedStyle(route).zIndex) < Number(getComputedStyle(controls).zIndex), vectorEffect: lineStyle?.vectorEffect, linecap: lineStyle?.strokeLinecap, linejoin: lineStyle?.strokeLinejoin, shapeRendering: lineStyle?.shapeRendering, menuAnimation: menu && getComputedStyle(menu).animationName }; })()`);
    // Insertion handles are intentionally hidden when their route segment sits below a card.
    // Geometry tests cover their creation; this browser check protects the interaction layering.
    if (connectorHandles.endpoints !== 2 || connectorHandles.endpointSizes.some(size => size < 10 || size > 18) || !connectorHandles.topmost || !connectorHandles.routeBelowControls || connectorHandles.vectorEffect !== 'non-scaling-stroke' || connectorHandles.linecap !== 'round' || connectorHandles.linejoin !== 'round' || connectorHandles.shapeRendering !== 'geometricprecision' || connectorHandles.menuAnimation !== 'oc-menu-in') throw new Error(`Connector geometry precision, menu motion, or controls regressed: ${JSON.stringify(connectorHandles)}`);
    const connectorExtremeZoom = await evaluate(`import('/src/store.ts').then(async module => {
      const store = module.useWorkspaceStore;
      const state = store.getState();
      const board = state.boards.find(item => item.id === state.activeBoardId);
      const connectorId = state.selection?.kind === 'connector' ? state.selection.id : null;
      const connector = board?.connectors.find(item => item.id === connectorId);
      const from = board?.placements.find(item => item.id === connector?.from);
      const to = board?.placements.find(item => item.id === connector?.to);
      const canvas = document.querySelector('.infinite-canvas');
      const rect = canvas?.getBoundingClientRect();
      if (!board || !connector || !from || !to || !rect) return null;
      const original = { ...board.viewport };
      const midpoint = { x: (from.x + from.width / 2 + to.x + to.width / 2) / 2, y: (from.y + from.height / 2 + to.y + to.height / 2) / 2 };
      const samples = [];
      for (const zoom of [.2, 2.4]) {
        store.getState().setViewport({ zoom, x: rect.width / 2 - midpoint.x * zoom, y: rect.height / 2 - midpoint.y * zoom });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const endpoints = [...document.querySelectorAll('.edge-endpoint-control')];
        const hitbox = document.querySelector('.edge-object.selected .edge-hitbox');
        samples.push({ zoom, endpoints: endpoints.length, endpointSizes: endpoints.map(item => item.getBoundingClientRect().width), hitboxVectorEffect: hitbox && getComputedStyle(hitbox).vectorEffect, hitboxStrokeWidth: hitbox && getComputedStyle(hitbox).strokeWidth });
      }
      store.getState().setViewport(original);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { samples, original, restored: store.getState().boards.find(item => item.id === board.id)?.viewport };
    })`);
    if (!connectorExtremeZoom || connectorExtremeZoom.samples.some(sample => sample.endpoints !== 2 || sample.endpointSizes.some(size => size < 10 || size > 14) || sample.hitboxVectorEffect !== 'non-scaling-stroke' || Math.abs(parseFloat(sample.hitboxStrokeWidth || '0') - 18) > .1) || JSON.stringify(connectorExtremeZoom.restored) !== JSON.stringify(connectorExtremeZoom.original)) throw new Error(`Connector hit targets changed with extreme canvas zoom: ${JSON.stringify(connectorExtremeZoom)}`);
    await evaluate(`document.querySelector('.connector-menu [aria-label="箭头方向"]')?.click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.connector-menu [aria-label="双向"]'))`), 2000);
    await evaluate(`document.querySelector('.connector-menu [aria-label="双向"]')?.click()`);
    await evaluate(`document.querySelector('.connector-menu [aria-label="线条类型"]')?.click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.connector-menu [aria-label="直线"]'))`), 2000);
    await evaluate(`document.querySelector('.connector-menu [aria-label="直线"]')?.click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.connector-menu [aria-label="标签文字"]'))`), 2000);
    await evaluate(`document.querySelector('.connector-menu [aria-label="标签文字"]')?.click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('[aria-label="编辑连线标签"]'))`), 2000);
    await waitFor(() => evaluate(`!document.querySelector('.connector-compact-panel')`), 2000);
    const inlineLabelFocus = await evaluate(`(() => ({ menu: Boolean(document.querySelector('.connector-menu')), panel: Boolean(document.querySelector('.connector-compact-panel')), input: Boolean(document.querySelector('[aria-label="编辑连线标签"]')), activeLabel: document.activeElement?.getAttribute('aria-label'), activeTag: document.activeElement?.tagName, activeClass: document.activeElement?.className }))()`);
    if (!inlineLabelFocus.menu || inlineLabelFocus.panel || !inlineLabelFocus.input || inlineLabelFocus.activeLabel !== '编辑连线标签') throw new Error(`Inline connector label did not retain menu and focus: ${JSON.stringify(inlineLabelFocus)}`);
    await evaluate(`(() => { const input = document.querySelector('[aria-label="编辑连线标签"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, '自动化关系'); input.dispatchEvent(new Event('input', { bubbles: true })); input.blur(); })()`);
    await waitFor(() => evaluate(`[...document.querySelectorAll('.edge-label')].some(label => label.textContent === '自动化关系')`), 3000);
    const connectorState = await evaluate(`import('/src/store.ts').then(module => { const board = module.useWorkspaceStore.getState().boards.find(item => item.id === module.useWorkspaceStore.getState().activeBoardId); return board?.connectors.find(item => item.label === '自动化关系'); })`);
    if (!connectorState || connectorState.arrow !== 'both' || connectorState.lineStyle !== 'straight') throw new Error(`Connector menu edits did not reach board state: ${JSON.stringify(connectorState)}`);
    const connectorDragBatch = await evaluate(`import('/src/store.ts').then(module => new Promise(resolve => { const store = module.useWorkspaceStore; const state = store.getState(); const edge = state.boards.find(item => item.id === state.activeBoardId)?.connectors.find(item => item.label === '自动化关系'); const labelText = [...document.querySelectorAll('.edge-label')].find(item => item.textContent === '自动化关系'); const label = labelText?.closest('.edge-label-group'); const rect = label?.getBoundingClientRect(); if (!edge || !label || !rect) return resolve(null); let previous = edge; let writes = 0; const unsubscribe = store.subscribe(nextState => { const next = nextState.boards.find(item => item.id === nextState.activeBoardId)?.connectors.find(item => item.id === edge.id); if (next && next !== previous) { writes += 1; previous = next; } }); const startX = rect.left + rect.width / 2; const startY = rect.top + rect.height / 2; label.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 171, clientX: startX, clientY: startY })); for (let index = 1; index <= 80; index += 1) window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 171, clientX: startX + index, clientY: startY + index * .25 })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, buttons: 0, pointerId: 171, clientX: startX + 80, clientY: startY + 20 })); requestAnimationFrame(() => { unsubscribe(); const latest = store.getState().boards.find(item => item.id === store.getState().activeBoardId)?.connectors.find(item => item.id === edge.id); resolve({ writes, points: latest?.controlPoints?.length ?? 0 }); }); }))`);
    if (!connectorDragBatch || connectorDragBatch.points !== 1 || connectorDragBatch.writes > 2) throw new Error(`Connector label drag did not coalesce high-frequency pointer samples: ${JSON.stringify(connectorDragBatch)}`);
    progress('connector creation, menu editing, inline label, and frame-batched keypoint dragging passed');

    // GitHub's hosted Windows disk can take substantially longer to drain the
    // serialized save queue after the connector stress pass. Keep requiring a
    // real saved state, but allow the slow runner to finish instead of treating
    // normal I/O backpressure as a product failure.
    await waitFor(() => evaluate(`document.querySelector('.vault-status-button')?.innerText.includes('已保存')`), 30000);
    const viewOnlyHistory = await evaluate(`window.openCanvasVault.loadWorkspace().then(async snapshot => { const board = snapshot.boards.find(item => item.id === 'performance-board'); const boardSource = 'boards/' + board.fileName; const boardBefore = (await window.openCanvasVault.listFileVersions(boardSource)).length; const desktopBefore = (await window.openCanvasVault.listFileVersions('.opencanvas/desktop.json')).length; const boardViewport = { x: board.viewport.x + 31, y: board.viewport.y - 17, zoom: Math.max(.25, Math.min(2.2, board.viewport.zoom * .97)) }; const desktopViewport = { x: snapshot.desktop.viewport.x - 23, y: snapshot.desktop.viewport.y + 19, zoom: Math.max(.25, Math.min(2.2, snapshot.desktop.viewport.zoom * 1.03)) }; await window.openCanvasVault.saveBoard({ ...board, viewport: boardViewport }); await window.openCanvasVault.saveDesktopLayout({ ...snapshot.desktop, viewport: desktopViewport }); const reloaded = await window.openCanvasVault.loadWorkspace(); return { boardBefore, boardAfter: (await window.openCanvasVault.listFileVersions(boardSource)).length, desktopBefore, desktopAfter: (await window.openCanvasVault.listFileVersions('.opencanvas/desktop.json')).length, boardViewport, persistedBoardViewport: reloaded.boards.find(item => item.id === board.id)?.viewport, desktopViewport, persistedDesktopViewport: reloaded.desktop.viewport }; })`);
    if (viewOnlyHistory.boardAfter !== viewOnlyHistory.boardBefore || viewOnlyHistory.desktopAfter !== viewOnlyHistory.desktopBefore || JSON.stringify(viewOnlyHistory.persistedBoardViewport) !== JSON.stringify(viewOnlyHistory.boardViewport) || JSON.stringify(viewOnlyHistory.persistedDesktopViewport) !== JSON.stringify(viewOnlyHistory.desktopViewport)) throw new Error(`View-only persistence polluted meaningful file history or failed to save: ${JSON.stringify(viewOnlyHistory)}`);
    progress('board and desktop viewports persisted without consuming content-history slots');

    const fileOrganizationRoundtrip = await evaluate(`(async () => {
      const store = window.__openCanvasQaStore;
      const original = store.getState().cards.find(card => card.id === 'archive-card');
      const created = await store.getState().createFolder('磁盘往返');
      const moved = await store.getState().moveCardToFolder('archive-card', '磁盘往返');
      const renamed = await store.getState().renameCardFile('archive-card', '归档说明重命名');
      const renamedCard = store.getState().cards.find(card => card.id === 'archive-card');
      const folderRenamed = await store.getState().renameFolder('磁盘往返', '磁盘整理');
      const container = await store.getState().createFolder('容器');
      const folderMoved = await store.getState().moveFolder('磁盘整理', '容器');
      const finalCard = store.getState().cards.find(card => card.id === 'archive-card');
      const referringCard = store.getState().cards.find(card => card.id === 'performance-card');
      return { originalPath: original?.relativePath, created, moved, renamed, renamedPath: renamedCard?.relativePath, folderRenamed, container, folderMoved, finalPath: finalCard?.relativePath, referenceBody: referringCard?.body };
    })()`);
    const organizedSnapshot = await evaluate(`window.openCanvasVault.loadWorkspace().then(snapshot => ({ card: snapshot.cards.find(card => card.id === 'archive-card'), referenceBody: snapshot.cards.find(card => card.id === 'performance-card')?.body, folders: snapshot.folders }))`);
    const finalOrganizedPath = fileOrganizationRoundtrip.finalPath;
    if (!fileOrganizationRoundtrip.created || !fileOrganizationRoundtrip.moved || !fileOrganizationRoundtrip.renamed || !fileOrganizationRoundtrip.folderRenamed || !fileOrganizationRoundtrip.container || !fileOrganizationRoundtrip.folderMoved
      || !finalOrganizedPath?.startsWith('容器/磁盘整理/')
      || organizedSnapshot.card?.relativePath !== finalOrganizedPath
      || !organizedSnapshot.referenceBody?.includes('[[容器/磁盘整理/')
      || !fsSync.existsSync(path.join(vault, 'notes', ...finalOrganizedPath.split('/')))
      || fsSync.existsSync(path.join(vault, 'notes', ...String(fileOrganizationRoundtrip.originalPath).split('/')))
      || fsSync.existsSync(path.join(vault, 'notes', ...String(fileOrganizationRoundtrip.renamedPath).split('/')))
      || !organizedSnapshot.folders.includes('容器/磁盘整理')) {
      throw new Error(`Real disk move/rename/link rewrite roundtrip failed: ${JSON.stringify({ fileOrganizationRoundtrip, organizedSnapshot })}`);
    }
    progress('real disk card/folder move, rename, and Markdown-link rewrite roundtrip passed');

    const forcedRollback = await evaluate(`window.openCanvasVault.applyFilePlan({
      cards: [],
      boards: [{ id: 'rollback-board', fileName: '../rollback.board.json' }],
      projects: [],
      folders: ['rollback-source'],
      writeCardIds: [],
      writeBoardIds: ['rollback-board'],
      directoryMoves: [{ from: 'rollback-source', to: 'rollback-target' }]
    }).then(() => ({ rejected: false }), error => ({ rejected: true, message: String(error?.message || error) }))`);
    if (!forcedRollback.rejected
      || !fsSync.existsSync(path.join(vault, 'notes', 'rollback-source', 'probe.txt'))
      || fsSync.existsSync(path.join(vault, 'notes', 'rollback-target'))
      || (await fs.readdir(path.join(vault, '.opencanvas', 'file-plan-transactions'))).length) {
      throw new Error(`Failed file plan did not roll its directory move back atomically: ${JSON.stringify(forcedRollback)}`);
    }
    progress('failed file-plan directory move rolled back without residue');

    const editedTitle = '桌面端自动保存验收';
    await evaluate(`window.openCanvasVault.loadWorkspace().then(snapshot => { const card = { ...snapshot.cards[0], title: ${JSON.stringify(editedTitle)}, updatedAt: new Date().toISOString() }; return window.openCanvasVault.saveCard(card); })`);
    const savedFile = await waitFor(async () => {
      const noteRoot = path.join(vault, 'notes');
      if (!fsSync.existsSync(noteRoot)) return null;
      const entries = await fs.readdir(noteRoot, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const fullPath = path.join(entry.parentPath || entry.path, entry.name);
        if ((await fs.readFile(fullPath, 'utf8')).includes(editedTitle)) return fullPath;
      }
      return null;
    });
    if (!savedFile) throw new Error('Edited card did not reach Markdown storage');

    const versionCheck = await evaluate(`window.openCanvasVault.loadWorkspace().then(async snapshot => { const card = snapshot.cards[0]; await window.openCanvasVault.saveCard({ ...card, title: '版本二', updatedAt: new Date().toISOString() }); const versions = await window.openCanvasVault.listFileVersions('notes/' + card.relativePath); return { count: versions.length, id: versions[0]?.id }; })`);
    if (!versionCheck?.count || !versionCheck.id) throw new Error('Automatic file history was not created');
    const restoredVersion = await evaluate(`window.openCanvasVault.restoreFileVersion(${JSON.stringify(versionCheck.id)})`);
    if (!restoredVersion) throw new Error('Restoring a file history version failed');
    progress('atomic save and history passed');

    const attachmentCheck = await evaluate(`window.openCanvasVault.listAttachments()`);
    if (!attachmentCheck.some((entry) => entry.relativePath === 'attachments/smoke.svg' && entry.mimeType === 'image/svg+xml' && entry.referencedBy.length === 0)) throw new Error('Attachment reference inventory failed');
    const pastedAttachment = await evaluate(`window.openCanvasVault.importAttachmentData({ name: 'pasted.txt', mimeType: 'text/plain', dataBase64: 'cGFzdGVkIGF0dGFjaG1lbnQ=' })`);
    if (!pastedAttachment?.relativePath || !pastedAttachment.relativePath.startsWith('attachments/pasted--') || pastedAttachment.size !== 17) throw new Error('Clipboard/drop attachment persistence or metadata failed');
    const attachmentRemoved = await evaluate(`window.openCanvasVault.deleteAttachment('attachments/smoke.svg')`);
    if (!attachmentRemoved) throw new Error('Moving an orphan attachment to trash failed');
    const trashEntry = await evaluate(`window.openCanvasVault.listTrash().then(entries => entries.find(entry => entry.sourcePath === 'attachments/smoke.svg'))`);
    if (!trashEntry?.id) throw new Error('Attachment did not appear in trash');
    const restoredAttachment = await evaluate(`window.openCanvasVault.restoreTrashEntry(${JSON.stringify(trashEntry.id)})`);
    if (restoredAttachment !== 'attachments/smoke.svg') throw new Error('Restoring an attachment from trash failed');

    const assetOk = await evaluate(`new Promise(resolve => { const image = new Image(); image.onload = () => resolve(true); image.onerror = () => resolve(false); image.src = 'opencanvas-asset://vault/attachments/smoke.svg'; })`);
    if (!assetOk) throw new Error('Local asset protocol failed');
    const escapedAssetStatus = await evaluate(`fetch('opencanvas-asset://vault/attachments/%2e%2e/notes/performance.md').then(response => response.status, () => 0)`);
    if (escapedAssetStatus === 200) throw new Error('Local asset protocol escaped the attachments directory');
    if (await evaluate(`window.openCanvasVault.openExternal('javascript:alert(1)')`)) throw new Error('Dangerous external URL protocol was accepted');
    const pastedPath = JSON.stringify(pastedAttachment.relativePath);
    const pastedRemoved = await evaluate(`window.openCanvasVault.deleteAttachment(${pastedPath})`);
    if (!pastedRemoved) throw new Error('Imported attachment could not be moved to trash');
    const pastedTrashId = await evaluate(`window.openCanvasVault.listTrash().then(entries => entries.find(entry => entry.sourcePath === ${pastedPath})?.id)`);
    if (!pastedTrashId || !await evaluate(`window.openCanvasVault.deleteTrashEntry(${JSON.stringify(pastedTrashId)})`)) throw new Error('Permanent trash deletion failed');
    progress('attachments and trash passed');

    await delay(1100);
    const externalPath = path.join(vault, 'notes', 'external-smoke.md');
    await fs.writeFile(externalPath, `---\nid: "external-smoke"\ntitle: "外部变更自动载入"\ncreatedAt: "2026-01-01T00:00:00.000Z"\nupdatedAt: "2026-01-01T00:00:00.000Z"\n---\n\n外部写入\n`, 'utf8');
    await delay(700);
    await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '卡片库')?.click()`);
    await waitFor(() => evaluate(`import('/src/store.ts').then(module => module.useWorkspaceStore.getState().cards.some(card => card.title === '外部变更自动载入'))`), 8000);
    await evaluate(`(() => { const input = document.querySelector('.sidebar-search input'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, '外部变更自动载入'); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '外部变更自动载入' })); })()`);
    await waitFor(() => evaluate(`[...document.querySelectorAll('.sidebar-entity-row')].some(row => row.textContent.includes('外部变更自动载入'))`), 3000);

    const focusedEditor = await evaluate(`(() => { const input = document.querySelector('.sidebar-search input'); input?.focus(); return Boolean(input && document.activeElement === input); })()`);
    if (!focusedEditor) throw new Error('Could not focus a card editor before the conflict check');
    await delay(1100);
    await fs.appendFile(externalPath, '\n再次外部修改\n', 'utf8');
    try {
      await waitFor(() => evaluate(`Boolean(document.querySelector('.vault-conflict-dialog'))`), 8000);
    } catch (error) {
      const diagnostic = await evaluate(`({ active: document.activeElement?.outerHTML?.slice(0, 180), status: document.querySelector('.vault-status-button')?.innerText })`);
      throw new Error(`Conflict dialog did not appear: ${JSON.stringify(diagnostic)}; ${error.message}`);
    }
    await evaluate(`[...document.querySelectorAll('.vault-conflict-dialog button')].find(button => button.textContent.includes('使用磁盘版本'))?.click()`);
    await waitFor(() => evaluate(`!document.querySelector('.vault-conflict-dialog')`), 8000);
    progress('external reload and conflict resolution passed');

    const visualScene = await evaluate(`(() => {
      const store = window.__openCanvasQaStore;
      let state = store.getState();
      state.notices.forEach(notice => state.dismissNotice(notice.id));
      const board = state.createBoard('Section 与连线视觉验收');
      state.openBoard(board.id, false);
      state = store.getState();
      const cards = [
        state.createCard('研究问题', '## 核心问题\\n把复杂主题拆成可以验证的具体问题。'),
        state.createCard('证据材料', '## 可靠来源\\n整理事实、访谈记录和反例。'),
        state.createCard('阶段结论', '## 当前判断\\n保留假设边界，并记录下一步行动。'),
      ];
      const placements = [
        state.addCardPlacement(cards[0].id, { x: 40, y: 80 }),
        state.addCardPlacement(cards[1].id, { x: 500, y: 80 }),
        state.addCardPlacement(cards[2].id, { x: 270, y: 360 }),
      ];
      if (placements.some(item => !item)) return null;
      state.updateBoardLayout(Object.fromEntries(placements.map(item => [item.id, { width: 360, height: 190 }])));
      state.setSelection({ kind: 'placement', id: placements[0].id, ids: placements.map(item => item.id) });
      state.frameSelection();
      state = store.getState();
      const active = state.boards.find(item => item.id === board.id);
      const section = active?.placements.find(item => item.isFrame);
      if (!section) return null;
      state.updatePlacement(section.id, { text: '研究路径' });
      state.connectPlacements(placements[0].id, placements[1].id, { fromAnchor: 'right', toAnchor: 'left' });
      state.connectPlacements(placements[1].id, placements[2].id, { fromAnchor: 'bottom', toAnchor: 'right' });
      state = store.getState();
      const latest = state.boards.find(item => item.id === board.id);
      const firstConnector = latest?.connectors.find(item => item.from === placements[0].id && item.to === placements[1].id);
      const secondConnector = latest?.connectors.find(item => item.from === placements[1].id && item.to === placements[2].id);
      if (!firstConnector || !secondConnector) return null;
      state.updateConnector(firstConnector.id, { label: '提出问题', color: 'blue', width: 3.5 });
      state.updateConnector(secondConnector.id, { label: '形成判断', color: 'green', width: 3.5, dashed: true });
      state.setViewport({ x: 92, y: 116, zoom: .78 });
      state.setSelection({ kind: 'placement', id: section.id, ids: [section.id] });
      return { boardId: board.id, sectionId: section.id, placementIds: placements.map(item => item.id), firstConnectorId: firstConnector.id, secondConnectorId: secondConnector.id };
    })()`);
    if (!visualScene) throw new Error('Could not create the isolated Section/connector visual scene');
    await waitFor(() => evaluate(`document.querySelectorAll('.canvas-node.node-note').length === 3 && document.querySelectorAll('.edge-object:not(.edge-draft)').length === 2 && Boolean(document.querySelector('.node-frame.selected'))`), 5000);
    await evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); if (state.darkMode) state.toggleDarkMode(); return true; })()`);
    await waitFor(() => evaluate(`document.querySelector('.app-shell')?.getAttribute('data-theme') === 'light'`), 2000);
    await captureElementArtifact('light-section-connector-overview', '.infinite-canvas');
    const sectionMenuPoint = await evaluate(`(() => { const chip = document.querySelector('[data-placement-id="${visualScene.sectionId}"] .section-title-chip'); const rect = chip?.getBoundingClientRect(); return rect && { x: rect.left + Math.min(46, rect.width / 2), y: rect.top + rect.height / 2 }; })()`);
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sectionMenuPoint.x, y: sectionMenuPoint.y, button: 'right', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sectionMenuPoint.x, y: sectionMenuPoint.y, button: 'right', clickCount: 1 });
    await waitFor(() => evaluate(`Boolean(document.querySelector('.canvas-context-menu[role="menu"]'))`), 2000);
    const defaultSectionSurface = await evaluate(`(() => {
      const section = document.querySelector('[data-placement-id="${visualScene.sectionId}"]');
      const chip = section?.querySelector('.section-title-chip');
      const group = document.querySelector('.canvas-context-menu [aria-label="区块颜色"]');
      if (!section || !chip || !group) return null;
      const style = getComputedStyle(section, '::before');
      return {
        background: style.backgroundColor,
        borderColor: style.borderColor,
        borderWidth: style.borderWidth,
        shadow: style.boxShadow,
        chipBackground: getComputedStyle(chip).backgroundColor,
        parentZ: getComputedStyle(section).zIndex,
        titleZ: getComputedStyle(chip).zIndex,
        swatches: group.querySelectorAll('[role="menuitemradio"]').length,
        current: group.querySelector('[role="menuitemradio"][aria-checked="true"]')?.getAttribute('aria-label'),
      };
    })()`);
    if (!defaultSectionSurface
      || defaultSectionSurface.swatches !== 9
      || !defaultSectionSurface.current?.startsWith('默认灰色')
      || Number.parseFloat(defaultSectionSurface.borderWidth) < 2.5
      || Number.parseFloat(defaultSectionSurface.borderWidth) > 3.1
      || defaultSectionSurface.parentZ !== 'auto'
      || Number.parseFloat(defaultSectionSurface.titleZ) < 70
      || !defaultSectionSurface.shadow.includes('inset')) {
      throw new Error(`Default Section surface/menu did not match the reference state: ${JSON.stringify(defaultSectionSurface)}`);
    }
    await captureElementArtifact('light-section-menu', '.infinite-canvas');
    await evaluate(`document.querySelector('.canvas-context-menu [aria-label="区块颜色"] [aria-label^="蓝色"]')?.click()`);
    const blueSectionSurface = await waitFor(() => evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === state.activeBoardId);
      const data = board?.placements.find(item => item.id === ${JSON.stringify(visualScene.sectionId)});
      const section = document.querySelector('[data-placement-id="${visualScene.sectionId}"]');
      const chip = section?.querySelector('.section-title-chip');
      if (data?.color !== 'blue' || !section?.classList.contains('node-color-blue') || !chip) return null;
      const style = getComputedStyle(section, '::before');
      return { color: data.color, background: style.backgroundColor, borderColor: style.borderColor, shadow: style.boxShadow, chipBackground: getComputedStyle(chip).backgroundColor };
    })()`), 2000);
    if (blueSectionSurface.background === defaultSectionSurface.background
      || blueSectionSurface.chipBackground === defaultSectionSurface.chipBackground
      || !blueSectionSurface.shadow.includes('inset')) {
      throw new Error(`Section color did not update its surface and title together: ${JSON.stringify({ defaultSectionSurface, blueSectionSurface })}`);
    }
    await captureElementArtifact('light-section-blue-selected', '.infinite-canvas');
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sectionMenuPoint.x, y: sectionMenuPoint.y, button: 'right', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sectionMenuPoint.x, y: sectionMenuPoint.y, button: 'right', clickCount: 1 });
    await waitFor(() => evaluate(`Boolean(document.querySelector('.canvas-context-menu[role="menu"]'))`), 2000);
    const lightSectionRenameBefore = await evaluate(`document.querySelector('[data-placement-id="${visualScene.sectionId}"] .section-title-chip')?.getBoundingClientRect().toJSON()`);
    await evaluate(`[...document.querySelectorAll('.canvas-context-menu[role="menu"] [role="menuitem"]')].find(item => item.textContent.includes('重命名区块'))?.click()`);
    const lightSectionRenameDuring = await waitFor(() => evaluate(`(() => { const editor = document.querySelector('[data-placement-id="${visualScene.sectionId}"] .section-title-editor'); const chip = editor?.closest('.section-title-chip'); const rect = chip?.getBoundingClientRect(); return editor && rect ? { focused: document.activeElement === editor, rect: rect.toJSON() } : null; })()`), 2000);
    if (!lightSectionRenameDuring.focused || Math.abs(lightSectionRenameDuring.rect.width - lightSectionRenameBefore.width) > 1 || Math.abs(lightSectionRenameDuring.rect.height - lightSectionRenameBefore.height) > 1 || Math.abs(lightSectionRenameDuring.rect.top - lightSectionRenameBefore.top) > 1) throw new Error(`Light Section rename changed chip geometry: ${JSON.stringify({ lightSectionRenameBefore, lightSectionRenameDuring })}`);
    await captureElementArtifact('light-section-rename', '.infinite-canvas');
    await key('Enter', 'Enter', 13);
    await waitFor(() => evaluate(`!document.querySelector('[data-placement-id="${visualScene.sectionId}"] .section-title-editor')`), 2000);
    await evaluate(`(() => { window.__openCanvasQaStore.getState().setSelection({ kind: 'connector', id: ${JSON.stringify(visualScene.firstConnectorId)} }); return true; })()`);
    await waitFor(() => evaluate(`document.querySelectorAll('.edge-controls-layer .edge-endpoint-control').length === 2`), 2000);
    const reattachPoints = await evaluate(`(() => {
      const endpoints = [...document.querySelectorAll('.edge-controls-layer .edge-endpoint-control')];
      const endpoint = endpoints[1]?.getBoundingClientRect();
      const target = document.querySelector('[data-placement-id="${visualScene.placementIds[2]}"]')?.getBoundingClientRect();
      return endpoint && target ? { from: { x: endpoint.left + endpoint.width / 2, y: endpoint.top + endpoint.height / 2 }, to: { x: target.left, y: target.top + target.height / 2 } } : null;
    })()`);
    if (!reattachPoints) throw new Error('Connector endpoint controls were not available in the isolated visual scene');
    await mouse('mousePressed', reattachPoints.from.x, reattachPoints.from.y);
    await mouse('mouseMoved', reattachPoints.to.x, reattachPoints.to.y, { buttons: 1 });
    await waitFor(() => evaluate(`document.querySelector('[data-placement-id="${visualScene.placementIds[2]}"]')?.classList.contains('connection-target')`), 2000);
    const liveReattachLabel = await evaluate(`(() => { const label = document.querySelector('.edge-object.selected .edge-label-group')?.getBoundingClientRect(); const source = document.querySelector('[data-placement-id="${visualScene.placementIds[0]}"]')?.getBoundingClientRect(); return label && source ? { y: label.top + label.height / 2, sourceY: source.top + source.height / 2 } : null; })()`);
    if (!liveReattachLabel || liveReattachLabel.y < liveReattachLabel.sourceY + 40) throw new Error(`Connector label did not follow the temporary endpoint route: ${JSON.stringify(liveReattachLabel)}`);
    await captureElementArtifact('light-connector-reattach-preview', '.infinite-canvas');
    await mouse('mouseReleased', reattachPoints.to.x, reattachPoints.to.y);
    const reattached = await waitFor(() => evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); const board = state.boards.find(item => item.id === state.activeBoardId); const edge = board?.connectors.find(item => item.id === ${JSON.stringify(visualScene.firstConnectorId)}); return edge?.to === ${JSON.stringify(visualScene.placementIds[2])} ? { to: edge.to, toAnchor: edge.toAnchor } : null; })()`), 3000);
    if (reattached.toAnchor !== 'left') throw new Error(`Connector reattachment did not preserve the chosen target port: ${JSON.stringify(reattached)}`);
    await evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); if (!state.darkMode) state.toggleDarkMode(); state.setSelection({ kind: 'connector', id: ${JSON.stringify(visualScene.firstConnectorId)} }); return true; })()`);
    await waitFor(() => evaluate(`document.querySelector('.app-shell')?.getAttribute('data-theme') === 'dark' && document.querySelectorAll('.edge-controls-layer .edge-endpoint-control').length === 2`), 2000);
    const darkBlueSectionSurface = await evaluate(`(() => {
      const section = document.querySelector('[data-placement-id="${visualScene.sectionId}"]');
      const chip = section?.querySelector('.section-title-chip');
      const canvas = document.querySelector('.infinite-canvas');
      if (!section || !chip || !canvas) return null;
      const style = getComputedStyle(section, '::before');
      return { background: style.backgroundColor, canvas: getComputedStyle(canvas).backgroundColor, shadow: style.boxShadow, chipBackground: getComputedStyle(chip).backgroundColor };
    })()`);
    if (!darkBlueSectionSurface
      || darkBlueSectionSurface.background === darkBlueSectionSurface.canvas
      || darkBlueSectionSurface.background === blueSectionSurface.background
      || !darkBlueSectionSurface.shadow.includes('inset')) {
      throw new Error(`Dark blue Section did not retain a distinct theme-aware surface: ${JSON.stringify({ blueSectionSurface, darkBlueSectionSurface })}`);
    }
    await captureElementArtifact('dark-section-connector-selected', '.infinite-canvas');
    const openedDarkConnectorMenu = await evaluate(`(() => { const path = document.querySelector('.edge-object.selected .edge-hitbox'); const label = document.querySelector('.edge-object.selected .edge-label-group'); const rect = label?.getBoundingClientRect() ?? path?.getBoundingClientRect(); if (!path || !rect) return false; path.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 })); return true; })()`);
    if (openedDarkConnectorMenu) {
      await waitFor(() => evaluate(`Boolean(document.querySelector('.connector-menu[role="menu"]'))`), 2000);
      await captureElementArtifact('dark-connector-menu', '.infinite-canvas');
      await key('Escape', 'Escape', 27);
    }
    await waitFor(() => evaluate(`document.querySelectorAll('.edge-controls-layer .edge-endpoint-control').length === 2`), 2000);
    const darkReattachPoints = await evaluate(`(() => {
      const endpoints = [...document.querySelectorAll('.edge-controls-layer .edge-endpoint-control')];
      const endpoint = endpoints[1]?.getBoundingClientRect();
      const target = document.querySelector('[data-placement-id="${visualScene.placementIds[1]}"]')?.getBoundingClientRect();
      return endpoint && target ? { from: { x: endpoint.left + endpoint.width / 2, y: endpoint.top + endpoint.height / 2 }, to: { x: target.left, y: target.top + target.height / 2 } } : null;
    })()`);
    if (!darkReattachPoints) throw new Error('Dark connector reattachment controls were not available');
    await mouse('mousePressed', darkReattachPoints.from.x, darkReattachPoints.from.y);
    await mouse('mouseMoved', darkReattachPoints.to.x, darkReattachPoints.to.y, { buttons: 1 });
    await waitFor(() => evaluate(`document.querySelector('[data-placement-id="${visualScene.placementIds[1]}"]')?.classList.contains('connection-target')`), 2000);
    await captureElementArtifact('dark-connector-reattach-preview', '.infinite-canvas');
    await key('Escape', 'Escape', 27);
    const darkReattachCancelled = await waitFor(() => evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); const edge = state.boards.find(item => item.id === state.activeBoardId)?.connectors.find(item => item.id === ${JSON.stringify(visualScene.firstConnectorId)}); return !document.querySelector('.connection-target') && edge?.to === ${JSON.stringify(visualScene.placementIds[2])} ? { to: edge.to, toAnchor: edge.toAnchor } : null; })()`), 2000);
    if (darkReattachCancelled.toAnchor !== 'left') throw new Error(`Cancelling dark connector reattachment changed its fixed port: ${JSON.stringify(darkReattachCancelled)}`);
    await evaluate(`(() => { window.__openCanvasQaStore.getState().setSelection({ kind: 'placement', id: ${JSON.stringify(visualScene.sectionId)}, ids: [${JSON.stringify(visualScene.sectionId)}] }); return true; })()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('[data-placement-id="${visualScene.sectionId}"] .section-title-chip'))`), 2000);
    const darkSectionRenameBefore = await evaluate(`document.querySelector('[data-placement-id="${visualScene.sectionId}"] .section-title-chip')?.getBoundingClientRect().toJSON()`);
    await evaluate(`document.querySelector('[data-placement-id="${visualScene.sectionId}"] [aria-label="打开区块菜单"]')?.click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.canvas-context-menu[role="menu"]'))`), 2000);
    await evaluate(`[...document.querySelectorAll('.canvas-context-menu[role="menu"] [role="menuitem"]')].find(item => item.textContent.includes('重命名区块'))?.click()`);
    const darkSectionRenameDuring = await waitFor(() => evaluate(`(() => { const editor = document.querySelector('[data-placement-id="${visualScene.sectionId}"] .section-title-editor'); const chip = editor?.closest('.section-title-chip'); const rect = chip?.getBoundingClientRect(); return editor && rect ? { focused: document.activeElement === editor, rect: rect.toJSON() } : null; })()`), 2000);
    if (!darkSectionRenameDuring.focused || Math.abs(darkSectionRenameDuring.rect.width - darkSectionRenameBefore.width) > 1 || Math.abs(darkSectionRenameDuring.rect.height - darkSectionRenameBefore.height) > 1 || Math.abs(darkSectionRenameDuring.rect.top - darkSectionRenameBefore.top) > 1) throw new Error(`Dark Section rename changed chip geometry: ${JSON.stringify({ darkSectionRenameBefore, darkSectionRenameDuring })}`);
    await captureElementArtifact('dark-section-rename', '.infinite-canvas');
    await key('Enter', 'Enter', 13);
    await waitFor(() => evaluate(`!document.querySelector('[data-placement-id="${visualScene.sectionId}"] .section-title-editor')`), 2000);
    const pointerTypeMatrix = await evaluate(`(() => {
      const store = window.__openCanvasQaStore;
      const cardId = ${JSON.stringify(visualScene.placementIds[0])};
      const touchCardId = ${JSON.stringify(visualScene.placementIds[1])};
      const snapshot = () => {
        const state = store.getState();
        const board = state.boards.find(item => item.id === state.activeBoardId);
        const card = board?.placements.find(item => item.id === cardId);
        return { selection: state.selection, card: card && { x: card.x, y: card.y, width: card.width, height: card.height } };
      };
      store.getState().setSelection(null);
      const penNode = document.querySelector('[data-placement-id="' + cardId + '"]');
      const penToolbar = penNode?.querySelector('.card-selection-toolbar');
      const penRect = penToolbar?.getBoundingClientRect();
      if (!penNode || !penRect) return { error: 'pen target missing' };
      const penPoint = { x: penRect.left + 44, y: penRect.top + penRect.height / 2 };
      const penBefore = snapshot();
      penToolbar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 901, pointerType: 'pen', pressure: .62, clientX: penPoint.x, clientY: penPoint.y }));
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 901, pointerType: 'pen', pressure: .54, clientX: penPoint.x + 62, clientY: penPoint.y + 34 }));
      window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, cancelable: true, pointerId: 901, pointerType: 'pen', pressure: 0, clientX: penPoint.x + 62, clientY: penPoint.y + 34 }));
      const penAfter = snapshot();
      const touchNode = document.querySelector('[data-placement-id="' + touchCardId + '"]');
      const touchToolbar = touchNode?.querySelector('.card-selection-toolbar');
      const touchRect = touchToolbar?.getBoundingClientRect();
      if (!touchNode || !touchRect) return { error: 'touch target missing', penBefore, penAfter };
      const touchPoint = { x: touchRect.left + 48, y: touchRect.top + touchRect.height / 2 };
      touchToolbar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 902, pointerType: 'touch', width: 18, height: 18, pressure: .5, clientX: touchPoint.x, clientY: touchPoint.y }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, buttons: 0, pointerId: 902, pointerType: 'touch', pressure: 0, clientX: touchPoint.x, clientY: touchPoint.y }));
      return { penBefore, penAfter, touchSelection: store.getState().selection };
    })()`);
    if (pointerTypeMatrix.error
      || JSON.stringify(pointerTypeMatrix.penBefore) !== JSON.stringify(pointerTypeMatrix.penAfter)
      || pointerTypeMatrix.touchSelection?.kind !== 'placement'
      || pointerTypeMatrix.touchSelection?.id !== visualScene.placementIds[1]) {
      throw new Error(`Pen/touch pointer matrix regressed: ${JSON.stringify(pointerTypeMatrix)}`);
    }
    const lowZoomCardProfile = await evaluate(`(async () => {
      const store = window.__openCanvasQaStore;
      const state = store.getState();
      const board = state.boards.find(item => item.id === state.activeBoardId);
      const placement = board?.placements.find(item => item.id === ${JSON.stringify(visualScene.placementIds[0])});
      const canvas = document.querySelector('.infinite-canvas')?.getBoundingClientRect();
      if (!placement || !canvas) return null;
      store.getState().setSelection({ kind: 'placement', id: placement.id, ids: [placement.id] });
      store.getState().setViewport({ zoom: .2, x: canvas.width / 2 - (placement.x + placement.width / 2) * .2, y: canvas.height / 2 - (placement.y + placement.height / 2) * .2 });
      await new Promise(resolve => setTimeout(resolve, 140));
      await new Promise(resolve => requestAnimationFrame(resolve));
      const node = document.querySelector('[data-placement-id="' + placement.id + '"]');
      node?.getAnimations({ subtree: true }).forEach(animation => animation.finish());
      await new Promise(resolve => requestAnimationFrame(resolve));
      const rect = node?.getBoundingClientRect();
      const ring = node && getComputedStyle(node, '::after');
      const style = node && getComputedStyle(node);
      return node && rect && ring && style ? {
        theme: document.querySelector('.app-shell')?.getAttribute('data-theme'),
        rect: { width: rect.width, height: rect.height },
        expected: { width: placement.width * .2, height: placement.height * .2 },
        ringOpacity: ring.opacity,
        ringShadow: ring.boxShadow,
        surfaceShadow: style.boxShadow,
        multiBounds: document.querySelectorAll('.multi-selection-bounds').length,
        selected: document.querySelectorAll('.canvas-node.selected').length,
        editing: node.classList.contains('card-editing'),
      } : null;
    })()`);
    if (!lowZoomCardProfile
      || lowZoomCardProfile.theme !== 'dark'
      || Math.abs(lowZoomCardProfile.rect.width - lowZoomCardProfile.expected.width) > 1
      || Math.abs(lowZoomCardProfile.rect.height - lowZoomCardProfile.expected.height) > 1
      || lowZoomCardProfile.ringOpacity !== '1'
      || lowZoomCardProfile.ringShadow === 'none'
      || lowZoomCardProfile.multiBounds !== 0
      || lowZoomCardProfile.selected !== 1
      || lowZoomCardProfile.editing) {
      throw new Error(`Twenty-percent card selection changed geometry or exposed an extra selection layer: ${JSON.stringify(lowZoomCardProfile)}`);
    }
    await captureElementArtifact('dark-card-selected-20-percent', '.infinite-canvas');
    await evaluate(`window.__openCanvasQaStore.getState().toggleDarkMode()`);
    await waitFor(() => evaluate(`document.querySelector('.app-shell')?.getAttribute('data-theme') === 'light'`), 2000);
    await captureElementArtifact('light-card-selected-20-percent', '.infinite-canvas');
    await evaluate(`window.__openCanvasQaStore.getState().toggleDarkMode()`);
    await waitFor(() => evaluate(`document.querySelector('.app-shell')?.getAttribute('data-theme') === 'dark'`), 2000);
    progress('isolated light/dark Section, low-zoom card selection, menu, live-label endpoint reattachment, pen cancellation, and touch selection artifacts passed');

    const lockedMultiSelection = await evaluate(`(() => {
      const store = window.__openCanvasQaStore;
      const state = store.getState();
      const [lockedId, freeAId, freeBId] = ${JSON.stringify(['__LOCKED__', '__FREE_A__', '__FREE_B__'])}.map((token, index) => ${JSON.stringify(visualScene.placementIds)}[index]);
      state.updateBoardLayout({
        [lockedId]: { x: 200, y: 180, width: 300, height: 150 },
        [freeAId]: { x: 400, y: 80, width: 300, height: 150 },
        [freeBId]: { x: 400, y: 270, width: 300, height: 150 },
      });
      state.updatePlacement(lockedId, { locked: true });
      state.setSelection({ kind: 'placement', id: freeAId, ids: [lockedId, freeAId, freeBId] });
      const canvas = document.querySelector('.infinite-canvas')?.getBoundingClientRect();
      if (!canvas) return null;
      const center = { x: 550, y: 250 };
      state.setViewport({ zoom: 2.4, x: canvas.width / 2 - center.x * 2.4, y: canvas.height / 2 - center.y * 2.4 });
      return { lockedId, freeAId, freeBId };
    })()`);
    if (!lockedMultiSelection) throw new Error('Could not establish the locked high-zoom multi-selection fixture');
    const lockedHighZoomProfile = await waitFor(() => evaluate(`(() => {
      const ids = ${JSON.stringify(lockedMultiSelection)};
      const locked = document.querySelector('[data-placement-id="' + ids.lockedId + '"]');
      const free = [ids.freeAId, ids.freeBId].map(id => document.querySelector('[data-placement-id="' + id + '"]'));
      const bounds = document.querySelector('.multi-selection-bounds');
      const lockedRect = locked?.getBoundingClientRect();
      const freeRects = free.map(item => item?.getBoundingClientRect());
      const boundsRect = bounds?.getBoundingClientRect();
      if (!lockedRect || freeRects.some(item => !item) || !boundsRect) return null;
      const union = {
        left: Math.min(...freeRects.map(item => item.left)),
        top: Math.min(...freeRects.map(item => item.top)),
        right: Math.max(...freeRects.map(item => item.right)),
        bottom: Math.max(...freeRects.map(item => item.bottom)),
      };
      return {
        theme: document.querySelector('.app-shell')?.getAttribute('data-theme'),
        selected: document.querySelectorAll('.canvas-node.selected').length,
        lockedSelected: locked.classList.contains('selected'),
        lockedClass: locked.classList.contains('node-locked'),
        lockedLeft: lockedRect.left,
        bounds: boundsRect.toJSON(),
        union,
        delta: {
          left: Math.abs(boundsRect.left - union.left), top: Math.abs(boundsRect.top - union.top),
          right: Math.abs(boundsRect.right - union.right), bottom: Math.abs(boundsRect.bottom - union.bottom),
        },
      };
    })()`), 4000);
    if (lockedHighZoomProfile.theme !== 'dark' || lockedHighZoomProfile.selected !== 3 || !lockedHighZoomProfile.lockedSelected || !lockedHighZoomProfile.lockedClass || Object.values(lockedHighZoomProfile.delta).some(value => value > 1) || Math.abs(lockedHighZoomProfile.bounds.left - lockedHighZoomProfile.lockedLeft) < 100) throw new Error(`Locked high-zoom multi-selection bounds regressed: ${JSON.stringify(lockedHighZoomProfile)}`);
    await captureElementArtifact('dark-locked-multiselect-high-zoom', '.infinite-canvas');
    await evaluate(`window.__openCanvasQaStore.getState().toggleDarkMode()`);
    await waitFor(() => evaluate(`document.querySelector('.app-shell')?.getAttribute('data-theme') === 'light'`), 2000);
    await captureElementArtifact('light-locked-multiselect-high-zoom', '.infinite-canvas');
    const lockedTidyResult = await evaluate(`(() => {
      const store = window.__openCanvasQaStore;
      const ids = ${JSON.stringify(lockedMultiSelection)};
      const snapshot = () => {
        const state = store.getState();
        const board = state.boards.find(item => item.id === state.activeBoardId);
        return Object.fromEntries([ids.lockedId, ids.freeAId, ids.freeBId].map(id => { const item = board?.placements.find(placement => placement.id === id); return [id, item && { x: item.x, y: item.y }]; }));
      };
      const before = snapshot();
      store.getState().tidySelection('align-top');
      return { before, after: snapshot() };
    })()`);
    if (lockedTidyResult.after[lockedMultiSelection.lockedId].y !== lockedTidyResult.before[lockedMultiSelection.lockedId].y
      || lockedTidyResult.after[lockedMultiSelection.freeAId].y !== 80
      || lockedTidyResult.after[lockedMultiSelection.freeBId].y !== 80) {
      throw new Error(`Locked Tidy Up changed the wrong geometry: ${JSON.stringify(lockedTidyResult)}`);
    }
    progress('240% light/dark locked multi-selection bounds and unlocked-only Tidy Up passed');

    const lockedSectionFixture = await evaluate(`(() => {
      const store = window.__openCanvasQaStore;
      let state = store.getState();
      const card = state.createCard('锁定的 Section 成员', '## 固定位置\\nSection 移动时，这张卡片不应发生位移。');
      const member = state.addCardPlacement(card.id, { x: 1000, y: 1000 });
      if (!member) return null;
      state.updateBoardLayout({ [member.id]: { width: 300, height: 150 } });
      state.setSelection({ kind: 'placement', id: member.id, ids: [member.id] });
      state.frameSelection();
      state = store.getState();
      const board = state.boards.find(item => item.id === state.activeBoardId);
      const currentMember = board?.placements.find(item => item.id === member.id);
      const currentSectionIds = currentMember ? [...(currentMember.sectionIds ?? []), ...(currentMember.sectionId ? [currentMember.sectionId] : [])] : [];
      const section = board?.placements.find(item => item.isFrame && currentSectionIds.includes(item.id));
      if (!section) return null;
      state.updatePlacement(member.id, { locked: true });
      state.setSelection({ kind: 'placement', id: section.id, ids: [section.id] });
      const canvas = document.querySelector('.infinite-canvas')?.getBoundingClientRect();
      if (!canvas) return null;
      const center = { x: section.x + section.width / 2, y: section.y + section.height / 2 };
      state.setViewport({ zoom: 1, x: canvas.width / 2 - center.x, y: canvas.height / 2 - center.y });
      return {
        memberId: member.id,
        sectionId: section.id,
        member: { x: 1000, y: 1000, width: 300, height: 150 },
        section: { x: section.x, y: section.y, width: section.width, height: section.height },
      };
    })()`);
    if (!lockedSectionFixture) throw new Error('Could not establish the locked Section elastic-drag fixture');
    const lockedSectionDragPoint = await waitFor(() => evaluate(`(() => {
      const chip = document.querySelector('[data-placement-id="${lockedSectionFixture.sectionId}"] .section-title-chip');
      const rect = chip?.getBoundingClientRect();
      return rect ? { x: rect.left + Math.min(46, rect.width / 2), y: rect.top + rect.height / 2 } : null;
    })()`), 3000);
    await mouse('mousePressed', lockedSectionDragPoint.x, lockedSectionDragPoint.y, { modifiers: 1 });
    await mouse('mouseMoved', lockedSectionDragPoint.x + 120, lockedSectionDragPoint.y, { buttons: 1, modifiers: 1 });
    const lockedSectionDuring = await waitFor(() => evaluate(`(() => {
      const store = window.__openCanvasQaStore;
      const ids = ${JSON.stringify(lockedSectionFixture)};
      const state = store.getState();
      const board = state.boards.find(item => item.id === state.activeBoardId);
      const section = board?.placements.find(item => item.id === ids.sectionId);
      const member = board?.placements.find(item => item.id === ids.memberId);
      const canvas = document.querySelector('.infinite-canvas');
      if (!section || !member || !canvas?.classList.contains('interaction-moving')) return null;
      return {
        section: { x: section.x, y: section.y, width: section.width, height: section.height, base: section.sectionBaseBounds },
        member: { x: member.x, y: member.y, sectionId: member.sectionId, sectionIds: member.sectionIds },
      };
    })()`), 3000);
    if (lockedSectionDuring.member.x !== lockedSectionFixture.member.x
      || lockedSectionDuring.member.y !== lockedSectionFixture.member.y
      || lockedSectionDuring.member.sectionId !== lockedSectionFixture.sectionId
      || Math.abs(lockedSectionDuring.section.x - lockedSectionFixture.section.x) > 1
      || Math.abs(lockedSectionDuring.section.width - (lockedSectionFixture.section.width + 120)) > 1
      || Math.abs(lockedSectionDuring.section.base.x - (lockedSectionFixture.section.x + 120)) > 1) {
      throw new Error(`Locked member did not hold position while the Section elastically preserved padding: ${JSON.stringify({ lockedSectionFixture, lockedSectionDuring })}`);
    }
    await captureElementArtifact('light-locked-section-elastic-drag', '.infinite-canvas');
    await mouse('mouseMoved', lockedSectionDragPoint.x + 420, lockedSectionDragPoint.y, { buttons: 1, modifiers: 1 });
    await mouse('mouseReleased', lockedSectionDragPoint.x + 420, lockedSectionDragPoint.y, { modifiers: 1 });
    const lockedSectionAfter = await waitFor(() => evaluate(`(() => {
      const ids = ${JSON.stringify(lockedSectionFixture)};
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === state.activeBoardId);
      const section = board?.placements.find(item => item.id === ids.sectionId);
      const member = board?.placements.find(item => item.id === ids.memberId);
      if (!section || !member || document.querySelector('.infinite-canvas')?.classList.contains('interaction-moving')) return null;
      return {
        section: { x: section.x, y: section.y, width: section.width, height: section.height, base: section.sectionBaseBounds },
        member: { x: member.x, y: member.y, sectionId: member.sectionId, sectionIds: member.sectionIds },
      };
    })()`), 3000);
    if (lockedSectionAfter.member.x !== lockedSectionFixture.member.x
      || lockedSectionAfter.member.y !== lockedSectionFixture.member.y
      || lockedSectionAfter.member.sectionId
      || lockedSectionAfter.member.sectionIds?.length
      || Math.abs(lockedSectionAfter.section.x - (lockedSectionFixture.section.x + 420)) > 1
      || Math.abs(lockedSectionAfter.section.width - lockedSectionFixture.section.width) > 1
      || lockedSectionAfter.section.base) {
      throw new Error(`Locked Section settlement did not restore its manual bounds and detach the stationary member: ${JSON.stringify({ lockedSectionFixture, lockedSectionAfter })}`);
    }
    await captureElementArtifact('light-locked-section-detached', '.infinite-canvas');

    const sectionCreationFixture = await evaluate(`(() => {
      const store = window.__openCanvasQaStore;
      const state = store.getState();
      const firstCard = state.createCard('区块创建验收 A', '从真实多选菜单创建 Section。');
      const secondCard = state.createCard('区块创建验收 B', '创建后四周应精确保留 40px。');
      const first = state.addCardPlacement(firstCard.id, { x: 2200, y: 1000 });
      const second = state.addCardPlacement(secondCard.id, { x: 2580, y: 1240 });
      if (!first || !second) return null;
      state.updateBoardLayout({
        [first.id]: { width: 300, height: 160 },
        [second.id]: { width: 340, height: 180 },
      });
      state.setSelection({ kind: 'placement', id: first.id, ids: [first.id, second.id] });
      const canvas = document.querySelector('.infinite-canvas')?.getBoundingClientRect();
      if (!canvas) return null;
      const expected = { x: 2160, y: 960, width: 800, height: 500 };
      state.setViewport({
        zoom: 1,
        x: canvas.width / 2 - (expected.x + expected.width / 2),
        y: canvas.height / 2 - (expected.y + expected.height / 2),
      });
      return { placementIds: [first.id, second.id], expected };
    })()`);
    if (!sectionCreationFixture) throw new Error('Could not establish the real-menu Section creation fixture');
    const sectionCreationMenuPoint = await waitFor(() => evaluate(`(() => {
      const node = document.querySelector('[data-placement-id="${sectionCreationFixture.placementIds[0]}"]');
      const rect = node?.getBoundingClientRect();
      return rect ? { x: rect.left + 40, y: rect.top + 20 } : null;
    })()`), 3000);
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sectionCreationMenuPoint.x, y: sectionCreationMenuPoint.y, button: 'right', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sectionCreationMenuPoint.x, y: sectionCreationMenuPoint.y, button: 'right', clickCount: 1 });
    const tidyTriggerPoint = await waitFor(() => evaluate(`(() => {
      const trigger = [...document.querySelectorAll('.canvas-context-menu[role="menu"] [role="menuitem"]')].find(node => node.textContent.trim() === '整理');
      const rect = trigger?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    })()`), 3000);
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tidyTriggerPoint.x, y: tidyTriggerPoint.y, button: 'left', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tidyTriggerPoint.x, y: tidyTriggerPoint.y, button: 'left', clickCount: 1 });
    const tidyFlyout = await waitFor(() => evaluate(`(() => {
      const trigger = [...document.querySelectorAll('.canvas-context-menu[role="menu"] [role="menuitem"]')].find(node => node.textContent.trim() === '整理');
      const submenu = document.querySelector('.tidy-submenu[data-presence="open"]');
      const action = submenu?.querySelector('button');
      const triggerRect = trigger?.getBoundingClientRect();
      const submenuRect = submenu?.getBoundingClientRect();
      const actionRect = action?.getBoundingClientRect();
      if (!triggerRect || !submenuRect || !actionRect) return null;
      const opensRight = submenuRect.left >= triggerRect.right;
      return {
        gap: { x: opensRight ? (triggerRect.right + submenuRect.left) / 2 : (submenuRect.right + triggerRect.left) / 2, y: actionRect.top + actionRect.height / 2 },
        action: { x: actionRect.left + actionRect.width / 2, y: actionRect.top + actionRect.height / 2 },
      };
    })()`), 5000);
    await mouse('mouseMoved', tidyFlyout.gap.x, tidyFlyout.gap.y);
    await delay(55);
    if (!await evaluate(`Boolean(document.querySelector('.tidy-submenu[data-presence="open"]'))`)) throw new Error('Tidy flyout closed before the pointer could cross its visual gap');
    await mouse('mouseMoved', tidyFlyout.action.x, tidyFlyout.action.y);
    await delay(180);
    if (!await evaluate(`Boolean(document.querySelector('.tidy-submenu[data-presence="open"]'))`)) throw new Error('Tidy flyout close timer was not cancelled after entering the submenu');
    const createSectionMenuItem = await waitFor(() => evaluate(`(() => {
      const item = [...document.querySelectorAll('.canvas-context-menu[role="menu"] [role="menuitem"]')].find(node => node.textContent.includes('为选择创建区块'));
      const rect = item?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    })()`), 3000);
    await mouse('mouseMoved', createSectionMenuItem.x, createSectionMenuItem.y);
    await waitFor(() => evaluate(`!document.querySelector('.tidy-submenu') && Boolean(document.querySelector('.canvas-context-menu[role="menu"]'))`), 1000);
    await mouse('mousePressed', createSectionMenuItem.x, createSectionMenuItem.y);
    await mouse('mouseReleased', createSectionMenuItem.x, createSectionMenuItem.y);
    const createdSectionProfile = await waitFor(() => evaluate(`(() => {
      const fixture = ${JSON.stringify(sectionCreationFixture)};
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === state.activeBoardId);
      const sectionId = state.selection?.kind === 'placement' && state.selection.ids?.length === 1 ? state.selection.id : null;
      const section = board?.placements.find(item => item.id === sectionId && item.isFrame);
      const members = fixture.placementIds.map(id => board?.placements.find(item => item.id === id));
      const node = section && document.querySelector('[data-placement-id="' + section.id + '"]');
      const rect = node?.getBoundingClientRect();
      if (!section || members.some(item => !item) || !rect) return null;
      return {
        id: section.id,
        geometry: { x: section.x, y: section.y, width: section.width, height: section.height },
        memberRelations: members.map(item => ({ sectionId: item.sectionId, sectionIds: item.sectionIds })),
        selectedNodes: [...document.querySelectorAll('.canvas-node.selected')].map(item => item.getAttribute('data-placement-id')),
        renameFocused: document.activeElement === node.querySelector('.section-title-editor'),
        rect: rect.toJSON(),
      };
    })()`), 3000);
    if (JSON.stringify(createdSectionProfile.geometry) !== JSON.stringify(sectionCreationFixture.expected)
      || createdSectionProfile.memberRelations.some(item => item.sectionId !== createdSectionProfile.id || item.sectionIds?.length !== 1 || item.sectionIds[0] !== createdSectionProfile.id)
      || createdSectionProfile.selectedNodes.length !== 1
      || createdSectionProfile.selectedNodes[0] !== createdSectionProfile.id
      || !createdSectionProfile.renameFocused) {
      throw new Error(`Real-menu Section creation did not atomically establish exact padding, membership, and selection: ${JSON.stringify({ sectionCreationFixture, createdSectionProfile })}`);
    }
    await captureElementArtifact('light-section-created-from-selection', '.infinite-canvas');
    const sectionInteriorMenuPoint = await waitFor(() => evaluate(`(() => {
      const node = document.querySelector('[data-placement-id="${createdSectionProfile.id}"]');
      const rect = node?.getBoundingClientRect();
      return rect ? { x: rect.right - 20, y: rect.bottom - 20 } : null;
    })()`), 3000);
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sectionInteriorMenuPoint.x, y: sectionInteriorMenuPoint.y, button: 'right', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sectionInteriorMenuPoint.x, y: sectionInteriorMenuPoint.y, button: 'right', clickCount: 1 });
    const sectionCreationMenuProfile = await waitFor(() => evaluate(`(() => {
      const menu = document.querySelector('.canvas-context-menu[role="menu"]');
      const labels = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])].map(item => item.textContent.trim());
      return ['新建卡片', '添加文字', '嵌套白板', '新建区块'].every(label => labels.includes(label)) ? { labels } : null;
    })()`), 3000);
    await captureElementArtifact('light-section-create-inside-menu', '.infinite-canvas');
    const createInsideMenuPoint = await evaluate(`(() => {
      const item = [...document.querySelectorAll('.canvas-context-menu[role="menu"] [role="menuitem"]')].find(node => node.textContent.trim() === '新建卡片');
      const rect = item?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    })()`);
    if (!createInsideMenuPoint) throw new Error(`Section create-inside menu lacked a clickable card action: ${JSON.stringify(sectionCreationMenuProfile)}`);
    await mouse('mousePressed', createInsideMenuPoint.x, createInsideMenuPoint.y);
    await mouse('mouseReleased', createInsideMenuPoint.x, createInsideMenuPoint.y);
    const createdInsideSection = await waitFor(() => evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === state.activeBoardId);
      const selectedId = state.selection?.kind === 'placement' ? state.selection.id : null;
      const placement = board?.placements.find(item => item.id === selectedId && item.kind === 'card');
      const section = board?.placements.find(item => item.id === ${JSON.stringify(createdSectionProfile.id)});
      const node = placement && document.querySelector('[data-placement-id="' + placement.id + '"]');
      if (!placement || !section || !node?.classList.contains('card-editing')) return null;
      return {
        placement: { id: placement.id, x: placement.x, y: placement.y, width: placement.width, height: placement.height, sectionId: placement.sectionId, sectionIds: placement.sectionIds },
        section: { x: section.x, y: section.y, width: section.width, height: section.height, base: section.sectionBaseBounds },
      };
    })()`), 5000);
    const insideRightGap = createdInsideSection.section.x + createdInsideSection.section.width - (createdInsideSection.placement.x + createdInsideSection.placement.width);
    const insideBottomGap = createdInsideSection.section.y + createdInsideSection.section.height - (createdInsideSection.placement.y + createdInsideSection.placement.height);
    if (createdInsideSection.placement.sectionId !== createdSectionProfile.id
      || JSON.stringify(createdInsideSection.placement.sectionIds) !== JSON.stringify([createdSectionProfile.id])
      || Math.abs(insideRightGap - 40) > .01
      || Math.abs(insideBottomGap - 40) > .01
      || JSON.stringify(createdInsideSection.section.base) !== JSON.stringify(sectionCreationFixture.expected)) {
      throw new Error(`Creating a card from a Section menu did not atomically keep membership and 40px padding: ${JSON.stringify({ createdInsideSection, insideRightGap, insideBottomGap })}`);
    }
    await captureElementArtifact('light-card-created-inside-section', '.infinite-canvas');
    const createInsideUndo = await evaluate(`(() => {
      const createdId = ${JSON.stringify(createdInsideSection.placement.id)};
      const state = window.__openCanvasQaStore.getState();
      state.undo();
      const next = window.__openCanvasQaStore.getState();
      const board = next.boards.find(item => item.id === next.activeBoardId);
      const section = board?.placements.find(item => item.id === ${JSON.stringify(createdSectionProfile.id)});
      return { exists: board?.placements.some(item => item.id === createdId), section, selection: next.selection };
    })()`);
    if (createInsideUndo.exists
      || JSON.stringify({ x: createInsideUndo.section.x, y: createInsideUndo.section.y, width: createInsideUndo.section.width, height: createInsideUndo.section.height }) !== JSON.stringify(sectionCreationFixture.expected)
      || createInsideUndo.section.sectionBaseBounds
      || createInsideUndo.selection) {
      throw new Error(`One undo did not remove the Section-created card and restore the Section: ${JSON.stringify(createInsideUndo)}`);
    }
    const createInsideRedo = await waitFor(() => evaluate(`(() => {
      const store = window.__openCanvasQaStore;
      const createdId = ${JSON.stringify(createdInsideSection.placement.id)};
      if (!store.getState().boards.find(item => item.id === store.getState().activeBoardId)?.placements.some(item => item.id === createdId)) store.getState().redo();
      const state = store.getState();
      const board = state.boards.find(item => item.id === state.activeBoardId);
      const placement = board?.placements.find(item => item.id === createdId);
      const section = board?.placements.find(item => item.id === ${JSON.stringify(createdSectionProfile.id)});
      return placement && section ? { placement, section } : null;
    })()`), 3000);
    if (createInsideRedo.placement.sectionId !== createdSectionProfile.id
      || JSON.stringify(createInsideRedo.placement.sectionIds) !== JSON.stringify([createdSectionProfile.id])
      || !createInsideRedo.section.sectionBaseBounds) {
      throw new Error(`Redo lost the Section-created card relation or elastic geometry: ${JSON.stringify(createInsideRedo)}`);
    }
    const liveSectionSnapGesture = await evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === state.activeBoardId);
      const placement = board?.placements.find(item => item.id === ${JSON.stringify(createdInsideSection.placement.id)});
      const section = board?.placements.find(item => item.id === ${JSON.stringify(createdSectionProfile.id)});
      const node = placement && document.querySelector('[data-placement-id="' + placement.id + '"]');
      const toolbar = node?.querySelector('.card-selection-toolbar');
      const rect = toolbar?.getBoundingClientRect();
      if (!placement || !section || !rect) return null;
      return {
        start: { x: rect.left + Math.min(80, rect.width / 2), y: rect.top + rect.height / 2 },
        end: {
          x: rect.left + Math.min(80, rect.width / 2) + (section.x + 45 - placement.x) * state.boards.find(item => item.id === state.activeBoardId).viewport.zoom,
          y: rect.top + rect.height / 2 + (section.y + 45 - placement.y) * state.boards.find(item => item.id === state.activeBoardId).viewport.zoom,
        },
        expected: { x: section.x + 40, y: section.y + 40 },
        original: { x: placement.x, y: placement.y },
      };
    })()`);
    if (!liveSectionSnapGesture) throw new Error('Could not establish a live Section padding-snap gesture');
    await mouse('mousePressed', liveSectionSnapGesture.start.x, liveSectionSnapGesture.start.y);
    await mouse('mouseMoved', liveSectionSnapGesture.end.x, liveSectionSnapGesture.end.y, { buttons: 1 });
    const liveSectionContainment = await waitFor(() => evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === state.activeBoardId);
      const placement = board?.placements.find(item => item.id === ${JSON.stringify(createdInsideSection.placement.id)});
      const sectionNode = document.querySelector('[data-placement-id="${createdSectionProfile.id}"]');
      const guides = [...document.querySelectorAll('.alignment-guide')].map(item => item.className);
      return placement?.x === ${liveSectionSnapGesture.expected.x} && placement?.y === ${liveSectionSnapGesture.expected.y} && sectionNode?.classList.contains('section-containment-target') ? { x: placement.x, y: placement.y, aria: sectionNode.getAttribute('aria-label'), guides } : null;
    })()`), 3000);
    if (!liveSectionContainment.aria.includes('将包含拖动对象') || liveSectionContainment.guides.length < 2) throw new Error(`Live Section target did not expose its active border, ARIA state, and padding guides: ${JSON.stringify(liveSectionContainment)}`);
    await captureElementArtifact('light-section-live-containment-target', '.infinite-canvas');
    await mouse('mouseReleased', liveSectionSnapGesture.end.x, liveSectionSnapGesture.end.y);
    await waitFor(() => evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); const board = state.boards.find(item => item.id === state.activeBoardId); const placement = board?.placements.find(item => item.id === ${JSON.stringify(createdInsideSection.placement.id)}); return placement?.x === ${liveSectionSnapGesture.expected.x} && placement?.y === ${liveSectionSnapGesture.expected.y} && placement.sectionId === ${JSON.stringify(createdSectionProfile.id)} && !document.querySelector('.section-containment-target'); })()`), 3000);
    await evaluate(`window.__openCanvasQaStore.getState().undo()`);
    await waitFor(() => evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); const board = state.boards.find(item => item.id === state.activeBoardId); const placement = board?.placements.find(item => item.id === ${JSON.stringify(createdInsideSection.placement.id)}); return placement?.x === ${liveSectionSnapGesture.original.x} && placement?.y === ${liveSectionSnapGesture.original.y}; })()`), 3000);
    // Leave the fixture in its pre-action state so the following assertion can
    // still undo the original Section-creation command in exactly one step.
    await evaluate(`window.__openCanvasQaStore.getState().undo()`);
    progress('Section context menu created an editing card with atomic membership, elastic padding, undo and redo');
    const nestedSectionMenuPoint = await waitFor(() => evaluate(`(() => {
      const node = document.querySelector('[data-placement-id="${createdSectionProfile.id}"]');
      const rect = node?.getBoundingClientRect();
      return rect ? { x: rect.left + 100, y: rect.top + 10 } : null;
    })()`), 3000);
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: nestedSectionMenuPoint.x, y: nestedSectionMenuPoint.y, button: 'right', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: nestedSectionMenuPoint.x, y: nestedSectionMenuPoint.y, button: 'right', clickCount: 1 });
    const createNestedSectionMenuPoint = await waitFor(() => evaluate(`(() => {
      const item = [...document.querySelectorAll('.canvas-context-menu[role="menu"] [role="menuitem"]')].find(node => node.textContent.trim() === '新建区块');
      const rect = item?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    })()`), 3000);
    await mouse('mousePressed', createNestedSectionMenuPoint.x, createNestedSectionMenuPoint.y);
    await mouse('mouseReleased', createNestedSectionMenuPoint.x, createNestedSectionMenuPoint.y);
    const nestedSectionProfile = await waitFor(() => evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === state.activeBoardId);
      const selectedId = state.selection?.kind === 'placement' ? state.selection.id : null;
      const child = board?.placements.find(item => item.id === selectedId && item.isFrame && item.id !== ${JSON.stringify(createdSectionProfile.id)});
      const parent = board?.placements.find(item => item.id === ${JSON.stringify(createdSectionProfile.id)});
      const editor = child && document.querySelector('[data-placement-id="' + child.id + '"] .section-title-editor');
      return child && parent && editor ? { child, parent, focused: document.activeElement === editor } : null;
    })()`), 3000);
    if (nestedSectionProfile.child.width !== 600
      || nestedSectionProfile.child.height !== 480
      || nestedSectionProfile.child.sectionId !== createdSectionProfile.id
      || JSON.stringify(nestedSectionProfile.child.sectionIds) !== JSON.stringify([createdSectionProfile.id])
      || JSON.stringify(nestedSectionProfile.parent.sectionBaseBounds) !== JSON.stringify(sectionCreationFixture.expected)
      || !nestedSectionProfile.focused) {
      throw new Error(`The Section menu did not create and rename a contained 600x480 child Section atomically: ${JSON.stringify(nestedSectionProfile)}`);
    }
    await captureElementArtifact('light-nested-section-created', '.infinite-canvas');
    const nestedSectionUndo = await evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      state.undo();
      const next = window.__openCanvasQaStore.getState();
      const board = next.boards.find(item => item.id === next.activeBoardId);
      const parent = board?.placements.find(item => item.id === ${JSON.stringify(createdSectionProfile.id)});
      return { childExists: board?.placements.some(item => item.id === ${JSON.stringify(nestedSectionProfile.child.id)}), parent, selection: next.selection };
    })()`);
    if (nestedSectionUndo.childExists
      || JSON.stringify({ x: nestedSectionUndo.parent.x, y: nestedSectionUndo.parent.y, width: nestedSectionUndo.parent.width, height: nestedSectionUndo.parent.height }) !== JSON.stringify(sectionCreationFixture.expected)
      || nestedSectionUndo.parent.sectionBaseBounds
      || nestedSectionUndo.selection) {
      throw new Error(`Undo did not remove the nested Section and restore its parent geometry: ${JSON.stringify(nestedSectionUndo)}`);
    }
    progress('Section context menu created a contained default child Section, focused its title, and undid it atomically');
    await evaluate(`window.__openCanvasQaStore.getState().toggleDarkMode()`);
    await waitFor(() => evaluate(`document.querySelector('.app-shell')?.getAttribute('data-theme') === 'dark'`), 2000);
    await captureElementArtifact('dark-section-created-from-selection', '.infinite-canvas');
    await evaluate(`window.__openCanvasQaStore.getState().toggleDarkMode()`);
    await waitFor(() => evaluate(`document.querySelector('.app-shell')?.getAttribute('data-theme') === 'light'`), 2000);
    const sectionCreationUndo = await evaluate(`(() => {
      const fixture = ${JSON.stringify(sectionCreationFixture)};
      const createdId = ${JSON.stringify(createdSectionProfile.id)};
      const store = window.__openCanvasQaStore;
      store.getState().undo();
      const state = store.getState();
      const board = state.boards.find(item => item.id === state.activeBoardId);
      return {
        sectionExists: board?.placements.some(item => item.id === createdId),
        memberRelations: fixture.placementIds.map(id => {
          const item = board?.placements.find(candidate => candidate.id === id);
          return item && { sectionId: item.sectionId, sectionIds: item.sectionIds };
        }),
        selection: state.selection,
      };
    })()`);
    if (sectionCreationUndo.sectionExists
      || sectionCreationUndo.selection
      || sectionCreationUndo.memberRelations.some(item => item?.sectionId || item?.sectionIds?.length)) {
      throw new Error(`Undo did not remove the newly created Section and restore member relations: ${JSON.stringify(sectionCreationUndo)}`);
    }
    progress('real multi-selection context menu created an exact 40px Section in both themes and one undo restored the prior board');

    const sectionToolGesture = await waitFor(() => evaluate(`(() => {
      const fixture = ${JSON.stringify(sectionCreationFixture)};
      const nodes = fixture.placementIds.map(id => document.querySelector('[data-placement-id="' + id + '"]'));
      const rects = nodes.map(node => node?.getBoundingClientRect());
      const button = document.querySelector('.canvas-toolbar button[aria-label="区块工具"]');
      const buttonRect = button?.getBoundingClientRect();
      const canvas = document.querySelector('.infinite-canvas')?.getBoundingClientRect();
      if (rects.some(rect => !rect) || !buttonRect || !canvas) return null;
      const left = Math.min(...rects.map(rect => rect.left));
      const top = Math.min(...rects.map(rect => rect.top));
      const right = Math.max(...rects.map(rect => rect.right));
      const bottom = Math.max(...rects.map(rect => rect.bottom));
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === state.activeBoardId);
      return {
        start: { x: left - 55, y: top - 55 },
        end: { x: right + 55, y: bottom + 55 },
        tool: { x: buttonRect.left + buttonRect.width / 2, y: buttonRect.top + buttonRect.height / 2 },
        sectionCount: board.placements.filter(item => item.isFrame).length,
        historyCount: state.commandHistory.past.length,
        expected: { x: 2145, y: 945, width: 830, height: 530 },
      };
    })()`), 3000);
    await evaluate(`document.querySelector('.canvas-toolbar button[aria-label="区块工具"]')?.click()`);
    await waitFor(() => evaluate(`document.querySelector('.canvas-toolbar button[aria-label="区块工具"]')?.getAttribute('aria-pressed') === 'true' && window.__openCanvasQaStore.getState().selection === null`), 2000);
    const cancelledSectionPointer = await beginDomPointerDrag('.infinite-canvas', sectionToolGesture.start, sectionToolGesture.end);
    const cancelledSectionPreview = await waitFor(() => evaluate(`(() => {
      const preview = document.querySelector('.section-creation-preview');
      const canvas = document.querySelector('.infinite-canvas');
      const rect = preview?.getBoundingClientRect();
      return preview && canvas?.classList.contains('interaction-drawing-section') && rect?.width > 700 && rect?.height > 400
        ? { width: rect.width, height: rect.height, border: getComputedStyle(preview).borderStyle }
        : null;
    })()`), 2000);
    if (cancelledSectionPreview.border !== 'solid') throw new Error(`Section tool preview did not use the real solid outline: ${JSON.stringify(cancelledSectionPreview)}`);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await endDomPointerDrag(cancelledSectionPointer, sectionToolGesture.end);
    const cancelledSectionGesture = await waitFor(() => evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === state.activeBoardId);
      return !document.querySelector('.section-creation-preview') && state.tool === 'select'
        ? { sectionCount: board.placements.filter(item => item.isFrame).length, historyCount: state.commandHistory.past.length }
        : null;
    })()`), 2000);
    if (cancelledSectionGesture.sectionCount !== sectionToolGesture.sectionCount || cancelledSectionGesture.historyCount !== sectionToolGesture.historyCount) throw new Error(`Escape committed a pending Section tool gesture: ${JSON.stringify({ sectionToolGesture, cancelledSectionGesture })}`);

    await evaluate(`document.querySelector('.canvas-toolbar button[aria-label="区块工具"]')?.click()`);
    const createdSectionPointer = await beginDomPointerDrag('.infinite-canvas', sectionToolGesture.start, sectionToolGesture.end);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.section-creation-preview'))`), 2000);
    await captureElementArtifact('light-section-tool-preview', '.infinite-canvas');
    await endDomPointerDrag(createdSectionPointer, sectionToolGesture.end);
    const sectionToolCreated = await waitFor(() => evaluate(`(() => {
      const fixture = ${JSON.stringify(sectionCreationFixture)};
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === state.activeBoardId);
      const selectedId = state.selection?.kind === 'placement' ? state.selection.id : null;
      const section = board?.placements.find(item => item.id === selectedId && item.isFrame);
      const editor = section && document.querySelector('[data-placement-id="' + section.id + '"] .section-title-editor');
      const members = fixture.placementIds.map(id => board?.placements.find(item => item.id === id));
      return section && editor && state.tool === 'select' ? {
        id: section.id,
        geometry: { x: section.x, y: section.y, width: section.width, height: section.height },
        memberRelations: members.map(item => item && { sectionId: item.sectionId, sectionIds: item.sectionIds }),
        focused: document.activeElement === editor,
        historyCount: state.commandHistory.past.length,
      } : null;
    })()`), 3000);
    const sectionToolGeometryStable = Object.keys(sectionToolGesture.expected).every((key) =>
      Math.abs(sectionToolCreated.geometry[key] - sectionToolGesture.expected[key]) <= 1
    );
    // Fractional browser coordinates at 125%/150% Windows scaling can map the
    // same drawn rectangle to a sub-pixel world coordinate. Preserve the real
    // geometry assertion while allowing that renderer rounding boundary.
    if (!sectionToolGeometryStable
      || sectionToolCreated.memberRelations.some(item => item?.sectionId !== sectionToolCreated.id || JSON.stringify(item.sectionIds) !== JSON.stringify([sectionToolCreated.id]))
      || !sectionToolCreated.focused
      || sectionToolCreated.historyCount !== sectionToolGesture.historyCount + 1) {
      throw new Error(`Section tool did not preserve its drawn rectangle, contained membership, focus, and atomic history: ${JSON.stringify({ sectionToolGesture, sectionToolCreated })}`);
    }
    await captureElementArtifact('light-section-tool-created', '.infinite-canvas');
    const sectionToolUndo = await evaluate(`(() => {
      const store = window.__openCanvasQaStore;
      store.getState().undo();
      const state = store.getState();
      const board = state.boards.find(item => item.id === state.activeBoardId);
      return {
        exists: board.placements.some(item => item.id === ${JSON.stringify(sectionToolCreated.id)}),
        memberRelations: ${JSON.stringify(sectionCreationFixture.placementIds)}.map(id => {
          const item = board.placements.find(candidate => candidate.id === id);
          return item && { sectionId: item.sectionId, sectionIds: item.sectionIds };
        }),
      };
    })()`);
    if (sectionToolUndo.exists || sectionToolUndo.memberRelations.some(item => item?.sectionId || item?.sectionIds?.length)) throw new Error(`Undo did not remove the Section-tool result atomically: ${JSON.stringify(sectionToolUndo)}`);
    progress('Section toolbar tool previewed a solid drag rectangle, cancelled cleanly, then created and renamed one atomic contained Section');

    const creationToolFixture = await evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const canvas = document.querySelector('.infinite-canvas')?.getBoundingClientRect();
      if (!canvas) return null;
      state.setViewport({ x: 0, y: 0, zoom: 1 });
      return {
        card: { start: { x: canvas.left + 120, y: canvas.top + 120 }, end: { x: canvas.left + 480, y: canvas.top + 310 } },
        text: { x: canvas.left + 240, y: canvas.top + 420 },
        board: { start: { x: canvas.left + 560, y: canvas.top + 120 }, end: { x: canvas.left + 910, y: canvas.top + 320 } },
      };
    })()`);
    if (!creationToolFixture) throw new Error('Could not establish blank-space creation tool fixture');
    await key('n', 'KeyN', 78);
    await waitFor(() => evaluate(`document.querySelector('.canvas-toolbar button[aria-label="卡片工具"]')?.getAttribute('aria-pressed') === 'true'`), 2000);
    const createdCardPointer = await beginDomPointerDrag('.infinite-canvas', creationToolFixture.card.start, creationToolFixture.card.end);
    const cardToolPreview = await waitFor(() => evaluate(`(() => { const node = document.querySelector('.creation-preview-card'); const rect = node?.getBoundingClientRect(); return rect ? { width: rect.width, height: rect.height } : null; })()`), 2000);
    if (cardToolPreview.width !== 360 || cardToolPreview.height !== 190) throw new Error(`Card tool preview did not follow the drawn rectangle: ${JSON.stringify(cardToolPreview)}`);
    await endDomPointerDrag(createdCardPointer, creationToolFixture.card.end);
    const cardToolCreated = await waitFor(() => evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === state.activeBoardId);
      const id = state.selection?.kind === 'placement' ? state.selection.id : null;
      const placement = board?.placements.find(item => item.id === id && item.kind === 'card');
      const node = placement && document.querySelector('[data-placement-id="' + placement.id + '"]');
      return placement && node?.classList.contains('card-editing') && state.tool === 'select' ? { id: placement.id, entityId: placement.entityId, x: placement.x, y: placement.y, width: placement.width, height: placement.height } : null;
    })()`), 3000);
    if (cardToolCreated.x !== 120 || cardToolCreated.y !== 120 || cardToolCreated.width !== 360 || cardToolCreated.height !== 190) throw new Error(`Card tool did not create the drawn card in edit mode: ${JSON.stringify(cardToolCreated)}`);
    const cardToolUndo = await evaluate(`(() => {
      document.activeElement?.blur();
      const store = window.__openCanvasQaStore;
      store.getState().undo();
      const state = store.getState();
      const board = state.boards.find(item => item.id === state.activeBoardId);
      return { placementExists: board.placements.some(item => item.id === ${JSON.stringify(cardToolCreated.id)}), entityExists: state.cards.some(item => item.id === ${JSON.stringify(cardToolCreated.entityId)}) };
    })()`);
    if (cardToolUndo.placementExists || cardToolUndo.entityExists) throw new Error(`Undo left an orphan entity from the card creation tool: ${JSON.stringify(cardToolUndo)}`);

    await key('t', 'KeyT', 84);
    const createdTextPointer = await beginDomPointerDrag('.infinite-canvas', creationToolFixture.text, creationToolFixture.text, { steps: 1 });
    await endDomPointerDrag(createdTextPointer, creationToolFixture.text);
    const textToolCreated = await waitFor(() => evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === state.activeBoardId);
      const id = state.selection?.kind === 'placement' ? state.selection.id : null;
      const placement = board?.placements.find(item => item.id === id && item.kind === 'text' && !item.isFrame);
      const editor = placement && document.querySelector('[data-placement-id="' + placement.id + '"] .floating-text-editor');
      return placement && editor && state.tool === 'select' ? { id: placement.id, x: placement.x, y: placement.y, focused: document.activeElement === editor } : null;
    })()`), 3000);
    if (textToolCreated.x !== 230 || textToolCreated.y !== 375 || !textToolCreated.focused) throw new Error(`Text tool did not place and edit text at the pointer: ${JSON.stringify(textToolCreated)}`);
    await evaluate(`(() => { document.activeElement?.blur(); window.__openCanvasQaStore.getState().undo(); })()`);

    await key('w', 'KeyW', 87);
    const createdBoardPointer = await beginDomPointerDrag('.infinite-canvas', creationToolFixture.board.start, creationToolFixture.board.end);
    const boardToolPreview = await waitFor(() => evaluate(`(() => { const node = document.querySelector('.creation-preview-board'); const rect = node?.getBoundingClientRect(); return rect ? { width: rect.width, height: rect.height, radius: getComputedStyle(node).borderRadius } : null; })()`), 2000);
    if (boardToolPreview.width !== 350 || boardToolPreview.height !== 200 || parseFloat(boardToolPreview.radius) < 12) throw new Error(`Sub-whiteboard tool preview did not match its drawn rounded rectangle: ${JSON.stringify(boardToolPreview)}`);
    await endDomPointerDrag(createdBoardPointer, creationToolFixture.board.end);
    const boardToolCreated = await waitFor(() => evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === state.activeBoardId);
      const id = state.selection?.kind === 'placement' ? state.selection.id : null;
      const placement = board?.placements.find(item => item.id === id && item.kind === 'board');
      const input = placement && document.querySelector('[data-placement-id="' + placement.id + '"] .nested-board-title-editor');
      const child = placement?.entityId && state.boards.find(item => item.id === placement.entityId);
      const rect = placement && document.querySelector('[data-placement-id="' + placement.id + '"]')?.getBoundingClientRect();
      return placement && child && input && rect && state.tool === 'select' ? { id: placement.id, childId: child.id, x: placement.x, y: placement.y, width: placement.width, height: placement.height, title: child.title, focused: document.activeElement === input, rect: rect.toJSON() } : null;
    })()`), 3000);
    if (boardToolCreated.x !== 560 || boardToolCreated.y !== 120 || boardToolCreated.width !== 350 || boardToolCreated.height !== 200 || !boardToolCreated.focused) throw new Error(`Sub-whiteboard tool did not create the drawn instance directly in inline rename: ${JSON.stringify(boardToolCreated)}`);
    await evaluate(`(() => {
      const input = document.querySelector('[data-placement-id="${boardToolCreated.id}"] .nested-board-title-editor');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '原位重命名白板');
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '原位重命名白板' }));
    })()`);
    const nestedRenameBlank = await evaluate(`(() => { const rect = document.querySelector('.infinite-canvas')?.getBoundingClientRect(); if (!rect) return null; for (let y = rect.top + 50; y < rect.bottom - 40; y += 22) for (let x = rect.left + 50; x < rect.right - 40; x += 22) if (!document.elementFromPoint(x, y)?.closest('.canvas-node, .canvas-toolbar, .zoom-controls')) return { x, y }; return null; })()`);
    if (!nestedRenameBlank) throw new Error('Could not find blank canvas space to commit nested whiteboard rename');
    const nestedRenameCommitPointer = await beginDomPointerDrag('.infinite-canvas', nestedRenameBlank, nestedRenameBlank, { steps: 1 });
    await endDomPointerDrag(nestedRenameCommitPointer, nestedRenameBlank);
    const committedNestedRename = await waitFor(() => evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const child = state.boards.find(item => item.id === ${JSON.stringify(boardToolCreated.childId)});
      const placement = state.boards.find(item => item.id === state.activeBoardId)?.placements.find(item => item.id === ${JSON.stringify(boardToolCreated.id)});
      const rect = document.querySelector('[data-placement-id="${boardToolCreated.id}"]')?.getBoundingClientRect();
      return child?.title === '原位重命名白板' && placement && rect && !document.querySelector('[data-placement-id="${boardToolCreated.id}"] .nested-board-title-editor') ? { title: child.title, placement, rect: rect.toJSON() } : null;
    })()`), 3000);
    if (committedNestedRename.placement.x !== boardToolCreated.x || committedNestedRename.placement.y !== boardToolCreated.y || committedNestedRename.placement.width !== boardToolCreated.width || committedNestedRename.placement.height !== boardToolCreated.height || committedNestedRename.rect.width !== boardToolCreated.rect.width || committedNestedRename.rect.height !== boardToolCreated.rect.height) throw new Error(`Inline rename changed nested whiteboard geometry: ${JSON.stringify({ boardToolCreated, committedNestedRename })}`);
    await evaluate(`window.__openCanvasQaStore.getState().setSelection(null)`);
    await waitFor(() => evaluate(`!document.querySelector('[data-placement-id="${boardToolCreated.id}"]')?.classList.contains('selected')`), 2000);
    await mouse('mouseMoved', nestedRenameBlank.x, nestedRenameBlank.y);
    const hiddenNestedBoardMenu = await evaluate(`(() => {
      const actions = document.querySelector('[data-placement-id="${boardToolCreated.id}"] .shared-board-preview-actions');
      if (!actions) return null;
      const before = getComputedStyle(actions);
      const profile = { pointerEventsDuringFade: before.pointerEvents, animationCount: actions.getAnimations().length };
      actions.getAnimations().forEach(animation => animation.finish());
      const after = getComputedStyle(actions);
      const button = actions.querySelector('.nested-board-more');
      const connect = actions.querySelector('.nested-board-connect');
      return { ...profile, opacity: after.opacity, pointerEvents: after.pointerEvents, buttonTabIndex: button?.tabIndex, connectTabIndex: connect?.tabIndex, connectLabel: connect?.getAttribute('aria-label'), expanded: button?.getAttribute('aria-expanded') };
    })()`);
    if (!hiddenNestedBoardMenu || hiddenNestedBoardMenu.pointerEventsDuringFade !== 'none' || hiddenNestedBoardMenu.opacity !== '0' || hiddenNestedBoardMenu.pointerEvents !== 'none' || hiddenNestedBoardMenu.buttonTabIndex !== -1 || hiddenNestedBoardMenu.connectTabIndex !== -1 || hiddenNestedBoardMenu.connectLabel !== '从此白板开始连线' || hiddenNestedBoardMenu.expanded !== 'false') throw new Error(`Idle nested whiteboard actions did not settle hidden, unfocusable, and non-interactive: ${JSON.stringify(hiddenNestedBoardMenu)}`);
    const nestedBoardTitlePoint = await evaluate(`(() => {
      const title = document.querySelector('[data-placement-id="${boardToolCreated.id}"] .shared-board-preview-heading strong');
      const rect = title?.getBoundingClientRect();
      if (!title || !rect) return null;
      for (let y = rect.top + 3; y < rect.bottom - 2; y += 4) for (let x = rect.left + 3; x < rect.right - 2; x += 6) {
        const hit = document.elementFromPoint(x, y);
        if (hit && title.contains(hit)) return { x, y, hit: hit.className || hit.tagName };
      }
      return { blocked: true, rect: rect.toJSON(), hits: [[rect.left + 3, rect.top + 3], [rect.left + rect.width / 2, rect.top + rect.height / 2], [rect.right - 3, rect.bottom - 3]].map(([x, y]) => ({ x, y, hit: document.elementFromPoint(x, y)?.className || document.elementFromPoint(x, y)?.tagName })) };
    })()`);
    if (!nestedBoardTitlePoint || nestedBoardTitlePoint.blocked) throw new Error(`Nested whiteboard title had no native hit point: ${JSON.stringify(nestedBoardTitlePoint)}`);
    const clickNestedBoardTitle = () => evaluate(`(() => {
      const title = document.querySelector('[data-placement-id="${boardToolCreated.id}"] .shared-board-preview-heading strong');
      const point = ${JSON.stringify({ x: nestedBoardTitlePoint.x, y: nestedBoardTitlePoint.y })};
      title.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 781, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: point.x, clientY: point.y }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 781, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0, clientX: point.x, clientY: point.y }));
      title.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1, clientX: point.x, clientY: point.y }));
    })()`);
    await clickNestedBoardTitle();
    const nestedBoardFirstTitleClick = await waitFor(() => evaluate(`(() => { const node = document.querySelector('[data-placement-id="${boardToolCreated.id}"]'); return node?.classList.contains('selected') && !node.querySelector('.nested-board-title-editor') ? true : null; })()`), 2000);
    if (!nestedBoardFirstTitleClick) throw new Error('First nested whiteboard title click did not only select its instance');
    const selectedNestedBoardMenu = await evaluate(`(() => { const actions = document.querySelector('[data-placement-id="${boardToolCreated.id}"] .shared-board-preview-actions'); if (!actions) return null; actions.getAnimations().forEach(animation => animation.finish()); const style = getComputedStyle(actions); const button = actions.querySelector('.nested-board-more'); const connect = actions.querySelector('.nested-board-connect'); const rect = connect?.getBoundingClientRect(); return { opacity: style.opacity, pointerEvents: style.pointerEvents, buttonTabIndex: button?.tabIndex, connectTabIndex: connect?.tabIndex, connectLabel: connect?.getAttribute('aria-label'), connectPressed: connect?.getAttribute('aria-pressed'), connectPoint: rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null, hasPopup: button?.getAttribute('aria-haspopup'), expanded: button?.getAttribute('aria-expanded') }; })()`);
    if (!selectedNestedBoardMenu || selectedNestedBoardMenu.opacity !== '1' || selectedNestedBoardMenu.pointerEvents !== 'auto' || selectedNestedBoardMenu.buttonTabIndex !== 0 || selectedNestedBoardMenu.connectTabIndex !== 0 || selectedNestedBoardMenu.connectLabel !== '从此白板开始连线' || selectedNestedBoardMenu.connectPressed !== 'false' || !selectedNestedBoardMenu.connectPoint || selectedNestedBoardMenu.hasPopup !== 'menu' || selectedNestedBoardMenu.expanded !== 'false') throw new Error(`Selected nested whiteboard did not reveal accessible object actions: ${JSON.stringify(selectedNestedBoardMenu)}`);
    await evaluate(`document.querySelector('[data-placement-id="${boardToolCreated.id}"] .nested-board-connect')?.click()`);
    const nestedBoardConnectionSource = await waitFor(() => evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); const node = document.querySelector('[data-placement-id="${boardToolCreated.id}"]'); const connect = node?.querySelector('.nested-board-connect'); const ports = node?.querySelectorAll('.connection-port').length; return state.tool === 'connect' && node?.classList.contains('connection-source') && connect?.getAttribute('aria-pressed') === 'true' && ports === 5 ? { tool: state.tool, label: connect.getAttribute('aria-label'), ports } : null; })()`), 2000);
    if (nestedBoardConnectionSource.label !== '取消从此白板连线') throw new Error(`Nested whiteboard connection source exposed the wrong cancellation action: ${JSON.stringify(nestedBoardConnectionSource)}`);
    await evaluate(`document.querySelector('[data-placement-id="${boardToolCreated.id}"] .nested-board-connect')?.click()`);
    await waitFor(() => evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); const node = document.querySelector('[data-placement-id="${boardToolCreated.id}"]'); return state.tool === 'select' && !node?.classList.contains('connection-source') && node?.querySelectorAll('.connection-port').length === 0; })()`), 2000);
    await clickNestedBoardTitle();
    const selectedTitleRename = await waitFor(() => evaluate(`document.activeElement === document.querySelector('[data-placement-id="${boardToolCreated.id}"] .nested-board-title-editor')`), 2000);
    if (!selectedTitleRename) throw new Error('Second click on the selected nested whiteboard title did not begin inline rename');
    await key('Escape', 'Escape', 27);
    await evaluate(`(() => {
      const title = document.querySelector('[data-placement-id="${boardToolCreated.id}"] .shared-board-preview-heading strong');
      const point = ${JSON.stringify({ x: nestedBoardTitlePoint.x, y: nestedBoardTitlePoint.y })};
      for (const [pointerId, detail] of [[783, 1], [784, 2]]) {
        title.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: point.x, clientY: point.y }));
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0, clientX: point.x, clientY: point.y }));
        title.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail, clientX: point.x, clientY: point.y }));
      }
      title.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0, detail: 2, clientX: point.x, clientY: point.y }));
    })()`);
    const nestedTitleDoubleClick = await waitFor(() => evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      return state.activeBoardId === ${JSON.stringify(boardToolCreated.childId)} && state.boardHistory.at(-1) && !document.querySelector('.nested-board-title-editor') ? { activeBoardId: state.activeBoardId, previousBoardId: state.boardHistory.at(-1) } : null;
    })()`), 3000);
    if (!nestedTitleDoubleClick) throw new Error('A real selected-title double click was swallowed by the delayed single-click rename intent');
    await evaluate(`window.__openCanvasQaStore.getState().goBack()`);
    await waitFor(() => evaluate(`window.__openCanvasQaStore.getState().activeBoardId === ${JSON.stringify(nestedTitleDoubleClick.previousBoardId)}`), 3000);
    await evaluate(`window.__openCanvasQaStore.getState().setSelection({ kind: 'placement', id: ${JSON.stringify(boardToolCreated.id)}, ids: [${JSON.stringify(boardToolCreated.id)}] })`);
    await waitFor(() => evaluate(`document.querySelector('[data-placement-id="${boardToolCreated.id}"]')?.classList.contains('selected')`), 2000);
    const nestedTitleDragBefore = await evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); const item = state.boards.find(board => board.id === state.activeBoardId)?.placements.find(item => item.id === ${JSON.stringify(boardToolCreated.id)}); return item && { x: item.x, y: item.y }; })()`);
    await evaluate(`(() => {
      const title = document.querySelector('[data-placement-id="${boardToolCreated.id}"] .shared-board-preview-heading strong');
      const start = ${JSON.stringify({ x: nestedBoardTitlePoint.x, y: nestedBoardTitlePoint.y })};
      const end = { x: start.x + 48, y: start.y + 24 };
      title.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 782, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: start.x, clientY: start.y }));
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 782, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: end.x, clientY: end.y }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 782, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0, clientX: end.x, clientY: end.y }));
      title.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1, clientX: end.x, clientY: end.y }));
    })()`);
    const nestedTitleDragAfter = await waitFor(() => evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); const item = state.boards.find(board => board.id === state.activeBoardId)?.placements.find(item => item.id === ${JSON.stringify(boardToolCreated.id)}); const node = document.querySelector('[data-placement-id="${boardToolCreated.id}"]'); return item && (item.x !== ${nestedTitleDragBefore.x} || item.y !== ${nestedTitleDragBefore.y}) && !node?.querySelector('.nested-board-title-editor') ? { x: item.x, y: item.y } : null; })()`), 3000);
    if (!nestedTitleDragAfter) throw new Error('Dragging from a selected nested whiteboard title did not remain a pure move gesture');
    await evaluate(`window.__openCanvasQaStore.getState().undo()`);
    await waitFor(() => evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); const item = state.boards.find(board => board.id === state.activeBoardId)?.placements.find(item => item.id === ${JSON.stringify(boardToolCreated.id)}); return item?.x === ${nestedTitleDragBefore.x} && item?.y === ${nestedTitleDragBefore.y}; })()`), 2000);
    const nestedBoardMorePoint = await evaluate(`(() => { const button = document.querySelector('[data-placement-id="${boardToolCreated.id}"] .nested-board-more'); const rect = button?.getBoundingClientRect(); return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null; })()`);
    if (!nestedBoardMorePoint) throw new Error('Nested whiteboard object-menu trigger had no hit target');
    await evaluate(`document.querySelector('[data-placement-id="${boardToolCreated.id}"] .nested-board-more')?.click()`);
    const nestedBoardButtonMenu = await waitFor(() => evaluate(`(() => { const menu = document.querySelector('.canvas-context-menu[role="menu"]'); const labels = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])].map(item => item.textContent.trim()); return labels.includes('进入白板') && labels.includes('重命名白板') && labels.includes('画连线') ? labels : null; })()`), 3000);
    if (!nestedBoardButtonMenu) throw new Error('Nested whiteboard more button did not open the shared object menu');
    const nestedBoardButtonExpanded = await evaluate(`document.querySelector('[data-placement-id="${boardToolCreated.id}"] .nested-board-more')?.getAttribute('aria-expanded')`);
    if (nestedBoardButtonExpanded !== 'true') throw new Error(`Nested whiteboard more button did not expose its expanded menu state: ${nestedBoardButtonExpanded}`);
    await key('Escape', 'Escape', 27);
    await waitFor(() => evaluate(`!document.querySelector('.canvas-context-menu')`), 2500, 20);
    const nestedBoardContextPoint = { x: committedNestedRename.rect.left + 40, y: committedNestedRename.rect.top + 24 };
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: nestedBoardContextPoint.x, y: nestedBoardContextPoint.y, button: 'right', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: nestedBoardContextPoint.x, y: nestedBoardContextPoint.y, button: 'right', clickCount: 1 });
    await waitFor(() => evaluate(`(() => { const item = [...document.querySelectorAll('.canvas-context-menu [role="menuitem"]')].find(node => node.textContent.trim() === '重命名白板'); if (!item) return null; item.click(); return true; })()`), 3000);
    await waitFor(() => evaluate(`document.activeElement?.classList.contains('nested-board-title-editor')`), 3000);
    await client.send('Input.insertText', { text: '这次应当取消' });
    // Cross the menu's exit-animation window deliberately. A slow renderer may
    // move focus while the old menu unmounts, but that must never commit the
    // inline title before the user's Escape reaches the editor.
    await new Promise((resolve) => setTimeout(resolve, 220));
    await key('Escape', 'Escape', 27);
    const cancelledNestedRename = await waitFor(() => evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); const child = state.boards.find(item => item.id === ${JSON.stringify(boardToolCreated.childId)}); return !document.querySelector('.nested-board-title-editor') ? { title: child?.title } : null; })()`), 2000);
    if (cancelledNestedRename.title !== '原位重命名白板') throw new Error(`Escape committed instead of cancelling nested whiteboard rename: ${JSON.stringify(cancelledNestedRename)}`);
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: nestedBoardContextPoint.x, y: nestedBoardContextPoint.y, button: 'right', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: nestedBoardContextPoint.x, y: nestedBoardContextPoint.y, button: 'right', clickCount: 1 });
    await waitFor(() => evaluate(`(() => { const item = [...document.querySelectorAll('.canvas-context-menu [role="menuitem"]')].find(node => node.textContent.trim() === '重命名白板'); if (!item) return null; item.click(); return true; })()`), 3000);
    await waitFor(() => evaluate(`document.activeElement?.classList.contains('nested-board-title-editor')`), 3000);
    await evaluate(`(() => {
      const input = document.querySelector('.nested-board-title-editor');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '独立历史标题');
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '独立历史标题' }));
    })()`);
    const nestedHistoryCommitPointer = await beginDomPointerDrag('.infinite-canvas', nestedRenameBlank, nestedRenameBlank, { steps: 1 });
    await endDomPointerDrag(nestedHistoryCommitPointer, nestedRenameBlank);
    const nestedRenameHistory = await waitFor(() => evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const child = state.boards.find(item => item.id === ${JSON.stringify(boardToolCreated.childId)});
      const last = state.commandHistory.past.at(-1);
      return child?.title === '独立历史标题' && last?.label === '重命名嵌套白板' ? { title: child.title, label: last.label, related: last.relatedBoardChanges?.length } : null;
    })()`), 3000);
    if (nestedRenameHistory.related !== 1) throw new Error(`Nested whiteboard rename did not create one related-board history delta: ${JSON.stringify(nestedRenameHistory)}`);
    const nestedRenameUndone = await evaluate(`(() => {
      const store = window.__openCanvasQaStore; store.getState().undo();
      const state = store.getState();
      const board = state.boards.find(item => item.id === state.activeBoardId);
      return { title: state.boards.find(item => item.id === ${JSON.stringify(boardToolCreated.childId)})?.title, placementExists: board?.placements.some(item => item.id === ${JSON.stringify(boardToolCreated.id)}) };
    })()`);
    if (nestedRenameUndone.title !== '原位重命名白板' || !nestedRenameUndone.placementExists) throw new Error(`Undo changed the nested whiteboard lifecycle instead of only its title: ${JSON.stringify(nestedRenameUndone)}`);
    const nestedRenameRedone = await evaluate(`(() => { const store = window.__openCanvasQaStore; store.getState().redo(); return store.getState().boards.find(item => item.id === ${JSON.stringify(boardToolCreated.childId)})?.title; })()`);
    if (nestedRenameRedone !== '独立历史标题') throw new Error(`Redo did not restore the independent nested whiteboard title: ${JSON.stringify(nestedRenameRedone)}`);
    await evaluate(`window.__openCanvasQaStore.getState().undo()`);
    const boardToolUndo = await evaluate(`(() => {
      const store = window.__openCanvasQaStore;
      const childId = ${JSON.stringify(boardToolCreated.childId)};
      store.getState().undo();
      const state = store.getState();
      const board = state.boards.find(item => item.id === state.activeBoardId);
      return { placementExists: board.placements.some(item => item.id === ${JSON.stringify(boardToolCreated.id)}), entityExists: state.boards.some(item => item.id === childId), desktopExists: state.desktop.placements.some(item => item.boardId === childId) };
    })()`);
    if (boardToolUndo.placementExists || boardToolUndo.entityExists || boardToolUndo.desktopExists) throw new Error(`Undo promoted or orphaned the newly created nested whiteboard: ${JSON.stringify(boardToolUndo)}`);
    progress('N/T/W creation tools used real previews and atomic lifecycles; nested inline rename passed commit, cancel, and independent undo/redo');

    const lightCardMotionFixture = await evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const card = state.createCard('亮色拖动与缩放视觉验收', '## 真实手势\\n截图来自越过意图阈值后的真实移动和左上角缩放。');
      const placement = state.addCardPlacement(card.id, { x: 3400, y: 900 });
      if (!placement) return null;
      state.updateBoardLayout({ [placement.id]: { width: 380, height: 220 } });
      state.setSelection({ kind: 'placement', id: placement.id, ids: [placement.id] });
      const canvas = document.querySelector('.infinite-canvas')?.getBoundingClientRect();
      if (!canvas) return null;
      state.setViewport({ zoom: 1, x: canvas.width / 2 - 3590, y: canvas.height / 2 - 1010 });
      return { id: placement.id, start: { x: 3400, y: 900, width: 380, height: 220 } };
    })()`);
    if (!lightCardMotionFixture) throw new Error('Could not establish the isolated light card motion fixture');
    const lightCardDragPoint = await waitFor(() => evaluate(`(() => {
      const toolbar = document.querySelector('[data-placement-id="${lightCardMotionFixture.id}"] .card-selection-toolbar');
      const rect = toolbar?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    })()`), 3000);
    await mouse('mousePressed', lightCardDragPoint.x, lightCardDragPoint.y, { modifiers: 1 });
    await mouse('mouseMoved', lightCardDragPoint.x + 56, lightCardDragPoint.y + 34, { buttons: 1, modifiers: 1 });
    const lightCardDragDuring = await waitFor(() => evaluate(`(() => {
      const fixture = ${JSON.stringify(lightCardMotionFixture)};
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === state.activeBoardId);
      const placement = board?.placements.find(item => item.id === fixture.id);
      const node = document.querySelector('[data-placement-id="' + fixture.id + '"]');
      const style = node && getComputedStyle(node);
      return placement && node && document.querySelector('.infinite-canvas')?.classList.contains('interaction-moving') ? {
        geometry: { x: placement.x, y: placement.y, width: placement.width, height: placement.height },
        editing: node.classList.contains('card-editing'),
        shadow: style.boxShadow,
        selectionOverlay: Boolean(document.querySelector('.multi-selection-bounds')),
      } : null;
    })()`), 3000);
    if (Math.abs(lightCardDragDuring.geometry.x - (lightCardMotionFixture.start.x + 56)) > 1
      || Math.abs(lightCardDragDuring.geometry.y - (lightCardMotionFixture.start.y + 34)) > 1
      || lightCardDragDuring.editing
      || !lightCardDragDuring.shadow
      || lightCardDragDuring.shadow === 'none'
      || lightCardDragDuring.selectionOverlay) {
      throw new Error(`Light card drag did not expose the real lightweight moving state: ${JSON.stringify(lightCardDragDuring)}`);
    }
    await captureElementArtifact('light-card-drag', '.infinite-canvas');
    await mouse('mouseReleased', lightCardDragPoint.x + 56, lightCardDragPoint.y + 34, { modifiers: 1 });
    await waitFor(() => evaluate(`!document.querySelector('.infinite-canvas')?.classList.contains('interaction-moving')`), 2000);
    await evaluate(`window.__openCanvasQaStore.getState().undo()`);
    await evaluate(`window.__openCanvasQaStore.getState().setSelection({ kind: 'placement', id: ${JSON.stringify(lightCardMotionFixture.id)}, ids: [${JSON.stringify(lightCardMotionFixture.id)}] })`);
    const lightCardResizePoint = await waitFor(() => evaluate(`(() => {
      const handle = document.querySelector('[data-placement-id="${lightCardMotionFixture.id}"] .resize-handle-nw');
      const rect = handle?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    })()`), 3000);
    await mouse('mousePressed', lightCardResizePoint.x, lightCardResizePoint.y, { modifiers: 1 });
    await mouse('mouseMoved', lightCardResizePoint.x - 44, lightCardResizePoint.y - 30, { buttons: 1, modifiers: 1 });
    const lightCardResizeDuring = await waitFor(() => evaluate(`(() => {
      const fixture = ${JSON.stringify(lightCardMotionFixture)};
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === state.activeBoardId);
      const placement = board?.placements.find(item => item.id === fixture.id);
      return placement && document.querySelector('.infinite-canvas')?.classList.contains('interaction-resizing') ? {
        geometry: { x: placement.x, y: placement.y, width: placement.width, height: placement.height },
        visibleHandles: document.querySelectorAll('[data-placement-id="' + fixture.id + '"] .resize-handle').length,
        selectionOverlay: Boolean(document.querySelector('.multi-selection-bounds')),
      } : null;
    })()`), 3000);
    if (Math.abs(lightCardResizeDuring.geometry.x - (lightCardMotionFixture.start.x - 44)) > 1
      || Math.abs(lightCardResizeDuring.geometry.y - (lightCardMotionFixture.start.y - 30)) > 1
      || Math.abs(lightCardResizeDuring.geometry.width - (lightCardMotionFixture.start.width + 44)) > 1
      || Math.abs(lightCardResizeDuring.geometry.height - (lightCardMotionFixture.start.height + 30)) > 1
      || lightCardResizeDuring.visibleHandles !== 8
      || lightCardResizeDuring.selectionOverlay) {
      throw new Error(`Light northwest resize did not preserve eight-handle direct geometry: ${JSON.stringify(lightCardResizeDuring)}`);
    }
    await captureElementArtifact('light-card-resize-northwest', '.infinite-canvas');
    await mouse('mouseReleased', lightCardResizePoint.x - 44, lightCardResizePoint.y - 30, { modifiers: 1 });
    await waitFor(() => evaluate(`!document.querySelector('.infinite-canvas')?.classList.contains('interaction-resizing')`), 2000);
    await evaluate(`window.__openCanvasQaStore.getState().undo()`);
    progress('light card drag and direct northwest resize artifacts came from real gestures and both reverted cleanly');

    await evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const canvas = document.querySelector('.infinite-canvas')?.getBoundingClientRect();
      if (!canvas) return false;
      state.setViewport({ zoom: 2.4, x: canvas.width / 2 - 550 * 2.4, y: canvas.height / 2 - 250 * 2.4 });
      return true;
    })()`);
    progress('locked Section drag kept the member fixed live, preserved elastic padding, and detached cleanly after exit');

    const forwardLayerResult = await evaluate(`(() => {
      const store = window.__openCanvasQaStore;
      const ids = ${JSON.stringify(lockedMultiSelection)};
      store.getState().updatePlacements({
        [ids.lockedId]: { locked: false, zIndex: -20 },
        [ids.freeAId]: { locked: false, zIndex: 3 },
        [ids.freeBId]: { locked: false, zIndex: 80 },
      });
      store.getState().setSelection({ kind: 'placement', id: ids.freeAId, ids: [ids.freeAId] });
      store.getState().arrangeSelection('forward');
      store.getState().setSelection(null);
      const board = store.getState().boards.find(item => item.id === store.getState().activeBoardId);
      return Object.fromEntries(board.placements.filter(item => [ids.freeAId, ids.freeBId].includes(item.id)).map(item => [item.id, item.zIndex]));
    })()`);
    const layerBlankPoint = await evaluate(`(() => { const rect = document.querySelector('.infinite-canvas')?.getBoundingClientRect(); return rect && { x: rect.right - 24, y: rect.bottom - 24 }; })()`);
    await mouse('mouseMoved', layerBlankPoint.x, layerBlankPoint.y);
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const forwardLayerTop = await evaluate(`(() => { const node = document.querySelector('[data-placement-id="${lockedMultiSelection.freeAId}"]'); const rect = node?.getBoundingClientRect(); return rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('.canvas-node')?.getAttribute('data-placement-id') : null; })()`);
    if (forwardLayerTop !== lockedMultiSelection.freeAId || forwardLayerResult[lockedMultiSelection.freeAId] <= forwardLayerResult[lockedMultiSelection.freeBId]) throw new Error(`Moving forward did not cross the nearest visible layer: ${JSON.stringify({ forwardLayerResult, forwardLayerTop })}`);
    const backwardLayerResult = await evaluate(`(() => {
      const store = window.__openCanvasQaStore;
      const ids = ${JSON.stringify(lockedMultiSelection)};
      store.getState().setSelection({ kind: 'placement', id: ids.freeAId, ids: [ids.freeAId] });
      store.getState().arrangeSelection('backward');
      store.getState().setSelection(null);
      const board = store.getState().boards.find(item => item.id === store.getState().activeBoardId);
      return Object.fromEntries(board.placements.filter(item => [ids.freeAId, ids.freeBId].includes(item.id)).map(item => [item.id, item.zIndex]));
    })()`);
    await mouse('mouseMoved', layerBlankPoint.x, layerBlankPoint.y);
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const backwardLayerTop = await evaluate(`(() => { const node = document.querySelector('[data-placement-id="${lockedMultiSelection.freeAId}"]'); const rect = node?.getBoundingClientRect(); return rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('.canvas-node')?.getAttribute('data-placement-id') : null; })()`);
    if (backwardLayerTop !== lockedMultiSelection.freeBId || backwardLayerResult[lockedMultiSelection.freeAId] >= backwardLayerResult[lockedMultiSelection.freeBId]) throw new Error(`Moving backward did not cross the nearest visible layer: ${JSON.stringify({ backwardLayerResult, backwardLayerTop })}`);

    const duplicateProfile = await evaluate(`(() => {
      const store = window.__openCanvasQaStore;
      const ids = ${JSON.stringify(lockedMultiSelection)};
      const beforeState = store.getState();
      const beforeBoard = beforeState.boards.find(item => item.id === beforeState.activeBoardId);
      const originalIds = [ids.lockedId, ids.freeAId, ids.freeBId];
      const originals = beforeBoard.placements.filter(item => originalIds.includes(item.id));
      const connectorCount = beforeBoard.connectors.length;
      beforeState.setSelection({ kind: 'placement', id: originalIds[0], ids: originalIds });
      beforeState.duplicateSelection();
      const afterState = store.getState();
      const afterBoard = afterState.boards.find(item => item.id === afterState.activeBoardId);
      const copyIds = afterState.selection?.kind === 'placement' ? (afterState.selection.ids?.length ? afterState.selection.ids : [afterState.selection.id]) : [];
      const copies = afterBoard.placements.filter(item => copyIds.includes(item.id));
      const byEntity = new Map(originals.map(item => [item.entityId, item]));
      return {
        originalIds,
        copyIds,
        originalEntities: originals.map(item => item.entityId).sort(),
        copyEntities: copies.map(item => item.entityId).sort(),
        offsets: copies.map(item => ({ id: item.id, dx: item.x - byEntity.get(item.entityId).x, dy: item.y - byEntity.get(item.entityId).y })),
        clonedConnectors: afterBoard.connectors.filter(edge => copyIds.includes(edge.from) && copyIds.includes(edge.to)).length,
        connectorDelta: afterBoard.connectors.length - connectorCount,
      };
    })()`);
    if (duplicateProfile.copyIds.length !== 3
      || duplicateProfile.copyIds.some(id => duplicateProfile.originalIds.includes(id))
      || JSON.stringify(duplicateProfile.copyEntities) !== JSON.stringify(duplicateProfile.originalEntities)
      || duplicateProfile.offsets.some(item => item.dx !== 32 || item.dy !== 32)
      || duplicateProfile.clonedConnectors !== 2 || duplicateProfile.connectorDelta !== 2) {
      throw new Error(`High-zoom instance duplication lost entity, connector, or offset semantics: ${JSON.stringify(duplicateProfile)}`);
    }
    await captureElementArtifact('light-copy-layer-high-zoom', '.infinite-canvas');
    await evaluate(`window.__openCanvasQaStore.getState().toggleDarkMode()`);
    await waitFor(() => evaluate(`document.querySelector('.app-shell')?.getAttribute('data-theme') === 'dark'`), 2000);
    await captureElementArtifact('dark-copy-layer-high-zoom', '.infinite-canvas');
    const independentCopyProfile = await evaluate(`(() => {
      const store = window.__openCanvasQaStore;
      const state = store.getState();
      const board = state.boards.find(item => item.id === state.activeBoardId);
      const sourcePlacement = board.placements.find(item => item.id === ${JSON.stringify(duplicateProfile.copyIds[0])});
      const sourceCard = state.cards.find(item => item.id === sourcePlacement?.entityId);
      const beforeCardCount = state.cards.length;
      state.setSelection({ kind: 'placement', id: sourcePlacement.id, ids: [sourcePlacement.id] });
      state.duplicateSelectionAsIndependentCards();
      const after = store.getState();
      const nextBoard = after.boards.find(item => item.id === after.activeBoardId);
      const copyId = after.selection?.kind === 'placement' ? after.selection.id : null;
      const copyPlacement = nextBoard.placements.find(item => item.id === copyId);
      const copyCard = after.cards.find(item => item.id === copyPlacement?.entityId);
      return {
        beforeCardCount, afterCardCount: after.cards.length,
        sourcePlacementId: sourcePlacement.id, copyPlacementId: copyPlacement?.id,
        sourceEntityId: sourcePlacement.entityId, copyEntityId: copyPlacement?.entityId,
        copyRelativePath: copyCard?.relativePath,
        sourceTitle: sourceCard?.title, copyTitle: copyCard?.title,
        sourceBody: sourceCard?.body, copyBody: copyCard?.body,
        offset: copyPlacement && { dx: copyPlacement.x - sourcePlacement.x, dy: copyPlacement.y - sourcePlacement.y },
      };
    })()`);
    if (independentCopyProfile.afterCardCount !== independentCopyProfile.beforeCardCount + 1
      || independentCopyProfile.copyPlacementId === independentCopyProfile.sourcePlacementId
      || independentCopyProfile.copyEntityId === independentCopyProfile.sourceEntityId
      || independentCopyProfile.copyTitle !== `${independentCopyProfile.sourceTitle} 副本`
      || independentCopyProfile.copyBody !== independentCopyProfile.sourceBody
      || independentCopyProfile.offset.dx !== 32 || independentCopyProfile.offset.dy !== 32) {
      throw new Error(`Independent card copy did not create a new Markdown entity: ${JSON.stringify(independentCopyProfile)}`);
    }
    const independentCopyEditedBody = '独立副本在撤销前继续编辑，重做后必须保留';
    await evaluate(`(() => {
      const store = window.__openCanvasQaStore;
      store.getState().updateCard(${JSON.stringify(independentCopyProfile.copyEntityId)}, { body: ${JSON.stringify('独立副本在撤销前继续编辑，重做后必须保留')} });
      return store.getState().flushPendingSaves();
    })()`);
    const independentCopyDiskPath = path.join(vault, 'notes', independentCopyProfile.copyRelativePath);
    if (!(await fs.readFile(independentCopyDiskPath, 'utf8')).includes(independentCopyEditedBody)) throw new Error(`Independent copy was not written before history verification: ${independentCopyDiskPath}`);
    await evaluate(`window.__openCanvasQaStore.getState().undo()`);
    const independentCopyUndo = await waitFor(() => evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === state.activeBoardId);
      return !state.cards.some(item => item.id === ${JSON.stringify(independentCopyProfile.copyEntityId)}) ? {
        placementExists: board?.placements.some(item => item.id === ${JSON.stringify(independentCopyProfile.copyPlacementId)}),
        selectionId: state.selection?.kind === 'placement' ? state.selection.id : null,
      } : null;
    })()`), 3000);
    if (independentCopyUndo.placementExists || independentCopyUndo.selectionId !== independentCopyProfile.sourcePlacementId) throw new Error(`Independent copy undo did not restore source selection atomically: ${JSON.stringify(independentCopyUndo)}`);
    await evaluate(`window.__openCanvasQaStore.getState().flushPendingSaves()`);
    if (fsSync.existsSync(independentCopyDiskPath)) throw new Error(`Independent copy undo left an orphan Markdown file: ${independentCopyDiskPath}`);
    await evaluate(`window.__openCanvasQaStore.getState().redo()`);
    const independentCopyRedo = await waitFor(() => evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const card = state.cards.find(item => item.id === ${JSON.stringify(independentCopyProfile.copyEntityId)});
      const board = state.boards.find(item => item.id === state.activeBoardId);
      return card && board?.placements.some(item => item.id === ${JSON.stringify(independentCopyProfile.copyPlacementId)}) ? {
        body: card.body,
        selectionId: state.selection?.kind === 'placement' ? state.selection.id : null,
      } : null;
    })()`), 3000);
    if (independentCopyRedo.body !== independentCopyEditedBody || independentCopyRedo.selectionId !== independentCopyProfile.copyPlacementId) throw new Error(`Independent copy redo lost the latest entity or copy selection: ${JSON.stringify(independentCopyRedo)}`);
    await evaluate(`window.__openCanvasQaStore.getState().flushPendingSaves()`);
    if (!(await fs.readFile(independentCopyDiskPath, 'utf8')).includes(independentCopyEditedBody)) throw new Error(`Independent copy redo did not recreate the latest Markdown file: ${independentCopyDiskPath}`);
    progress('240% layer exchange, instance duplication, connector remap, and independent Markdown copy with orphan-free undo/redo passed');

    const textConversionFixture = await evaluate(`(async () => {
      const store = window.__openCanvasQaStore;
      const state = store.getState();
      if (state.darkMode) state.toggleDarkMode();
      const board = state.createBoard('文字转卡片原生验收');
      store.getState().openBoard(board.id);
      store.getState().setViewport({ x: 0, y: 0, zoom: 1 });
      const targetCard = store.getState().createCard('连线目标', '保持连接关系');
      const target = store.getState().addCardPlacement(targetCard.id, { x: 710, y: 260 });
      const text = store.getState().addTextPlacement({ x: 300, y: 290 });
      store.getState().updatePlacement(text.id, { text: '这段白板文字将原地变成 Markdown 卡片', width: 330, height: 108, color: 'transparent' });
      store.getState().connectPlacements(text.id, target.id, { label: '保留关系' });
      store.getState().setSelection({ kind: 'placement', id: text.id, ids: [text.id] });
      await store.getState().flushPendingSaves();
      return { boardId: board.id, textId: text.id, targetId: target.id, body: '这段白板文字将原地变成 Markdown 卡片' };
    })()`);
    await waitFor(() => evaluate(`document.querySelector('[aria-label="白板名称"]')?.value === '文字转卡片原生验收' && Boolean(document.querySelector('[data-placement-id="${textConversionFixture.textId}"] .text-selection-toolbar [aria-label="转为新卡片"]'))`), 4000);
    const textToolbarProfile = await evaluate(`(() => {
      const node = document.querySelector('[data-placement-id="${textConversionFixture.textId}"]');
      const toolbar = node?.querySelector('.text-selection-toolbar');
      const button = toolbar?.querySelector('button');
      const canvas = document.querySelector('.infinite-canvas');
      const nodeRect = node?.getBoundingClientRect();
      const toolbarRect = toolbar?.getBoundingClientRect();
      const canvasRect = canvas?.getBoundingClientRect();
      const style = toolbar && getComputedStyle(toolbar);
      return nodeRect && toolbarRect && canvasRect && style ? {
        node: nodeRect.toJSON(), toolbar: toolbarRect.toJSON(), canvas: canvasRect.toJSON(),
        buttonLabel: button?.getAttribute('aria-label'), animation: style.animationName,
        above: toolbarRect.bottom <= nodeRect.top + 1,
        contained: toolbarRect.left >= canvasRect.left && toolbarRect.right <= canvasRect.right && toolbarRect.top >= canvasRect.top,
      } : null;
    })()`);
    if (!textToolbarProfile || textToolbarProfile.buttonLabel !== '转为新卡片' || !textToolbarProfile.above || !textToolbarProfile.contained || textToolbarProfile.animation === 'none') throw new Error(`Selected text conversion toolbar was not stable and contained: ${JSON.stringify(textToolbarProfile)}`);
    await captureElementArtifact('light-text-to-card-toolbar', '.infinite-canvas');

    const textNodePoint = await evaluate(`(() => { const rect = document.querySelector('[data-placement-id="${textConversionFixture.textId}"]')?.getBoundingClientRect(); return rect && { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
    await mouse('mousePressed', textNodePoint.x, textNodePoint.y, { button: 'right' });
    await mouse('mouseReleased', textNodePoint.x, textNodePoint.y, { button: 'right' });
    const convertMenuPoint = await waitFor(() => evaluate(`(() => { const item = [...document.querySelectorAll('.canvas-context-menu [role="menuitem"]')].find(node => node.textContent.includes('转为新卡片')); const rect = item?.getBoundingClientRect(); return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null; })()`), 3000);
    await mouse('mousePressed', convertMenuPoint.x, convertMenuPoint.y);
    await mouse('mouseReleased', convertMenuPoint.x, convertMenuPoint.y);
    const convertedTextProfile = await waitFor(() => evaluate(`(() => {
      const store = window.__openCanvasQaStore;
      const state = store.getState();
      const board = state.boards.find(item => item.id === ${JSON.stringify(textConversionFixture.boardId)});
      const selectionId = state.selection?.kind === 'placement' ? state.selection.id : null;
      const placement = board?.placements.find(item => item.id === selectionId);
      const card = state.cards.find(item => item.id === placement?.entityId);
      const edge = board?.connectors.find(item => item.label === '保留关系');
      return placement?.kind === 'card' && card?.body === ${JSON.stringify(textConversionFixture.body)} ? {
        placementId: placement.id, cardId: card.id, relativePath: card.relativePath,
        body: card.body, geometry: { x: placement.x, y: placement.y, width: placement.width, height: placement.height },
        color: placement.color, edgeFrom: edge?.from, edgeTo: edge?.to,
        originalExists: board.placements.some(item => item.id === ${JSON.stringify(textConversionFixture.textId)}),
        selected: document.querySelector('.canvas-node.selected')?.getAttribute('data-placement-id'),
      } : null;
    })()`), 4000);
    if (convertedTextProfile.originalExists
      || convertedTextProfile.edgeFrom !== convertedTextProfile.placementId
      || convertedTextProfile.edgeTo !== textConversionFixture.targetId
      || convertedTextProfile.selected !== convertedTextProfile.placementId
      || convertedTextProfile.color !== 'paper'
      || convertedTextProfile.geometry.x !== 300 || convertedTextProfile.geometry.y !== 290
      || convertedTextProfile.geometry.width !== 520 || convertedTextProfile.geometry.height !== 200) {
      throw new Error(`Text conversion lost placement geometry, selection, color, or connector semantics: ${JSON.stringify(convertedTextProfile)}`);
    }
    await evaluate(`window.__openCanvasQaStore.getState().flushPendingSaves()`);
    const convertedTextDiskPath = path.join(vault, 'notes', convertedTextProfile.relativePath);
    const convertedTextDisk = await fs.readFile(convertedTextDiskPath, 'utf8');
    if (!convertedTextDisk.includes(textConversionFixture.body)) throw new Error(`Text conversion did not create the Markdown file: ${convertedTextDiskPath}`);
    await captureElementArtifact('light-text-converted-card', '.infinite-canvas');

    await waitFor(() => evaluate(`!document.querySelector('.canvas-context-menu')`), 2000);
    await evaluate(`window.__openCanvasQaStore.getState().undo()`);
    const undoneTextConversion = await waitFor(() => evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === ${JSON.stringify(textConversionFixture.boardId)});
      const placement = board?.placements.find(item => item.id === ${JSON.stringify(textConversionFixture.textId)});
      const edge = board?.connectors.find(item => item.label === '保留关系');
      return placement?.kind === 'text' ? {
        selected: state.selection?.kind === 'placement' && state.selection.id === placement.id,
        createdCardExists: state.cards.some(item => item.id === ${JSON.stringify(convertedTextProfile.cardId)}),
        edgeFrom: edge?.from, edgeTo: edge?.to,
      } : null;
    })()`), 3000);
    if (!undoneTextConversion.selected || undoneTextConversion.createdCardExists || undoneTextConversion.edgeFrom !== textConversionFixture.textId || undoneTextConversion.edgeTo !== textConversionFixture.targetId) throw new Error(`Undo did not restore the original text object atomically: ${JSON.stringify(undoneTextConversion)}`);
    await evaluate(`window.__openCanvasQaStore.getState().flushPendingSaves()`);
    if (fsSync.existsSync(convertedTextDiskPath)) throw new Error(`Undo left the generated Markdown file active: ${convertedTextDiskPath}`);

    await evaluate(`window.__openCanvasQaStore.getState().redo()`);
    const redoneTextConversion = await waitFor(() => evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === ${JSON.stringify(textConversionFixture.boardId)});
      const placement = board?.placements.find(item => item.id === ${JSON.stringify(convertedTextProfile.placementId)});
      return placement?.kind === 'card' ? {
        selected: state.selection?.kind === 'placement' && state.selection.id === placement.id,
        cardExists: state.cards.some(item => item.id === ${JSON.stringify(convertedTextProfile.cardId)}),
      } : null;
    })()`), 3000);
    if (!redoneTextConversion.selected || !redoneTextConversion.cardExists) throw new Error(`Redo did not restore the converted card and its selection atomically: ${JSON.stringify(redoneTextConversion)}`);
    await evaluate(`window.__openCanvasQaStore.getState().flushPendingSaves()`);
    const redoneTextDisk = await fs.readFile(convertedTextDiskPath, 'utf8');
    if (!redoneTextDisk.includes(textConversionFixture.body)) throw new Error(`Redo did not recreate the generated Markdown file: ${convertedTextDiskPath}`);
    progress('selected text converted through the real menu into a Markdown card with geometry, connector, selection, undo/redo, and disk lifecycle intact');

    const defaultSizeFixture = await evaluate(`(async () => {
      const store = window.__openCanvasQaStore;
      const state = store.getState();
      if (state.darkMode) state.toggleDarkMode();
      const board = state.createBoard('恢复默认尺寸原生验收');
      const nestedBoard = state.createBoard('默认尺寸嵌套白板');
      store.getState().openBoard(board.id);
      store.getState().setViewport({ x: 0, y: 0, zoom: 1 });
      const card = store.getState().createCard('尺寸基准卡片', '恢复后仍保持内容与关系');
      const cardPlacement = store.getState().addCardPlacement(card.id, { x: 220, y: 180 });
      store.getState().updatePlacement(cardPlacement.id, { width: 220, height: 100 });
      store.getState().setSelection({ kind: 'placement', id: cardPlacement.id, ids: [cardPlacement.id] });
      store.getState().frameSelection();
      const sectionId = store.getState().selection?.kind === 'placement' ? store.getState().selection.id : null;
      const nestedPlacement = store.getState().addBoardPlacement(nestedBoard.id, { x: 580, y: 190 });
      store.getState().updatePlacement(nestedPlacement.id, { width: 760, height: 420 });
      const lockedText = store.getState().addTextPlacement({ x: 230, y: 500 });
      store.getState().updatePlacement(lockedText.id, { text: '锁定文字不改变尺寸', width: 620, height: 260, locked: true });
      const selectedIds = [sectionId, cardPlacement.id, nestedPlacement.id, lockedText.id].filter(Boolean);
      store.getState().setSelection({ kind: 'placement', id: cardPlacement.id, ids: selectedIds });
      await store.getState().flushPendingSaves();
      return { boardId: board.id, fileName: board.fileName, cardId: cardPlacement.id, cardEntityId: card.id, nestedId: nestedPlacement.id, lockedTextId: lockedText.id, sectionId, selectedIds };
    })()`);
    await waitFor(() => evaluate(`document.querySelector('[aria-label="白板名称"]')?.value === '恢复默认尺寸原生验收' && document.querySelectorAll('.canvas-node.selected').length === 4`), 4000);
    const defaultSizeMenuPoint = await evaluate(`(() => { const rect = document.querySelector('[data-placement-id="${defaultSizeFixture.cardId}"]')?.getBoundingClientRect(); return rect && { x: rect.left + Math.min(80, rect.width / 2), y: rect.top + Math.min(22, rect.height / 2) }; })()`);
    await mouse('mousePressed', defaultSizeMenuPoint.x, defaultSizeMenuPoint.y, { button: 'right' });
    await mouse('mouseReleased', defaultSizeMenuPoint.x, defaultSizeMenuPoint.y, { button: 'right' });
    const defaultSizeActionPoint = await waitFor(() => evaluate(`(() => { const items = [...document.querySelectorAll('.canvas-context-menu [role="menuitem"]')]; const item = items.find(node => node.textContent.includes('恢复默认尺寸')); const rect = item?.getBoundingClientRect(); return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, matches: items.filter(node => node.textContent.includes('恢复默认尺寸')).length } : null; })()`), 3000);
    if (defaultSizeActionPoint.matches !== 1) throw new Error(`Default-size menu action was duplicated: ${JSON.stringify(defaultSizeActionPoint)}`);
    await captureElementArtifact('light-default-size-menu', '.infinite-canvas');
    await mouse('mousePressed', defaultSizeActionPoint.x, defaultSizeActionPoint.y);
    await mouse('mouseReleased', defaultSizeActionPoint.x, defaultSizeActionPoint.y);
    const defaultSizeApplied = await waitFor(() => evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === ${JSON.stringify(defaultSizeFixture.boardId)});
      const value = id => board?.placements.find(item => item.id === id);
      const card = value(${JSON.stringify(defaultSizeFixture.cardId)});
      const nested = value(${JSON.stringify(defaultSizeFixture.nestedId)});
      const locked = value(${JSON.stringify(defaultSizeFixture.lockedTextId)});
      const section = value(${JSON.stringify(defaultSizeFixture.sectionId)});
      return card?.width === 520 && card?.height === 185 && nested?.width === 430 && nested?.height === 270 ? {
        card: { x: card.x, y: card.y, width: card.width, height: card.height },
        nested: { x: nested.x, y: nested.y, width: nested.width, height: nested.height },
        locked: { width: locked?.width, height: locked?.height },
        section: section && { x: section.x, y: section.y, width: section.width, height: section.height, base: section.sectionBaseBounds },
        selection: state.selection,
      } : null;
    })()`), 3000);
    if (defaultSizeApplied.locked.width !== 620 || defaultSizeApplied.locked.height !== 260
      || defaultSizeApplied.section.width !== 600 || defaultSizeApplied.section.height !== 265
      || defaultSizeApplied.section.base?.width !== 300 || defaultSizeApplied.section.base?.height !== 180
      || JSON.stringify(defaultSizeApplied.selection?.ids) !== JSON.stringify(defaultSizeFixture.selectedIds)) {
      throw new Error(`Default-size command lost locked, Section-padding, or selection semantics: ${JSON.stringify(defaultSizeApplied)}`);
    }
    await captureElementArtifact('light-default-size-applied', '.infinite-canvas');
    await evaluate(`window.__openCanvasQaStore.getState().toggleDarkMode()`);
    await waitFor(() => evaluate(`document.querySelector('.app-shell')?.getAttribute('data-theme') === 'dark'`), 2000);
    await captureElementArtifact('dark-default-size-applied', '.infinite-canvas');
    await evaluate(`window.__openCanvasQaStore.getState().undo()`);
    const defaultSizeUndone = await waitFor(() => evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === ${JSON.stringify(defaultSizeFixture.boardId)});
      const value = id => board?.placements.find(item => item.id === id);
      const card = value(${JSON.stringify(defaultSizeFixture.cardId)});
      const nested = value(${JSON.stringify(defaultSizeFixture.nestedId)});
      const section = value(${JSON.stringify(defaultSizeFixture.sectionId)});
      return card?.width === 220 && nested?.width === 760 ? { card, nested, section, selection: state.selection } : null;
    })()`), 3000);
    if (defaultSizeUndone.card.height !== 100 || defaultSizeUndone.nested.height !== 420 || defaultSizeUndone.section.width !== 300 || defaultSizeUndone.section.height !== 180 || defaultSizeUndone.section.sectionBaseBounds || JSON.stringify(defaultSizeUndone.selection?.ids) !== JSON.stringify(defaultSizeFixture.selectedIds)) throw new Error(`Undo did not restore the pre-default geometry atomically: ${JSON.stringify(defaultSizeUndone)}`);
    await evaluate(`(() => { window.__openCanvasQaStore.getState().redo(); return window.__openCanvasQaStore.getState().flushPendingSaves(); })()`);
    const defaultSizeDiskBoard = JSON.parse(await fs.readFile(path.join(vault, 'boards', defaultSizeFixture.fileName), 'utf8'));
    const defaultSizeDiskCard = defaultSizeDiskBoard.placements.find(item => item.id === defaultSizeFixture.cardId);
    const defaultSizeDiskNested = defaultSizeDiskBoard.placements.find(item => item.id === defaultSizeFixture.nestedId);
    if (defaultSizeDiskCard?.width !== 520 || defaultSizeDiskCard?.height !== 185 || defaultSizeDiskNested?.width !== 430 || defaultSizeDiskNested?.height !== 270) throw new Error(`Redo did not persist default dimensions to board JSON: ${JSON.stringify({ defaultSizeDiskCard, defaultSizeDiskNested })}`);
    progress('real default-size menu restored mixed object dimensions, respected locks, grew Section padding, and survived dark/light undo/redo plus disk reload');

    await evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      if (state.darkMode) state.toggleDarkMode();
      state.setSelection({ kind: 'placement', id: ${JSON.stringify(defaultSizeFixture.sectionId)}, ids: [${JSON.stringify(defaultSizeFixture.sectionId)}] });
    })()`);
    const fitSectionMenuPoint = await waitFor(() => evaluate(`(() => { const rect = document.querySelector('[data-placement-id="${defaultSizeFixture.sectionId}"]')?.getBoundingClientRect(); return rect && { x: rect.left + Math.min(90, rect.width / 2), y: rect.top + Math.min(20, rect.height / 2) }; })()`), 3000);
    await mouse('mousePressed', fitSectionMenuPoint.x, fitSectionMenuPoint.y, { button: 'right' });
    await mouse('mouseReleased', fitSectionMenuPoint.x, fitSectionMenuPoint.y, { button: 'right' });
    const fitSectionActionPoint = await waitFor(() => evaluate(`(() => { const items = [...document.querySelectorAll('.canvas-context-menu [role="menuitem"]')]; const item = items.find(node => node.textContent.includes('适应内容')); const rect = item?.getBoundingClientRect(); return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, matches: items.filter(node => node.textContent.includes('适应内容')).length } : null; })()`), 3000);
    if (fitSectionActionPoint.matches !== 1) throw new Error(`Fit-to-content menu action was duplicated: ${JSON.stringify(fitSectionActionPoint)}`);
    await captureElementArtifact('light-section-fit-menu', '.infinite-canvas');
    await mouse('mousePressed', fitSectionActionPoint.x, fitSectionActionPoint.y);
    await mouse('mouseReleased', fitSectionActionPoint.x, fitSectionActionPoint.y);
    const fittedSection = await waitFor(() => evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === ${JSON.stringify(defaultSizeFixture.boardId)});
      const section = board?.placements.find(item => item.id === ${JSON.stringify(defaultSizeFixture.sectionId)});
      return section && !section.sectionBaseBounds ? { section, selection: state.selection } : null;
    })()`), 3000);
    if (fittedSection.section.x !== 180 || fittedSection.section.y !== 140 || fittedSection.section.width !== 600 || fittedSection.section.height !== 265 || fittedSection.selection?.id !== defaultSizeFixture.sectionId) throw new Error(`Fit-to-content did not preserve exact Section padding and selection: ${JSON.stringify(fittedSection)}`);
    await captureElementArtifact('light-section-fit-applied', '.infinite-canvas');
    await evaluate(`window.__openCanvasQaStore.getState().toggleDarkMode()`);
    await captureElementArtifact('dark-section-fit-applied', '.infinite-canvas');
    await evaluate(`window.__openCanvasQaStore.getState().undo()`);
    const fitSectionUndone = await waitFor(() => evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === ${JSON.stringify(defaultSizeFixture.boardId)});
      const section = board?.placements.find(item => item.id === ${JSON.stringify(defaultSizeFixture.sectionId)});
      return section?.sectionBaseBounds ? { section, selection: state.selection } : null;
    })()`), 3000);
    if (fitSectionUndone.section.sectionBaseBounds.width !== 300 || fitSectionUndone.section.sectionBaseBounds.height !== 180 || fitSectionUndone.selection?.id !== defaultSizeFixture.sectionId) throw new Error(`Undo did not restore the Section manual base: ${JSON.stringify(fitSectionUndone)}`);
    await evaluate(`(() => { window.__openCanvasQaStore.getState().redo(); return window.__openCanvasQaStore.getState().flushPendingSaves(); })()`);
    const fitSectionDiskBoard = JSON.parse(await fs.readFile(path.join(vault, 'boards', defaultSizeFixture.fileName), 'utf8'));
    const fitSectionDisk = fitSectionDiskBoard.placements.find(item => item.id === defaultSizeFixture.sectionId);
    if (fitSectionDisk?.x !== 180 || fitSectionDisk?.y !== 140 || fitSectionDisk?.width !== 600 || fitSectionDisk?.height !== 265 || fitSectionDisk?.sectionBaseBounds) throw new Error(`Redo did not persist the fitted Section bounds: ${JSON.stringify(fitSectionDisk)}`);
    progress('real Section menu fit content to exact member padding, cleared the elastic base, and survived light/dark undo/redo plus disk reload');

    await evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      if (state.darkMode) state.toggleDarkMode();
      state.setSelection({ kind: 'placement', id: ${JSON.stringify(defaultSizeFixture.cardId)}, ids: [${JSON.stringify(defaultSizeFixture.cardId)}] });
    })()`);
    const fitCardMenuPoint = await waitFor(() => evaluate(`(() => { const rect = document.querySelector('[data-placement-id="${defaultSizeFixture.cardId}"]')?.getBoundingClientRect(); return rect && { x: rect.left + Math.min(90, rect.width / 2), y: rect.top + Math.min(22, rect.height / 2) }; })()`), 3000);
    await mouse('mousePressed', fitCardMenuPoint.x, fitCardMenuPoint.y, { button: 'right' });
    await mouse('mouseReleased', fitCardMenuPoint.x, fitCardMenuPoint.y, { button: 'right' });
    const fitCardActionPoint = await waitFor(() => evaluate(`(() => { const items = [...document.querySelectorAll('.canvas-context-menu [role="menuitem"]')]; const item = items.find(node => node.textContent.includes('适应内容')); const rect = item?.getBoundingClientRect(); return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, matches: items.filter(node => node.textContent.includes('适应内容')).length } : null; })()`), 3000);
    if (fitCardActionPoint.matches !== 1) throw new Error(`Card fit-to-content menu action was duplicated: ${JSON.stringify(fitCardActionPoint)}`);
    await captureElementArtifact('light-card-fit-menu', '.infinite-canvas');
    await mouse('mousePressed', fitCardActionPoint.x, fitCardActionPoint.y);
    await mouse('mouseReleased', fitCardActionPoint.x, fitCardActionPoint.y);
    const fittedCardInitial = await waitFor(() => evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === ${JSON.stringify(defaultSizeFixture.boardId)});
      const card = board?.placements.find(item => item.id === ${JSON.stringify(defaultSizeFixture.cardId)});
      const editor = document.querySelector('[data-placement-id="${defaultSizeFixture.cardId}"] .card-inline-editor');
      const contentBottom = editor ? Math.max(0, ...[...editor.children].map(child => child.offsetTop + Math.max(child.offsetHeight, child.scrollHeight))) : null;
      const paddingBottom = editor ? Number(getComputedStyle(editor).paddingBottom.replace('px', '')) : 0;
      const expected = contentBottom === null ? null : Math.max(145, Math.ceil(39 + contentBottom + paddingBottom));
      return card?.autoHeight && expected === card.height ? { card, expected, selection: state.selection } : null;
    })()`), 3000);
    if (fittedCardInitial.selection?.id !== defaultSizeFixture.cardId || fittedCardInitial.card.scrollTop !== 0) throw new Error(`Initial card fit lost selection or scroll reset: ${JSON.stringify(fittedCardInitial)}`);
    await captureElementArtifact('light-card-fit-applied', '.infinite-canvas');

    const autoHeightBody = Array.from({ length: 24 }, (_, index) => `自动高度正文 ${index + 1}：内容变化后卡片与 Section 应同步增长。`).join('\n\n');
    await evaluate(`window.__openCanvasQaStore.getState().updateCard(${JSON.stringify(defaultSizeFixture.cardEntityId)}, { body: ${JSON.stringify(autoHeightBody)} })`);
    const autoHeightGrown = await waitFor(() => evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === ${JSON.stringify(defaultSizeFixture.boardId)});
      const card = board?.placements.find(item => item.id === ${JSON.stringify(defaultSizeFixture.cardId)});
      const section = board?.placements.find(item => item.id === ${JSON.stringify(defaultSizeFixture.sectionId)});
      const editor = document.querySelector('[data-placement-id="${defaultSizeFixture.cardId}"] .card-inline-editor');
      const contentBottom = editor ? Math.max(0, ...[...editor.children].map(child => child.offsetTop + Math.max(child.offsetHeight, child.scrollHeight))) : null;
      const paddingBottom = editor ? Number(getComputedStyle(editor).paddingBottom.replace('px', '')) : 0;
      const expected = contentBottom === null ? null : Math.max(145, Math.ceil(39 + contentBottom + paddingBottom));
      return card?.autoHeight && expected === card.height && card.height > ${fittedCardInitial.card.height + 120} ? { card, section, expected } : null;
    })()`), 5000);
    const grownBottomGap = autoHeightGrown.section.y + autoHeightGrown.section.height - (autoHeightGrown.card.y + autoHeightGrown.card.height);
    if (Math.abs(grownBottomGap - 40) > 0.01 || !autoHeightGrown.section.sectionBaseBounds) throw new Error(`Automatic card height did not keep the Section elastic padding: ${JSON.stringify({ autoHeightGrown, grownBottomGap })}`);

    await evaluate(`window.__openCanvasQaStore.getState().undo()`);
    const fitCardUndone = await waitFor(() => evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === ${JSON.stringify(defaultSizeFixture.boardId)});
      const card = board?.placements.find(item => item.id === ${JSON.stringify(defaultSizeFixture.cardId)});
      return card && !card.autoHeight && card.height === 185 ? { card, selection: state.selection } : null;
    })()`), 3000);
    if (fitCardUndone.selection?.id !== defaultSizeFixture.cardId) throw new Error(`Undo of card fit lost selection: ${JSON.stringify(fitCardUndone)}`);
    await evaluate(`window.__openCanvasQaStore.getState().redo()`);
    const fitCardRedone = await waitFor(() => evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === ${JSON.stringify(defaultSizeFixture.boardId)});
      const card = board?.placements.find(item => item.id === ${JSON.stringify(defaultSizeFixture.cardId)});
      return card?.autoHeight && card.height > ${fittedCardInitial.card.height + 120} ? card : null;
    })()`), 5000);

    // Direct resize handles are exercised above with the real northwest
    // pointer gesture. Here isolate the mode transition from Section snapping:
    // the same placement update committed by any height handle must leave
    // auto-height before later Markdown changes arrive.
    await evaluate(`window.__openCanvasQaStore.getState().updateBoardLayout({ ${JSON.stringify(defaultSizeFixture.cardId)}: { height: ${fitCardRedone.height - 86} } })`);
    const manuallyResizedCard = await waitFor(() => evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === ${JSON.stringify(defaultSizeFixture.boardId)});
      const card = board?.placements.find(item => item.id === ${JSON.stringify(defaultSizeFixture.cardId)});
      return card && !card.autoHeight && card.height < ${fitCardRedone.height - 70} ? card : null;
    })()`), 3000);
    const manualHeight = manuallyResizedCard.height;
    const longerManualBody = autoHeightBody + '\n\n' + Array.from({ length: 30 }, (_, index) => `手动尺寸保持段落 ${index + 1}`).join('\n\n');
    await evaluate(`window.__openCanvasQaStore.getState().updateCard(${JSON.stringify(defaultSizeFixture.cardEntityId)}, { body: ${JSON.stringify(longerManualBody)} })`);
    await delay(500);
    const manualHeightAfterContent = await evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); const board = state.boards.find(item => item.id === ${JSON.stringify(defaultSizeFixture.boardId)}); const card = board?.placements.find(item => item.id === ${JSON.stringify(defaultSizeFixture.cardId)}); return { height: card?.height, autoHeight: card?.autoHeight }; })()`);
    if (manualHeightAfterContent.height !== manualHeight || manualHeightAfterContent.autoHeight) throw new Error(`Manual card resize did not disable automatic height: ${JSON.stringify({ manualHeight, manualHeightAfterContent })}`);
    await evaluate(`window.__openCanvasQaStore.getState().toggleDarkMode()`);
    await captureElementArtifact('dark-card-fit-manual-height', '.infinite-canvas');
    await evaluate(`window.__openCanvasQaStore.getState().flushPendingSaves()`);
    const manualFitDiskBoard = JSON.parse(await fs.readFile(path.join(vault, 'boards', defaultSizeFixture.fileName), 'utf8'));
    const manualFitDiskCard = manualFitDiskBoard.placements.find(item => item.id === defaultSizeFixture.cardId);
    if (manualFitDiskCard?.height !== manualHeight || manualFitDiskCard?.autoHeight) throw new Error(`Manual card size did not persist after leaving auto height: ${JSON.stringify(manualFitDiskCard)}`);
    progress('real card menu fitted rendered content, live Markdown changes grew the card and Section, undo/redo preserved the mode, and manual resize disabled it');

    await evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      if (state.darkMode) state.toggleDarkMode();
      state.setSelection({ kind: 'placement', id: ${JSON.stringify(defaultSizeFixture.cardId)}, ids: [${JSON.stringify(defaultSizeFixture.cardId)}] });
    })()`);
    const foldMenuPoint = await waitFor(() => evaluate(`(() => { const rect = document.querySelector('[data-placement-id="${defaultSizeFixture.cardId}"]')?.getBoundingClientRect(); return rect && { x: rect.left + Math.min(90, rect.width / 2), y: rect.top + Math.min(20, rect.height / 2) }; })()`), 3000);
    await mouse('mousePressed', foldMenuPoint.x, foldMenuPoint.y, { button: 'right' });
    await mouse('mouseReleased', foldMenuPoint.x, foldMenuPoint.y, { button: 'right' });
    const foldActionPoint = await waitFor(() => evaluate(`(() => { const item = [...document.querySelectorAll('.canvas-context-menu [role="menuitem"]')].find(node => node.textContent.includes('折叠卡片')); const rect = item?.getBoundingClientRect(); return rect && { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`), 3000);
    await mouse('mousePressed', foldActionPoint.x, foldActionPoint.y);
    await mouse('mouseReleased', foldActionPoint.x, foldActionPoint.y);
    const foldedCardProfile = await waitFor(() => evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === ${JSON.stringify(defaultSizeFixture.boardId)});
      const card = board?.placements.find(item => item.id === ${JSON.stringify(defaultSizeFixture.cardId)});
      const node = document.querySelector('[data-placement-id="${defaultSizeFixture.cardId}"]');
      const rect = node?.getBoundingClientRect();
      const handles = [...(node?.querySelectorAll('.resize-handle') || [])].map(item => item.className).sort();
      return card?.collapsed && rect && Math.abs(rect.height - 62) < 1 ? {
        card,
        rect: rect.toJSON(),
        handles,
        title: node.querySelector('.card-collapsed-title')?.textContent,
        editors: node.querySelectorAll('.card-inline-editor').length,
        expandButton: node.querySelector('[aria-label="展开卡片内容"]')?.getAttribute('aria-label'),
        selected: node.classList.contains('selected'),
      } : null;
    })()`), 4000);
    if (foldedCardProfile.card.expandedHeight !== manualHeight
      || foldedCardProfile.card.autoHeight
      || foldedCardProfile.editors !== 0
      || foldedCardProfile.handles.length !== 2
      || !foldedCardProfile.handles.every(value => /resize-handle-[ew](?:\s|$)/.test(value))
      || foldedCardProfile.title !== '尺寸基准卡片'
      || foldedCardProfile.expandButton !== '展开卡片内容'
      || !foldedCardProfile.selected) {
      throw new Error(`Folded card did not preserve expanded geometry or render the compact title strip: ${JSON.stringify(foldedCardProfile)}`);
    }
    await captureElementArtifact('light-card-folded', '.infinite-canvas');

    const foldedEastHandle = await evaluate(`(() => { const rect = document.querySelector('[data-placement-id="${defaultSizeFixture.cardId}"] .resize-handle-e')?.getBoundingClientRect(); return rect && { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
    await mouse('mousePressed', foldedEastHandle.x, foldedEastHandle.y, { modifiers: 1 });
    await mouse('mouseMoved', foldedEastHandle.x - 600, foldedEastHandle.y, { buttons: 1, modifiers: 1 });
    await mouse('mouseReleased', foldedEastHandle.x - 600, foldedEastHandle.y, { modifiers: 1 });
    const foldedDirectMinimum = await waitFor(() => evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); const board = state.boards.find(item => item.id === ${JSON.stringify(defaultSizeFixture.boardId)}); const card = board?.placements.find(item => item.id === ${JSON.stringify(defaultSizeFixture.cardId)}); return card?.collapsed && card.width === 280 ? card : null; })()`), 3000);
    if (foldedDirectMinimum.height !== 62 || foldedDirectMinimum.expandedHeight !== manualHeight) throw new Error(`Folded horizontal resize did not use the 280px compact minimum: ${JSON.stringify(foldedDirectMinimum)}`);
    await evaluate(`window.__openCanvasQaStore.getState().undo()`);
    await waitFor(() => evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); const board = state.boards.find(item => item.id === ${JSON.stringify(defaultSizeFixture.boardId)}); const card = board?.placements.find(item => item.id === ${JSON.stringify(defaultSizeFixture.cardId)}); return card?.collapsed && card.width === 520; })()`), 3000);

    const foldedFitMenuPoint = await evaluate(`(() => { const rect = document.querySelector('[data-placement-id="${defaultSizeFixture.cardId}"]')?.getBoundingClientRect(); return rect && { x: rect.left + Math.min(90, rect.width / 2), y: rect.top + rect.height / 2 }; })()`);
    await mouse('mousePressed', foldedFitMenuPoint.x, foldedFitMenuPoint.y, { button: 'right' });
    await mouse('mouseReleased', foldedFitMenuPoint.x, foldedFitMenuPoint.y, { button: 'right' });
    const foldedFitActionPoint = await waitFor(() => evaluate(`(() => { const item = [...document.querySelectorAll('.canvas-context-menu [role="menuitem"]')].find(node => node.textContent.includes('适应内容')); const rect = item?.getBoundingClientRect(); return rect && { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`), 3000);
    await mouse('mousePressed', foldedFitActionPoint.x, foldedFitActionPoint.y);
    await mouse('mouseReleased', foldedFitActionPoint.x, foldedFitActionPoint.y);
    const foldedFittedProfile = await waitFor(() => evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === ${JSON.stringify(defaultSizeFixture.boardId)});
      const card = board?.placements.find(item => item.id === ${JSON.stringify(defaultSizeFixture.cardId)});
      const title = document.querySelector('[data-placement-id="${defaultSizeFixture.cardId}"] .card-collapsed-title');
      const expected = title ? Math.max(280, Math.ceil(title.scrollWidth + 96)) : null;
      return card?.collapsed && card.width === expected ? { card, expected, selection: state.selection } : null;
    })()`), 3000);
    if (foldedFittedProfile.card.height !== 62 || foldedFittedProfile.card.expandedHeight !== manualHeight || foldedFittedProfile.selection?.id !== defaultSizeFixture.cardId) throw new Error(`Folded fit-to-content lost height, expansion state, or selection: ${JSON.stringify(foldedFittedProfile)}`);
    await evaluate(`window.__openCanvasQaStore.getState().undo()`);
    const foldedFitUndone = await waitFor(() => evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); const board = state.boards.find(item => item.id === ${JSON.stringify(defaultSizeFixture.boardId)}); const card = board?.placements.find(item => item.id === ${JSON.stringify(defaultSizeFixture.cardId)}); return card?.collapsed && card.width === 520 ? card : null; })()`), 3000);
    if (foldedFitUndone.height !== 62 || foldedFitUndone.expandedHeight !== manualHeight) throw new Error(`Undo of folded width fit lost the folded geometry: ${JSON.stringify(foldedFitUndone)}`);
    await evaluate(`window.__openCanvasQaStore.getState().undo()`);
    const foldUndone = await waitFor(() => evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); const board = state.boards.find(item => item.id === ${JSON.stringify(defaultSizeFixture.boardId)}); const card = board?.placements.find(item => item.id === ${JSON.stringify(defaultSizeFixture.cardId)}); return card && !card.collapsed && card.height === ${manualHeight} && document.querySelector('[data-placement-id="${defaultSizeFixture.cardId}"] .card-inline-editor') ? card : null; })()`), 4000);
    if (foldUndone.expandedHeight !== undefined) throw new Error(`Undo of fold retained private folded geometry: ${JSON.stringify(foldUndone)}`);
    await evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); state.redo(); state.redo(); })()`);
    await waitFor(() => evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); const board = state.boards.find(item => item.id === ${JSON.stringify(defaultSizeFixture.boardId)}); const card = board?.placements.find(item => item.id === ${JSON.stringify(defaultSizeFixture.cardId)}); return card?.collapsed && card.width === ${foldedFittedProfile.expected}; })()`), 4000);
    await evaluate(`window.__openCanvasQaStore.getState().toggleDarkMode()`);
    await captureElementArtifact('dark-card-folded-fitted', '.infinite-canvas');
    const expandButtonPoint = await evaluate(`(() => { const rect = document.querySelector('[data-placement-id="${defaultSizeFixture.cardId}"] [aria-label="展开卡片内容"]')?.getBoundingClientRect(); return rect && { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
    await mouse('mousePressed', expandButtonPoint.x, expandButtonPoint.y);
    await mouse('mouseReleased', expandButtonPoint.x, expandButtonPoint.y);
    const expandedAfterFold = await waitFor(() => evaluate(`(() => {
      const state = window.__openCanvasQaStore.getState();
      const board = state.boards.find(item => item.id === ${JSON.stringify(defaultSizeFixture.boardId)});
      const card = board?.placements.find(item => item.id === ${JSON.stringify(defaultSizeFixture.cardId)});
      const node = document.querySelector('[data-placement-id="${defaultSizeFixture.cardId}"]');
      return card && !card.collapsed && card.height === ${manualHeight} && node?.querySelector('.card-inline-editor') ? { card, handles: node.querySelectorAll('.resize-handle').length } : null;
    })()`), 4000);
    if (expandedAfterFold.card.expandedHeight !== undefined || expandedAfterFold.handles !== 8 || expandedAfterFold.card.width !== foldedFittedProfile.expected) throw new Error(`Toolbar expansion did not restore the document and vertical size: ${JSON.stringify(expandedAfterFold)}`);
    await evaluate(`window.__openCanvasQaStore.getState().flushPendingSaves()`);
    const expandedDiskBoard = JSON.parse(await fs.readFile(path.join(vault, 'boards', defaultSizeFixture.fileName), 'utf8'));
    const expandedDiskCard = expandedDiskBoard.placements.find(item => item.id === defaultSizeFixture.cardId);
    if (expandedDiskCard?.collapsed || expandedDiskCard?.height !== manualHeight || expandedDiskCard?.expandedHeight !== undefined) throw new Error(`Expanded card state did not persist cleanly: ${JSON.stringify(expandedDiskCard)}`);
    progress('real fold menu rendered the 62px title strip, folded fit measured natural title width, undo/redo restored both modes, and the toolbar expanded the card cleanly');

    const longPanelCard = await evaluate(`(() => {
      const store = window.__openCanvasQaStore;
      const state = store.getState();
      const card = state.createCard('这是一个用于验证超长标题在右侧栏与全屏阅读之间平稳过渡且不会挤压工具栏或造成横向溢出的组合验收卡片', '## 长标题验收\\n右侧栏与全屏页面使用同一份 Markdown 内容。\\n\\n- 保持编辑器实例唯一\\n- 保持滚动与焦点连续\\n- 不产生页面级横向滚动');
      if (state.darkMode) state.toggleDarkMode();
      state.openCardInSidePanel(card.id);
      return { id: card.id, title: card.title };
    })()`);
    await waitFor(() => evaluate(`document.querySelector('.card-side-panel-title')?.value === ${JSON.stringify(longPanelCard.title)} && Boolean(document.querySelector('.card-side-panel .card-prosemirror'))`), 5000);
    const readPanelLayout = () => evaluate(`(() => {
      const panel = document.querySelector('.card-side-panel');
      const header = panel?.querySelector('.card-side-panel-header');
      const documentPane = panel?.querySelector('.card-side-panel-document');
      const title = panel?.querySelector('.card-side-panel-title');
      const editor = panel?.querySelector('.structured-card-editor');
      const panelRect = panel?.getBoundingClientRect();
      const headerRect = header?.getBoundingClientRect();
      const documentRect = documentPane?.getBoundingClientRect();
      const titleRect = title?.getBoundingClientRect();
      return panelRect && headerRect && documentRect && titleRect ? {
        theme: document.querySelector('.app-shell')?.getAttribute('data-theme'),
        panel: panelRect.toJSON(),
        header: headerRect.toJSON(),
        document: documentRect.toJSON(),
        title: titleRect.toJSON(),
        editors: panel.querySelectorAll('.structured-card-editor').length,
        activeEditors: [...document.querySelectorAll('.card-prosemirror[contenteditable="true"]')].filter(item => !item.closest('[inert]')).length,
        rootOverflow: document.documentElement.scrollWidth - innerWidth,
        panelOverflow: panel.scrollWidth - panel.clientWidth,
        documentOverflow: documentPane.scrollWidth - documentPane.clientWidth,
        editorContained: Boolean(editor && editor.getBoundingClientRect().left >= documentRect.left - 1 && editor.getBoundingClientRect().right <= documentRect.right + 1),
      } : null;
    })()`);
    const lightPanelLayout = await readPanelLayout();
    if (!lightPanelLayout || lightPanelLayout.theme !== 'light' || lightPanelLayout.editors !== 1 || lightPanelLayout.activeEditors !== 1 || lightPanelLayout.rootOverflow > 1 || lightPanelLayout.panelOverflow > 1 || lightPanelLayout.documentOverflow > 1 || !lightPanelLayout.editorContained || lightPanelLayout.title.left < lightPanelLayout.document.left - 1 || lightPanelLayout.title.right > lightPanelLayout.document.right + 1 || lightPanelLayout.header.right > lightPanelLayout.panel.right + 1) throw new Error(`Light long-title side panel overflowed or duplicated its editor: ${JSON.stringify(lightPanelLayout)}`);
    await captureVisualArtifact('light-side-panel-long-title');
    await evaluate(`document.querySelector('.card-side-panel [aria-label="展开卡片"]')?.click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.note-page .card-prosemirror')) && document.querySelector('.note-page input[aria-label="卡片标题"]')?.value === ${JSON.stringify(longPanelCard.title)}`), 5000);
    const readPageLayout = () => evaluate(`(() => {
      const page = document.querySelector('.note-page');
      const documentPane = page?.querySelector('.note-page-document');
      const title = page?.querySelector('input[aria-label="卡片标题"]');
      const pageRect = page?.getBoundingClientRect();
      const documentRect = documentPane?.getBoundingClientRect();
      const titleRect = title?.getBoundingClientRect();
      return pageRect && documentRect && titleRect ? {
        theme: document.querySelector('.app-shell')?.getAttribute('data-theme'),
        page: pageRect.toJSON(), document: documentRect.toJSON(), title: titleRect.toJSON(),
        pageEditors: page.querySelectorAll('.structured-card-editor').length,
        totalEditors: document.querySelectorAll('.structured-card-editor').length,
        activeEditors: [...document.querySelectorAll('.card-prosemirror[contenteditable="true"]')].filter(item => !item.closest('[inert]')).length,
        rootOverflow: document.documentElement.scrollWidth - innerWidth,
        pageOverflow: page.scrollWidth - page.clientWidth,
        documentOverflow: documentPane.scrollWidth - documentPane.clientWidth,
      } : null;
    })()`);
    const lightPageLayout = await readPageLayout();
    if (!lightPageLayout || lightPageLayout.theme !== 'light' || lightPageLayout.pageEditors !== 1 || lightPageLayout.totalEditors !== 2 || lightPageLayout.activeEditors !== 1 || lightPageLayout.rootOverflow > 1 || lightPageLayout.pageOverflow > 1 || lightPageLayout.documentOverflow > 1 || lightPageLayout.title.left < lightPageLayout.document.left - 1 || lightPageLayout.title.right > lightPageLayout.document.right + 1) throw new Error(`Light long-title full page overflowed or leaked an active editor: ${JSON.stringify(lightPageLayout)}`);
    await captureVisualArtifact('light-full-page-long-title');
    await evaluate(`document.querySelector('.note-page-topbar button')?.click()`);
    await waitFor(() => evaluate(`!document.querySelector('.note-page') && document.querySelector('.card-side-panel')?.getAttribute('aria-hidden') === 'false'`), 3500);
    await evaluate(`(() => { const state = window.__openCanvasQaStore.getState(); if (!state.darkMode) state.toggleDarkMode(); return true; })()`);
    await waitFor(() => evaluate(`document.querySelector('.app-shell')?.getAttribute('data-theme') === 'dark'`), 2000);
    const darkPanelLayout = await readPanelLayout();
    if (!darkPanelLayout || darkPanelLayout.theme !== 'dark' || darkPanelLayout.editors !== 1 || darkPanelLayout.activeEditors !== 1 || darkPanelLayout.rootOverflow > 1 || darkPanelLayout.documentOverflow > 1) throw new Error(`Dark long-title side panel regressed: ${JSON.stringify(darkPanelLayout)}`);
    await captureVisualArtifact('dark-side-panel-long-title');
    await evaluate(`document.querySelector('.card-side-panel [aria-label="展开卡片"]')?.click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.note-page .card-prosemirror'))`), 5000);
    const darkPageLayout = await readPageLayout();
    if (!darkPageLayout || darkPageLayout.theme !== 'dark' || darkPageLayout.pageEditors !== 1 || darkPageLayout.totalEditors !== 2 || darkPageLayout.activeEditors !== 1 || darkPageLayout.rootOverflow > 1 || darkPageLayout.documentOverflow > 1) throw new Error(`Dark long-title full page regressed: ${JSON.stringify(darkPageLayout)}`);
    await captureVisualArtifact('dark-full-page-long-title');
    await evaluate(`document.querySelector('.note-page-topbar button')?.click()`);
    await waitFor(() => evaluate(`!document.querySelector('.note-page')`), 3500);
    await evaluate(`document.querySelector('.card-side-panel [aria-label="关闭卡片侧栏"]')?.click()`);
    await waitFor(() => evaluate(`document.querySelector('.card-side-panel')?.getAttribute('aria-hidden') === 'true'`), 2000);
    progress('light/dark long-title side-panel and full-page containment artifacts passed');

    await evaluate(`void import('/src/store.ts').then(async module => {
      const store = module.useWorkspaceStore;
      const card = store.getState().cards.find(item => item.id === 'external-smoke') ?? store.getState().cards[0];
      for (let index = 0; index < 80; index += 1) store.getState().updateCard(card.id, { title: '连续保存-' + index, body: '最终关闭刷新-' + index });
      const latest = store.getState().cards.find(item => item.id === card.id);
      await window.__openCanvasFlush?.();
      window.__rapidSaveQa = { relativePath: latest.relativePath, title: latest.title, body: latest.body };
    }).catch(error => { window.__rapidSaveQa = { error: String(error?.stack || error) }; })`);
    const rapidSaveResult = await waitFor(() => evaluate(`window.__rapidSaveQa ?? null`), 12000);
    await evaluate(`delete window.__rapidSaveQa`);
    if (rapidSaveResult.error) throw new Error(`Rapid-save integration errored: ${rapidSaveResult.error}`);
    await waitFor(() => evaluate(`document.querySelector('.vault-status-button')?.innerText.includes('已保存')`), 30000);
    const rapidSaveDisk = await fs.readFile(path.join(vault, 'notes', rapidSaveResult.relativePath), 'utf8');
    if (!rapidSaveDisk.includes('连续保存-79') || !rapidSaveDisk.includes('最终关闭刷新-79') || rapidSaveDisk.includes('最终关闭刷新-78')) throw new Error(`Close-time save flush did not persist the latest rapid edit: ${JSON.stringify(rapidSaveResult)}`);
    progress('80 rapid edits flushed the latest card revision before shutdown');

    process.stdout.write(`Electron smoke passed: 5000-node board first viewport ${boardOpenMs}ms/${renderProfile.nodes} DOM nodes, lazy editor, inline link popover, keyboard command menu, shared-card synchronization, per-board undo/redo, serialized rapid saves, connector creation/menu/label editing, atomic recovery, recovery center, ZIP/Canvas real-file roundtrips, integrity check, pointer drag/resize/wheel, typography visual regression, native vault, Markdown save, history, trash restore/permanent delete, paste attachment, attachment inventory, asset protocol, external reload, conflict resolution.\n`);
    completed = true;
  } finally {
    let gracefulElectronExit = false;
    if (client) {
      try {
        // window.close() may tear down the DevTools socket before Chromium can
        // acknowledge Runtime.evaluate. Dispatch it, then judge success by the
        // Electron process exit instead of waiting forever for that reply.
        void client.send('Runtime.evaluate', { expression: 'window.close()', awaitPromise: false, returnByValue: true }, 3000).catch(() => {});
        gracefulElectronExit = await waitForProcessExit(electron);
      } catch {}
      client.close();
    }
    if (process.platform === 'win32') {
      if (!gracefulElectronExit && electron.pid) spawnSync('taskkill.exe', ['/pid', String(electron.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      if (vite?.pid) spawnSync('taskkill.exe', ['/pid', String(vite.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      if (!gracefulElectronExit) electron.kill();
      vite?.kill();
    }
    await delay(250);
    if (deniedAclPath) spawnSync('icacls.exe', [deniedAclPath, '/remove:d', aclAccount], { windowsHide: true, stdio: 'ignore' });
    await fs.rm(testRoot, { recursive: true, force: true });
    if (completed && !gracefulElectronExit) throw new Error('Electron did not exit through the save-and-close handshake');
    const unexpectedVaultErrors = stderr.split("Error occurred in handler for 'vault:").slice(1)
      .filter((entry) => !(entry.startsWith("e2e-preview-open-format'") && entry.includes('ZIP 包含不安全路径')))
      .filter((entry) => !(entry.startsWith("apply-file-plan'") && entry.includes('Unsafe file name: ../rollback.board.json')))
      .filter((entry) => !(entry.startsWith("apply-file-plan'") && entry.includes('Windows 无法使用这个路径片段：CON')))
      .filter((entry) => !(entry.startsWith("apply-file-plan'") && entry.includes('卡片路径存在同名目标：冲突/DUPLICATE.md')))
      .filter((entry) => !(entry.startsWith("apply-file-plan'") && /EACCES|EPERM|access denied|permission denied/i.test(entry) && entry.includes('只读权限验收')));
    if (completed && unexpectedVaultErrors.length) throw new Error(`A vault write failed during shutdown:\n${unexpectedVaultErrors.join("\nError occurred in handler for 'vault:")}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
