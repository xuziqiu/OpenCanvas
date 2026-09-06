import type { Board, Card, DesktopLayout, OpenCanvasVaultApi, VaultChangeEvent, WorkspaceFilePlan, WorkspaceSnapshot } from './types';
import { browserSnapshotForStorage, stripBrowserDerivedState } from './domain/browserWorkspacePersistence';
import { repairWorkspaceIntegrityIssue } from './domain/integrityRepair';
import { normalizeWorkspaceSnapshot } from './domain/schema';

const STORAGE_KEY_V4 = 'opencanvas.workspace.v4';
const STORAGE_KEY_V3 = 'opencanvas.workspace.v3';
const STORAGE_KEY_V2 = 'opencanvas.workspace.v2';
const STORAGE_KEY_V1 = 'opencanvas.workspace.v1';

function readBrowserSnapshot(): WorkspaceSnapshot {
  const raw = localStorage.getItem(STORAGE_KEY_V4) ?? localStorage.getItem(STORAGE_KEY_V3) ?? localStorage.getItem(STORAGE_KEY_V2) ?? localStorage.getItem(STORAGE_KEY_V1);
  if (raw) {
    try {
      return normalizeWorkspaceSnapshot(stripBrowserDerivedState(JSON.parse(raw)));
    } catch {
      // Fall through to a clean workspace.
    }
  }
  return normalizeWorkspaceSnapshot({ vaultPath: '浏览器本地存储' });
}

function writeBrowserSnapshot(update: (snapshot: WorkspaceSnapshot) => WorkspaceSnapshot) {
  localStorage.setItem(STORAGE_KEY_V4, JSON.stringify(browserSnapshotForStorage(update(readBrowserSnapshot()))));
}

const browserVault: OpenCanvasVaultApi = {
  async loadWorkspace() {
    return readBrowserSnapshot();
  },
  async saveCard(card: Card) {
    writeBrowserSnapshot((snapshot) => ({
      ...snapshot,
      cards: [...snapshot.cards.filter((item) => item.id !== card.id), card],
    }));
  },
  async saveBoard(board: Board) {
    writeBrowserSnapshot((snapshot) => ({
      ...snapshot,
      boards: [...snapshot.boards.filter((item) => item.id !== board.id), board],
    }));
  },
  async saveDesktopLayout(desktop: DesktopLayout) {
    writeBrowserSnapshot((snapshot) => ({ ...snapshot, desktop }));
  },
  async applyFilePlan(plan: WorkspaceFilePlan) {
    writeBrowserSnapshot((snapshot) => ({
      ...snapshot,
      cards: plan.cards,
      boards: plan.boards,
      projects: plan.projects,
      folders: plan.folders,
    }));
  },
  async prepareClose() {},
  async setWindowTheme() { return false; },
  async chooseVault() {
    return null;
  },
  async revealVault() {},
  async revealItem() { return false; },
  async importAttachment() { return null; },
  async importAttachmentFile() { return null; },
  async importAttachmentData() { return null; },
  async exportBundle() { return null; },
  async exportOpenFormat() { return null; },
  async importOpenFormat() { return null; },
  async commitOpenFormatImport() { return { attachmentPathMap: {} }; },
  async cancelOpenFormatImport() {},
  async listTrash() { return []; },
  async restoreTrashEntry() { return null; },
  async deleteTrashEntry() { return false; },
  async listAttachments() { return []; },
  async deleteAttachment() { return false; },
  async openAttachment() { return false; },
  async revealAttachment() { return false; },
  async openExternal(url) {
    if (!/^https?:|^mailto:/i.test(url)) return false;
    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
  },
  async listFileVersions() { return []; },
  async getHistoryLimit() { return 30; },
  async setHistoryLimit(value) { return value; },
  async restoreFileVersion() { return false; },
  async repairIntegrityIssue(issue) {
    let repaired = false;
    writeBrowserSnapshot((snapshot) => {
      const next = repairWorkspaceIntegrityIssue(snapshot, issue);
      repaired = Boolean(next);
      return next ?? snapshot;
    });
    return repaired;
  },
  async checkIntegrity() {
    const snapshot = readBrowserSnapshot();
    return { checkedAt: new Date().toISOString(), issues: snapshot.loadIssues ?? [], recoveryEvents: [], recentVersions: [] };
  },
  async getAppInfo() {
    return {
      appVersion: '浏览器测试版', electronVersion: null, chromiumVersion: navigator.userAgent,
      nodeVersion: null, platform: navigator.platform || 'browser', arch: 'browser', packaged: false,
      automatedTest: false, vaultPath: '浏览器本地存储',
    };
  },
  onExternalChange() { return () => {}; },
};

const nativeVault = typeof window !== 'undefined' ? window.openCanvasVault : undefined;
export const isNativeVault = Boolean(nativeVault);

function normalizeNativeSnapshot(value: unknown): WorkspaceSnapshot {
  const normalized = normalizeWorkspaceSnapshot(value);
  if (value && typeof value === 'object' && 'recovery' in value) normalized.recovery = (value as WorkspaceSnapshot).recovery;
  return normalized;
}

export const vaultApi: OpenCanvasVaultApi = nativeVault ? {
  async loadWorkspace() {
    return normalizeNativeSnapshot(await nativeVault.loadWorkspace());
  },
  saveCard: (card) => nativeVault.saveCard(card),
  saveBoard: (board) => nativeVault.saveBoard(board),
  saveDesktopLayout: (desktop) => nativeVault.saveDesktopLayout(desktop),
  applyFilePlan: (plan) => nativeVault.applyFilePlan(plan),
  prepareClose: () => nativeVault.prepareClose?.() ?? Promise.resolve(),
  setWindowTheme: (theme) => nativeVault.setWindowTheme?.(theme) ?? Promise.resolve(false),
  async chooseVault() {
    const snapshot = await nativeVault.chooseVault();
    return snapshot ? normalizeNativeSnapshot(snapshot) : null;
  },
  revealVault: () => nativeVault.revealVault(),
  revealItem: (sourcePath) => nativeVault.revealItem?.(sourcePath) ?? Promise.resolve(false),
  importAttachment: () => nativeVault.importAttachment?.() ?? Promise.resolve(null),
  importAttachmentFile: (file) => nativeVault.importAttachmentFile?.(file) ?? Promise.resolve(null),
  importAttachmentData: (payload) => nativeVault.importAttachmentData?.(payload) ?? Promise.resolve(null),
  exportBundle: (bundle) => nativeVault.exportBundle?.(bundle) ?? Promise.resolve(null),
  exportOpenFormat: (request) => nativeVault.exportOpenFormat?.(request) ?? Promise.resolve(null),
  importOpenFormat: () => nativeVault.importOpenFormat?.() ?? Promise.resolve(null),
  commitOpenFormatImport: (request) => nativeVault.commitOpenFormatImport?.(request) ?? Promise.resolve({ attachmentPathMap: {} }),
  cancelOpenFormatImport: (sessionId) => nativeVault.cancelOpenFormatImport?.(sessionId) ?? Promise.resolve(),
  listTrash: () => nativeVault.listTrash?.() ?? Promise.resolve([]),
  restoreTrashEntry: (entryId) => nativeVault.restoreTrashEntry?.(entryId) ?? Promise.resolve(null),
  deleteTrashEntry: (entryId) => nativeVault.deleteTrashEntry?.(entryId) ?? Promise.resolve(false),
  listAttachments: () => nativeVault.listAttachments?.() ?? Promise.resolve([]),
  deleteAttachment: (relativePath) => nativeVault.deleteAttachment?.(relativePath) ?? Promise.resolve(false),
  openAttachment: (relativePath) => nativeVault.openAttachment?.(relativePath) ?? Promise.resolve(false),
  revealAttachment: (relativePath) => nativeVault.revealAttachment?.(relativePath) ?? Promise.resolve(false),
  openExternal: (url) => nativeVault.openExternal?.(url) ?? Promise.resolve(false),
  listFileVersions: (sourcePath) => nativeVault.listFileVersions?.(sourcePath) ?? Promise.resolve([]),
  getHistoryLimit: () => nativeVault.getHistoryLimit?.() ?? Promise.resolve(30),
  setHistoryLimit: (value) => nativeVault.setHistoryLimit?.(value) ?? Promise.resolve(value),
  restoreFileVersion: (versionId) => nativeVault.restoreFileVersion?.(versionId) ?? Promise.resolve(false),
  repairIntegrityIssue: (issue) => nativeVault.repairIntegrityIssue?.(issue) ?? Promise.resolve(false),
  checkIntegrity: () => nativeVault.checkIntegrity?.() ?? Promise.resolve({ checkedAt: new Date().toISOString(), issues: [], recoveryEvents: [], recentVersions: [] }),
  getAppInfo: () => nativeVault.getAppInfo?.() ?? browserVault.getAppInfo!(),
  onExternalChange: (callback: (event: VaultChangeEvent) => void) => nativeVault.onExternalChange?.(callback) ?? (() => {}),
} : browserVault;
