const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('openCanvasVault', {
  loadWorkspace: () => ipcRenderer.invoke('vault:load'),
  saveCard: (card) => ipcRenderer.invoke('vault:save-card', card),
  saveBoard: (board) => ipcRenderer.invoke('vault:save-board', board),
  saveDesktopLayout: (desktop) => ipcRenderer.invoke('vault:save-desktop', desktop),
  applyFilePlan: (plan) => ipcRenderer.invoke('vault:apply-file-plan', plan),
  prepareClose: () => ipcRenderer.invoke('vault:prepare-close'),
  setWindowTheme: (theme) => ipcRenderer.invoke('window:set-theme', theme),
  chooseVault: () => ipcRenderer.invoke('vault:choose'),
  revealVault: () => ipcRenderer.invoke('vault:reveal'),
  revealItem: (sourcePath) => ipcRenderer.invoke('vault:reveal-item', sourcePath),
  importAttachment: () => ipcRenderer.invoke('vault:import-attachment'),
  importAttachmentFile: (file) => {
    const sourcePath = webUtils.getPathForFile(file);
    if (!sourcePath) return Promise.resolve(null);
    return ipcRenderer.invoke('vault:import-attachment-file', { sourcePath, name: file.name, mimeType: file.type });
  },
  importAttachmentData: (payload) => ipcRenderer.invoke('vault:import-attachment-data', payload),
  exportBundle: (bundle) => ipcRenderer.invoke('vault:export-bundle', bundle),
  exportOpenFormat: (request) => ipcRenderer.invoke('vault:export-open-format', request),
  importOpenFormat: () => ipcRenderer.invoke('vault:import-open-format'),
  commitOpenFormatImport: (request) => ipcRenderer.invoke('vault:commit-open-format-import', request),
  cancelOpenFormatImport: (sessionId) => ipcRenderer.invoke('vault:cancel-open-format-import', sessionId),
  listTrash: () => ipcRenderer.invoke('vault:list-trash'),
  restoreTrashEntry: (id) => ipcRenderer.invoke('vault:restore-trash-entry', id),
  deleteTrashEntry: (id) => ipcRenderer.invoke('vault:delete-trash-entry', id),
  listAttachments: () => ipcRenderer.invoke('vault:list-attachments'),
  deleteAttachment: (relativePath) => ipcRenderer.invoke('vault:delete-attachment', relativePath),
  openAttachment: (relativePath) => ipcRenderer.invoke('vault:open-attachment', relativePath),
  revealAttachment: (relativePath) => ipcRenderer.invoke('vault:reveal-attachment', relativePath),
  openExternal: (url) => ipcRenderer.invoke('vault:open-external', url),
  listFileVersions: (sourcePath) => ipcRenderer.invoke('vault:list-file-versions', sourcePath),
  getHistoryLimit: () => ipcRenderer.invoke('vault:get-history-limit'),
  setHistoryLimit: (value) => ipcRenderer.invoke('vault:set-history-limit', value),
  restoreFileVersion: (id) => ipcRenderer.invoke('vault:restore-file-version', id),
  repairIntegrityIssue: (issue) => ipcRenderer.invoke('vault:repair-integrity-issue', issue),
  checkIntegrity: () => ipcRenderer.invoke('vault:check-integrity'),
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  e2eExportOpenFormat: (request, targetPath) => ipcRenderer.invoke('vault:e2e-export-open-format', request, targetPath),
  e2ePreviewOpenFormat: (sourcePath) => ipcRenderer.invoke('vault:e2e-preview-open-format', sourcePath),
  onExternalChange: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('vault:external-change', listener);
    return () => ipcRenderer.removeListener('vault:external-change', listener);
  },
});
