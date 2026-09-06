export type PlacementKind = 'card' | 'board' | 'text';
export type CanvasTool = 'select' | 'pan' | 'connect' | 'card' | 'text' | 'section' | 'board';

/** A card is an independent knowledge entity. Markdown remains its portable source. */
export interface Card {
  id: string;
  fileName: string;
  /** Portable path below notes/. Existing flat cards use the file name. */
  relativePath: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** A placement is a view of an entity on one board, never the entity itself. */
export interface BoardPlacement {
  id: string;
  kind: PlacementKind;
  entityId?: string;
  text?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  collapsed?: boolean;
  /** Expanded height retained while a card is rendered as a folded title strip. */
  expandedHeight?: number;
  /** A card fitted to content keeps following its rendered document height. */
  autoHeight?: boolean;
  /** Independent reading position for this one spatial instance. */
  scrollTop?: number;
  zIndex?: number;
  groupId?: string;
  /**
   * Section membership is independent from ordinary object grouping.
   * `sectionId` is retained as the primary/legacy relation for older boards;
   * current boards may reference every overlapping Section through sectionIds.
   */
  sectionId?: string;
  sectionIds?: string[];
  /** Manual Section bounds saved before temporary content-driven expansion. */
  sectionBaseBounds?: { x: number; y: number; width: number; height: number };
  locked?: boolean;
  hidden?: boolean;
  isFrame?: boolean;
}

export interface BoardConnector {
  id: string;
  from: string;
  to: string;
  label?: string;
  color?: string;
  lineStyle?: 'curve' | 'orthogonal' | 'straight';
  arrow?: 'none' | 'end' | 'start' | 'both';
  width?: number;
  dashed?: boolean;
  fromAnchor?: 'top' | 'right' | 'bottom' | 'left';
  toAnchor?: 'top' | 'right' | 'bottom' | 'left';
  controlPoints?: Array<{ id: string; x: number; y: number; direction?: 'vertical' | 'horizontal' }>;
}

export type AttachmentDirection = 'top' | 'right' | 'bottom' | 'left';

/** A persistent spatial relationship between two placements on one board. */
export interface BoardAttachment {
  objectId: string;
  attachedObjectId: string;
  direction: AttachmentDirection;
  gap: number;
}

export interface Board {
  version: 4;
  id: string;
  fileName: string;
  title: string;
  projectId?: string;
  placements: BoardPlacement[];
  connectors: BoardConnector[];
  attachments: BoardAttachment[];
  viewport: Viewport;
  createdAt: string;
  updatedAt: string;
}

/** A real file-system directory that a board may use as its default card home. */
export interface ProjectDirectory {
  id: string;
  name: string;
  relativePath: string;
  createdAt: string;
}

export interface DesktopBoardPlacement {
  boardId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopLayout {
  placements: DesktopBoardPlacement[];
  viewport: Viewport;
}

export interface WorkspaceFilePlan {
  cards: Card[];
  boards: Board[];
  projects: ProjectDirectory[];
  folders: string[];
  /** Omitted for a full snapshot write; an empty list intentionally writes none. */
  writeCardIds?: string[];
  /** Omitted for a full snapshot write; an empty list intentionally writes none. */
  writeBoardIds?: string[];
  previousCardPaths?: Record<string, string>;
  directoryMoves?: Array<{ from: string; to: string }>;
  trashedCardPaths?: string[];
  trashedBoardFileNames?: string[];
  trashedDirectoryPaths?: string[];
}

export interface WorkspaceSnapshot {
  schemaVersion: 4;
  vaultPath: string;
  cards: Card[];
  boards: Board[];
  projects: ProjectDirectory[];
  folders: string[];
  desktop: DesktopLayout;
  loadIssues?: VaultIntegrityIssue[];
  recovery?: {
    recovered: string[];
    discarded: string[];
    importTransactions?: string[];
    filePlanTransactions?: string[];
    failedTransactions?: Array<{ id: string; failures: string[] }>;
  };
}

export interface VaultIntegrityIssue {
  kind: 'missing-card' | 'missing-board' | 'broken-connector' | 'missing-attachment' | 'duplicate-id' | 'invalid-file';
  sourcePath: string;
  message: string;
  boardId?: string;
  placementId?: string;
  connectorId?: string;
  attachmentName?: string;
  repairAction?: 'remove-reference' | 'remove-connector' | 'restore-attachment';
}

interface VaultRecoveryEvent {
  id: string;
  recoveredAt: string;
  recovered: string[];
  discarded: string[];
  importTransactions: string[];
  filePlanTransactions: string[];
  failedTransactions: Array<{ id: string; failures: string[] }>;
}

export interface VaultIntegrityReport {
  checkedAt: string;
  issues: VaultIntegrityIssue[];
  recoveryEvents: VaultRecoveryEvent[];
  recentVersions: VaultFileVersion[];
}

export interface VaultChangeEvent {
  paths: string[];
  occurredAt: string;
}

export interface ImportedAttachment {
  name: string;
  relativePath: string;
  url: string;
  mimeType?: string;
  size?: number;
}

interface WorkspaceExportBundle {
  name: string;
  cards: Card[];
  boards: Board[];
}

type OpenWorkspaceFormat = 'opencanvas-zip' | 'obsidian-canvas' | 'markdown-zip';

interface OpenFormatExportRequest extends WorkspaceExportBundle {
  format: OpenWorkspaceFormat;
  activeBoardId?: string;
  canvasDocument?: unknown;
}

export interface OpenFormatImportResult {
  sessionId: string;
  format: OpenWorkspaceFormat;
  name: string;
  bundle?: WorkspaceExportBundle;
  canvasDocument?: unknown;
  attachments?: Array<{ name: string; size: number; exists: boolean }>;
  sourceFiles?: Array<{ relativePath: string; content: string }>;
  warnings?: string[];
  summary?: { cards: number; boards: number; attachments: number; idConflicts: number; pathConflicts: number };
}

interface OpenFormatImportCommitRequest {
  sessionId: string;
  attachmentStrategy: 'rename' | 'skip';
  cards: Card[];
  boards: Board[];
  desktop: DesktopLayout;
}

export interface VaultTrashEntry {
  id: string;
  sourcePath: string;
  name: string;
  kind: 'card' | 'board' | 'file';
  size: number;
  deletedAt: string;
}

export interface VaultAttachmentEntry {
  relativePath: string;
  name: string;
  size: number;
  mimeType: string;
  referencedBy: Array<{ cardId: string; title: string }>;
}

export interface VaultFileVersion {
  id: string;
  sourcePath: string;
  createdAt: string;
  size: number;
}

export interface OpenCanvasAppInfo {
  appVersion: string;
  electronVersion: string | null;
  chromiumVersion: string;
  nodeVersion: string | null;
  platform: string;
  arch: string;
  packaged: boolean;
  automatedTest: boolean;
  vaultPath: string;
}

export interface OpenCanvasVaultApi {
  loadWorkspace(): Promise<unknown>;
  saveCard(card: Card): Promise<void>;
  saveBoard(board: Board): Promise<void>;
  saveDesktopLayout(layout: DesktopLayout): Promise<void>;
  applyFilePlan(plan: WorkspaceFilePlan): Promise<void>;
  prepareClose?(): Promise<void>;
  setWindowTheme?(theme: 'dark' | 'light'): Promise<boolean>;
  chooseVault(): Promise<unknown | null>;
  revealVault(): Promise<void>;
  revealItem?(sourcePath: string): Promise<boolean>;
  importAttachment?(): Promise<ImportedAttachment | null>;
  importAttachmentFile?(file: File): Promise<ImportedAttachment | null>;
  importAttachmentData?(payload: { name: string; mimeType?: string; dataBase64: string }): Promise<ImportedAttachment | null>;
  exportBundle?(bundle: WorkspaceExportBundle): Promise<string | null>;
  exportOpenFormat?(request: OpenFormatExportRequest): Promise<string | null>;
  importOpenFormat?(): Promise<OpenFormatImportResult | null>;
  commitOpenFormatImport?(request: OpenFormatImportCommitRequest): Promise<{ attachmentPathMap: Record<string, string> }>;
  cancelOpenFormatImport?(sessionId: string): Promise<void>;
  listTrash?(): Promise<VaultTrashEntry[]>;
  restoreTrashEntry?(id: string): Promise<string | null>;
  deleteTrashEntry?(id: string): Promise<boolean>;
  listAttachments?(): Promise<VaultAttachmentEntry[]>;
  deleteAttachment?(relativePath: string): Promise<boolean>;
  openAttachment?(relativePath: string): Promise<boolean>;
  revealAttachment?(relativePath: string): Promise<boolean>;
  openExternal?(url: string): Promise<boolean>;
  listFileVersions?(sourcePath: string): Promise<VaultFileVersion[]>;
  getHistoryLimit?(): Promise<number>;
  setHistoryLimit?(value: number): Promise<number>;
  restoreFileVersion?(id: string): Promise<boolean>;
  repairIntegrityIssue?(issue: VaultIntegrityIssue): Promise<boolean>;
  checkIntegrity?(): Promise<VaultIntegrityReport>;
  getAppInfo?(): Promise<OpenCanvasAppInfo>;
  onExternalChange?(callback: (event: VaultChangeEvent) => void): () => void;
}

// Compatibility names for extensions written against the prototype API.
