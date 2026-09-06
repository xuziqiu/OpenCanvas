const { app, BrowserWindow, dialog, ipcMain, shell, protocol, net, Menu, nativeTheme } = require('electron');
const fsNative = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { strFromU8, strToU8, unzipSync, zipSync } = require('fflate');

app.setName('OpenCanvas');
protocol.registerSchemesAsPrivileged([{ scheme: 'opencanvas-asset', privileges: { secure: true, supportFetchAPI: true, stream: true } }]);

let mainWindow;
let vaultWatcher;
let watchedVaultPath;
let externalChangeTimer;
const internalChangeRules = new Map();
const internalWriteFingerprints = new Map();
const externalChangePaths = new Set();
const pendingImports = new Map();
const recentRecoveryReports = new Map();
const MIME_BY_EXTENSION = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.zip': 'application/zip' };
const activeVaultWrites = new Set();
const activeFilePlanTransactionIds = new Set();
let vaultWriteTail = Promise.resolve();
let acceptingVaultWrites = true;
const ZIP_LIMITS = { files: 5000, entryBytes: 256 * 1024 * 1024, totalBytes: 1024 * 1024 * 1024, ratio: 200 };
const VAULT_READ_CONCURRENCY = 32;
const INTERNAL_METADATA_DIRS = ['.opencanvas/trash', '.opencanvas/import-staging', '.opencanvas/file-plan-transactions', '.opencanvas/history'];

async function copyAttachmentFromPath(sourcePath, suppliedMimeType = '') {
  const source = path.resolve(String(sourcePath || ''));
  const stat = await fs.stat(source);
  if (!stat.isFile()) throw new Error('只能导入普通文件');
  const extension = path.extname(source).toLowerCase();
  const originalName = path.basename(source, extension).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 70) || 'attachment';
  const fileName = `${originalName}--${randomUUID().slice(0, 8)}${extension}`;
  const vaultPath = await getVaultPath();
  await ensureVault(vaultPath);
  markInternalWrite(`attachments/${fileName}`);
  const target = path.join(vaultPath, 'attachments', fileName);
  await fs.copyFile(source, target);
  await recordInternalPathFingerprint(target);
  return {
    name: path.basename(source),
    relativePath: `attachments/${fileName}`,
    url: `opencanvas-asset://vault/attachments/${encodeURIComponent(fileName)}`,
    mimeType: String(suppliedMimeType || MIME_BY_EXTENSION[extension] || 'application/octet-stream'),
    size: stat.size,
  };
}

function trackVaultWrite(task) {
  if (!acceptingVaultWrites) return Promise.reject(new Error('应用正在关闭，已停止接受新的写入'));
  const promise = vaultWriteTail.catch(() => {}).then(task);
  vaultWriteTail = promise.catch(() => {});
  activeVaultWrites.add(promise);
  return promise.finally(() => activeVaultWrites.delete(promise));
}

async function prepareVaultClose() {
  acceptingVaultWrites = false;
  while (activeVaultWrites.size) await Promise.allSettled([...activeVaultWrites]);
}

function markInternalWrite(paths = []) {
  const expiresAt = Date.now() + 2500;
  for (const value of Array.isArray(paths) ? paths : [paths]) {
    const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!normalized) continue;
    internalChangeRules.set(normalized, expiresAt);
    const parts = normalized.split('/');
    while (parts.length > 1) {
      parts.pop();
      internalChangeRules.set(parts.join('/'), expiresAt);
    }
  }
}

function fingerprintBuffer(value, encoding) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, encoding);
  return `${buffer.byteLength}:${createHash('sha256').update(buffer).digest('base64url')}`;
}

function relativePathInsideWatchedVault(target) {
  if (!watchedVaultPath) return null;
  const relative = path.relative(watchedVaultPath, path.resolve(target));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.replace(/\\/g, '/');
}

function recordInternalWriteFingerprint(target, value, encoding) {
  const relativePath = relativePathInsideWatchedVault(target);
  if (!relativePath) return;
  internalWriteFingerprints.set(relativePath, fingerprintBuffer(value, encoding));
}

async function pathFingerprint(target) {
  try {
    const stat = await fs.stat(target);
    return stat.isFile() ? fingerprintBuffer(await fs.readFile(target)) : 'directory';
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function recordInternalPathFingerprint(target) {
  const relativePath = relativePathInsideWatchedVault(target);
  if (!relativePath) return;
  internalWriteFingerprints.set(relativePath, await pathFingerprint(target));
}

function expectInternalRemoval(target) {
  const relativePath = relativePathInsideWatchedVault(target);
  if (relativePath) internalWriteFingerprints.set(relativePath, 'missing');
}

async function expectInternalMove(source, target) {
  const fingerprint = await pathFingerprint(source);
  const sourceRelative = relativePathInsideWatchedVault(source);
  const targetRelative = relativePathInsideWatchedVault(target);
  if (sourceRelative) internalWriteFingerprints.set(sourceRelative, 'missing');
  if (targetRelative) internalWriteFingerprints.set(targetRelative, fingerprint);
}

async function consumeInternalChange(vaultPath, relativePath) {
  let expectedFingerprint = internalWriteFingerprints.get(relativePath);
  if (expectedFingerprint !== undefined) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let actualFingerprint = 'missing';
      try {
        const target = resolveBelow(vaultPath, relativePath);
        const stat = await fs.stat(target);
        if (stat.isFile()) actualFingerprint = fingerprintBuffer(await fs.readFile(target));
        else actualFingerprint = 'directory';
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      const latestExpectedFingerprint = internalWriteFingerprints.get(relativePath);
      if (actualFingerprint === latestExpectedFingerprint) return true;
      if (latestExpectedFingerprint !== expectedFingerprint && latestExpectedFingerprint !== undefined) {
        // A newer queued application save landed while this watcher event was
        // reading the previous revision. Compare again with the latest write.
        if (attempt === 3) return true;
        expectedFingerprint = latestExpectedFingerprint;
        continue;
      }
      break;
    }
    // A different fingerprint is a genuine external edit, even if it happens
    // inside the old time-based grace period.
    internalWriteFingerprints.delete(relativePath);
    internalChangeRules.delete(relativePath);
    return false;
  }
  const now = Date.now();
  let matched = false;
  for (const [rule, expiresAt] of internalChangeRules) {
    if (expiresAt < now) { internalChangeRules.delete(rule); continue; }
    if (relativePath === rule || (rule.endsWith('/') && relativePath.startsWith(rule))) {
      matched = true;
    }
  }
  return matched;
}

function queueExternalChange(relativePath) {
  externalChangePaths.add(relativePath);
  clearTimeout(externalChangeTimer);
  externalChangeTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !externalChangePaths.size) return;
    mainWindow.webContents.send('vault:external-change', {
      paths: [...externalChangePaths],
      occurredAt: new Date().toISOString(),
    });
    externalChangePaths.clear();
  }, 260);
}

function normalizeWatchedRelativePath(vaultPath, changedPath) {
  const rawPath = String(changedPath || '');
  let relativePath = (path.isAbsolute(rawPath) ? path.relative(vaultPath, rawPath) : rawPath).replace(/\\/g, '/').replace(/^\.\//, '');
  if (/^(?:notes|boards|attachments|\.opencanvas)(?:\/|$)/.test(relativePath)) return relativePath;
  const rootMarker = relativePath.match(/\/(notes|boards|attachments|\.opencanvas)(?=\/|$)/);
  if (rootMarker?.index !== undefined) relativePath = relativePath.slice(rootMarker.index + 1);
  return relativePath;
}

async function isWatchableVaultFile(vaultPath, relativePath) {
  const lowerPath = relativePath.toLowerCase();
  if (relativePath.startsWith('notes/') && !lowerPath.endsWith('.md')) return false;
  if (relativePath.startsWith('boards/') && !lowerPath.endsWith('.json')) return false;
  try {
    return !(await fs.stat(resolveBelow(vaultPath, relativePath))).isDirectory();
  } catch (error) {
    // A missing path may be a deleted file. Keep it observable so an external
    // deletion cannot be silently overwritten by the next application save.
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

function handleVaultWatchEvent(vaultPath, fileName) {
  const relativePath = normalizeWatchedRelativePath(vaultPath, fileName);
  if (!relativePath || ['notes', 'boards', 'attachments', '.opencanvas'].includes(relativePath) || INTERNAL_METADATA_DIRS.some((directory) => relativePath === directory || relativePath.startsWith(`${directory}/`)) || relativePath === '.opencanvas/recovery-log.json' || relativePath.includes(ATOMIC_TEMP_MARKER)) return;
  void isWatchableVaultFile(vaultPath, relativePath).then((watchable) => {
    if (!watchable) return true;
    return consumeInternalChange(vaultPath, relativePath);
  }).then((internal) => {
    if (internal) return;
    queueExternalChange(relativePath);
  }).catch(() => {
    // Verification errors must remain visible instead of risking a silent
    // overwrite of content that may have changed outside the app.
    queueExternalChange(relativePath);
  });
}

function resolveWatchCallbackPath(directory, fileName) {
  let normalized = String(fileName || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const directoryName = path.basename(directory);
  const duplicatedSuffix = directoryName.slice(-2);
  // Some Windows/Node runner combinations prepend the final two characters of
  // the watched directory (for example `boards` -> `ds/file.json`). Only strip
  // that artifact when it is not a real child directory, preserving legitimate
  // folders that happen to use the same two-character name.
  if (normalized.startsWith(`${duplicatedSuffix}/`) && !fsNative.existsSync(path.join(directory, duplicatedSuffix))) {
    normalized = normalized.slice(duplicatedSuffix.length + 1);
  }
  return normalized ? path.join(directory, ...normalized.split('/')) : directory;
}

async function startVaultWatcher(vaultPath) {
  const resolved = path.resolve(vaultPath);
  if (vaultWatcher && watchedVaultPath === resolved) return;
  vaultWatcher?.close();
  vaultWatcher = undefined;
  watchedVaultPath = resolved;
  internalChangeRules.clear();
  internalWriteFingerprints.clear();
  externalChangePaths.clear();
  await ensureVault(resolved);
  const watchers = new Map();
  const watcherGroup = {
    closed: false,
    refreshTimer: undefined,
    close() {
      this.closed = true;
      clearTimeout(this.refreshTimer);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
  vaultWatcher = watcherGroup;

  const collectDirectories = async () => {
    const roots = ['notes', 'boards', 'attachments', '.opencanvas'].map((name) => path.join(resolved, name));
    // The four roots are created by ensureVault. Watching the vault itself as
    // well duplicates nested Windows events and can reintroduce malformed
    // paths (for example `boards/ds/file.json`) after the scoped watcher has
    // already handled the correct event.
    const directories = new Set(roots);
    const queue = [path.join(resolved, 'notes')];
    while (queue.length) {
      const directory = queue.shift();
      let entries;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); }
      catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const child = path.join(directory, entry.name);
        directories.add(child);
        queue.push(child);
      }
    }
    return directories;
  };

  const restart = () => {
    if (watcherGroup.closed || vaultWatcher !== watcherGroup) return;
    watcherGroup.close();
    vaultWatcher = undefined;
    setTimeout(() => {
      if (!vaultWatcher && watchedVaultPath === resolved) void startVaultWatcher(resolved);
    }, 250);
  };

  const refresh = async () => {
    if (watcherGroup.closed || vaultWatcher !== watcherGroup) return;
    const directories = await collectDirectories();
    if (watcherGroup.closed || vaultWatcher !== watcherGroup) return;
    for (const [directory, watcher] of watchers) {
      if (directories.has(directory)) continue;
      watcher.close();
      watchers.delete(directory);
    }
    for (const directory of directories) {
      if (watchers.has(directory)) continue;
      const watcher = fsNative.watch(directory, { recursive: false }, (eventType, fileName) => {
        const rawName = String(fileName || '');
        const changedPath = resolveWatchCallbackPath(directory, rawName);
        handleVaultWatchEvent(resolved, changedPath);
        if (eventType !== 'rename') return;
        void fs.stat(changedPath).then((stat) => {
          if (stat.isDirectory()) scheduleRefresh();
        }).catch((error) => {
          if (error?.code === 'ENOENT' && !path.extname(rawName)) scheduleRefresh();
        });
      });
      watcher.on('error', restart);
      watchers.set(directory, watcher);
    }
  };

  const scheduleRefresh = () => {
    if (watcherGroup.closed || vaultWatcher !== watcherGroup) return;
    clearTimeout(watcherGroup.refreshTimer);
    watcherGroup.refreshTimer = setTimeout(() => void refresh().catch(restart), 350);
  };

  try {
    await refresh();
  } catch {
    restart();
  }
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

async function readSettings() {
  try {
    return JSON.parse(await fs.readFile(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

async function writeSettings(settings) {
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  await atomicWriteFile(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
}

async function getVaultPath() {
  if (process.env.OPENCANVAS_VAULT_DIR) {
    return path.resolve(process.env.OPENCANVAS_VAULT_DIR);
  }
  const settings = await readSettings();
  return settings.vaultPath || path.join(app.getPath('documents'), 'OpenCanvas Vault');
}

async function getHistoryLimit() {
  const settings = await readSettings();
  const value = Number(settings.historyLimit);
  return Number.isFinite(value) ? Math.max(5, Math.min(200, Math.round(value))) : 30;
}

async function setHistoryLimit(value) {
  const settings = await readSettings();
  const historyLimit = Number.isFinite(Number(value)) ? Math.max(5, Math.min(200, Math.round(Number(value)))) : 30;
  await writeSettings({ ...settings, historyLimit });
  return historyLimit;
}

function assertSafeFileName(fileName, extension) {
  if (
    typeof fileName !== 'string' ||
    path.basename(fileName) !== fileName ||
    !fileName.toLowerCase().endsWith(extension)
  ) {
    throw new Error(`Unsafe file name: ${String(fileName)}`);
  }
  assertWindowsPathSegment(fileName);
}

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function assertWindowsPathSegment(segment) {
  if (
    !segment ||
    segment.length > 255 ||
    /[<>:"\\|?*\u0000-\u001f]/.test(segment) ||
    /[. ]$/.test(segment) ||
    segment === '.' ||
    segment === '..' ||
    WINDOWS_DEVICE_NAME.test(segment)
  ) {
    throw new Error(`Windows 无法使用这个路径片段：${String(segment)}`);
  }
}

function safeRelativePath(value, extension) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Unsafe relative path: ${String(value)}`);
  const normalized = path.posix.normalize(value.replace(/\\/g, '/')).replace(/^\.\//, '');
  if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new Error(`Unsafe relative path: ${value}`);
  }
  normalized.split('/').forEach(assertWindowsPathSegment);
  if (extension && !normalized.toLowerCase().endsWith(extension)) throw new Error(`Unexpected extension: ${value}`);
  return normalized;
}

function secureUnzip(data) {
  let count = 0;
  let totalBytes = 0;
  const entries = unzipSync(data, { filter(file) {
    count += 1;
    const name = String(file.name || '');
    const normalized = name.replace(/\\/g, '/');
    if (count > ZIP_LIMITS.files) throw new Error(`ZIP 文件数超过 ${ZIP_LIMITS.files} 项安全上限`);
    if (!name || name.includes('\0') || name.length > 500 || normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || /(^|\/)\.\.(\/|$)/.test(normalized)) throw new Error(`ZIP 包含不安全路径：${name}`);
    if (file.originalSize > ZIP_LIMITS.entryBytes) throw new Error(`ZIP 单文件解压后超过 ${ZIP_LIMITS.entryBytes / 1024 / 1024} MB：${name}`);
    totalBytes += file.originalSize;
    if (totalBytes > ZIP_LIMITS.totalBytes) throw new Error('ZIP 解压后总体积超过 1 GB 安全上限');
    if (file.originalSize > 10 * 1024 * 1024 && file.originalSize > Math.max(1, file.size) * ZIP_LIMITS.ratio) throw new Error(`ZIP 文件压缩比异常：${name}`);
    return true;
  } });
  return entries;
}

function resolveBelow(root, relative) {
  const target = path.resolve(root, ...safeRelativePath(relative).split('/'));
  const resolvedRoot = path.resolve(root);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`Path escapes vault: ${relative}`);
  return target;
}

const ATOMIC_TEMP_MARKER = '.opencanvas-tmp-';
const activeAtomicTemps = new Set();
const atomicWriteQueues = new Map();
const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

async function renameWithRetry(source, target, attempts = 7) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.rename(source, target);
      return;
    } catch (error) {
      if (!TRANSIENT_RENAME_ERRORS.has(error?.code) || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(400, 25 * (2 ** attempt))));
    }
  }
}

async function performAtomicWrite(target, data, encoding) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}${ATOMIC_TEMP_MARKER}${randomUUID()}`;
  activeAtomicTemps.add(path.resolve(temporary));
  let handle;
  try {
    handle = await fs.open(temporary, 'wx');
    await handle.writeFile(data, encoding ? { encoding } : undefined);
    await handle.sync();
    await handle.close();
    handle = undefined;
    recordInternalWriteFingerprint(target, data, encoding);
    try {
      await renameWithRetry(temporary, target);
    } catch (error) {
      await recordInternalPathFingerprint(target);
      throw error;
    }
  } catch (error) {
    try { await handle?.close(); } catch {}
    try { await fs.unlink(temporary); } catch {}
    throw error;
  } finally {
    activeAtomicTemps.delete(path.resolve(temporary));
  }
}

function atomicWriteFile(target, data, encoding) {
  const key = path.resolve(target);
  const previous = atomicWriteQueues.get(key) ?? Promise.resolve();
  const write = previous.catch(() => {}).then(() => performAtomicWrite(target, data, encoding));
  atomicWriteQueues.set(key, write);
  return write.finally(() => { if (atomicWriteQueues.get(key) === write) atomicWriteQueues.delete(key); });
}

function recoveryLogPath(vaultPath) {
  return path.join(vaultPath, '.opencanvas', 'recovery-log.json');
}

async function readRecoveryEvents(vaultPath) {
  try {
    const value = JSON.parse(await fs.readFile(recoveryLogPath(vaultPath), 'utf8'));
    return Array.isArray(value) ? value.slice(0, 30) : [];
  } catch {
    return [];
  }
}

async function appendRecoveryEvent(vaultPath, recovery) {
  const event = {
    id: randomUUID(),
    recoveredAt: new Date().toISOString(),
    recovered: recovery.recovered || [],
    discarded: recovery.discarded || [],
    importTransactions: recovery.importTransactions || [],
    filePlanTransactions: recovery.filePlanTransactions || [],
    failedTransactions: recovery.failedTransactions || [],
  };
  const events = [event, ...await readRecoveryEvents(vaultPath)].slice(0, 30);
  markInternalWrite('.opencanvas/recovery-log.json');
  await atomicWriteFile(recoveryLogPath(vaultPath), JSON.stringify(events, null, 2), 'utf8');
  return event;
}

async function listRecentFileVersions(vaultPath, limit = 50) {
  const historyRoot = path.join(vaultPath, '.opencanvas', 'history');
  const files = await readFilesRecursive(historyRoot, '.bak');
  const versions = [];
  for (const relative of files) {
    const parts = relative.split('/');
    if (parts.length < 2) continue;
    const fileName = parts.at(-1);
    const sourcePath = parts.slice(0, -1).join('/');
    try {
      const stat = await fs.stat(resolveBelow(historyRoot, relative));
      const timestamp = Number(fileName.split('--')[0]);
      versions.push({
        id: relative,
        sourcePath,
        createdAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : stat.mtime.toISOString(),
        size: stat.size,
      });
    } catch {}
  }
  return versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

async function recoverInterruptedWrites(vaultPath) {
  const roots = [path.join(vaultPath, 'notes'), path.join(vaultPath, 'boards'), path.join(vaultPath, '.opencanvas')];
  const recovered = [];
  const discarded = [];
  for (const root of roots) {
    for (const relative of await readFilesRecursive(root, '')) {
      if (!relative.includes(ATOMIC_TEMP_MARKER)) continue;
      const temporary = resolveBelow(root, relative);
      if (activeAtomicTemps.has(path.resolve(temporary))) continue;
      const markerIndex = temporary.lastIndexOf(ATOMIC_TEMP_MARKER);
      const target = temporary.slice(0, markerIndex);
      try {
        const stat = await fs.stat(temporary);
        if (!stat.isFile() || stat.size === 0 || fsNative.existsSync(target)) {
          await fs.unlink(temporary);
          discarded.push(path.relative(vaultPath, temporary).replace(/\\/g, '/'));
          continue;
        }
        if (target.endsWith('.json')) JSON.parse(await fs.readFile(temporary, 'utf8'));
        await renameWithRetry(temporary, target);
        recovered.push(path.relative(vaultPath, target).replace(/\\/g, '/'));
      } catch {
        try { await fs.unlink(temporary); } catch {}
        discarded.push(path.relative(vaultPath, temporary).replace(/\\/g, '/'));
      }
    }
  }
  return { recovered, discarded };
}

async function recoverImportTransactions(vaultPath) {
  const stagingRoot = path.join(vaultPath, '.opencanvas', 'import-staging');
  let directories = [];
  try { directories = (await fs.readdir(stagingRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()); } catch {}
  const recovered = [];
  for (const directory of directories) {
    if (pendingImports.has(directory.name)) continue;
    const transactionRoot = path.join(stagingRoot, directory.name);
    const journalPath = path.join(transactionRoot, 'journal.json');
    let journal;
    try { journal = JSON.parse(await fs.readFile(journalPath, 'utf8')); } catch {
      await fs.rm(transactionRoot, { recursive: true, force: true });
      continue;
    }
    if (journal.state === 'complete') {
      await fs.rm(transactionRoot, { recursive: true, force: true });
      continue;
    }
    for (const entry of Array.isArray(journal.entries) ? journal.entries : []) {
      try {
        const relative = safeRelativePath(entry.finalRelative);
        if (!relative.startsWith('notes/') && !relative.startsWith('boards/') && !relative.startsWith('attachments/')) continue;
        const target = resolveBelow(vaultPath, relative);
        await fs.unlink(target);
        if (relative.startsWith('notes/')) await removeEmptyParents(path.dirname(target), path.join(vaultPath, 'notes'));
      } catch {}
    }
    const desktopPath = path.join(vaultPath, '.opencanvas', 'desktop.json');
    try {
      if (typeof journal.previousDesktopBase64 === 'string') await atomicWriteFile(desktopPath, Buffer.from(journal.previousDesktopBase64, 'base64'));
      else await fs.unlink(desktopPath);
    } catch {}
    recovered.push(directory.name);
    await fs.rm(transactionRoot, { recursive: true, force: true });
  }
  return recovered;
}

function relativeVaultPath(vaultPath, target) {
  const relative = path.relative(path.resolve(vaultPath), path.resolve(target)).replace(/\\/g, '/');
  return safeRelativePath(relative);
}

async function rollbackFilePlanJournal(vaultPath, transactionRoot, journal) {
  const failures = [];
  for (const operation of [...(Array.isArray(journal.operations) ? journal.operations : [])].reverse()) {
    try {
      if (operation.kind === 'move') {
        const source = resolveBelow(vaultPath, operation.sourceRelative);
        const target = resolveBelow(vaultPath, operation.targetRelative);
        if (fsNative.existsSync(target) && !fsNative.existsSync(source)) {
          await fs.mkdir(path.dirname(source), { recursive: true });
          await expectInternalMove(target, source);
          await renameWithRetry(target, source);
          await Promise.all([recordInternalPathFingerprint(source), recordInternalPathFingerprint(target)]);
        }
        continue;
      }
      const target = resolveBelow(vaultPath, operation.targetRelative);
      if (operation.existed && operation.backupName) {
        const backup = resolveBelow(path.join(transactionRoot, 'backups'), operation.backupName);
        await atomicWriteFile(target, await fs.readFile(backup));
      } else {
        expectInternalRemoval(target);
        try { await fs.unlink(target); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        await recordInternalPathFingerprint(target);
      }
    } catch (error) {
      failures.push(`${operation.kind}:${operation.targetRelative || operation.sourceRelative}:${error?.message || error}`);
    }
  }
  return failures;
}

async function recoverFilePlanTransactions(vaultPath) {
  const root = path.join(vaultPath, '.opencanvas', 'file-plan-transactions');
  let directories = [];
  try { directories = (await fs.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()); } catch {}
  const recovered = [];
  const failed = [];
  for (const directory of directories) {
    if (activeFilePlanTransactionIds.has(directory.name)) continue;
    const transactionRoot = path.join(root, directory.name);
    let journal;
    try { journal = JSON.parse(await fs.readFile(path.join(transactionRoot, 'journal.json'), 'utf8')); } catch {
      await fs.rm(transactionRoot, { recursive: true, force: true });
      continue;
    }
    if (journal.state === 'complete') {
      await fs.rm(transactionRoot, { recursive: true, force: true });
      continue;
    }
    const failures = await rollbackFilePlanJournal(vaultPath, transactionRoot, journal);
    if (failures.length) {
      failed.push({ id: directory.name, failures });
      continue;
    }
    recovered.push(directory.name);
    await fs.rm(transactionRoot, { recursive: true, force: true });
  }
  return { recovered, failed };
}

async function createFilePlanTransaction(vaultPath) {
  const id = randomUUID();
  const root = path.join(vaultPath, '.opencanvas', 'file-plan-transactions', id);
  const backups = path.join(root, 'backups');
  const journalPath = path.join(root, 'journal.json');
  const journal = { version: 1, id, state: 'active', operations: [] };
  activeFilePlanTransactionIds.add(id);
  const persist = () => atomicWriteFile(journalPath, JSON.stringify(journal, null, 2), 'utf8');
  try {
    await fs.mkdir(backups, { recursive: true });
    await persist();
  } catch (error) {
    activeFilePlanTransactionIds.delete(id);
    throw error;
  }
  const prepareFileOperation = async (kind, target) => {
    const targetRelative = relativeVaultPath(vaultPath, target);
    const existed = fsNative.existsSync(target);
    const backupName = existed ? `${String(journal.operations.length).padStart(5, '0')}-${randomUUID()}.bak` : undefined;
    if (backupName) await fs.copyFile(target, resolveBelow(backups, backupName));
    const operation = { kind, targetRelative, existed, backupName };
    journal.operations.push(operation);
    await persist();
    return operation;
  };
  return {
    id,
    async write(target, data, encoding) {
      await prepareFileOperation('write', target);
      await atomicWriteFile(target, data, encoding);
    },
    async delete(target) {
      await prepareFileOperation('delete', target);
      expectInternalRemoval(target);
      try { await fs.unlink(target); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      await recordInternalPathFingerprint(target);
    },
    async move(source, target) {
      const operation = { kind: 'move', sourceRelative: relativeVaultPath(vaultPath, source), targetRelative: relativeVaultPath(vaultPath, target) };
      journal.operations.push(operation);
      await persist();
      await fs.mkdir(path.dirname(target), { recursive: true });
      await expectInternalMove(source, target);
      await renameWithRetry(source, target);
      await Promise.all([recordInternalPathFingerprint(source), recordInternalPathFingerprint(target)]);
    },
    async complete() {
      try {
        journal.state = 'complete';
        await persist();
        await fs.rm(root, { recursive: true, force: true });
      } finally {
        activeFilePlanTransactionIds.delete(id);
      }
    },
    async rollback() {
      try {
        const failures = await rollbackFilePlanJournal(vaultPath, root, journal);
        if (!failures.length) await fs.rm(root, { recursive: true, force: true });
        return failures;
      } finally {
        activeFilePlanTransactionIds.delete(id);
      }
    },
  };
}

function serializeCard(card) {
  const header = [
    '---',
    `id: ${JSON.stringify(card.id)}`,
    `title: ${JSON.stringify(card.title)}`,
    `createdAt: ${JSON.stringify(card.createdAt)}`,
    `updatedAt: ${JSON.stringify(card.updatedAt)}`,
    '---',
    '',
  ].join('\n');
  return `${header}${card.body || ''}\n`;
}

function parseHeaderValue(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value.trim();
  }
}

function parseNote(relativePath, raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const metadata = {};
  let body = raw;
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const separator = line.indexOf(':');
      if (separator > 0) {
        metadata[line.slice(0, separator).trim()] = parseHeaderValue(
          line.slice(separator + 1).trim(),
        );
      }
    }
    body = raw.slice(match[0].length).replace(/\r?\n$/, '');
  }

  const now = new Date().toISOString();
  const fileName = path.basename(relativePath);
  const fallbackTitle = path.basename(fileName, '.md').replace(/--[a-f0-9]{8}$/i, '');
  return {
    id: String(metadata.id || path.basename(fileName, '.md')),
    fileName,
    relativePath: relativePath.replace(/\\/g, '/'),
    title: String(metadata.title || fallbackTitle || 'Untitled'),
    body,
    createdAt: String(metadata.createdAt || now),
    updatedAt: String(metadata.updatedAt || now),
  };
}

async function ensureVault(vaultPath) {
  await Promise.all([
    fs.mkdir(path.join(vaultPath, 'notes'), { recursive: true }),
    fs.mkdir(path.join(vaultPath, 'boards'), { recursive: true }),
    fs.mkdir(path.join(vaultPath, 'attachments'), { recursive: true }),
    fs.mkdir(path.join(vaultPath, '.opencanvas'), { recursive: true }),
  ]);
}

async function readFilesRecursive(directory, extension, prefix = '') {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) files.push(...await readFilesRecursive(path.join(directory, entry.name), extension, relative));
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) files.push(relative);
    }
    return files;
  } catch {
    return [];
  }
}

async function mapWithConcurrency(values, limit, mapper) {
  if (!values.length) return [];
  const results = new Array(values.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), values.length) }, worker));
  return results;
}

async function backupExisting(vaultPath, target, sourcePath) {
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) return;
    const safeSource = safeRelativePath(sourcePath);
    const historyDirectory = resolveBelow(path.join(vaultPath, '.opencanvas', 'history'), safeSource);
    await fs.mkdir(historyDirectory, { recursive: true });
    const versionName = `${Date.now()}--${randomUUID().slice(0, 6)}.bak`;
    await fs.copyFile(target, path.join(historyDirectory, versionName));
    const versions = (await fs.readdir(historyDirectory, { withFileTypes: true })).filter((entry) => entry.isFile()).sort((a, b) => b.name.localeCompare(a.name));
    for (const obsolete of versions.slice(await getHistoryLimit())) await fs.unlink(path.join(historyDirectory, obsolete.name));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function backupExistingForMeaningfulJsonChange(vaultPath, target, sourcePath, nextValue, volatileKeys) {
  let shouldBackup = true;
  try {
    const currentValue = JSON.parse(await fs.readFile(target, 'utf8'));
    const stableValue = (value) => Object.fromEntries(Object.entries(value || {}).filter(([key]) => !volatileKeys.has(key)));
    shouldBackup = JSON.stringify(stableValue(currentValue)) !== JSON.stringify(stableValue(nextValue));
  } catch (error) {
    if (error?.code === 'ENOENT') shouldBackup = false;
    // Invalid JSON is intentionally preserved before replacement so recovery
    // remains possible even though it cannot be compared structurally.
  }
  if (shouldBackup) await backupExisting(vaultPath, target, sourcePath);
}

async function removeEmptyParents(start, stop) {
  let current = path.resolve(start);
  const boundary = path.resolve(stop);
  while (current.startsWith(`${boundary}${path.sep}`)) {
    try { await fs.rmdir(current); } catch { break; }
    current = path.dirname(current);
  }
}

async function listTrashEntries(vaultPath) {
  const trashRoot = path.join(vaultPath, '.opencanvas', 'trash');
  const files = await readFilesRecursive(trashRoot, '');
  const entries = [];
  for (const id of files) {
    const parts = id.split('/');
    if (parts.length < 3 || !['notes', 'boards', 'attachments'].includes(parts[1])) continue;
    const sourcePath = parts.slice(1).join('/');
    const target = resolveBelow(trashRoot, id);
    try {
      const stat = await fs.stat(target);
      const timestamp = Number(parts[0].split('-')[0]);
      entries.push({
        id,
        sourcePath,
        name: parts.at(-1),
        kind: sourcePath.startsWith('notes/') && sourcePath.endsWith('.md') ? 'card' : sourcePath.startsWith('boards/') && sourcePath.endsWith('.board.json') ? 'board' : 'file',
        size: stat.size,
        deletedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : stat.mtime.toISOString(),
      });
    } catch {}
  }
  return entries.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

async function readOrganization(vaultPath, noteDirectory) {
  let stored = {};
  try {
    stored = JSON.parse(await fs.readFile(path.join(vaultPath, '.opencanvas', 'file-organization.json'), 'utf8'));
  } catch {}
  const markerFiles = await readFilesRecursive(noteDirectory, '.opencanvas-project.json');
  const markerProjects = (await mapWithConcurrency(markerFiles, VAULT_READ_CONCURRENCY, async (relative) => {
    try {
      const marker = JSON.parse(await fs.readFile(resolveBelow(noteDirectory, relative), 'utf8'));
      const relativePath = path.posix.dirname(relative);
      if (!marker.id || relativePath === '.') return null;
      return { id: String(marker.id), name: String(marker.name || path.posix.basename(relativePath)), relativePath, createdAt: String(marker.createdAt || new Date().toISOString()) };
    } catch { return null; }
  })).filter(Boolean);
  const projectMap = new Map((Array.isArray(stored.projects) ? stored.projects : []).map((project) => [project.id, project]));
  for (const project of markerProjects) projectMap.set(project.id, project);
  return {
    projects: [...projectMap.values()],
    folders: Array.isArray(stored.folders) ? stored.folders : [],
  };
}

async function loadWorkspaceAt(vaultPath) {
  await ensureVault(vaultPath);
  const recoveredFilePlans = await recoverFilePlanTransactions(vaultPath);
  const recoveredImports = await recoverImportTransactions(vaultPath);
  const recovery = await recoverInterruptedWrites(vaultPath);
  recovery.importTransactions = recoveredImports;
  recovery.filePlanTransactions = recoveredFilePlans.recovered;
  recovery.failedTransactions = recoveredFilePlans.failed;
  const recoveryCount = recovery.recovered.length + recovery.discarded.length + recoveredImports.length + recoveredFilePlans.recovered.length + recoveredFilePlans.failed.length;
  const recoveryKey = path.resolve(vaultPath);
  if (recoveryCount > 0) {
    recentRecoveryReports.set(recoveryKey, recovery);
    await appendRecoveryEvent(vaultPath, recovery);
  }
  const reportedRecovery = recoveryCount > 0 ? recovery : (recentRecoveryReports.get(recoveryKey) || recovery);
  const noteDirectory = path.join(vaultPath, 'notes');
  const boardDirectory = path.join(vaultPath, 'boards');
  const [noteFiles, boardFiles] = await Promise.all([
    readFilesRecursive(noteDirectory, '.md'),
    readFilesRecursive(boardDirectory, '.board.json'),
  ]);

  const noteResults = await mapWithConcurrency(noteFiles, VAULT_READ_CONCURRENCY,
      async (relativePath) => {
        try {
          return { card: parseNote(relativePath, await fs.readFile(resolveBelow(noteDirectory, relativePath), 'utf8')) };
        } catch (error) {
          return { issue: { kind: 'invalid-file', sourcePath: `notes/${relativePath}`, message: `无法读取卡片文件，原文件已保留：${error?.message || '未知错误'}` } };
        }
      });
  const cards = noteResults.flatMap((result) => result.card ? [result.card] : []);

  const boardResults = await mapWithConcurrency(boardFiles, VAULT_READ_CONCURRENCY,
      async (fileName) => {
        try {
          const board = JSON.parse(await fs.readFile(path.join(boardDirectory, fileName), 'utf8'));
          const placements = Array.isArray(board.placements)
            ? board.placements
            : (Array.isArray(board.nodes) ? board.nodes : []).map((node) => ({
                ...node,
                kind: node.kind === 'note' ? 'card' : node.kind,
                entityId: node.entityId || node.refId,
              }));
          return { board: {
            ...board,
            version: 4,
            fileName,
            placements,
            connectors: Array.isArray(board.connectors) ? board.connectors : (Array.isArray(board.edges) ? board.edges : []),
            attachments: Array.isArray(board.attachments) ? board.attachments : [],
            viewport: board.viewport || { x: 120, y: 80, zoom: 1 },
          } };
        } catch (error) {
          return { issue: { kind: 'invalid-file', sourcePath: `boards/${fileName}`, message: `无法解析白板文件，原文件已保留：${error?.message || '未知错误'}` } };
        }
      });
  const boards = boardResults.flatMap((result) => result.board ? [result.board] : []);
  const loadIssues = [...noteResults, ...boardResults].flatMap((result) => result.issue ? [result.issue] : []);
  const organization = await readOrganization(vaultPath, noteDirectory);
  let desktop = {};
  try { desktop = JSON.parse(await fs.readFile(path.join(vaultPath, '.opencanvas', 'desktop.json'), 'utf8')); } catch {}
  const derivedFolders = cards.map((card) => path.posix.dirname(card.relativePath)).filter((folder) => folder !== '.');
  return {
    schemaVersion: 4,
    vaultPath,
    cards,
    boards,
    projects: organization.projects,
    folders: [...new Set([...organization.folders, ...organization.projects.map((project) => project.relativePath), ...derivedFolders])],
    desktop,
    loadIssues,
    recovery: reportedRecovery,
  };
}

async function checkVaultIntegrity(vaultPath) {
  const snapshot = await loadWorkspaceAt(vaultPath);
  const issues = [...(snapshot.loadIssues || [])];
  const cardIds = new Set();
  const boardIds = new Set();
  for (const card of snapshot.cards) {
    if (cardIds.has(card.id)) issues.push({ kind: 'duplicate-id', sourcePath: `notes/${card.relativePath}`, message: `卡片 ID 重复：${card.id}` });
    cardIds.add(card.id);
    for (const match of String(card.body || '').matchAll(/attachments\/([^\s)"']+)/g)) {
      const fileName = decodeURIComponent(match[1]);
      if (path.basename(fileName) === fileName && !fsNative.existsSync(path.join(vaultPath, 'attachments', fileName))) issues.push({ kind: 'missing-attachment', sourcePath: `notes/${card.relativePath}`, message: `缺少附件：attachments/${fileName}`, attachmentName: fileName, repairAction: 'restore-attachment' });
    }
  }
  for (const board of snapshot.boards) {
    if (boardIds.has(board.id)) issues.push({ kind: 'duplicate-id', sourcePath: `boards/${board.fileName}`, message: `白板 ID 重复：${board.id}` });
    boardIds.add(board.id);
  }
  for (const board of snapshot.boards) {
    const placementIds = new Set(board.placements.map((placement) => placement.id));
    for (const placement of board.placements) {
      if (placement.kind === 'card' && placement.entityId && !cardIds.has(placement.entityId)) issues.push({ kind: 'missing-card', sourcePath: `boards/${board.fileName}`, message: `放置项 ${placement.id} 引用了不存在的卡片 ${placement.entityId}`, boardId: board.id, placementId: placement.id, repairAction: 'remove-reference' });
      if (placement.kind === 'board' && placement.entityId && !boardIds.has(placement.entityId)) issues.push({ kind: 'missing-board', sourcePath: `boards/${board.fileName}`, message: `放置项 ${placement.id} 引用了不存在的白板 ${placement.entityId}`, boardId: board.id, placementId: placement.id, repairAction: 'remove-reference' });
    }
    for (const connector of board.connectors) if (!placementIds.has(connector.from) || !placementIds.has(connector.to)) issues.push({ kind: 'broken-connector', sourcePath: `boards/${board.fileName}`, message: `连线 ${connector.id} 的端点已经不存在`, boardId: board.id, connectorId: connector.id, repairAction: 'remove-connector' });
  }
  return {
    checkedAt: new Date().toISOString(),
    issues,
    recoveryEvents: await readRecoveryEvents(vaultPath),
    recentVersions: await listRecentFileVersions(vaultPath),
  };
}

async function repairIntegrityIssue(issue) {
  const vaultPath = await getVaultPath();
  await ensureVault(vaultPath);
  if (!issue || typeof issue !== 'object') return false;

  if (issue.repairAction === 'restore-attachment') {
    assertSafeFileName(issue.attachmentName, path.extname(issue.attachmentName));
    const result = await dialog.showOpenDialog(mainWindow, {
      title: `找回附件 ${issue.attachmentName}`,
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return false;
    const target = path.join(vaultPath, 'attachments', issue.attachmentName);
    markInternalWrite(`attachments/${issue.attachmentName}`);
    await atomicWriteFile(target, await fs.readFile(result.filePaths[0]));
    return true;
  }

  if (!issue.boardId) return false;
  const snapshot = await loadWorkspaceAt(vaultPath);
  const board = snapshot.boards.find((item) => item.id === issue.boardId);
  if (!board) return false;
  if (issue.repairAction === 'remove-reference' && issue.placementId) {
    const placementId = issue.placementId;
    board.placements = board.placements.filter((placement) => placement.id !== placementId);
    board.connectors = board.connectors.filter((connector) => connector.from !== placementId && connector.to !== placementId);
    board.attachments = board.attachments.filter((attachment) => attachment.objectId !== placementId && attachment.attachedObjectId !== placementId);
  } else if (issue.repairAction === 'remove-connector' && issue.connectorId) {
    board.connectors = board.connectors.filter((connector) => connector.id !== issue.connectorId);
  } else {
    return false;
  }
  board.updatedAt = new Date().toISOString();
  await saveBoard(board);
  return true;
}

async function saveCard(card) {
  const vaultPath = await getVaultPath();
  await ensureVault(vaultPath);
  const relativePath = safeRelativePath(card.relativePath || card.fileName, '.md');
  markInternalWrite(`notes/${relativePath}`);
  const target = resolveBelow(path.join(vaultPath, 'notes'), relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await backupExisting(vaultPath, target, `notes/${relativePath}`);
  await atomicWriteFile(
    target,
    serializeCard(card),
    'utf8',
  );
}

async function saveBoard(board) {
  const vaultPath = await getVaultPath();
  await ensureVault(vaultPath);
  assertSafeFileName(board.fileName, '.board.json');
  markInternalWrite(`boards/${board.fileName}`);
  const target = path.join(vaultPath, 'boards', board.fileName);
  const serialized = { ...board, version: 4 };
  await backupExistingForMeaningfulJsonChange(vaultPath, target, `boards/${board.fileName}`, serialized, new Set(['viewport', 'updatedAt', 'version']));
  await atomicWriteFile(
    target,
    JSON.stringify(serialized, null, 2),
    'utf8',
  );
}

async function saveDesktopLayout(desktop) {
  const vaultPath = await getVaultPath();
  await ensureVault(vaultPath);
  markInternalWrite('.opencanvas/desktop.json');
  const target = path.join(vaultPath, '.opencanvas', 'desktop.json');
  await backupExistingForMeaningfulJsonChange(vaultPath, target, '.opencanvas/desktop.json', desktop, new Set(['viewport']));
  await atomicWriteFile(target, JSON.stringify(desktop, null, 2), 'utf8');
}

async function writeOrganization(vaultPath, projects, folders, transaction) {
  const noteDirectory = path.join(vaultPath, 'notes');
  const normalizedFolders = [...new Set((folders || []).map((folder) => safeRelativePath(folder)))];
  for (const markerPath of await readFilesRecursive(noteDirectory, '.opencanvas-project.json')) {
    const target = resolveBelow(noteDirectory, markerPath);
    if (transaction) await transaction.delete(target); else try { await fs.unlink(target); } catch {}
  }
  for (const folder of normalizedFolders) await fs.mkdir(resolveBelow(noteDirectory, folder), { recursive: true });
  for (const project of projects || []) {
    const projectPath = safeRelativePath(project.relativePath);
    const directory = resolveBelow(noteDirectory, projectPath);
    await fs.mkdir(directory, { recursive: true });
    const target = path.join(directory, '.opencanvas-project.json');
    if (transaction) await transaction.write(target, JSON.stringify(project, null, 2), 'utf8');
    else await atomicWriteFile(target, JSON.stringify(project, null, 2), 'utf8');
  }
  const organizationTarget = path.join(vaultPath, '.opencanvas', 'file-organization.json');
  const organizationData = JSON.stringify({ version: 1, projects: projects || [], folders: normalizedFolders }, null, 2);
  if (transaction) await transaction.write(organizationTarget, organizationData, 'utf8');
  else await atomicWriteFile(organizationTarget, organizationData, 'utf8');
}

async function applyFilePlan(plan) {
  const vaultPath = await getVaultPath();
  await ensureVault(vaultPath);
  const writeCardIds = Array.isArray(plan.writeCardIds) ? new Set(plan.writeCardIds) : null;
  const writeBoardIds = Array.isArray(plan.writeBoardIds) ? new Set(plan.writeBoardIds) : null;
  const cardsToWrite = Array.isArray(plan.cards) ? plan.cards.filter((card) => !writeCardIds || writeCardIds.has(card.id)) : [];
  const boardsToWrite = Array.isArray(plan.boards) ? plan.boards.filter((board) => !writeBoardIds || writeBoardIds.has(board.id)) : [];
  const assertUniqueTargets = (values, label) => {
    const seen = new Set();
    for (const value of values) {
      const key = value.toLocaleLowerCase();
      if (seen.has(key)) throw new Error(`${label}存在同名目标：${value}`);
      seen.add(key);
    }
  };
  assertUniqueTargets(cardsToWrite.map((card) => safeRelativePath(card.relativePath || card.fileName, '.md')), '卡片路径');
  assertUniqueTargets(boardsToWrite.map((board) => {
    assertSafeFileName(board.fileName, '.board.json');
    return board.fileName;
  }), '白板文件');
  assertUniqueTargets((plan.projects || []).map((project) => safeRelativePath(project.relativePath)), '项目目录');
  assertUniqueTargets((plan.directoryMoves || []).map((move) => safeRelativePath(move.to)), '目录移动目标');
  markInternalWrite([
    ...cardsToWrite.map((card) => `notes/${safeRelativePath(card.relativePath || card.fileName, '.md')}`),
    ...Object.values(plan.previousCardPaths || {}).map((cardPath) => `notes/${safeRelativePath(cardPath, '.md')}`),
    ...boardsToWrite.map((board) => `boards/${board.fileName}`),
    ...(plan.trashedDirectoryPaths || []).map((directoryPath) => `notes/${safeRelativePath(directoryPath)}`),
    ...(plan.trashedCardPaths || []).map((cardPath) => `notes/${safeRelativePath(cardPath, '.md')}`),
    ...(plan.trashedBoardFileNames || []).map((fileName) => {
      assertSafeFileName(fileName, '.board.json');
      return `boards/${fileName}`;
    }),
    ...(plan.directoryMoves || []).flatMap((move) => [
      `notes/${safeRelativePath(move.from)}`,
      `notes/${safeRelativePath(move.to)}`,
    ]),
    ...(Array.isArray(plan.projects) ? plan.projects.map((project) => `notes/${safeRelativePath(project.relativePath)}/.opencanvas-project.json`) : []),
    '.opencanvas/file-organization.json',
  ]);
  const noteDirectory = path.join(vaultPath, 'notes');
  const transaction = await createFilePlanTransaction(vaultPath);
  try {
    const trashRoot = path.join(vaultPath, '.opencanvas', 'trash', `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
    const moveToTrash = async (source, relativeTarget) => {
      const target = resolveBelow(trashRoot, relativeTarget);
      await fs.mkdir(path.dirname(target), { recursive: true });
      try {
        await transaction.move(source, target);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    };
    for (const relativePath of plan.trashedDirectoryPaths || []) {
      const safePath = safeRelativePath(relativePath);
      await moveToTrash(resolveBelow(noteDirectory, safePath), `notes/${safePath}`);
    }
    for (const relativePath of plan.trashedCardPaths || []) {
      const safePath = safeRelativePath(relativePath, '.md');
      await moveToTrash(resolveBelow(noteDirectory, safePath), `notes/${safePath}`);
    }
    for (const fileName of plan.trashedBoardFileNames || []) {
      assertSafeFileName(fileName, '.board.json');
      await moveToTrash(path.join(vaultPath, 'boards', fileName), `boards/${fileName}`);
    }
    for (const move of plan.directoryMoves || []) {
      const from = resolveBelow(noteDirectory, move.from);
      const to = resolveBelow(noteDirectory, move.to);
      await fs.mkdir(path.dirname(to), { recursive: true });
      try {
        await transaction.move(from, to);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    for (const card of cardsToWrite) {
      const nextRelative = safeRelativePath(card.relativePath || card.fileName, '.md');
      const previousRelative = plan.previousCardPaths?.[card.id];
      const target = resolveBelow(noteDirectory, nextRelative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (previousRelative && previousRelative !== nextRelative) {
        const source = resolveBelow(noteDirectory, previousRelative);
        try {
          await transaction.move(source, target);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
      await backupExisting(vaultPath, target, `notes/${nextRelative}`);
      await transaction.write(target, serializeCard(card), 'utf8');
    }
    for (const board of boardsToWrite) {
      assertSafeFileName(board.fileName, '.board.json');
      const target = path.join(vaultPath, 'boards', board.fileName);
      await backupExisting(vaultPath, target, `boards/${board.fileName}`);
      await transaction.write(target, JSON.stringify({ ...board, version: 4 }, null, 2), 'utf8');
    }
    await writeOrganization(vaultPath, plan.projects || [], plan.folders || [], transaction);
    await transaction.complete();
  } catch (error) {
    const rollbackFailures = await transaction.rollback();
    if (rollbackFailures.length) error.message = `${error.message}；自动回滚有 ${rollbackFailures.length} 项失败，下次启动会继续恢复`;
    throw error;
  }
}

function resolveVaultSource(vaultPath, sourcePath) {
  const safePath = safeRelativePath(sourcePath);
  if (!safePath.startsWith('notes/') && !safePath.startsWith('boards/') && !safePath.startsWith('attachments/') && safePath !== '.opencanvas/desktop.json') {
    throw new Error(`Unsupported vault source path: ${sourcePath}`);
  }
  return resolveBelow(vaultPath, safePath);
}

async function uniqueRestoreTarget(vaultPath, sourcePath) {
  let candidate = safeRelativePath(sourcePath);
  let target = resolveVaultSource(vaultPath, candidate);
  let suffix = 2;
  while (fsNative.existsSync(target)) {
    const boardExtension = candidate.endsWith('.board.json') ? '.board.json' : path.posix.extname(candidate);
    const base = candidate.slice(0, -boardExtension.length);
    candidate = `${base} restored ${suffix++}${boardExtension}`;
    target = resolveVaultSource(vaultPath, candidate);
  }
  return { sourcePath: candidate, target };
}

async function exportOpenFormatDirect(request, targetPath) {
  const format = request?.format;
  const safeName = String(request?.name || 'OpenCanvas 导出').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').slice(0, 70) || 'OpenCanvas 导出';
  const resolvedTarget = path.resolve(targetPath);
  await fs.mkdir(path.dirname(resolvedTarget), { recursive: true });
  if (format === 'obsidian-canvas') {
    if (!request.canvasDocument || typeof request.canvasDocument !== 'object') throw new Error('缺少 Canvas 文档');
    await atomicWriteFile(resolvedTarget, JSON.stringify(request.canvasDocument, null, 2), 'utf8');
    return resolvedTarget;
  }
  if (format !== 'opencanvas-zip') throw new Error('不支持的导出格式');
  const entries = {};
  const cards = Array.isArray(request.cards) ? request.cards : [];
  const boards = Array.isArray(request.boards) ? request.boards : [];
  entries['manifest.json'] = strToU8(JSON.stringify({ format: 'opencanvas', version: 1, name: safeName, exportedAt: new Date().toISOString(), cards, boards }, null, 2));
  for (const card of cards) entries[`notes/${safeRelativePath(card.relativePath || card.fileName, '.md')}`] = strToU8(serializeCard(card));
  for (const board of boards) {
    assertSafeFileName(board.fileName, '.board.json');
    entries[`boards/${board.fileName}`] = strToU8(JSON.stringify({ ...board, version: 4 }, null, 2));
  }
  const attachmentNames = new Set(cards.flatMap((card) => [...String(card.body || '').matchAll(/attachments\/([^\s)"']+)/g)].map((match) => decodeURIComponent(match[1]))));
  const vaultPath = await getVaultPath();
  for (const fileName of attachmentNames) {
    if (path.basename(fileName) !== fileName) continue;
    try { entries[`attachments/${fileName}`] = new Uint8Array(await fs.readFile(path.join(vaultPath, 'attachments', fileName))); } catch {}
  }
  await atomicWriteFile(resolvedTarget, Buffer.from(zipSync(entries, { level: 6 })));
  return resolvedTarget;
}

async function previewOpenFormatDirect(sourcePath) {
  const source = path.resolve(sourcePath);
  const stat = await fs.stat(source);
  if (stat.size > 200 * 1024 * 1024) throw new Error('导入文件超过 200 MB 安全上限');
  if (path.extname(source).toLowerCase() === '.canvas') {
    const canvasDocument = JSON.parse(await fs.readFile(source, 'utf8'));
    const sourceFiles = [];
    const warnings = [];
    const sourceRoot = path.dirname(source);
    for (const node of Array.isArray(canvasDocument?.nodes) ? canvasDocument.nodes : []) {
      if (node?.type !== 'file' || typeof node.file !== 'string') continue;
      const relative = safeRelativePath(node.file.replace(/^notes\//i, ''), '.md');
      try { sourceFiles.push({ relativePath: relative, content: await fs.readFile(resolveBelow(sourceRoot, node.file), 'utf8') }); }
      catch { warnings.push(`找不到 Canvas 引用的 Markdown：${node.file}`); }
    }
    const sessionId = randomUUID();
    pendingImports.set(sessionId, { format: 'obsidian-canvas', source, attachments: new Map() });
    return { sessionId, format: 'obsidian-canvas', name: path.basename(source, '.canvas'), canvasDocument, sourceFiles, warnings, summary: { cards: sourceFiles.length, boards: 1, attachments: 0, idConflicts: 0, pathConflicts: 0 } };
  }
  const vaultPath = await getVaultPath();
  const snapshot = await loadWorkspaceAt(vaultPath);
  return previewZipImport(secureUnzip(new Uint8Array(await fs.readFile(source))), source, vaultPath, snapshot);
}

function sanitizedImportSegment(value, fallback = '未命名') {
  let result = String(value || '').replace(/[<>:"\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').slice(0, 120).trim();
  if (!result) result = fallback;
  if (WINDOWS_DEVICE_NAME.test(result)) result = `_${result}`;
  return result;
}

function stripSingleZipRoot(entryNames) {
  const files = entryNames.filter((name) => name && !name.endsWith('/') && !name.startsWith('__MACOSX/'));
  if (!files.length) return { files, prefix: '' };
  const first = files[0].split('/')[0];
  const prefix = first && files.every((name) => name.startsWith(`${first}/`)) ? `${first}/` : '';
  return { files, prefix };
}

function markdownImportBody(raw, title) {
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  let body = frontmatter ? raw.slice(frontmatter[0].length) : raw;
  const heading = body.match(/^#\s+(.+)\r?\n(?:\r?\n)?/);
  if (heading && heading[1].trim() === title.trim()) body = body.slice(heading[0].length);
  return body.replace(/\r\n/g, '\n').replace(/\n$/, '');
}

function markdownImportTitle(raw, fallback) {
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (frontmatter) {
    const titleLine = frontmatter[1].split(/\r?\n/).find((line) => /^title\s*:/i.test(line));
    if (titleLine) {
      const value = parseHeaderValue(titleLine.slice(titleLine.indexOf(':') + 1).trim());
      if (String(value || '').trim()) return sanitizedImportSegment(value, fallback);
    }
  }
  const heading = (frontmatter ? raw.slice(frontmatter[0].length) : raw).match(/^#\s+(.+)$/m);
  return sanitizedImportSegment(heading?.[1]?.trim() || fallback, '未命名');
}

function rewriteImportedMarkdownLinks(body, noteEntryName, attachmentNamesByEntry) {
  return body.replace(/(!?\[[^\]]*\]\()(<[^>]+>|[^)\s]+)([^)]*\))/g, (whole, opening, rawTarget, closing) => {
    const wrapped = rawTarget.startsWith('<') && rawTarget.endsWith('>');
    const target = wrapped ? rawTarget.slice(1, -1) : rawTarget;
    if (!target || /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) return whole;
    const [pathPart, suffix = ''] = target.split(/(?=[?#])/u, 2);
    let decoded = pathPart;
    try { decoded = decodeURIComponent(pathPart); } catch {}
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(noteEntryName), decoded)).replace(/^\.\//, '');
    const fileName = attachmentNamesByEntry.get(resolved.toLocaleLowerCase());
    if (!fileName) return whole;
    const nextTarget = `attachments/${fileName}${suffix}`;
    const needsWrapper = wrapped || /\s/.test(nextTarget);
    return `${opening}${needsWrapper ? `<${nextTarget}>` : nextTarget}${closing}`;
  });
}

function previewZipImport(entries, source, vaultPath, snapshot) {
  const entryNames = Object.keys(entries);
  if (entryNames.length > ZIP_LIMITS.files) throw new Error(`ZIP 文件数超过 ${ZIP_LIMITS.files} 项安全上限`);
  if (entries['manifest.json']) {
    const manifest = JSON.parse(strFromU8(entries['manifest.json']));
    if (manifest?.format !== 'opencanvas' || manifest?.version !== 1 || !Array.isArray(manifest.cards) || !Array.isArray(manifest.boards)) throw new Error('OpenCanvas ZIP 清单无效');
    return previewOpenCanvasZip(entries, entryNames, manifest, source, vaultPath, snapshot);
  }
  const { files, prefix } = stripSingleZipRoot(entryNames);
  const markdownEntries = files.filter((name) => name.toLowerCase().endsWith('.md'));
  if (!markdownEntries.length) throw new Error('ZIP 中没有找到 Markdown 文件，也不是有效的 OpenCanvas ZIP');
  const now = new Date().toISOString();
  const attachmentData = new Map();
  const attachments = [];
  const usedAttachmentNames = new Set();
  const attachmentNamesByEntry = new Map();
  for (const entryName of files) {
    if (entryName.toLowerCase().endsWith('.md') || /(^|\/)\.ds_store$/i.test(entryName)) continue;
    const original = sanitizedImportSegment(path.posix.basename(entryName), 'attachment');
    const extension = path.extname(original);
    const base = path.basename(original, extension);
    let fileName = original;
    let suffix = 2;
    while (usedAttachmentNames.has(fileName.toLocaleLowerCase())) fileName = `${base} ${suffix++}${extension}`;
    usedAttachmentNames.add(fileName.toLocaleLowerCase());
    attachmentNamesByEntry.set(entryName.toLocaleLowerCase(), fileName);
    attachmentData.set(fileName, Buffer.from(entries[entryName]));
    attachments.push({ name: fileName, size: entries[entryName].byteLength, exists: fsNative.existsSync(path.join(vaultPath, 'attachments', fileName)) });
  }
  const usedPaths = new Set();
  const cards = markdownEntries.map((entryName) => {
    const raw = strFromU8(entries[entryName]);
    const sourceRelative = entryName.slice(prefix.length);
    const parts = sourceRelative.split('/').filter(Boolean);
    const file = parts.pop() || '未命名.md';
    const title = markdownImportTitle(raw, path.posix.basename(file, '.md'));
    const directories = parts.map((part) => sanitizedImportSegment(part));
    let fileName = `${title}.md`;
    let relativePath = [...directories, fileName].join('/');
    let suffix = 2;
    while (usedPaths.has(relativePath.toLocaleLowerCase())) {
      fileName = `${title} ${suffix++}.md`;
      relativePath = [...directories, fileName].join('/');
    }
    usedPaths.add(relativePath.toLocaleLowerCase());
    const body = rewriteImportedMarkdownLinks(markdownImportBody(raw, title), entryName, attachmentNamesByEntry);
    return { id: randomUUID(), fileName, relativePath, title, body, createdAt: now, updatedAt: now };
  });
  const sessionId = randomUUID();
  pendingImports.set(sessionId, { format: 'markdown-zip', source, attachments: attachmentData });
  const existingPaths = new Set(snapshot.cards.map((card) => card.relativePath.toLocaleLowerCase()));
  const pathConflicts = cards.filter((card) => existingPaths.has(card.relativePath.toLocaleLowerCase())).length;
  const archiveName = sanitizedImportSegment(path.basename(source, path.extname(source)), 'Markdown 导入');
  return {
    sessionId,
    format: 'markdown-zip',
    name: archiveName,
    bundle: { name: archiveName, cards, boards: [] },
    attachments,
    warnings: [
      'Heptabase 的 Markdown 导出不包含白板坐标、Section、连线和嵌套白板；本次只迁移笔记目录与附件。',
      '导入前不会修改知识库；确认后使用事务写入，失败会回滚本次新增文件。',
    ],
    summary: { cards: cards.length, boards: 0, attachments: attachments.length, idConflicts: 0, pathConflicts },
  };
}

function previewOpenCanvasZip(entries, entryNames, manifest, source, vaultPath, snapshot) {
  const existingCardIds = new Set(snapshot.cards.map((card) => card.id));
  const existingBoardIds = new Set(snapshot.boards.map((board) => board.id));
  const existingPaths = new Set(snapshot.cards.map((card) => card.relativePath.toLocaleLowerCase()));
  const attachments = [];
  const attachmentData = new Map();
  for (const entryName of entryNames) {
    if (!entryName.startsWith('attachments/') || entryName.endsWith('/')) continue;
    const fileName = path.basename(entryName);
    if (entryName !== `attachments/${fileName}`) continue;
    const target = path.join(vaultPath, 'attachments', fileName);
    attachments.push({ name: fileName, size: entries[entryName].byteLength, exists: fsNative.existsSync(target) });
    attachmentData.set(fileName, Buffer.from(entries[entryName]));
  }
  const sessionId = randomUUID();
  pendingImports.set(sessionId, { format: 'opencanvas-zip', source, attachments: attachmentData });
  const idConflicts = manifest.cards.filter((card) => existingCardIds.has(card.id)).length + manifest.boards.filter((board) => existingBoardIds.has(board.id)).length;
  const pathConflicts = manifest.cards.filter((card) => existingPaths.has(String(card.relativePath || card.fileName).toLocaleLowerCase())).length;
  return { sessionId, format: 'opencanvas-zip', name: String(manifest.name || path.basename(source, '.zip')), bundle: { name: String(manifest.name || '导入'), cards: manifest.cards, boards: manifest.boards }, attachments, warnings: [], summary: { cards: manifest.cards.length, boards: manifest.boards.length, attachments: attachments.length, idConflicts, pathConflicts } };
}

function windowThemeColors(theme) {
  const dark = theme === 'dark';
  return {
    backgroundColor: dark ? '#151515' : '#ebeae6',
    symbolColor: dark ? '#eeeeef' : '#26272a',
  };
}

function applyWindowTheme(theme) {
  const normalizedTheme = theme === 'light' ? 'light' : 'dark';
  const colors = windowThemeColors(normalizedTheme);
  nativeTheme.themeSource = normalizedTheme;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(colors.backgroundColor);
    if (process.platform === 'win32') {
      mainWindow.setTitleBarOverlay({ color: colors.backgroundColor, symbolColor: colors.symbolColor, height: 32 });
    }
  }
  return normalizedTheme;
}

function registerIpc() {
  ipcMain.handle('window:set-theme', async (_event, theme) => {
    if (theme !== 'dark' && theme !== 'light') return false;
    applyWindowTheme(theme);
    const settings = await readSettings();
    if (settings.windowTheme !== theme) await writeSettings({ ...settings, windowTheme: theme });
    return true;
  });
  ipcMain.handle('vault:load', async () => {
    const vaultPath = await getVaultPath();
    await startVaultWatcher(vaultPath);
    return loadWorkspaceAt(vaultPath);
  });
  ipcMain.handle('vault:save-card', (_event, card) => trackVaultWrite(() => saveCard(card)));
  ipcMain.handle('vault:save-board', (_event, board) => trackVaultWrite(() => saveBoard(board)));
  ipcMain.handle('vault:save-desktop', (_event, desktop) => trackVaultWrite(() => saveDesktopLayout(desktop)));
  ipcMain.handle('vault:apply-file-plan', (_event, plan) => trackVaultWrite(() => applyFilePlan(plan)));
  ipcMain.handle('vault:prepare-close', () => prepareVaultClose());
  ipcMain.handle('vault:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择或创建 OpenCanvas 知识库',
      defaultPath: app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const vaultPath = path.resolve(result.filePaths[0]);
    await writeSettings({ ...(await readSettings()), vaultPath });
    await startVaultWatcher(vaultPath);
    return loadWorkspaceAt(vaultPath);
  });
  ipcMain.handle('vault:reveal', async () => {
    const vaultPath = await getVaultPath();
    await ensureVault(vaultPath);
    await shell.openPath(vaultPath);
  });
  ipcMain.handle('vault:reveal-item', async (_event, sourcePath) => {
    const vaultPath = await getVaultPath();
    await ensureVault(vaultPath);
    const safePath = safeRelativePath(sourcePath);
    const target = ['notes', 'boards', 'attachments'].includes(safePath)
      ? resolveBelow(vaultPath, safePath)
      : resolveVaultSource(vaultPath, safePath);
    if (!fsNative.existsSync(target)) return false;
    const stat = await fs.stat(target);
    if (stat.isDirectory()) return (await shell.openPath(target)) === '';
    shell.showItemInFolder(target);
    return true;
  });
  ipcMain.handle('vault:import-attachment', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '插入附件',
      properties: ['openFile'],
      filters: [{ name: '常用文件', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'pdf', 'mp3', 'wav', 'm4a', 'mp4', 'webm', 'mov', 'txt', 'csv', 'zip'] }, { name: '所有文件', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return copyAttachmentFromPath(result.filePaths[0]);
  });
  ipcMain.handle('vault:import-attachment-file', async (_event, payload) => copyAttachmentFromPath(payload?.sourcePath, payload?.mimeType));
  ipcMain.handle('vault:import-attachment-data', async (_event, payload) => {
    const sourceName = path.basename(String(payload?.name || 'attachment'));
    const extension = path.extname(sourceName).toLowerCase().slice(0, 12);
    const originalName = path.basename(sourceName, extension).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 70) || 'attachment';
    const buffer = Buffer.from(String(payload?.dataBase64 || ''), 'base64');
    if (!buffer.length || buffer.length > 25 * 1024 * 1024) throw new Error('附件必须小于 25 MB');
    const fileName = `${originalName}--${randomUUID().slice(0, 8)}${extension}`;
    const vaultPath = await getVaultPath();
    await ensureVault(vaultPath);
    markInternalWrite(`attachments/${fileName}`);
    await fs.writeFile(path.join(vaultPath, 'attachments', fileName), buffer);
    return { name: sourceName, relativePath: `attachments/${fileName}`, url: `opencanvas-asset://vault/attachments/${encodeURIComponent(fileName)}`, mimeType: String(payload?.mimeType || 'application/octet-stream'), size: buffer.length };
  });
  ipcMain.handle('vault:export-bundle', async (_event, bundle) => {
    const result = await dialog.showOpenDialog(mainWindow, { title: '选择导出位置', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const safeName = String(bundle?.name || 'OpenCanvas 导出').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').slice(0, 70) || 'OpenCanvas 导出';
    let exportRoot = path.join(result.filePaths[0], safeName);
    let suffix = 2;
    while (fsNative.existsSync(exportRoot)) exportRoot = path.join(result.filePaths[0], `${safeName} ${suffix++}`);
    await Promise.all([fs.mkdir(path.join(exportRoot, 'notes'), { recursive: true }), fs.mkdir(path.join(exportRoot, 'boards'), { recursive: true }), fs.mkdir(path.join(exportRoot, 'attachments'), { recursive: true })]);
    for (const card of bundle?.cards || []) {
      const target = resolveBelow(path.join(exportRoot, 'notes'), safeRelativePath(card.relativePath || card.fileName, '.md'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, serializeCard(card), 'utf8');
    }
    for (const board of bundle?.boards || []) {
      assertSafeFileName(board.fileName, '.board.json');
      await fs.writeFile(path.join(exportRoot, 'boards', board.fileName), JSON.stringify({ ...board, version: 4 }, null, 2), 'utf8');
    }
    const attachmentNames = new Set((bundle?.cards || []).flatMap((card) => [...String(card.body || '').matchAll(/attachments\/([^\s)"']+)/g)].map((match) => decodeURIComponent(match[1]))));
    const vaultPath = await getVaultPath();
    for (const fileName of attachmentNames) {
      if (path.basename(fileName) !== fileName) continue;
      try { await fs.copyFile(path.join(vaultPath, 'attachments', fileName), path.join(exportRoot, 'attachments', fileName)); } catch {}
    }
    await fs.writeFile(path.join(exportRoot, 'README.md'), `# ${safeName}\n\n由 OpenCanvas 导出。卡片位于 notes，白板位于 boards，附件位于 attachments。\n`, 'utf8');
    await shell.openPath(exportRoot);
    return exportRoot;
  });
  ipcMain.handle('vault:export-open-format', async (_event, request) => {
    const format = request?.format;
    const extension = format === 'obsidian-canvas' ? 'canvas' : 'zip';
    const safeName = String(request?.name || 'OpenCanvas 导出').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').slice(0, 70) || 'OpenCanvas 导出';
    const result = await dialog.showSaveDialog(mainWindow, {
      title: format === 'obsidian-canvas' ? '导出 Obsidian Canvas' : '导出 OpenCanvas ZIP',
      defaultPath: `${safeName}.${extension}`,
      filters: format === 'obsidian-canvas' ? [{ name: 'Obsidian Canvas', extensions: ['canvas'] }] : [{ name: 'OpenCanvas ZIP', extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePath) return null;
    if (format === 'obsidian-canvas') {
      if (!request.canvasDocument || typeof request.canvasDocument !== 'object') throw new Error('缺少 Canvas 文档');
      await fs.writeFile(result.filePath, JSON.stringify(request.canvasDocument, null, 2), 'utf8');
      return result.filePath;
    }
    if (format !== 'opencanvas-zip') throw new Error('不支持的导出格式');
    const entries = {};
    const cards = Array.isArray(request.cards) ? request.cards : [];
    const boards = Array.isArray(request.boards) ? request.boards : [];
    entries['manifest.json'] = strToU8(JSON.stringify({ format: 'opencanvas', version: 1, name: safeName, exportedAt: new Date().toISOString(), cards, boards }, null, 2));
    for (const card of cards) entries[`notes/${safeRelativePath(card.relativePath || card.fileName, '.md')}`] = strToU8(serializeCard(card));
    for (const board of boards) {
      assertSafeFileName(board.fileName, '.board.json');
      entries[`boards/${board.fileName}`] = strToU8(JSON.stringify({ ...board, version: 4 }, null, 2));
    }
    const attachmentNames = new Set(cards.flatMap((card) => [...String(card.body || '').matchAll(/attachments\/([^\s)"']+)/g)].map((match) => decodeURIComponent(match[1]))));
    const vaultPath = await getVaultPath();
    for (const fileName of attachmentNames) {
      if (path.basename(fileName) !== fileName) continue;
      try { entries[`attachments/${fileName}`] = new Uint8Array(await fs.readFile(path.join(vaultPath, 'attachments', fileName))); } catch {}
    }
    await fs.writeFile(result.filePath, Buffer.from(zipSync(entries, { level: 6 })));
    return result.filePath;
  });
  ipcMain.handle('vault:import-open-format', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入 Heptabase、OpenCanvas 或 Obsidian 数据',
      properties: ['openFile'],
      filters: [{ name: '支持的格式', extensions: ['zip', 'canvas'] }, { name: 'Heptabase / Markdown ZIP', extensions: ['zip'] }, { name: 'OpenCanvas ZIP', extensions: ['zip'] }, { name: 'Obsidian Canvas', extensions: ['canvas'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const source = path.resolve(result.filePaths[0]);
    const stat = await fs.stat(source);
    if (stat.size > 200 * 1024 * 1024) throw new Error('导入文件超过 200 MB 安全上限');
    if (path.extname(source).toLowerCase() === '.canvas') {
      const canvasDocument = JSON.parse(await fs.readFile(source, 'utf8'));
      const sourceFiles = [];
      const warnings = [];
      const sourceRoot = path.dirname(source);
      for (const node of Array.isArray(canvasDocument?.nodes) ? canvasDocument.nodes : []) {
        if (node?.type !== 'file' || typeof node.file !== 'string') continue;
        const relative = safeRelativePath(node.file.replace(/^notes\//i, ''), '.md');
        try { sourceFiles.push({ relativePath: relative, content: await fs.readFile(resolveBelow(sourceRoot, node.file), 'utf8') }); }
        catch { warnings.push(`找不到 Canvas 引用的 Markdown：${node.file}`); }
      }
      const sessionId = randomUUID();
      pendingImports.set(sessionId, { format: 'obsidian-canvas', source, attachments: new Map() });
      return { sessionId, format: 'obsidian-canvas', name: path.basename(source, '.canvas'), canvasDocument, sourceFiles, warnings, summary: { cards: sourceFiles.length, boards: 1, attachments: 0, idConflicts: 0, pathConflicts: 0 } };
    }
    const vaultPath = await getVaultPath();
    const snapshot = await loadWorkspaceAt(vaultPath);
    return previewZipImport(secureUnzip(new Uint8Array(await fs.readFile(source))), source, vaultPath, snapshot);
  });
  ipcMain.handle('vault:cancel-open-format-import', async (_event, sessionId) => { pendingImports.delete(String(sessionId || '')); });
  ipcMain.handle('vault:commit-open-format-import', async (_event, request) => {
    const sessionId = String(request?.sessionId || '');
    const pending = pendingImports.get(sessionId);
    if (!pending) throw new Error('导入会话已经失效，请重新选择文件');
    const vaultPath = await getVaultPath();
    await ensureVault(vaultPath);
    const cards = Array.isArray(request?.cards) ? request.cards : [];
    const boards = Array.isArray(request?.boards) ? request.boards : [];
    if (!request?.desktop || !Array.isArray(request.desktop.placements)) throw new Error('导入桌面布局无效');
    const transactionRoot = path.join(vaultPath, '.opencanvas', 'import-staging', sessionId);
    const stagedRoot = path.join(transactionRoot, 'staged');
    const journalPath = path.join(transactionRoot, 'journal.json');
    await fs.rm(transactionRoot, { recursive: true, force: true });
    await fs.mkdir(stagedRoot, { recursive: true });
    const attachmentPathMap = {};
    const entries = [];
    let previousDesktop;
    try {
      for (const [originalName, content] of pending.attachments) {
        let fileName = originalName;
        let finalRelative = `attachments/${fileName}`;
        let target = resolveBelow(vaultPath, finalRelative);
        if (fsNative.existsSync(target)) {
          if (request?.attachmentStrategy === 'skip') continue;
          const extension = path.extname(originalName); const base = path.basename(originalName, extension);
          fileName = `${base}--import-${randomUUID().slice(0, 6)}${extension}`;
          finalRelative = `attachments/${fileName}`;
          target = resolveBelow(vaultPath, finalRelative);
          attachmentPathMap[`attachments/${originalName}`] = `attachments/${fileName}`;
        }
        const staged = resolveBelow(stagedRoot, finalRelative);
        await atomicWriteFile(staged, content);
        entries.push({ finalRelative, stagedRelative: finalRelative });
      }

      const rewriteAttachmentPaths = (body) => Object.entries(attachmentPathMap).reduce((value, [from, to]) => value.replaceAll(from, to), String(body || ''));
      const seenTargets = new Set(entries.map((entry) => entry.finalRelative.toLocaleLowerCase()));
      for (const card of cards) {
        const relativePath = safeRelativePath(card.relativePath || card.fileName, '.md');
        const finalRelative = `notes/${relativePath}`;
        if (seenTargets.has(finalRelative.toLocaleLowerCase()) || fsNative.existsSync(resolveBelow(vaultPath, finalRelative))) throw new Error(`导入目标已经存在：${finalRelative}`);
        seenTargets.add(finalRelative.toLocaleLowerCase());
        const staged = resolveBelow(stagedRoot, finalRelative);
        await atomicWriteFile(staged, serializeCard({ ...card, body: rewriteAttachmentPaths(card.body) }), 'utf8');
        entries.push({ finalRelative, stagedRelative: finalRelative });
      }
      for (const board of boards) {
        assertSafeFileName(board.fileName, '.board.json');
        const finalRelative = `boards/${board.fileName}`;
        if (seenTargets.has(finalRelative.toLocaleLowerCase()) || fsNative.existsSync(resolveBelow(vaultPath, finalRelative))) throw new Error(`导入目标已经存在：${finalRelative}`);
        seenTargets.add(finalRelative.toLocaleLowerCase());
        const staged = resolveBelow(stagedRoot, finalRelative);
        await atomicWriteFile(staged, JSON.stringify({ ...board, version: 4 }, null, 2), 'utf8');
        entries.push({ finalRelative, stagedRelative: finalRelative });
      }

      const desktopPath = path.join(vaultPath, '.opencanvas', 'desktop.json');
      try { previousDesktop = await fs.readFile(desktopPath); } catch {}
      const journal = { version: 1, state: 'committing', entries, previousDesktopBase64: previousDesktop?.toString('base64') };
      await atomicWriteFile(journalPath, JSON.stringify(journal, null, 2), 'utf8');
      markInternalWrite([...entries.map((entry) => entry.finalRelative), '.opencanvas/desktop.json']);
      for (const entry of entries) {
        const staged = resolveBelow(stagedRoot, entry.stagedRelative);
        const target = resolveBelow(vaultPath, entry.finalRelative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await renameWithRetry(staged, target);
        await recordInternalPathFingerprint(target);
      }
      await atomicWriteFile(desktopPath, JSON.stringify(request.desktop, null, 2), 'utf8');
      await atomicWriteFile(journalPath, JSON.stringify({ ...journal, state: 'complete' }, null, 2), 'utf8');
      pendingImports.delete(sessionId);
      await fs.rm(transactionRoot, { recursive: true, force: true });
      return { attachmentPathMap };
    } catch (error) {
      for (const entry of entries.reverse()) {
        try {
          const target = resolveBelow(vaultPath, entry.finalRelative);
          await fs.unlink(target);
          if (entry.finalRelative.startsWith('notes/')) await removeEmptyParents(path.dirname(target), path.join(vaultPath, 'notes'));
        } catch {}
      }
      const desktopPath = path.join(vaultPath, '.opencanvas', 'desktop.json');
      try {
        if (previousDesktop) await atomicWriteFile(desktopPath, previousDesktop);
        else await fs.unlink(desktopPath);
      } catch {}
      await fs.rm(transactionRoot, { recursive: true, force: true });
      throw error;
    }
  });
  ipcMain.handle('vault:list-trash', async () => {
    const vaultPath = await getVaultPath();
    await ensureVault(vaultPath);
    return listTrashEntries(vaultPath);
  });
  ipcMain.handle('vault:restore-trash-entry', async (_event, id) => {
    const vaultPath = await getVaultPath();
    const trashRoot = path.join(vaultPath, '.opencanvas', 'trash');
    const safeId = safeRelativePath(id);
    const entry = (await listTrashEntries(vaultPath)).find((item) => item.id === safeId);
    if (!entry) return null;
    const source = resolveBelow(trashRoot, safeId);
    const restored = await uniqueRestoreTarget(vaultPath, entry.sourcePath);
    markInternalWrite(restored.sourcePath);
    await fs.mkdir(path.dirname(restored.target), { recursive: true });
    await expectInternalMove(source, restored.target);
    await renameWithRetry(source, restored.target);
    await recordInternalPathFingerprint(restored.target);
    await removeEmptyParents(path.dirname(source), trashRoot);
    return restored.sourcePath;
  });
  ipcMain.handle('vault:delete-trash-entry', async (_event, id) => {
    const vaultPath = await getVaultPath();
    const trashRoot = path.join(vaultPath, '.opencanvas', 'trash');
    const safeId = safeRelativePath(id);
    const entry = (await listTrashEntries(vaultPath)).find((item) => item.id === safeId);
    if (!entry) return false;
    const target = resolveBelow(trashRoot, safeId);
    markInternalWrite(`.opencanvas/trash/${safeId}`);
    await fs.unlink(target);
    await removeEmptyParents(path.dirname(target), trashRoot);
    return true;
  });
  ipcMain.handle('vault:list-attachments', async () => {
    const vaultPath = await getVaultPath();
    await ensureVault(vaultPath);
    const snapshot = await loadWorkspaceAt(vaultPath);
    const references = new Map();
    for (const card of snapshot.cards) {
      for (const match of String(card.body || '').matchAll(/attachments\/([^\s)"']+)/g)) {
        const relativePath = `attachments/${decodeURIComponent(match[1])}`;
        references.set(relativePath, [...(references.get(relativePath) || []), { cardId: card.id, title: card.title }]);
      }
    }
    const files = await readFilesRecursive(path.join(vaultPath, 'attachments'), '');
    const entries = [];
    for (const file of files) {
      const relativePath = `attachments/${file}`;
      try {
        const stat = await fs.stat(resolveVaultSource(vaultPath, relativePath));
        entries.push({ relativePath, name: path.posix.basename(file), size: stat.size, mimeType: MIME_BY_EXTENSION[path.extname(file).toLowerCase()] || 'application/octet-stream', referencedBy: references.get(relativePath) || [] });
      } catch {}
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  });
  ipcMain.handle('vault:delete-attachment', async (_event, relativePath) => {
    const vaultPath = await getVaultPath();
    const safePath = safeRelativePath(relativePath);
    if (!safePath.startsWith('attachments/')) throw new Error('Only attachments can be removed here');
    const source = resolveVaultSource(vaultPath, safePath);
    if (!fsNative.existsSync(source)) return false;
    const trashRoot = path.join(vaultPath, '.opencanvas', 'trash', `${Date.now()}-${randomUUID().slice(0, 6)}`);
    const target = resolveBelow(trashRoot, safePath);
    markInternalWrite(safePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await expectInternalMove(source, target);
    await renameWithRetry(source, target);
    await recordInternalPathFingerprint(source);
    return true;
  });
  ipcMain.handle('vault:open-attachment', async (_event, relativePath) => {
    const vaultPath = await getVaultPath();
    const safePath = safeRelativePath(relativePath);
    if (!safePath.startsWith('attachments/')) return false;
    const target = resolveVaultSource(vaultPath, safePath);
    if (!fsNative.existsSync(target)) return false;
    return (await shell.openPath(target)) === '';
  });
  ipcMain.handle('vault:reveal-attachment', async (_event, relativePath) => {
    const vaultPath = await getVaultPath();
    const safePath = safeRelativePath(relativePath);
    if (!safePath.startsWith('attachments/')) return false;
    const target = resolveVaultSource(vaultPath, safePath);
    if (!fsNative.existsSync(target)) return false;
    shell.showItemInFolder(target);
    return true;
  });
  ipcMain.handle('vault:open-external', async (_event, value) => {
    try {
      const target = new URL(String(value));
      if (!['https:', 'http:', 'mailto:'].includes(target.protocol)) return false;
      await shell.openExternal(target.toString());
      return true;
    } catch { return false; }
  });
  ipcMain.handle('vault:list-file-versions', async (_event, sourcePath) => {
    const vaultPath = await getVaultPath();
    const safeSource = safeRelativePath(sourcePath);
    resolveVaultSource(vaultPath, safeSource);
    const directory = resolveBelow(path.join(vaultPath, '.opencanvas', 'history'), safeSource);
    try {
      const files = (await fs.readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile()).sort((a, b) => b.name.localeCompare(a.name));
      return Promise.all(files.map(async (entry) => {
        const stat = await fs.stat(path.join(directory, entry.name));
        const timestamp = Number(entry.name.split('--')[0]);
        return { id: `${safeSource}/${entry.name}`, sourcePath: safeSource, createdAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : stat.mtime.toISOString(), size: stat.size };
      }));
    } catch { return []; }
  });
  ipcMain.handle('vault:get-history-limit', () => getHistoryLimit());
  ipcMain.handle('vault:set-history-limit', (_event, value) => setHistoryLimit(value));
  ipcMain.handle('vault:restore-file-version', async (_event, id) => {
    const vaultPath = await getVaultPath();
    const safeId = safeRelativePath(id);
    const parts = safeId.split('/');
    if (parts.length < 2 || !parts.at(-1).endsWith('.bak')) return false;
    const sourcePath = parts.slice(0, -1).join('/');
    const version = resolveBelow(path.join(vaultPath, '.opencanvas', 'history'), safeId);
    const target = resolveVaultSource(vaultPath, sourcePath);
    if (!fsNative.existsSync(version)) return false;
    markInternalWrite(sourcePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await backupExisting(vaultPath, target, sourcePath);
    await fs.copyFile(version, target);
    return true;
  });
  ipcMain.handle('vault:check-integrity', async () => {
    const vaultPath = await getVaultPath();
    return checkVaultIntegrity(vaultPath);
  });
  ipcMain.handle('app:get-info', async () => ({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron || null,
    chromiumVersion: process.versions.chrome || '',
    nodeVersion: process.versions.node || null,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    automatedTest: process.env.OPENCANVAS_E2E === '1',
    vaultPath: await getVaultPath(),
  }));
  ipcMain.handle('vault:repair-integrity-issue', async (_event, issue) => repairIntegrityIssue(issue));
  if (process.env.OPENCANVAS_E2E === '1') {
    ipcMain.handle('vault:e2e-export-open-format', async (_event, request, targetPath) => exportOpenFormatDirect(request, targetPath));
    ipcMain.handle('vault:e2e-preview-open-format', async (_event, sourcePath) => previewOpenFormatDirect(sourcePath));
  }
}

function createWindow(initialTheme = 'dark') {
  let closeAfterFlush = false;
  acceptingVaultWrites = true;
  const colors = windowThemeColors(initialTheme);
  mainWindow = new BrowserWindow({
    show: process.env.OPENCANVAS_E2E !== '1',
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: colors.backgroundColor,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : process.platform === 'win32' ? 'hidden' : 'default',
    titleBarOverlay: process.platform === 'win32' ? { color: colors.backgroundColor, symbolColor: colors.symbolColor, height: 32 } : false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.removeMenu();

  mainWindow.on('close', (event) => {
    if (closeAfterFlush || mainWindow.isDestroyed()) return;
    event.preventDefault();
    void mainWindow.webContents.executeJavaScript('window.__openCanvasFlush?.()')
      .catch(() => undefined)
      .finally(() => {
        closeAfterFlush = true;
        if (!mainWindow.isDestroyed()) mainWindow.close();
      });
  });

  if (!app.isPackaged) {
    mainWindow.loadURL(process.env.OPENCANVAS_DEV_URL || 'http://127.0.0.1:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(async () => {
  const settings = await readSettings();
  const initialTheme = settings.windowTheme === 'light' ? 'light' : 'dark';
  applyWindowTheme(initialTheme);
  Menu.setApplicationMenu(null);
  protocol.handle('opencanvas-asset', async (request) => {
    try {
      const url = new URL(request.url);
      const relativePath = decodeURIComponent(url.pathname.replace(/^\//, ''));
      const safePath = safeRelativePath(relativePath);
      if (url.hostname !== 'vault' || !safePath.startsWith('attachments/')) return new Response('Not found', { status: 404 });
      const vaultPath = await getVaultPath();
      return net.fetch(pathToFileURL(resolveBelow(vaultPath, safePath)).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
  registerIpc();
  createWindow(initialTheme);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(nativeTheme.themeSource === 'light' ? 'light' : 'dark');
  });
});

app.on('window-all-closed', () => {
  vaultWatcher?.close();
  if (process.platform !== 'darwin') app.quit();
});
