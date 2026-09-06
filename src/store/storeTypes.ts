import type { BoardHistory } from '../domain/history';
import type { TidyAction } from '../domain/tidyLayout';
import type { ConnectorMotionOptions } from '../domain/connectorMotion';
import type { Board, BoardConnector, BoardPlacement, CanvasTool, Card, DesktopBoardPlacement, DesktopLayout, OpenFormatImportResult, ProjectDirectory, VaultChangeEvent, Viewport, WorkspaceSnapshot } from '../types';

export type Selection =
  | { kind: 'placement'; id: string; ids?: string[] }
  | { kind: 'connector'; id: string }
  | null;

type WorkspaceView = 'desktop' | 'board';
type WorkspaceSaveState = 'saved' | 'saving' | 'error' | 'external-change';
export interface AppNotice { id: string; tone: 'info' | 'success' | 'error'; title: string; message: string; }

/** Initial geometry and optional Section membership for a new board instance. */
export interface PlacementPosition {
  x: number;
  y: number;
  sectionId?: string;
  sectionIds?: string[];
}

interface SizedPlacementPosition extends PlacementPosition {
  width?: number;
  height?: number;
}

type SectionPlacementPosition = SizedPlacementPosition;

export interface WorkspaceDataState {
  ready: boolean;
  vaultPath: string;
  cards: Card[];
  boards: Board[];
  projects: ProjectDirectory[];
  folders: string[];
  desktop: DesktopLayout;
}

export interface NavigationState {
  workspaceView: WorkspaceView;
  activeBoardId: string | null;
  boardHistory: string[];
  focusedCardId: string | null;
  focusTransitionSource: 'canvas' | 'side-panel' | null;
  sidePanelCardId: string | null;
  sidePanelOpen: boolean;
}

export interface BoardState {
  selection: Selection;
  tool: CanvasTool;
}

export interface EditorState {
  darkMode: boolean;
}

export interface FileState {
  saveState: WorkspaceSaveState;
  saveError: string | null;
  externalChangePaths: string[];
  lastSavedAt: string | null;
  pendingImport: OpenFormatImportResult | null;
}

export interface HistoryState {
  commandHistory: BoardHistory;
}

export interface NotificationState {
  notices: AppNotice[];
}

interface WorkspaceActions {
  load: () => Promise<void>;
  applySnapshot: (snapshot: WorkspaceSnapshot, preserveNavigation?: boolean) => void;
  chooseVault: () => Promise<void>;
  revealVault: () => Promise<void>;
  handleExternalVaultChange: (event: VaultChangeEvent) => Promise<void>;
  reloadFromDisk: () => Promise<void>;
  overwriteExternalChanges: () => Promise<void>;
  resolveExternalChange: (path: string, resolution: 'disk' | 'local') => Promise<void>;
  retrySaveAll: () => Promise<void>;
  flushPendingSaves: () => Promise<void>;
  createCard: (title?: string, body?: string, projectId?: string) => Card;
  createCardInFolder: (title?: string, folderPath?: string) => Card;
  createBoard: (title?: string, projectId?: string) => Board;
  createCardPlacement: (position?: SizedPlacementPosition) => BoardPlacement | null;
  createNestedBoardPlacement: (position?: SizedPlacementPosition) => BoardPlacement | null;
  organizeBoardAsProject: (boardId: string, name: string) => Promise<ProjectDirectory | null>;
  unbindBoardProject: (boardId: string) => Promise<boolean>;
  exportBoardBundle: (boardId: string) => Promise<string | null>;
  exportOpenFormat: (format: 'opencanvas-zip' | 'obsidian-canvas') => Promise<string | null>;
  importOpenFormat: () => Promise<boolean>;
  prepareOpenFormatImport: () => Promise<boolean>;
  confirmOpenFormatImport: (attachmentStrategy?: 'rename' | 'skip') => Promise<boolean>;
  cancelOpenFormatImport: () => Promise<void>;
  createFolder: (name: string, parentPath?: string) => Promise<string | null>;
  moveCardToFolder: (cardId: string, folderPath?: string) => Promise<boolean>;
  renameFolder: (folderPath: string, name: string) => Promise<boolean>;
  moveFolder: (folderPath: string, targetParent?: string) => Promise<boolean>;
  renameCardFile: (cardId: string, title: string) => Promise<boolean>;
  deleteCard: (cardId: string) => Promise<boolean>;
  deleteFolder: (folderPath: string) => Promise<boolean>;
  deleteBoard: (boardId: string) => Promise<boolean>;
  updateDesktopPlacement: (boardId: string, changes: Partial<DesktopBoardPlacement>) => void;
  updateDesktopPlacements: (changes: Record<string, Partial<DesktopBoardPlacement>>) => void;
  setDesktopViewport: (viewport: Viewport) => void;
  updateCard: (id: string, changes: Partial<Pick<Card, 'title' | 'body'>>) => void;
  renameTag: (oldTag: string, nextTag: string) => Promise<void>;
  deleteTag: (tag: string) => Promise<void>;
  updateBoard: (id: string, changes: Partial<Pick<Board, 'title'>>, options?: { mergeCreated?: boolean }) => void;
  openBoard: (id: string, remember?: boolean) => void;
  showDesktop: () => void;
  openBoardPath: (id: string, history: string[]) => void;
  goBack: () => void;
  addCardPlacement: (cardId: string, position?: SizedPlacementPosition) => BoardPlacement | null;
  addBoardPlacement: (boardId: string, position?: SizedPlacementPosition) => BoardPlacement | null;
  addTextPlacement: (position?: PlacementPosition) => BoardPlacement | null;
  addSectionPlacement: (position?: SectionPlacementPosition) => BoardPlacement | null;
  updatePlacement: (placementId: string, changes: Partial<BoardPlacement>) => void;
  updatePlacements: (changes: Record<string, Partial<BoardPlacement>>) => void;
  updateBoardLayout: (changes: Record<string, Partial<BoardPlacement>>, options?: ConnectorMotionOptions) => void;
  settleBoardLayout: (movedIds: string[]) => void;
  transferPlacementsToBoard: (targetBoardId: string, placementIds: string[], options?: { copy?: boolean }) => boolean;
  connectPlacements: (from: string, to: string, options?: Partial<Pick<BoardConnector, 'fromAnchor' | 'toAnchor'>>) => void;
  updateConnector: (connectorId: string, changes: Partial<BoardConnector>) => void;
  removeSelection: () => void;
  duplicateSelection: () => void;
  duplicateSelectionAsIndependentCards: () => void;
  convertSelectedTextToCards: () => void;
  copySelection: () => Promise<void>;
  pasteSelection: (position?: { x: number; y: number }) => Promise<void>;
  arrangeSelection: (direction: 'front' | 'back' | 'forward' | 'backward') => void;
  tidySelection: (action: TidyAction) => void;
  resetSelectionSize: () => void;
  fitSelectionToContent: (cardHeights?: Record<string, number>, cardWidths?: Record<string, number>) => Promise<void>;
  syncAutoHeightPlacements: (cardHeights: Record<string, number>) => Promise<void>;
  setCardPlacementsCollapsed: (placementIds: string[], collapsed: boolean) => Promise<void>;
  setSelectionColor: (color: string) => void;
  groupSelection: () => void;
  ungroupSelection: () => void;
  frameSelection: () => BoardPlacement | null;
  setSelectionLocked: (locked: boolean) => void;
  styleConnectorsForSelection: (changes: Partial<Pick<BoardConnector, 'color' | 'lineStyle' | 'arrow' | 'width' | 'dashed'>>) => void;
  beginBoardTransaction: (label: string) => void;
  commitBoardTransaction: () => void;
  cancelBoardTransaction: () => void;
  undo: () => void;
  redo: () => void;
  setViewport: (viewport: Viewport) => void;
  setSelection: (selection: Selection) => void;
  focusCard: (cardId: string | null, source?: 'canvas' | 'side-panel') => void;
  openCardInSidePanel: (cardId: string | null) => void;
  setTool: (tool: CanvasTool) => void;
  toggleDarkMode: () => void;
  pushNotice: (notice: Omit<AppNotice, 'id'>) => void;
  dismissNotice: (noticeId: string) => void;
}

export type WorkspaceStore = WorkspaceDataState
  & NavigationState
  & BoardState
  & EditorState
  & FileState
  & HistoryState
  & NotificationState
  & WorkspaceActions;
