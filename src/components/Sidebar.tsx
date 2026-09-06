import {
  Check,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  ClipboardCopy,
  Download,
  ExternalLink,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  History,
  Info,
  FolderKanban,
  Move,
  Pencil,
  Plus,
  Paperclip,
  Search,
  RefreshCw,
  Settings2,
  Sparkles,
  SunMoon,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { lazy, Suspense, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useWorkspaceStore } from '../store';
import { boardReferenceImpact } from '../domain/workspaceIndex';
import { IncrementalSearchIndex, searchWorkspace } from '../domain/searchIndex';
import { isComposingKeyboardEvent } from '../domain/keyboard';
import { evaluateFileTreeDrop, type FileTreeDragItem } from '../domain/fileTreeDrop';
import { edgeAutoScrollVelocity, type EdgeAutoScrollDirection } from '../domain/edgeAutoScroll';
import { buildVisibleFileTreeRows, type FileTreeVisibleRow } from '../domain/fileTreeModel';
import { fixedVirtualRange, scrollTopToRevealFixedRow } from '../domain/fixedVirtualList';
import { clampOverlayPosition } from '../domain/overlayPosition';
import { formatDiagnosticSummary } from '../domain/diagnostics';
import type { Board, Card, OpenCanvasAppInfo } from '../types';
import type { VaultAttachmentEntry, VaultFileVersion, VaultTrashEntry } from '../types';
import type { VaultIntegrityReport } from '../types';
import { isNativeVault, vaultApi } from '../vault';
import ExitPresence from './ExitPresence';
import { handleMenuKeyDown } from './menuKeyboard';
import AsyncActionButton, { useAsyncActionGate } from './AsyncActionButton';
import { CardIcon, CardPlusIcon, DesktopIcon, FilesIcon, WhiteboardIcon } from './icons/ProductIcons';

const FilePlus2 = CardPlusIcon;

const BookOpen = WhiteboardIcon;
const FileText = CardIcon;
const UserGuide = lazy(() => import('./UserGuide'));

type SearchMode = 'boards' | 'cards' | 'files';
type FileTarget = { kind: 'root' } | { kind: 'folder'; value: string } | { kind: 'card'; value: string };
type FileMenu = FileTarget & { x: number; y: number };
type RenameState = { kind: 'folder' | 'card' | 'board'; value: string; draft: string } | null;
type BoardMenu = { boardId: string; x: number; y: number } | null;
type NewItemState = { kind: 'folder' | 'card'; parentPath: string; draft: string } | null;
type MoveState = { kind: 'folder' | 'card'; value: string } | null;
type DeleteState = { kind: 'folder' | 'card'; value: string; label: string; count: number } | null;

const FILE_TREE_ROW_HEIGHT = 31;
const FILE_TREE_OVERSCAN = 8;
const ENTITY_ROW_HEIGHT = 34;
const ENTITY_LIST_OVERSCAN = 7;

type SidebarEntityRow =
  | { key: `board:${string}`; kind: 'board'; entity: Board }
  | { key: `card:${string}`; kind: 'card'; entity: Card; child: boolean };

function setDragData(event: React.DragEvent, kind: 'card' | 'board', id: string) {
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData('application/x-opencanvas-item', JSON.stringify({ kind, id }));
}

function setFileDragData(event: React.DragEvent, kind: 'card' | 'folder', value: string) {
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-opencanvas-file-item', JSON.stringify({ kind, value }));
}

function parentPath(value: string) {
  const index = value.lastIndexOf('/');
  return index < 0 ? '' : value.slice(0, index);
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export default function Sidebar() {
  const { pendingAction, runAction } = useAsyncActionGate();
  const [mode, setMode] = useState<SearchMode>('boards');
  const [query, setQuery] = useState('');
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['']));
  const [fileMenu, setFileMenu] = useState<FileMenu | null>(null);
  const [boardMenu, setBoardMenu] = useState<BoardMenu>(null);
  const [boardProjectTarget, setBoardProjectTarget] = useState<Board | null>(null);
  const [boardDeleteTarget, setBoardDeleteTarget] = useState<Board | null>(null);
  const [renameState, setRenameState] = useState<RenameState>(null);
  const [newItem, setNewItem] = useState<NewItemState>(null);
  const [moveState, setMoveState] = useState<MoveState>(null);
  const [deleteState, setDeleteState] = useState<DeleteState>(null);
  const [fileDrag, setFileDrag] = useState<{ kind: 'card' | 'folder'; value: string } | null>(null);
  const [fileDropFeedback, setFileDropFeedback] = useState<{ path: string; state: 'move' | 'noop' | 'invalid' } | null>(null);
  const [fileHoverExpandPath, setFileHoverExpandPath] = useState<string | null>(null);
  const [fileAutoScrollDirection, setFileAutoScrollDirection] = useState<EdgeAutoScrollDirection>(null);
  const [fileTreeActiveKey, setFileTreeActiveKey] = useState<string>('root');
  const [fileTreeScrollTop, setFileTreeScrollTop] = useState(0);
  const [entityListActiveKey, setEntityListActiveKey] = useState<string>('');
  const [entityListScrollTop, setEntityListScrollTop] = useState(0);
  const [sidebarListViewportHeight, setSidebarListViewportHeight] = useState(420);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [appInfo, setAppInfo] = useState<OpenCanvasAppInfo | null>(null);
  const [libraryDialog, setLibraryDialog] = useState<'trash' | 'attachments' | null>(null);
  const [trashEntries, setTrashEntries] = useState<VaultTrashEntry[]>([]);
  const [attachmentEntries, setAttachmentEntries] = useState<VaultAttachmentEntry[]>([]);
  const [permanentDeleteId, setPermanentDeleteId] = useState<string | null>(null);
  const [versionTarget, setVersionTarget] = useState<{ sourcePath: string; label: string } | null>(null);
  const [fileVersions, setFileVersions] = useState<VaultFileVersion[]>([]);
  const [historyLimit, setHistoryLimit] = useState(30);
  const [integrityReport, setIntegrityReport] = useState<VaultIntegrityReport | null>(null);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [userGuideOpen, setUserGuideOpen] = useState(false);
  const inlineInput = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const fileHoverExpandRef = useRef<{ path: string; timer: number } | null>(null);
  const fileDragPreviewRef = useRef<HTMLElement | null>(null);
  const fileAutoScrollRef = useRef<{ pointerY: number; frame: number | null }>({ pointerY: 0, frame: null });
  const fileMenuFocusReturnKeyRef = useRef<string | null>(null);
  const fileTreePendingFocusKeyRef = useRef<string | null>(null);
  const entityPendingFocusKeyRef = useRef<string | null>(null);
  const listScrollPositionsRef = useRef<Record<SearchMode, number>>({ boards: 0, cards: 0, files: 0 });
  const searchScrollSnapshotsRef = useRef<Partial<Record<SearchMode, number>>>({});
  const pendingSearchScrollRestoreRef = useRef<{ mode: SearchMode; top: number } | null>(null);
  const searchIndexRef = useRef(new IncrementalSearchIndex());
  const boards = useWorkspaceStore((state) => state.boards);
  const cards = useWorkspaceStore((state) => state.cards);
  const projects = useWorkspaceStore((state) => state.projects);
  const folders = useWorkspaceStore((state) => state.folders);
  const workspaceView = useWorkspaceStore((state) => state.workspaceView);
  const activeBoardId = useWorkspaceStore((state) => state.activeBoardId);
  const focusedCardId = useWorkspaceStore((state) => state.focusedCardId);
  const createBoard = useWorkspaceStore((state) => state.createBoard);
  const createCard = useWorkspaceStore((state) => state.createCard);
  const createCardInFolder = useWorkspaceStore((state) => state.createCardInFolder);
  const createFolder = useWorkspaceStore((state) => state.createFolder);
  const moveCardToFolder = useWorkspaceStore((state) => state.moveCardToFolder);
  const renameFolder = useWorkspaceStore((state) => state.renameFolder);
  const renameCardFile = useWorkspaceStore((state) => state.renameCardFile);
  const moveFolder = useWorkspaceStore((state) => state.moveFolder);
  const deleteCard = useWorkspaceStore((state) => state.deleteCard);
  const deleteFolder = useWorkspaceStore((state) => state.deleteFolder);
  const deleteBoard = useWorkspaceStore((state) => state.deleteBoard);
  const updateBoard = useWorkspaceStore((state) => state.updateBoard);
  const organizeBoardAsProject = useWorkspaceStore((state) => state.organizeBoardAsProject);
  const unbindBoardProject = useWorkspaceStore((state) => state.unbindBoardProject);
  const exportBoardBundle = useWorkspaceStore((state) => state.exportBoardBundle);
  const exportOpenFormat = useWorkspaceStore((state) => state.exportOpenFormat);
  const pendingImport = useWorkspaceStore((state) => state.pendingImport);
  const prepareOpenFormatImport = useWorkspaceStore((state) => state.prepareOpenFormatImport);
  const confirmOpenFormatImport = useWorkspaceStore((state) => state.confirmOpenFormatImport);
  const cancelOpenFormatImport = useWorkspaceStore((state) => state.cancelOpenFormatImport);
  const openBoard = useWorkspaceStore((state) => state.openBoard);
  const showDesktop = useWorkspaceStore((state) => state.showDesktop);
  const focusCard = useWorkspaceStore((state) => state.focusCard);
  const darkMode = useWorkspaceStore((state) => state.darkMode);
  const toggleDarkMode = useWorkspaceStore((state) => state.toggleDarkMode);
  const vaultPath = useWorkspaceStore((state) => state.vaultPath);
  const saveState = useWorkspaceStore((state) => state.saveState);
  const saveError = useWorkspaceStore((state) => state.saveError);
  const externalChangePaths = useWorkspaceStore((state) => state.externalChangePaths);
  const chooseVault = useWorkspaceStore((state) => state.chooseVault);
  const revealVault = useWorkspaceStore((state) => state.revealVault);
  const reloadFromDisk = useWorkspaceStore((state) => state.reloadFromDisk);
  const overwriteExternalChanges = useWorkspaceStore((state) => state.overwriteExternalChanges);
  const retrySaveAll = useWorkspaceStore((state) => state.retrySaveAll);
  const resolveExternalChange = useWorkspaceStore((state) => state.resolveExternalChange);
  const pushNotice = useWorkspaceStore((state) => state.pushNotice);

  const deferredQuery = useDeferredValue(query);
  const hasSearchQuery = Boolean(query.trim());
  const effectiveSearchQuery = deferredQuery.trim();
  const searchPending = query !== deferredQuery;
  const searchRecords = useMemo(() => effectiveSearchQuery ? searchIndexRef.current.update(cards, boards) : [], [boards, cards, effectiveSearchQuery]);
  const searchHits = useMemo(() => effectiveSearchQuery ? searchWorkspace(searchRecords, effectiveSearchQuery, searchRecords.length) : null, [effectiveSearchQuery, searchRecords]);
  const matchingEntityKeys = useMemo(() => searchHits ? new Set(searchHits.map((hit) => `${hit.record.kind}:${hit.record.id}`)) : null, [searchHits]);
  const visibleBoards = useMemo(() => {
    if (!searchHits) return boards;
    const byId = new Map(boards.map((board) => [board.id, board]));
    return searchHits.flatMap((hit) => hit.record.kind === 'board' && byId.has(hit.record.id) ? [byId.get(hit.record.id)!] : []);
  }, [boards, searchHits]);
  const visibleCards = useMemo(() => {
    if (!searchHits) return cards;
    const byId = new Map(cards.map((card) => [card.id, card]));
    return searchHits.flatMap((hit) => hit.record.kind === 'card' && byId.has(hit.record.id) ? [byId.get(hit.record.id)!] : []);
  }, [cards, searchHits]);
  const sidebarEntityRows = useMemo<SidebarEntityRow[]>(() => {
    if (mode !== 'files' && searchHits) {
      const boardById = new Map(boards.map((board) => [board.id, board]));
      const cardById = new Map(cards.map((card) => [card.id, card]));
      return searchHits.flatMap((hit): SidebarEntityRow[] => {
        if (hit.record.kind === 'board') {
          const board = boardById.get(hit.record.id);
          return board ? [{ key: `board:${board.id}`, kind: 'board', entity: board }] : [];
        }
        const card = cardById.get(hit.record.id);
        return card ? [{ key: `card:${card.id}`, kind: 'card', entity: card, child: false }] : [];
      });
    }
    if (mode === 'cards') return visibleCards.map((card) => ({ key: `card:${card.id}` as const, kind: 'card' as const, entity: card, child: false }));
    if (mode !== 'boards') return [];
    const rows: SidebarEntityRow[] = visibleBoards.map((board) => ({ key: `board:${board.id}` as const, kind: 'board' as const, entity: board }));
    const focusedCard = focusedCardId ? cards.find((card) => card.id === focusedCardId) : undefined;
    if (focusedCard && (!matchingEntityKeys || matchingEntityKeys.has(`card:${focusedCard.id}`))) rows.push({ key: `card:${focusedCard.id}`, kind: 'card', entity: focusedCard, child: true });
    return rows;
  }, [boards, cards, focusedCardId, matchingEntityKeys, mode, searchHits, visibleBoards, visibleCards]);
  const entityListRange = fixedVirtualRange(sidebarEntityRows.length, ENTITY_ROW_HEIGHT, sidebarListViewportHeight, entityListScrollTop, ENTITY_LIST_OVERSCAN);
  const renderedEntityRows = sidebarEntityRows.slice(entityListRange.start, entityListRange.end);
  const knownFolders = useMemo(() => {
    const result = new Set<string>([...folders, ...projects.map((project) => project.relativePath)]);
    for (const card of cards) {
      let current = parentPath(card.relativePath);
      while (current) { result.add(current); current = parentPath(current); }
    }
    for (const folder of [...result]) {
      let current = parentPath(folder);
      while (current) { result.add(current); current = parentPath(current); }
    }
    return [...result].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }, [cards, folders, projects]);
  const projectFolderPaths = useMemo(() => new Set(projects.map((project) => project.relativePath)), [projects]);
  const fileTreeRows = useMemo(() => buildVisibleFileTreeRows({
    folders: knownFolders,
    cards: visibleCards,
    expandedFolders,
    projectFolders: projectFolderPaths,
    searchQuery: effectiveSearchQuery,
    newItem: newItem ? { kind: newItem.kind, parentPath: newItem.parentPath } : null,
  }), [effectiveSearchQuery, expandedFolders, knownFolders, newItem, projectFolderPaths, visibleCards]);
  const fileTreeRange = fixedVirtualRange(fileTreeRows.length, FILE_TREE_ROW_HEIGHT, sidebarListViewportHeight, fileTreeScrollTop, FILE_TREE_OVERSCAN);
  const renderedFileTreeRows = fileTreeRows.slice(fileTreeRange.start, fileTreeRange.end);

  const revealFileTreeIndex = (index: number) => {
    const viewport = tabListRef.current;
    if (!viewport || index < 0) return;
    const next = scrollTopToRevealFixedRow(index, FILE_TREE_ROW_HEIGHT, viewport.clientHeight, viewport.scrollTop);
    if (Math.abs(next - viewport.scrollTop) > .5) viewport.scrollTop = next;
    setFileTreeScrollTop(next);
  };

  const focusFileTreeIndex = (index: number) => {
    if (index < 0 || index >= fileTreeRows.length) return;
    const row = fileTreeRows[index];
    fileTreePendingFocusKeyRef.current = row.key;
    setFileTreeActiveKey(row.key);
    revealFileTreeIndex(index);
  };

  const revealEntityIndex = (index: number) => {
    const viewport = tabListRef.current;
    if (!viewport || index < 0) return;
    const next = scrollTopToRevealFixedRow(index, ENTITY_ROW_HEIGHT, viewport.clientHeight, viewport.scrollTop);
    if (Math.abs(next - viewport.scrollTop) > .5) viewport.scrollTop = next;
    setEntityListScrollTop(next);
  };

  const focusEntityIndex = (index: number) => {
    if (index < 0 || index >= sidebarEntityRows.length) return;
    const row = sidebarEntityRows[index];
    entityPendingFocusKeyRef.current = row.key;
    setEntityListActiveKey(row.key);
    revealEntityIndex(index);
  };

  useEffect(() => { setExpandedFolders((current) => new Set([...current, ...projects.map((project) => project.relativePath)])); }, [projects]);
  useEffect(() => {
    if (mode === 'files') return;
    if (fileAutoScrollRef.current.frame !== null) window.cancelAnimationFrame(fileAutoScrollRef.current.frame);
    fileAutoScrollRef.current.frame = null;
    setFileAutoScrollDirection(null);
  }, [mode]);
  useEffect(() => () => {
    if (fileHoverExpandRef.current) window.clearTimeout(fileHoverExpandRef.current.timer);
    if (fileAutoScrollRef.current.frame !== null) window.cancelAnimationFrame(fileAutoScrollRef.current.frame);
  }, []);
  useLayoutEffect(() => {
    const viewport = tabListRef.current;
    if (!viewport) return;
    const restored = listScrollPositionsRef.current[mode] ?? 0;
    viewport.scrollTop = restored;
    if (mode === 'files') setFileTreeScrollTop(restored); else setEntityListScrollTop(restored);
  }, [mode]);
  useLayoutEffect(() => {
    const pending = pendingSearchScrollRestoreRef.current;
    if (!pending || pending.mode !== mode || hasSearchQuery || effectiveSearchQuery) return;
    const viewport = tabListRef.current;
    if (!viewport) return;
    viewport.scrollTop = pending.top;
    listScrollPositionsRef.current[mode] = pending.top;
    if (mode === 'files') setFileTreeScrollTop(pending.top); else setEntityListScrollTop(pending.top);
    pendingSearchScrollRestoreRef.current = null;
  }, [effectiveSearchQuery, fileTreeRows.length, hasSearchQuery, mode, sidebarEntityRows.length]);
  useEffect(() => {
    const viewport = tabListRef.current;
    if (!viewport) return;
    const update = () => setSidebarListViewportHeight(viewport.clientHeight || 420);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [mode]);
  useEffect(() => {
    if (!fileTreeRows.some((row) => row.key === fileTreeActiveKey)) setFileTreeActiveKey('root');
  }, [fileTreeActiveKey, fileTreeRows]);
  useLayoutEffect(() => {
    if (mode === 'files') return;
    const preferred = focusedCardId ? `card:${focusedCardId}` : mode === 'boards' && activeBoardId ? `board:${activeBoardId}` : '';
    const next = sidebarEntityRows.some((row) => row.key === entityListActiveKey) ? entityListActiveKey
      : sidebarEntityRows.some((row) => row.key === preferred) ? preferred
        : sidebarEntityRows[0]?.key ?? '';
    if (next !== entityListActiveKey) setEntityListActiveKey(next);
  }, [activeBoardId, entityListActiveKey, focusedCardId, mode, sidebarEntityRows]);
  useEffect(() => {
    if (mode === 'files') return;
    const preferred = focusedCardId ? `card:${focusedCardId}` : mode === 'boards' && activeBoardId ? `board:${activeBoardId}` : '';
    const index = sidebarEntityRows.findIndex((row) => row.key === preferred);
    if (index < 0) return;
    setEntityListActiveKey(preferred);
    revealEntityIndex(index);
  // Entity identity changes are the signal; scrolling does not retrigger it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBoardId, focusedCardId, mode]);
  useLayoutEffect(() => {
    const pendingKey = fileTreePendingFocusKeyRef.current;
    if (!pendingKey) return;
    const target = tabListRef.current?.querySelector<HTMLElement>(`[data-tree-key="${CSS.escape(pendingKey)}"]`);
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    fileTreePendingFocusKeyRef.current = null;
  }, [fileTreeActiveKey, fileTreeRange.end, fileTreeRange.start]);
  useLayoutEffect(() => {
    const pendingKey = entityPendingFocusKeyRef.current;
    if (!pendingKey) return;
    const target = tabListRef.current?.querySelector<HTMLElement>(`[data-entity-key="${CSS.escape(pendingKey)}"]`);
    if (!target) return;
    target.focus({ preventScroll: true });
    entityPendingFocusKeyRef.current = null;
  }, [entityListActiveKey, entityListRange.end, entityListRange.start]);
  useEffect(() => {
    if (mode !== 'files' || !focusedCardId) return;
    const key = `card:${focusedCardId}`;
    const index = fileTreeRows.findIndex((row) => row.key === key);
    if (index >= 0) { setFileTreeActiveKey(key); revealFileTreeIndex(index); }
  // Focused card identity is the navigation signal; viewport dimensions do not
  // need to retrigger this reveal.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedCardId, mode]);
  useEffect(() => {
    if (!renameState && !newItem) return;
    const key = renameState?.kind === 'folder' ? `folder:${renameState.value}`
      : renameState?.kind === 'card' ? `card:${renameState.value}`
        : newItem ? `new:${newItem.kind}:${newItem.parentPath}` : '';
    const index = fileTreeRows.findIndex((row) => row.key === key);
    if (mode === 'files' && index >= 0) revealFileTreeIndex(index);
    if (mode !== 'files') {
      const entityIndex = sidebarEntityRows.findIndex((row) => row.key === key);
      if (entityIndex >= 0) revealEntityIndex(entityIndex);
    }
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => inlineInput.current?.select()));
  // The model update caused by rename/new item is sufficient.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameState, newItem]);
  useEffect(() => {
    if (!fileMenu) return;
    const dismiss = (event: PointerEvent) => {
      if ((event.target as HTMLElement | null)?.closest('.file-context-menu')) return;
      fileMenuFocusReturnKeyRef.current = null;
      setFileMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (isComposingKeyboardEvent(event) || event.key !== 'Escape') return;
      const returnKey = fileMenuFocusReturnKeyRef.current;
      fileMenuFocusReturnKeyRef.current = null;
      setFileMenu(null);
      if (returnKey) window.requestAnimationFrame(() => tabListRef.current?.querySelector<HTMLElement>(`[data-tree-key="${CSS.escape(returnKey)}"], [data-entity-key="${CSS.escape(returnKey)}"]`)?.focus({ preventScroll: true }));
    };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', dismiss); window.removeEventListener('keydown', escape); };
  }, [fileMenu]);
  useEffect(() => {
    if (!boardMenu) return;
    const dismiss = (event: PointerEvent) => { if (!(event.target as HTMLElement | null)?.closest('.board-list-context-menu')) setBoardMenu(null); };
    const escape = (event: KeyboardEvent) => { if (!isComposingKeyboardEvent(event) && event.key === 'Escape') setBoardMenu(null); };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', dismiss); window.removeEventListener('keydown', escape); };
  }, [boardMenu]);
  useEffect(() => {
    if (!workspaceMenuOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!(event.target as HTMLElement | null)?.closest('.workspace-vault-menu, .vault-status-button')) setWorkspaceMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (!isComposingKeyboardEvent(event) && event.key === 'Escape') setWorkspaceMenuOpen(false); };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', dismiss); window.removeEventListener('keydown', escape); };
  }, [workspaceMenuOpen]);
  useEffect(() => {
    if (libraryDialog === 'trash') void vaultApi.listTrash?.().then(setTrashEntries);
    if (libraryDialog === 'attachments') void vaultApi.listAttachments?.().then(setAttachmentEntries);
  }, [libraryDialog]);
  useEffect(() => {
    if (!shortcutHelpOpen) return;
    const close = (event: KeyboardEvent) => { if (!isComposingKeyboardEvent(event) && event.key === 'Escape') setShortcutHelpOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [shortcutHelpOpen]);
  useEffect(() => {
    const openGuide = () => setUserGuideOpen(true);
    window.addEventListener('opencanvas:open-user-guide', openGuide);
    return () => window.removeEventListener('opencanvas:open-user-guide', openGuide);
  }, []);
  useEffect(() => {
    if (!aboutOpen) return;
    void vaultApi.getAppInfo?.().then(setAppInfo);
    const close = (event: KeyboardEvent) => { if (!isComposingKeyboardEvent(event) && event.key === 'Escape') setAboutOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [aboutOpen]);
  useEffect(() => {
    if (!settingsOpen) return;
    void vaultApi.getHistoryLimit?.().then(setHistoryLimit);
    const close = (event: KeyboardEvent) => { if (!isComposingKeyboardEvent(event) && event.key === 'Escape') setSettingsOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [settingsOpen]);
  useEffect(() => {
    if (versionTarget) {
      void vaultApi.listFileVersions?.(versionTarget.sourcePath).then(setFileVersions);
      void vaultApi.getHistoryLimit?.().then(setHistoryLimit);
    }
  }, [versionTarget]);

  const openFileMenuAt = (target: FileTarget, x: number, y: number, returnFocusKey: string | null = null) => {
    const position = clampOverlayPosition({ x, y, width: 235, height: 350, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
    fileMenuFocusReturnKeyRef.current = returnFocusKey;
    setFileMenu({ ...target, x: position.x, y: position.y });
  };
  const openFileMenu = (event: React.MouseEvent, target: FileTarget) => {
    event.preventDefault();
    event.stopPropagation();
    openFileMenuAt(target, event.clientX, event.clientY);
  };
  const openBoardMenuAt = (boardId: string, x: number, y: number) => {
    const position = clampOverlayPosition({ x, y, width: 230, height: 280, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
    setBoardMenu({ boardId, x: position.x, y: position.y });
  };
  const openBoardMenu = (event: React.MouseEvent, boardId: string) => {
    event.preventDefault();
    event.stopPropagation();
    openBoardMenuAt(boardId, event.clientX, event.clientY);
  };
  const createCurrent = () => {
    if (mode === 'boards') { const board = createBoard('未命名白板'); openBoard(board.id); }
    else if (mode === 'cards') { const card = createCard('未命名卡片'); focusCard(card.id); }
    else { setQuery(''); setNewItem({ kind: 'folder', parentPath: '', draft: '新建文件夹' }); }
  };
  const resolveFileDragItem = (payload: { kind?: string; value?: string }): FileTreeDragItem | null => {
    if (payload.kind === 'folder' && payload.value) return { kind: 'folder', path: payload.value };
    if (payload.kind === 'card' && payload.value) {
      const card = cards.find((item) => item.id === payload.value);
      return card ? { kind: 'card', path: card.relativePath } : null;
    }
    return null;
  };
  const beginFileDrag = (event: React.DragEvent, kind: 'card' | 'folder', value: string) => {
    setFileDragData(event, kind, value);
    fileDragPreviewRef.current?.remove();
    const preview = document.createElement('div');
    const label = kind === 'card'
      ? cards.find((item) => item.id === value)?.title || '未命名卡片'
      : value.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || '文件夹';
    preview.className = 'file-drag-preview';
    preview.dataset.kind = kind;
    preview.setAttribute('aria-hidden', 'true');
    preview.textContent = label;
    (document.querySelector('.app-shell') ?? document.body).append(preview);
    fileDragPreviewRef.current = preview;
    try { event.dataTransfer.setDragImage(preview, 18, 16); } catch { /* Synthetic drags may not implement a custom image. */ }
    setFileDrag({ kind, value });
  };
  const clearFileHoverExpand = () => {
    if (fileHoverExpandRef.current) window.clearTimeout(fileHoverExpandRef.current.timer);
    fileHoverExpandRef.current = null;
    setFileHoverExpandPath(null);
  };
  const stopFileAutoScroll = () => {
    if (fileAutoScrollRef.current.frame !== null) window.cancelAnimationFrame(fileAutoScrollRef.current.frame);
    fileAutoScrollRef.current.frame = null;
    setFileAutoScrollDirection(null);
  };
  const updateFileAutoScroll = (pointerY: number) => {
    const viewport = tabListRef.current;
    if (!viewport || mode !== 'files') return;
    fileAutoScrollRef.current.pointerY = pointerY;
    const initial = edgeAutoScrollVelocity(pointerY, viewport.getBoundingClientRect().top, viewport.getBoundingClientRect().bottom);
    setFileAutoScrollDirection((current) => current === initial.direction ? current : initial.direction);
    if (!initial.direction) {
      if (fileAutoScrollRef.current.frame !== null) window.cancelAnimationFrame(fileAutoScrollRef.current.frame);
      fileAutoScrollRef.current.frame = null;
      return;
    }
    if (fileAutoScrollRef.current.frame !== null) return;
    const step = () => {
      const currentViewport = tabListRef.current;
      if (!currentViewport) { stopFileAutoScroll(); return; }
      const rect = currentViewport.getBoundingClientRect();
      const result = edgeAutoScrollVelocity(fileAutoScrollRef.current.pointerY, rect.top, rect.bottom);
      if (!result.direction) { stopFileAutoScroll(); return; }
      const previous = currentViewport.scrollTop;
      currentViewport.scrollTop += result.velocity;
      if (Math.abs(currentViewport.scrollTop - previous) < .1) { stopFileAutoScroll(); return; }
      fileAutoScrollRef.current.frame = window.requestAnimationFrame(step);
    };
    fileAutoScrollRef.current.frame = window.requestAnimationFrame(step);
  };
  const clearFileDrag = () => {
    clearFileHoverExpand();
    stopFileAutoScroll();
    fileDragPreviewRef.current?.remove();
    fileDragPreviewRef.current = null;
    setFileDrag(null);
    setFileDropFeedback(null);
  };
  const handleFileDragOver = (event: React.DragEvent, folderPath = '') => {
    event.preventDefault();
    event.stopPropagation();
    const item = fileDrag ? resolveFileDragItem(fileDrag) : null;
    if (!item) return;
    const evaluation = evaluateFileTreeDrop(item, folderPath, knownFolders);
    event.dataTransfer.dropEffect = evaluation.state === 'move' ? 'move' : 'none';
    setFileDropFeedback((current) => current?.path === folderPath && current.state === evaluation.state ? current : { path: folderPath, state: evaluation.state });
    if (folderPath && evaluation.state === 'move' && !expandedFolders.has(folderPath) && !query.trim()) {
      if (fileHoverExpandRef.current?.path !== folderPath) {
        clearFileHoverExpand();
        setFileHoverExpandPath(folderPath);
        const timer = window.setTimeout(() => {
          toggleFolder(folderPath, true);
          fileHoverExpandRef.current = null;
          setFileHoverExpandPath(null);
        }, 560);
        fileHoverExpandRef.current = { path: folderPath, timer };
      }
    } else if (fileHoverExpandRef.current?.path !== folderPath) clearFileHoverExpand();
  };
  const handleFileDrop = async (event: React.DragEvent, folderPath = '') => {
    event.preventDefault();
    event.stopPropagation();
    try {
      const payload = JSON.parse(event.dataTransfer.getData('application/x-opencanvas-file-item')) as { kind?: string; value?: string };
      const item = resolveFileDragItem(payload);
      if (!item) return;
      const evaluation = evaluateFileTreeDrop(item, folderPath, knownFolders);
      if (evaluation.state === 'invalid') {
        pushNotice({ tone: 'info', title: '无法移动到这里', message: evaluation.message });
        return;
      }
      if (evaluation.state === 'noop') return;
      const moved = payload.kind === 'card' && payload.value
        ? await moveCardToFolder(payload.value, folderPath)
        : payload.kind === 'folder' && payload.value
          ? await moveFolder(payload.value, folderPath)
          : false;
      if (!moved) pushNotice({ tone: 'info', title: '文件没有移动', message: '目标位置可能存在同名项目，请换一个目录或先重命名。' });
    } catch { /* Ignore unrelated drags. */ }
    finally { clearFileDrag(); }
  };
  const toggleFolder = (folderPath: string, force?: boolean) => setExpandedFolders((current) => {
    const next = new Set(current);
    const expanded = force ?? !next.has(folderPath);
    if (expanded) next.add(folderPath); else next.delete(folderPath);
    return next;
  });
  const finishRename = async (save: boolean) => {
    const current = renameState;
    setRenameState(null);
    if (!save || !current?.draft.trim()) return;
    if (current.kind === 'folder') {
      if (!await renameFolder(current.value, current.draft.trim())) pushNotice({ tone: 'info', title: '没有完成重命名', message: '同一目录中已有同名文件夹，或名称无法使用。' });
    }
    else if (current.kind === 'card') {
      if (!await renameCardFile(current.value, current.draft.trim())) pushNotice({ tone: 'info', title: '没有完成重命名', message: '文件名称无法使用。' });
    }
    else updateBoard(current.value, { title: current.draft.trim() });
  };
  const finishNewItem = async (save: boolean) => {
    const current = newItem;
    setNewItem(null);
    if (!save || !current?.draft.trim()) return;
    if (current.kind === 'folder') {
      const path = await createFolder(current.draft.trim(), current.parentPath);
      if (path) toggleFolder(current.parentPath, true);
      else pushNotice({ tone: 'info', title: '没有新建文件夹', message: '同一目录中已有同名文件夹，或名称无法使用。' });
    } else {
      const card = createCardInFolder(current.draft.trim(), current.parentPath);
      toggleFolder(current.parentPath, true);
      focusCard(card.id);
    }
  };
  useEffect(() => {
    if (!renameState && !newItem) return;
    const finishOutside = (event: PointerEvent) => {
      if ((event.target as HTMLElement | null)?.closest('.file-inline-input')) return;
      const value = inlineInput.current?.value.trim() ?? '';
      if (renameState) {
        const current = renameState;
        setRenameState(null);
        if (value) {
          if (current.kind === 'folder') void renameFolder(current.value, value).then((renamed) => { if (!renamed) pushNotice({ tone: 'info', title: '没有完成重命名', message: '同一目录中已有同名文件夹，或名称无法使用。' }); });
          else if (current.kind === 'card') void renameCardFile(current.value, value).then((renamed) => { if (!renamed) pushNotice({ tone: 'info', title: '没有完成重命名', message: '文件名称无法使用。' }); });
          else updateBoard(current.value, { title: value });
        }
      } else if (newItem) {
        const current = newItem;
        setNewItem(null);
        if (value) {
          if (current.kind === 'folder') void createFolder(value, current.parentPath).then((path) => { if (path) toggleFolder(current.parentPath, true); else pushNotice({ tone: 'info', title: '没有新建文件夹', message: '同一目录中已有同名文件夹，或名称无法使用。' }); });
          else {
            const card = createCardInFolder(value, current.parentPath);
            toggleFolder(current.parentPath, true);
            focusCard(card.id);
          }
        }
      }
    };
    window.addEventListener('pointerdown', finishOutside, true);
    return () => window.removeEventListener('pointerdown', finishOutside, true);
  }, [createCardInFolder, createFolder, focusCard, newItem, pushNotice, renameCardFile, renameFolder, renameState, updateBoard]);
  const beginRename = (target: FileTarget) => {
    setFileMenu(null);
    if (target.kind === 'folder') {
      setFileTreeActiveKey(`folder:${target.value}`);
      setRenameState({ kind: 'folder', value: target.value, draft: target.value.split('/').at(-1) ?? target.value });
    }
    if (target.kind === 'card') {
      const card = cards.find((item) => item.id === target.value);
      if (card) {
        if (mode === 'files') setFileTreeActiveKey(`card:${card.id}`); else setEntityListActiveKey(`card:${card.id}`);
        setRenameState({ kind: 'card', value: card.id, draft: card.title || card.fileName.replace(/\.md$/i, '') });
      }
    }
  };
  const requestDelete = (target: FileTarget) => {
    setFileMenu(null);
    if (target.kind === 'card') {
      const card = cards.find((item) => item.id === target.value);
      if (card) setDeleteState({ kind: 'card', value: card.id, label: card.title || card.fileName, count: 1 });
    }
    if (target.kind === 'folder') {
      const count = cards.filter((card) => parentPath(card.relativePath) === target.value || parentPath(card.relativePath).startsWith(`${target.value}/`)).length;
      setDeleteState({ kind: 'folder', value: target.value, label: target.value.split('/').at(-1) ?? target.value, count });
    }
  };
  const inlineEditor = (kind: 'folder' | 'card' | 'board', value: string, depth: number) => {
    const state = renameState?.kind === kind && renameState.value === value ? renameState : null;
    return state ? <input
      ref={inlineInput}
      className="file-inline-input"
      style={{ '--file-depth': depth } as React.CSSProperties}
      value={state.draft}
      aria-label={kind === 'folder' ? '重命名文件夹' : kind === 'board' ? '重命名白板' : '重命名文件'}
      onChange={(event) => setRenameState({ ...state, draft: event.target.value })}
      onBlur={() => void finishRename(true)}
      onKeyDown={(event) => {
        if (isComposingKeyboardEvent(event.nativeEvent)) return;
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') { event.preventDefault(); void finishRename(false); }
      }}
    /> : null;
  };

  const bindPendingEntityFocus = (key: string) => (element: HTMLElement | null) => {
    if (!element || entityPendingFocusKeyRef.current !== key) return;
    element.focus({ preventScroll: true });
    entityPendingFocusKeyRef.current = null;
  };

  const activateEntityRow = (row: SidebarEntityRow) => {
    setEntityListActiveKey(row.key);
    if (row.kind === 'board') openBoard(row.entity.id); else focusCard(row.entity.id);
  };

  const handleEntityListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isComposingKeyboardEvent(event.nativeEvent) || (event.target as HTMLElement | null)?.closest('input, textarea')) return;
    if (!sidebarEntityRows.length) return;
    const activeIndex = Math.max(0, sidebarEntityRows.findIndex((row) => row.key === entityListActiveKey));
    const active = sidebarEntityRows[activeIndex];
    let nextIndex: number | null = null;
    if (event.key === 'ArrowDown') nextIndex = Math.min(sidebarEntityRows.length - 1, activeIndex + 1);
    if (event.key === 'ArrowUp') nextIndex = Math.max(0, activeIndex - 1);
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = sidebarEntityRows.length - 1;
    const page = Math.max(1, Math.floor(sidebarListViewportHeight / ENTITY_ROW_HEIGHT) - 1);
    if (event.key === 'PageDown') nextIndex = Math.min(sidebarEntityRows.length - 1, activeIndex + page);
    if (event.key === 'PageUp') nextIndex = Math.max(0, activeIndex - page);
    if (nextIndex !== null) {
      event.preventDefault();
      focusEntityIndex(nextIndex);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activateEntityRow(active);
      return;
    }
    if (event.key === 'F2') {
      event.preventDefault();
      if (active.kind === 'board') {
        setEntityListActiveKey(active.key);
        setRenameState({ kind: 'board', value: active.entity.id, draft: active.entity.title });
      } else beginRename({ kind: 'card', value: active.entity.id });
      return;
    }
    if (event.key === 'Delete') {
      event.preventDefault();
      if (active.kind === 'board') setBoardDeleteTarget(active.entity);
      else requestDelete({ kind: 'card', value: active.entity.id });
      return;
    }
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const element = tabListRef.current?.querySelector<HTMLElement>(`[data-entity-key="${CSS.escape(active.key)}"]`);
      const rect = element?.getBoundingClientRect();
      if (active.kind === 'board') openBoardMenuAt(active.entity.id, rect?.left ?? 10, rect ? rect.bottom - 3 : 10);
      else openFileMenuAt({ kind: 'card', value: active.entity.id }, rect?.left ?? 10, rect ? rect.bottom - 3 : 10, active.key);
    }
  };

  const renderEntityRow = (row: SidebarEntityRow, index: number) => {
    const current = entityListActiveKey === row.key;
    const renaming = renameState?.kind === row.kind && renameState.value === row.entity.id;
    const selected = row.kind === 'board'
      ? workspaceView === 'board' && row.entity.id === activeBoardId && !focusedCardId
      : row.entity.id === focusedCardId;
    const className = `sidebar-entity-row entity-${row.kind} ${row.kind === 'card' && row.child ? 'child-card-tab' : ''} ${selected ? 'active' : ''} ${current ? 'list-current' : ''}`;
    const shared = {
      ref: bindPendingEntityFocus(row.key),
      role: 'option',
      'aria-selected': selected,
      'aria-posinset': index + 1,
      'aria-setsize': sidebarEntityRows.length,
      'data-entity-key': row.key,
      tabIndex: current ? 0 : -1,
      style: { transform: `translateY(${index * ENTITY_ROW_HEIGHT}px)` },
      onFocus: () => setEntityListActiveKey(row.key),
      onPointerDown: () => setEntityListActiveKey(row.key),
      onContextMenu: (event: React.MouseEvent) => row.kind === 'board' ? openBoardMenu(event, row.entity.id) : openFileMenu(event, { kind: 'card', value: row.entity.id }),
    };
    const content = <>{row.kind === 'board' ? <WhiteboardIcon size={15} /> : <CardIcon size={15} />}{renaming ? inlineEditor(row.kind, row.entity.id, 0) : <span>{row.entity.title || (row.kind === 'card' ? '未命名卡片' : '未命名白板')}</span>}</>;
    if (renaming) return <div key={row.key} {...shared} className={`${className} is-renaming`}>{content}</div>;
    return <button
      key={row.key}
      {...shared}
      className={className}
      draggable
      onClick={() => activateEntityRow(row)}
      onDragStart={(event) => setDragData(event, row.kind, row.entity.id)}
    >{content}</button>;
  };

  const fileTargetForRow = (row: FileTreeVisibleRow): FileTarget | null => row.kind === 'root' ? { kind: 'root' }
    : row.kind === 'folder' ? { kind: 'folder', value: row.path }
      : row.kind === 'card' ? { kind: 'card', value: row.card.id } : null;

  const bindPendingFileTreeFocus = (key: string) => (element: HTMLElement | null) => {
    if (!element || fileTreePendingFocusKeyRef.current !== key) return;
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    fileTreePendingFocusKeyRef.current = null;
  };

  const activateFileTreeRow = (row: FileTreeVisibleRow) => {
    setFileTreeActiveKey(row.key);
    if (row.kind === 'root') toggleFolder('');
    if (row.kind === 'folder') toggleFolder(row.path);
    if (row.kind === 'card') focusCard(row.card.id);
  };

  const handleFileTreeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isComposingKeyboardEvent(event.nativeEvent) || (event.target as HTMLElement | null)?.closest('input, textarea')) return;
    const activeIndex = Math.max(0, fileTreeRows.findIndex((row) => row.key === fileTreeActiveKey));
    const active = fileTreeRows[activeIndex];
    if (!active) return;
    let nextIndex: number | null = null;
    if (event.key === 'ArrowDown') nextIndex = Math.min(fileTreeRows.length - 1, activeIndex + 1);
    if (event.key === 'ArrowUp') nextIndex = Math.max(0, activeIndex - 1);
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = fileTreeRows.length - 1;
    if (event.key === 'PageDown') nextIndex = Math.min(fileTreeRows.length - 1, activeIndex + Math.max(1, Math.floor(sidebarListViewportHeight / FILE_TREE_ROW_HEIGHT) - 1));
    if (event.key === 'PageUp') nextIndex = Math.max(0, activeIndex - Math.max(1, Math.floor(sidebarListViewportHeight / FILE_TREE_ROW_HEIGHT) - 1));
    if (event.key === 'ArrowRight') {
      if (active.kind === 'root') {
        if (!active.expanded) toggleFolder('', true);
        else nextIndex = Math.min(fileTreeRows.length - 1, activeIndex + 1);
      }
      else if (active.kind === 'folder') {
        if (!active.expanded) toggleFolder(active.path, true);
        else if (fileTreeRows[activeIndex + 1]?.parentKey === active.key) nextIndex = activeIndex + 1;
      }
    }
    if (event.key === 'ArrowLeft') {
      if (active.kind === 'root' && active.expanded && !query.trim()) toggleFolder('', false);
      else if (active.kind === 'folder' && active.expanded && !query.trim()) toggleFolder(active.path, false);
      else if (active.parentKey) nextIndex = fileTreeRows.findIndex((row) => row.key === active.parentKey);
    }
    if (nextIndex !== null && nextIndex >= 0) {
      event.preventDefault();
      focusFileTreeIndex(nextIndex);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activateFileTreeRow(active);
      return;
    }
    const target = fileTargetForRow(active);
    if (event.key === 'F2' && target && target.kind !== 'root') {
      event.preventDefault();
      beginRename(target);
      return;
    }
    if (event.key === 'Delete' && target && target.kind !== 'root') {
      event.preventDefault();
      requestDelete(target);
      return;
    }
    if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) && target) {
      event.preventDefault();
      const rowElement = tabListRef.current?.querySelector<HTMLElement>(`[data-tree-key="${CSS.escape(active.key)}"]`);
      const rect = rowElement?.getBoundingClientRect();
      openFileMenuAt(target, rect?.left ?? 10, rect ? rect.bottom - 3 : 10, active.key);
    }
  };

  const renderFileTreeRow = (row: FileTreeVisibleRow, index: number) => {
    const positionStyle = { '--file-depth': row.depth, transform: `translateY(${index * FILE_TREE_ROW_HEIGHT}px)` } as React.CSSProperties;
    const current = fileTreeActiveKey === row.key;
    if (row.kind === 'root') return <div
      className={`file-tree-root file-tree-virtual-row ${current ? 'tree-current' : ''} ${fileDropFeedback?.path === '' ? `file-drop-${fileDropFeedback.state}` : ''}`}
      data-drop-label={fileDropFeedback?.path === '' ? fileDropFeedback.state === 'move' ? '移到这里' : fileDropFeedback.state === 'noop' ? '已在这里' : '不能移动' : undefined}
      key={row.key}
      role="treeitem"
      aria-level={1}
      aria-posinset={row.posInSet}
      aria-setsize={row.setSize}
      aria-expanded={row.expanded}
      aria-selected={current}
      data-tree-key={row.key}
      ref={bindPendingFileTreeFocus(row.key)}
      tabIndex={current ? 0 : -1}
      style={positionStyle}
      onFocus={() => setFileTreeActiveKey(row.key)}
      onPointerDown={() => setFileTreeActiveKey(row.key)}
      onClick={() => toggleFolder('')}
      onDragOver={(event) => handleFileDragOver(event, '')}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { clearFileHoverExpand(); setFileDropFeedback(null); } }}
      onDrop={(event) => void handleFileDrop(event, '')}
      onContextMenu={(event) => openFileMenu(event, { kind: 'root' })}
    ><ChevronRight className={`file-chevron ${row.expanded ? 'expanded' : ''} ${row.hasChildren ? '' : 'empty'}`} size={13} />{row.expanded ? <FolderOpen size={15} /> : <Folder size={15} />}<span>Notes</span><small>{cards.length}</small></div>;

    if (row.kind === 'new') return <div className="file-tree-row file-tree-virtual-row file-new-item-row" key={row.key} role="none" style={positionStyle}>
      <span className="file-tree-indent-guides" aria-hidden="true" />
      {row.itemKind === 'folder' ? <Folder size={14} /> : <CardIcon size={14} />}
      {newItem && <input ref={inlineInput} className="file-inline-input" value={newItem.draft} aria-label={newItem.kind === 'folder' ? '新建文件夹名称' : '新建文件名称'} onChange={(event) => setNewItem({ ...newItem, draft: event.target.value })} onBlur={() => void finishNewItem(true)} onKeyDown={(event) => { if (isComposingKeyboardEvent(event.nativeEvent)) return; if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { event.preventDefault(); void finishNewItem(false); } }} />}
    </div>;

    if (row.kind === 'folder') {
      const renaming = renameState?.kind === 'folder' && renameState.value === row.path;
      const content = <>
        <ChevronRight className={`file-chevron ${row.expanded ? 'expanded' : ''} ${row.hasChildren ? '' : 'empty'}`} size={12} />
        {row.expanded ? <FolderOpen size={15} /> : <Folder size={15} />}
        {renaming ? inlineEditor('folder', row.path, row.depth) : <span>{row.label}</span>}
        {row.project && <small>项目</small>}
      </>;
      return <div
        className={`file-tree-row file-tree-virtual-row file-folder-row ${row.project ? 'is-project' : ''} ${current ? 'tree-current' : ''} ${fileDrag?.kind === 'folder' && fileDrag.value === row.path ? 'is-dragging' : ''} ${fileDropFeedback?.path === row.path ? `file-drop-${fileDropFeedback.state}` : ''} ${fileHoverExpandPath === row.path ? 'file-drop-expand-pending' : ''}`}
        data-drop-label={fileDropFeedback?.path === row.path ? fileDropFeedback.state === 'move' ? '移到这里' : fileDropFeedback.state === 'noop' ? '已在这里' : '不能移动' : undefined}
        key={row.key}
        role="treeitem"
        aria-level={row.depth + 2}
        aria-posinset={row.posInSet}
        aria-setsize={row.setSize}
        aria-expanded={row.expanded}
        aria-selected={current}
        data-tree-key={row.key}
        ref={bindPendingFileTreeFocus(row.key)}
        tabIndex={current ? 0 : -1}
        style={positionStyle}
        draggable={!renaming}
        onFocus={() => setFileTreeActiveKey(row.key)}
        onPointerDown={() => setFileTreeActiveKey(row.key)}
        onDragStart={(event) => beginFileDrag(event, 'folder', row.path)}
        onDragEnd={clearFileDrag}
        onDragOver={(event) => handleFileDragOver(event, row.path)}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { clearFileHoverExpand(); setFileDropFeedback(null); } }}
        onDrop={(event) => void handleFileDrop(event, row.path)}
        onContextMenu={(event) => openFileMenu(event, { kind: 'folder', value: row.path })}
      ><span className="file-tree-indent-guides" aria-hidden="true" />{renaming ? <span className="file-row-main file-row-renaming">{content}</span> : <button className="file-row-main" tabIndex={-1} onClick={() => toggleFolder(row.path)}>{content}</button>}</div>;
    }

    const renaming = renameState?.kind === 'card' && renameState.value === row.card.id;
    const className = `file-tree-row file-tree-virtual-row file-card-row ${row.depth === 0 ? 'root-card' : ''} ${row.card.id === focusedCardId ? 'active' : ''} ${current ? 'tree-current' : ''} ${fileDrag?.kind === 'card' && fileDrag.value === row.card.id ? 'is-dragging' : ''}`;
    const shared = {
      role: 'treeitem',
      'aria-level': row.depth + 2,
      'aria-posinset': row.posInSet,
      'aria-setsize': row.setSize,
      'aria-selected': row.card.id === focusedCardId,
      'data-tree-key': row.key,
      ref: bindPendingFileTreeFocus(row.key),
      tabIndex: current ? 0 : -1,
      style: positionStyle,
      onFocus: () => setFileTreeActiveKey(row.key),
      onPointerDown: () => setFileTreeActiveKey(row.key),
      onContextMenu: (event: React.MouseEvent) => openFileMenu(event, { kind: 'card', value: row.card.id }),
    };
    return renaming
      ? <div key={row.key} {...shared} className={`${className} file-row-renaming`}><span className="file-tree-indent-guides" aria-hidden="true" /><CardIcon size={14} />{inlineEditor('card', row.card.id, row.depth)}</div>
      : <button key={row.key} {...shared} className={className} draggable onClick={() => focusCard(row.card.id)} onDragStart={(event) => beginFileDrag(event, 'card', row.card.id)} onDragEnd={clearFileDrag}><span className="file-tree-indent-guides" aria-hidden="true" /><CardIcon size={14} /><span>{row.card.title || row.card.fileName}</span></button>;
  };

  const menuTarget = fileMenu && (fileMenu.kind === 'folder' ? fileMenu.value : fileMenu.kind === 'card' ? cards.find((card) => card.id === fileMenu.value)?.title : 'Notes');
  const moveDestinations = moveState ? knownFolders.filter((folder) => moveState.kind !== 'folder' || (folder !== moveState.value && !folder.startsWith(`${moveState.value}/`))) : [];
  const vaultLabel = vaultPath.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || '浏览器空间';
  const saveStatusLabel = saveState === 'saving' ? '正在保存' : saveState === 'error' ? '保存失败' : saveState === 'external-change' ? '等待处理' : '已保存';
  const diagnosticSummary = appInfo ? formatDiagnosticSummary(appInfo, { cards: cards.length, boards: boards.length, folders: folders.length, projects: projects.length, saveState: saveStatusLabel, integrityIssues: integrityReport?.issues.length }) : '';
  const copyDiagnostics = async () => {
    if (!diagnosticSummary) return;
    let copied = false;
    try { await navigator.clipboard.writeText(diagnosticSummary); copied = true; } catch {
      const textarea = document.createElement('textarea');
      textarea.value = diagnosticSummary;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      copied = document.execCommand('copy');
      textarea.remove();
    }
    pushNotice({ tone: copied ? 'success' : 'error', title: copied ? '诊断信息已复制' : '无法复制诊断信息', message: copied ? '仅含版本、环境、知识库位置与对象数，不含笔记正文。' : '请重试，或手动记录版本和知识库位置。' });
  };
  const refreshRecoveryCenter = async () => setIntegrityReport(await vaultApi.checkIntegrity?.() ?? { checkedAt: new Date().toISOString(), issues: [], recoveryEvents: [], recentVersions: [] });
  const revealLocalItem = (sourcePath: string) => {
    if (isNativeVault) { void vaultApi.revealItem?.(sourcePath); return; }
    pushNotice({ tone: 'info', title: '浏览器测试页没有本地文件位置', message: '当前数据保存在浏览器 localStorage；桌面版会生成 Markdown 和白板 JSON 文件。' });
  };
  const changeSearchQuery = (nextQuery: string) => {
    const wasSearching = Boolean(query.trim());
    const willSearch = Boolean(nextQuery.trim());
    if (!wasSearching && willSearch) searchScrollSnapshotsRef.current[mode] = tabListRef.current?.scrollTop ?? 0;
    if (wasSearching && !willSearch) pendingSearchScrollRestoreRef.current = { mode, top: searchScrollSnapshotsRef.current[mode] ?? listScrollPositionsRef.current[mode] ?? 0 };
    setQuery(nextQuery);
  };
  const clearSearch = () => {
    changeSearchQuery('');
    searchInputRef.current?.focus({ preventScroll: true });
  };
  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (isComposingKeyboardEvent(event.nativeEvent)) return;
    if (event.key === 'Escape' && query) {
      event.preventDefault();
      event.stopPropagation();
      clearSearch();
      return;
    }
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    if (mode === 'files') focusFileTreeIndex(fileTreeRows.length > 1 ? 1 : 0);
    else focusEntityIndex(0);
  };

  const boardDeleteImpact = boardDeleteTarget ? boardReferenceImpact(boards, boardDeleteTarget.id) : null;
  return <aside className="sidebar">
    <div className="sidebar-window-row" aria-hidden="true" />
    <div className={`sidebar-search ${searchPending ? 'is-searching' : ''}`} aria-busy={searchPending}>
      <Sparkles size={14} />
      <input ref={searchInputRef} value={query} onChange={(event) => changeSearchQuery(event.target.value)} onKeyDown={handleSearchKeyDown} placeholder="搜索你的空间" aria-label="搜索你的空间" />
      {query ? <button className="sidebar-search-clear" aria-label="清除搜索" title="清除搜索" onClick={clearSearch}>{searchPending ? <RefreshCw className="sidebar-search-spinner" size={13} /> : <X size={14} />}</button> : <Search size={15} />}
      <span className="sr-only" aria-live="polite">{searchPending ? '正在搜索' : hasSearchQuery ? `搜索完成，${mode === 'files' ? Math.max(0, fileTreeRows.length - 1) : sidebarEntityRows.length} 项结果` : ''}</span>
    </div>
    <nav className="global-nav" aria-label="全局导航">
      <button className={workspaceView === 'desktop' && mode === 'boards' ? 'active' : ''} aria-current={workspaceView === 'desktop' && mode === 'boards' ? 'page' : undefined} onClick={() => { showDesktop(); setMode('boards'); }}><DesktopIcon size={17} className="nav-object-icon" /><span>桌面</span></button>
      <button className={workspaceView === 'board' && mode === 'boards' ? 'active' : ''} aria-current={workspaceView === 'board' && mode === 'boards' ? 'page' : undefined} onClick={() => { setMode('boards'); if (workspaceView !== 'board' && activeBoardId) openBoard(activeBoardId); }}><WhiteboardIcon size={17} className="nav-object-icon" /><span>白板</span></button>
      <button className={mode === 'cards' ? 'active' : ''} aria-current={mode === 'cards' ? 'page' : undefined} onClick={() => setMode('cards')}><CardIcon size={17} className="nav-object-icon" /><span>卡片库</span></button>
      <button className={mode === 'files' ? 'active' : ''} aria-current={mode === 'files' ? 'page' : undefined} onClick={() => setMode('files')}><FilesIcon size={17} className="nav-object-icon" /><span>文件</span></button>
    </nav>
    <div className="sidebar-divider" />
    <div className="tabs-heading"><span>{hasSearchQuery && mode !== 'files' ? '搜索结果' : mode === 'boards' ? '白板标签' : mode === 'cards' ? '卡片标签' : '文件目录'}</span><div>{!hasSearchQuery && <button onClick={createCurrent} aria-label={mode === 'files' ? '新建文件夹' : mode === 'boards' ? '新建白板' : '新建卡片'} title={mode === 'files' ? '新建文件夹' : mode === 'boards' ? '新建白板' : '新建卡片'}><Plus size={15} /></button>}</div></div>
    <div
      ref={tabListRef}
      className={`tab-list ${mode === 'files' ? `file-tree${fileAutoScrollDirection ? ` file-auto-scroll-${fileAutoScrollDirection}` : ''}` : ''}`}
      role={mode === 'files' ? 'tree' : 'listbox'}
      aria-label={mode === 'files' ? 'Notes 文件目录' : hasSearchQuery ? '空间搜索结果' : mode === 'boards' ? '白板列表' : '卡片列表'}
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        listScrollPositionsRef.current[mode] = top;
        if (mode === 'files') setFileTreeScrollTop(top); else setEntityListScrollTop(top);
      }}
      onKeyDown={mode === 'files' ? handleFileTreeKeyDown : handleEntityListKeyDown}
      onDragOverCapture={(event) => { if (mode === 'files' && fileDrag) updateFileAutoScroll(event.clientY); }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) stopFileAutoScroll(); }}
    >
      {mode !== 'files' ? <div className="sidebar-entity-spacer" role="none" style={{ height: entityListRange.totalHeight }}>
        {renderedEntityRows.map((row, localIndex) => renderEntityRow(row, entityListRange.start + localIndex))}
        {!sidebarEntityRows.length && <p className="sidebar-empty sidebar-entity-empty">{hasSearchQuery ? '没有匹配内容' : mode === 'boards' ? '还没有白板，点击上方 + 创建' : '还没有卡片，点击上方 + 创建'}</p>}
      </div> : <div className="file-tree-virtual-spacer" role="none" style={{ height: fileTreeRange.totalHeight, minHeight: fileTreeRange.totalHeight }}>
        {renderedFileTreeRows.map((row, localIndex) => renderFileTreeRow(row, fileTreeRange.start + localIndex))}
        {fileTreeRows.length === 1 && <p className="file-tree-empty">{hasSearchQuery ? '没有匹配的文件或目录' : '还没有 Markdown 文件，右键 Notes 或点击上方 + 创建'}</p>}
      </div>}
    </div>
    <div className="file-drag-status" role="status" aria-live="polite" aria-atomic="true">
      {fileDrag && fileDropFeedback
        ? `${fileDrag.kind === 'folder' ? '文件夹' : '卡片'}将${fileDropFeedback.state === 'move' ? `移动到${fileDropFeedback.path || ' Notes 根目录'}` : fileDropFeedback.state === 'noop' ? '保持在原目录' : '不能移动到该目录'}`
        : ''}
    </div>
    <button className="new-tab-button" onClick={createCurrent}><Plus size={15} />{mode === 'files' ? '新建文件夹' : `新建${mode === 'boards' ? '白板' : '卡片'}`}</button>
    <footer className="sidebar-footer">
      <button className={`vault-status-button state-${saveState}`} aria-label="知识库与保存状态" title={vaultPath || '知识库'} onClick={() => setWorkspaceMenuOpen((current) => !current)}>
        <HardDrive size={15} />
        <span><strong>{vaultLabel}</strong><small>{saveStatusLabel}</small></span>
        {saveState === 'saved' ? <Check size={13} /> : saveState === 'error' || saveState === 'external-change' ? <CircleAlert size={14} /> : <RefreshCw className="vault-saving-icon" size={13} />}
      </button>
      <button className="theme-toggle-button" aria-label="设置" title="设置" onClick={() => setSettingsOpen(true)}><Settings2 size={16} /></button>
      <button className="theme-toggle-button" aria-label="查看快捷键" title="快捷键" onClick={() => setShortcutHelpOpen(true)}><CircleHelp size={16} /></button>
      <button className="theme-toggle-button" aria-label={darkMode ? '切换到亮色模式' : '切换到深色模式'} title={darkMode ? '切换到亮色模式' : '切换到深色模式'} onClick={toggleDarkMode}><SunMoon size={16} /></button>
    </footer>

    <ExitPresence show={workspaceMenuOpen} duration={110}>{workspaceMenuOpen ? <div className="canvas-context-menu workspace-vault-menu" role="menu" aria-label="知识库操作" onKeyDown={handleMenuKeyDown}>
      <div className="context-menu-heading">知识库</div>
      <div className="workspace-vault-summary"><HardDrive size={16} /><div><strong>{vaultLabel}</strong><span title={vaultPath}>{vaultPath || '浏览器本地存储'}</span></div></div>
      <div className={`workspace-save-summary state-${saveState}`}>{saveState === 'saved' ? <Check size={14} /> : saveState === 'saving' ? <RefreshCw className="vault-saving-icon" size={14} /> : <CircleAlert size={14} />}<span>{saveError || (saveState === 'external-change' ? '磁盘内容有外部修改' : saveStatusLabel)}</span></div>
      <div className="context-menu-separator" />
      <button role="menuitem" onClick={() => { setWorkspaceMenuOpen(false); setSettingsOpen(true); }}><Settings2 size={15} /><span>设置…</span></button>
      <button role="menuitem" onClick={() => { setWorkspaceMenuOpen(false); setUserGuideOpen(true); }}><BookOpen size={15} /><span>用户手册</span></button>
      <button role="menuitem" onClick={() => { setWorkspaceMenuOpen(false); setAboutOpen(true); }}><Info size={15} /><span>关于与诊断…</span></button>
      {isNativeVault ? <>
        <button role="menuitem" onClick={async () => { setWorkspaceMenuOpen(false); await chooseVault(); }}><FolderOpen size={15} /><span>切换知识库…</span></button>
        <button role="menuitem" onClick={async () => { setWorkspaceMenuOpen(false); await revealVault(); }}><Folder size={15} /><span>在资源管理器中显示</span></button>
        <button role="menuitem" onClick={() => { setWorkspaceMenuOpen(false); setLibraryDialog('trash'); }}><Trash2 size={15} /><span>回收站</span></button>
        <button role="menuitem" onClick={() => { setWorkspaceMenuOpen(false); setLibraryDialog('attachments'); }}><Paperclip size={15} /><span>附件管理</span></button>
        <div className="context-menu-separator" />
        <button role="menuitem" onClick={async () => { setWorkspaceMenuOpen(false); await prepareOpenFormatImport(); }}><Upload size={15} /><span>导入 Heptabase / ZIP / Canvas…</span></button>
        <button role="menuitem" onClick={async () => { setWorkspaceMenuOpen(false); await exportOpenFormat('opencanvas-zip'); }}><Download size={15} /><span>导出知识库 ZIP…</span></button>
        {workspaceView === 'board' && activeBoardId && <button role="menuitem" onClick={async () => { setWorkspaceMenuOpen(false); await exportOpenFormat('obsidian-canvas'); }}><Download size={15} /><span>导出当前 Obsidian Canvas…</span></button>}
      </> : <div className="workspace-browser-note">浏览器测试版使用本地存储；桌面版可直接选择文件夹。</div>}
      <button role="menuitem" onClick={async () => { setWorkspaceMenuOpen(false); await refreshRecoveryCenter(); }}><History size={15} /><span>恢复与完整性…</span></button>
      {saveState === 'error' && <button role="menuitem" onClick={async () => { setWorkspaceMenuOpen(false); await retrySaveAll(); }}><RefreshCw size={15} /><span>重试保存</span></button>}
    </div> : null}</ExitPresence>

    <ExitPresence show={settingsOpen}>{settingsOpen ? <div className="project-dialog-backdrop" onPointerDown={(event) => { if (!pendingAction && event.target === event.currentTarget) setSettingsOpen(false); }}><section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title">
      <header><div className="settings-dialog-icon"><Settings2 size={20} /></div><div><h2 id="settings-dialog-title">设置</h2><p>文件位置、外观和本地版本保留规则</p></div></header>
      <div className="settings-dialog-content">
        <section className="settings-group"><div className="settings-group-heading"><HardDrive size={16} /><div><h3>文件与存储</h3><p>{isNativeVault ? '卡片是 Markdown，白板是开放的 JSON 文件。' : '当前浏览器测试页使用浏览器本地存储。'}</p></div></div>
          <div className="settings-location-card"><span>当前知识库位置</span><strong title={vaultPath}>{vaultPath || '浏览器本地存储'}</strong>{isNativeVault ? <><div><button onClick={() => void revealVault()}><FolderOpen size={14} />打开文件夹</button><button onClick={async () => { await chooseVault(); setSettingsOpen(false); }}><Move size={14} />更改位置…</button></div><small>更改位置会切换到所选知识库；原目录不会被删除，也不会在未确认时自动搬移。</small></> : <small>浏览器页面不会生成可见的 Markdown 文件；桌面版默认保存在“文档/OpenCanvas Vault”，并可在这里改为任意文件夹。</small>}</div>
        </section>
        <section className="settings-group"><div className="settings-row"><div><h3>外观</h3><p>切换整个工作区的明暗配色。</p></div><button className="settings-inline-control" onClick={toggleDarkMode}><SunMoon size={14} />{darkMode ? '深色模式' : '亮色模式'}</button></div></section>
        {isNativeVault && <section className="settings-group"><div className="settings-row"><div><h3>文件版本</h3><p>每次覆盖写入前，为单个文件保留的历史版本数量。</p></div><select className="settings-inline-control" value={historyLimit} onChange={async (event) => setHistoryLimit(await vaultApi.setHistoryLimit?.(Number(event.target.value)) ?? Number(event.target.value))}><option value="10">10 个</option><option value="30">30 个</option><option value="60">60 个</option><option value="100">100 个</option><option value="200">200 个</option></select></div></section>}
        <section className="settings-group"><div className="settings-row"><div><h3>帮助与首次使用</h3><p>重新查看引导、打开完整手册或检查应用版本。</p></div><div className="settings-help-actions"><button className="settings-inline-control" onClick={() => { setSettingsOpen(false); window.dispatchEvent(new Event('opencanvas:open-welcome')); }}>首次引导</button><button className="settings-inline-control" onClick={() => { setSettingsOpen(false); setUserGuideOpen(true); }}>用户手册</button><button className="settings-inline-control" onClick={() => { setSettingsOpen(false); setAboutOpen(true); }}>关于</button></div></div></section>
      </div>
      <footer><button data-modal-close disabled={Boolean(pendingAction)} onClick={() => setSettingsOpen(false)}>完成</button></footer>
    </section></div> : null}</ExitPresence>

    <ExitPresence show={aboutOpen}>{aboutOpen ? <div className="project-dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) setAboutOpen(false); }}><section className="about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-dialog-title">
      <header><div className="about-app-mark">O</div><div><h2 id="about-dialog-title">OpenCanvas</h2><p>开放、本地优先的视觉知识工作区</p></div></header>
      <div className="about-dialog-content">
        <section className="about-version-grid"><span>应用版本<strong>{appInfo?.appVersion ?? '正在读取…'}</strong></span><span>运行模式<strong>{appInfo?.packaged ? '桌面正式包' : appInfo?.electronVersion ? '桌面开发版' : '浏览器测试版'}</strong></span><span>运行环境<strong>{appInfo?.electronVersion ? `Electron ${appInfo.electronVersion}` : 'Chromium'}</strong></span><span>系统架构<strong>{appInfo ? `${appInfo.platform} ${appInfo.arch}` : '正在读取…'}</strong></span></section>
        <section className="about-vault-summary"><small>当前知识库</small><strong title={appInfo?.vaultPath ?? vaultPath}>{appInfo?.vaultPath ?? vaultPath}</strong><span>{cards.length} 张卡片 · {boards.length} 块白板 · {folders.length} 个文件夹 · {projects.length} 个项目 · {saveStatusLabel}</span></section>
        <p className="about-privacy-note">复制的诊断摘要不包含笔记正文、附件内容或文件清单。提交问题前仍请检查知识库路径是否需遮盖。</p>
      </div>
      <footer><button autoFocus onClick={() => { setAboutOpen(false); setUserGuideOpen(true); }}><BookOpen size={14} />用户手册</button><button onClick={() => void vaultApi.openExternal?.('https://github.com/xuziqiu/OpenCanvas/issues/new/choose')}><ExternalLink size={14} />反馈问题</button><button disabled={!diagnosticSummary} onClick={() => void copyDiagnostics()}><ClipboardCopy size={14} />复制诊断信息</button><button className="primary" data-modal-close onClick={() => setAboutOpen(false)}>完成</button></footer>
    </section></div> : null}</ExitPresence>

    <ExitPresence show={shortcutHelpOpen}>{shortcutHelpOpen ? <div className="project-dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) setShortcutHelpOpen(false); }}><section className="shortcut-help-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcut-help-title"><header><CircleHelp size={20} /><div><h2 id="shortcut-help-title">快捷键</h2><p>画布未在编辑文字时生效</p></div></header><div className="shortcut-help-grid">
      <span>快速打开</span><kbd>Ctrl K</kbd>
      <span>选择 / 平移 / 连线</span><kbd>V / H / C</kbd>
      <span>全选画布节点</span><kbd>Ctrl A</kbd>
      <span>复制 / 粘贴 / 独立副本</span><kbd>Ctrl C / V / D</kbd>
      <span>为多个选中对象创建区块</span><kbd>Ctrl G</kbd>
      <span>撤销 / 重做</span><kbd>Ctrl Z / Ctrl Y</kbd>
      <span>多选或增强吸附</span><kbd>Shift</kbd>
      <span>临时关闭吸附</span><kbd>Alt</kbd>
      <span>取消选择或操作</span><kbd>Esc</kbd>
      <span>删除选择</span><kbd>Delete</kbd>
      <span>微调选中对象</span><kbd>方向键 / Shift + 方向键</kbd>
      <span>缩放画布 / 平移画布</span><kbd>滚轮 / 空格拖动</kbd>
      <span>滚动卡片内容</span><kbd>选中且内容溢出时</kbd>
    </div><footer><button className="secondary" onClick={() => { setShortcutHelpOpen(false); setUserGuideOpen(true); }}><BookOpen size={14} />完整用户手册</button><button data-modal-close autoFocus onClick={() => setShortcutHelpOpen(false)}>完成</button></footer></section></div> : null}</ExitPresence>

    <ExitPresence show={userGuideOpen} duration={170}>{userGuideOpen ? <div className="project-dialog-backdrop user-guide-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) setUserGuideOpen(false); }}><Suspense fallback={<section className="user-guide-loading" role="status">正在打开用户手册…</section>}><UserGuide onClose={() => setUserGuideOpen(false)} /></Suspense></div> : null}</ExitPresence>

    <ExitPresence show={externalChangePaths.length > 0}>{externalChangePaths.length > 0 ? <div className="vault-conflict-backdrop"><section className="vault-conflict-dialog" role="alertdialog" aria-modal="true" aria-label="文件外部修改冲突">
      <div className="vault-conflict-icon"><CircleAlert size={22} /></div>
      <div><h2>文件已在外部修改</h2><p>检测到磁盘内容变化，而应用里也有尚未落盘的编辑。自动保存已暂停，请选择保留哪一份。</p></div>
      <ul className="vault-conflict-files">{externalChangePaths.map((path) => <li key={path}><span title={path}>{path}</span><div><AsyncActionButton actionKey={`conflict:disk:${path}`} pendingAction={pendingAction} runAction={runAction} busyLabel="处理中…" action={() => resolveExternalChange(path, 'disk')}>用磁盘</AsyncActionButton><AsyncActionButton actionKey={`conflict:local:${path}`} pendingAction={pendingAction} runAction={runAction} busyLabel="处理中…" action={() => resolveExternalChange(path, 'local')}>用应用内</AsyncActionButton></div></li>)}</ul>
      <footer><AsyncActionButton actionKey="conflict:all-disk" pendingAction={pendingAction} runAction={runAction} busyLabel="正在载入…" action={reloadFromDisk}>使用磁盘版本</AsyncActionButton><AsyncActionButton className="primary" actionKey="conflict:all-local" pendingAction={pendingAction} runAction={runAction} busyLabel="正在写入…" action={overwriteExternalChanges}>保留应用内版本</AsyncActionButton></footer>
    </section></div> : null}</ExitPresence>

    <ExitPresence show={Boolean(libraryDialog)}>{libraryDialog ? <div className="project-dialog-backdrop" onPointerDown={(event) => { if (!pendingAction && event.target === event.currentTarget) setLibraryDialog(null); }}><section className="vault-library-dialog" role="dialog" aria-modal="true" aria-label={libraryDialog === 'trash' ? '回收站' : '附件管理'}>
      <header><div className="vault-library-icon">{libraryDialog === 'trash' ? <Trash2 size={19} /> : <Paperclip size={19} />}</div><div><h2>{libraryDialog === 'trash' ? '回收站' : '附件管理'}</h2><p>{libraryDialog === 'trash' ? '恢复的文件会回到原位置；同名时会安全地添加 restored 后缀。' : '只清理没有任何卡片引用的附件；删除后仍可从回收站恢复。'}</p></div></header>
      <div className="vault-library-list">{libraryDialog === 'trash' ? trashEntries.map((entry) => <div className="vault-library-row" key={entry.id}><span className="vault-library-kind">{entry.kind === 'card' ? <FileText size={15} /> : entry.kind === 'board' ? <BookOpen size={15} /> : <Paperclip size={15} />}</span><div><strong>{entry.name}</strong><small>{entry.sourcePath} · {formatBytes(entry.size)} · {new Date(entry.deletedAt).toLocaleString('zh-CN')}</small></div><AsyncActionButton actionKey={`trash:restore:${entry.id}`} pendingAction={pendingAction} runAction={runAction} busyLabel="正在恢复…" action={async () => { await vaultApi.restoreTrashEntry?.(entry.id); setTrashEntries(await vaultApi.listTrash?.() ?? []); await reloadFromDisk(); }}>恢复</AsyncActionButton><button className="danger" disabled={Boolean(pendingAction)} onClick={() => setPermanentDeleteId(entry.id)}>彻底删除</button></div>) : attachmentEntries.map((entry) => <div className="vault-library-row" key={entry.relativePath}><span className="vault-library-kind"><Paperclip size={15} /></span><div><strong>{entry.name}</strong><small>{entry.mimeType} · {formatBytes(entry.size)} · {entry.referencedBy.length ? `${entry.referencedBy.length} 张卡片正在引用` : '未被引用'}</small></div><button disabled={Boolean(pendingAction)} onClick={() => void vaultApi.openAttachment?.(entry.relativePath)}>打开</button><button disabled={Boolean(pendingAction)} onClick={() => void vaultApi.revealAttachment?.(entry.relativePath)}>定位</button><AsyncActionButton disabled={entry.referencedBy.length > 0} className={entry.referencedBy.length ? '' : 'danger'} actionKey={`attachment:delete:${entry.relativePath}`} pendingAction={pendingAction} runAction={runAction} busyLabel="正在移动…" action={async () => { await vaultApi.deleteAttachment?.(entry.relativePath); setAttachmentEntries(await vaultApi.listAttachments?.() ?? []); }}>移入回收站</AsyncActionButton></div>)}{(libraryDialog === 'trash' ? trashEntries : attachmentEntries).length === 0 && <p className="vault-library-empty">{libraryDialog === 'trash' ? '回收站是空的' : '没有附件'}</p>}</div>
      <footer><button data-modal-close disabled={Boolean(pendingAction)} onClick={() => setLibraryDialog(null)}>完成</button></footer>
    </section></div> : null}</ExitPresence>

    <ExitPresence show={Boolean(permanentDeleteId)}>{permanentDeleteId ? <div className="project-dialog-backdrop"><section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-label="彻底删除"><h2>彻底删除这个文件？</h2><p>这一步不可撤销；自动版本历史也不会代替回收站恢复这个条目。</p><footer><button data-modal-close disabled={Boolean(pendingAction)} onClick={() => setPermanentDeleteId(null)}>取消</button><AsyncActionButton className="danger" actionKey="trash:delete-permanently" pendingAction={pendingAction} runAction={runAction} busyLabel="正在删除…" action={async () => { await vaultApi.deleteTrashEntry?.(permanentDeleteId); setPermanentDeleteId(null); setTrashEntries(await vaultApi.listTrash?.() ?? []); }}>彻底删除</AsyncActionButton></footer></section></div> : null}</ExitPresence>

    <ExitPresence show={Boolean(versionTarget)}>{versionTarget ? <div className="project-dialog-backdrop" onPointerDown={(event) => { if (!pendingAction && event.target === event.currentTarget) setVersionTarget(null); }}><section className="vault-library-dialog version-history-dialog" role="dialog" aria-modal="true" aria-label="版本历史"><header><div className="vault-library-icon"><History size={19} /></div><div><h2>版本历史</h2><p>{versionTarget.label} · 写入前自动保留版本。</p></div></header><label className="history-limit-field">每个文件保留<select disabled={Boolean(pendingAction)} value={historyLimit} onChange={async (event) => setHistoryLimit(await vaultApi.setHistoryLimit?.(Number(event.target.value)) ?? Number(event.target.value))}><option value="10">10 个</option><option value="30">30 个</option><option value="60">60 个</option><option value="100">100 个</option><option value="200">200 个</option></select></label><div className="vault-library-list">{fileVersions.map((version) => <div className="vault-library-row" key={version.id}><span className="vault-library-kind"><History size={15} /></span><div><strong>{new Date(version.createdAt).toLocaleString('zh-CN')}</strong><small>{formatBytes(version.size)}</small></div><AsyncActionButton actionKey={`history:restore:${version.id}`} pendingAction={pendingAction} runAction={runAction} busyLabel="正在恢复…" action={async () => { await vaultApi.restoreFileVersion?.(version.id); setVersionTarget(null); await reloadFromDisk(); }}>恢复此版本</AsyncActionButton></div>)}{!fileVersions.length && <p className="vault-library-empty">这个文件还没有历史版本</p>}</div><footer><button data-modal-close disabled={Boolean(pendingAction)} onClick={() => setVersionTarget(null)}>关闭</button></footer></section></div> : null}</ExitPresence>

    <ExitPresence show={Boolean(integrityReport)}>{integrityReport ? <div className="project-dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) setIntegrityReport(null); }}><section className="vault-library-dialog integrity-dialog" role="dialog" aria-modal="true" aria-label="恢复与完整性"><header><div className="vault-library-icon">{integrityReport.issues.length ? <CircleAlert size={19} /> : <Check size={19} />}</div><div><h2>恢复与完整性</h2><p>{integrityReport.issues.length ? `发现 ${integrityReport.issues.length} 个问题；可修复项会先保留文件历史再修改。` : '当前没有缺失引用、断裂连线或附件问题。'}</p></div></header><div className="recovery-center-content">
      <section><h3>完整性问题 <small>{integrityReport.issues.length}</small></h3><div className="vault-library-list">{integrityReport.issues.map((issue, index) => <div className="vault-library-row integrity-row" key={`${issue.sourcePath}-${index}`}><span className="vault-library-kind"><CircleAlert size={15} /></span><div><strong>{issue.message}</strong><small>{issue.sourcePath}</small></div>{issue.repairAction && <button className={issue.repairAction === 'restore-attachment' ? '' : 'danger'} onClick={async () => { const repaired = await vaultApi.repairIntegrityIssue?.(issue); if (repaired) { await reloadFromDisk(); await refreshRecoveryCenter(); } }}>{issue.repairAction === 'restore-attachment' ? '找回附件' : issue.repairAction === 'remove-connector' ? '清理连线' : '清理引用'}</button>}</div>)}{!integrityReport.issues.length && <p className="vault-library-empty compact">知识库结构正常</p>}</div></section>
      <section><h3>自动恢复记录 <small>{integrityReport.recoveryEvents.length}</small></h3><div className="vault-library-list recovery-event-list">{integrityReport.recoveryEvents.map((event) => { const fixed = event.recovered.length + event.importTransactions.length + event.filePlanTransactions.length; return <div className="vault-library-row recovery-event-row" key={event.id}><span className="vault-library-kind"><RefreshCw size={15} /></span><div><strong>{fixed ? `已恢复 ${fixed} 项` : `已清理 ${event.discarded.length} 个无效临时文件`}</strong><small>{new Date(event.recoveredAt).toLocaleString('zh-CN')}{event.failedTransactions.length ? ` · ${event.failedTransactions.length} 项需手动处理` : ''}</small></div></div>; })}{!integrityReport.recoveryEvents.length && <p className="vault-library-empty compact">尚无自动恢复记录</p>}</div></section>
      <section><h3>最近文件版本 <small>{integrityReport.recentVersions.length}</small></h3><div className="vault-library-list recovery-version-list">{integrityReport.recentVersions.map((version) => <div className="vault-library-row" key={version.id}><span className="vault-library-kind"><History size={15} /></span><div><strong>{version.sourcePath}</strong><small>{new Date(version.createdAt).toLocaleString('zh-CN')} · {formatBytes(version.size)}</small></div><button onClick={async () => { if (await vaultApi.restoreFileVersion?.(version.id)) { await reloadFromDisk(); await refreshRecoveryCenter(); } }}>恢复</button></div>)}{!integrityReport.recentVersions.length && <p className="vault-library-empty compact">还没有可恢复的历史版本</p>}</div></section>
    </div><footer><small>检查于 {new Date(integrityReport.checkedAt).toLocaleString('zh-CN')}</small><button onClick={() => void refreshRecoveryCenter()}><RefreshCw size={13} />重新检查</button><button data-modal-close onClick={() => setIntegrityReport(null)}>完成</button></footer></section></div> : null}</ExitPresence>

    <ExitPresence show={Boolean(pendingImport)}>{pendingImport ? <div className="project-dialog-backdrop"><section className="vault-library-dialog import-preview-dialog" role="dialog" aria-modal="true" aria-label="导入预览"><header><div className="vault-library-icon"><Upload size={19} /></div><div><h2>确认导入</h2><p>{pendingImport.name} · {pendingImport.format === 'obsidian-canvas' ? 'Obsidian Canvas' : pendingImport.format === 'markdown-zip' ? 'Heptabase / Markdown ZIP' : 'OpenCanvas ZIP'}</p></div></header><div className="import-preview-summary"><div><strong>{pendingImport.summary?.cards ?? 0}</strong><span>卡片</span></div><div><strong>{pendingImport.summary?.boards ?? 0}</strong><span>白板</span></div><div><strong>{pendingImport.summary?.attachments ?? 0}</strong><span>附件</span></div></div>{Boolean((pendingImport.summary?.idConflicts ?? 0) + (pendingImport.summary?.pathConflicts ?? 0)) && <div className="import-conflict-summary"><CircleAlert size={15} /><span>{pendingImport.summary?.idConflicts ?? 0} 个 ID 冲突、{pendingImport.summary?.pathConflicts ?? 0} 个路径冲突；将自动生成新 ID，并把同名文件放入“导入/{pendingImport.name}”。</span></div>}{pendingImport.attachments?.some((item) => item.exists) && <div className="import-conflict-summary"><Paperclip size={15} /><span>{pendingImport.attachments.filter((item) => item.exists).length} 个同名附件将安全重命名，正文引用会同步更新。</span></div>}<div className="vault-library-list import-warning-list">{pendingImport.warnings?.map((warning) => <div className="vault-library-row" key={warning}><span className="vault-library-kind"><CircleAlert size={15} /></span><div><strong>{warning}</strong></div></div>)}</div><footer><AsyncActionButton data-modal-close actionKey="import:cancel" pendingAction={pendingAction} runAction={runAction} busyLabel="正在取消…" action={cancelOpenFormatImport}>取消</AsyncActionButton><AsyncActionButton className="primary" actionKey="import:commit" pendingAction={pendingAction} runAction={runAction} busyLabel="正在导入…" action={() => confirmOpenFormatImport('rename')}>开始导入</AsyncActionButton></footer></section></div> : null}</ExitPresence>

    <ExitPresence show={Boolean(fileMenu)} duration={110}>{fileMenu ? <div className="canvas-context-menu file-context-menu" role="menu" aria-label="文件操作" onKeyDown={handleMenuKeyDown} style={{ left: fileMenu.x, top: fileMenu.y }} onContextMenu={(event) => event.preventDefault()}>
      <div className="context-menu-heading">{menuTarget || '文件操作'}</div>
      {(fileMenu.kind === 'root' || fileMenu.kind === 'folder') && <><button role="menuitem" onClick={() => { const parent = fileMenu.kind === 'folder' ? fileMenu.value : ''; setFileMenu(null); setQuery(''); setNewItem({ kind: 'card', parentPath: parent, draft: '未命名卡片' }); toggleFolder(parent, true); }}><FilePlus2 size={15} /><span>新建卡片</span></button><button role="menuitem" onClick={() => { const parent = fileMenu.kind === 'folder' ? fileMenu.value : ''; setFileMenu(null); setQuery(''); setNewItem({ kind: 'folder', parentPath: parent, draft: '新建文件夹' }); toggleFolder(parent, true); }}><FolderPlus size={15} /><span>新建文件夹</span></button></>}
      {(fileMenu.kind === 'root' || fileMenu.kind === 'folder') && <button role="menuitem" onClick={() => { toggleFolder(fileMenu.kind === 'root' ? '' : fileMenu.value); setFileMenu(null); }}><ChevronRight size={15} /><span>{expandedFolders.has(fileMenu.kind === 'root' ? '' : fileMenu.value) ? '折叠文件夹' : '展开文件夹'}</span></button>}
      {fileMenu.kind === 'card' && <button role="menuitem" onClick={() => { focusCard(fileMenu.value); setFileMenu(null); }}><CardIcon size={15} /><span>打开</span></button>}
      <button role="menuitem" onClick={() => { const sourcePath = fileMenu.kind === 'root' ? 'notes' : fileMenu.kind === 'folder' ? `notes/${fileMenu.value}` : `notes/${cards.find((item) => item.id === fileMenu.value)?.relativePath ?? ''}`; setFileMenu(null); revealLocalItem(sourcePath); }}><FolderOpen size={15} /><span>打开本地位置</span></button>
      {fileMenu.kind === 'card' && isNativeVault && (() => { const card = cards.find((item) => item.id === fileMenu.value); return card ? <button role="menuitem" onClick={() => { setVersionTarget({ sourcePath: `notes/${card.relativePath}`, label: card.title || card.fileName }); setFileMenu(null); }}><History size={15} /><span>版本历史</span></button> : null; })()}
      {fileMenu.kind !== 'root' && <><div className="context-menu-separator" /><button role="menuitem" onClick={() => beginRename(fileMenu)}><Pencil size={15} /><span>重命名</span></button><button role="menuitem" onClick={() => { setMoveState({ kind: fileMenu.kind, value: fileMenu.value }); setFileMenu(null); }}><Move size={15} /><span>移动到…</span></button><div className="context-menu-separator" /><button className="danger" role="menuitem" onClick={() => requestDelete(fileMenu)}><Trash2 size={15} /><span>移入回收目录</span></button></>}
      {fileMenu.kind === 'root' && <><div className="context-menu-separator" /><button role="menuitem" onClick={() => { setExpandedFolders(new Set(['', ...knownFolders])); setFileMenu(null); }}><FolderOpen size={15} /><span>全部展开</span></button><button role="menuitem" onClick={() => { setExpandedFolders(new Set()); setFileMenu(null); }}><Folder size={15} /><span>全部折叠</span></button></>}
    </div> : null}</ExitPresence>
    <ExitPresence show={Boolean(boardMenu)} duration={110}>{boardMenu ? (() => {
      const target = boards.find((board) => board.id === boardMenu.boardId);
      if (!target) return null;
      const project = target.projectId ? projects.find((item) => item.id === target.projectId) : undefined;
      return <div className="canvas-context-menu file-context-menu board-list-context-menu" role="menu" aria-label={`${target.title} 操作`} onKeyDown={handleMenuKeyDown} style={{ left: boardMenu.x, top: boardMenu.y }} onContextMenu={(event) => event.preventDefault()}><div className="context-menu-heading">{target.title}</div><button role="menuitem" onClick={() => { openBoard(target.id); setBoardMenu(null); }}><BookOpen size={15} /><span>打开白板</span></button><button role="menuitem" onClick={() => { setBoardMenu(null); revealLocalItem(`boards/${target.fileName}`); }}><FolderOpen size={15} /><span>打开本地位置</span></button><button role="menuitem" onClick={() => { setRenameState({ kind: 'board', value: target.id, draft: target.title }); setBoardMenu(null); }}><Pencil size={15} /><span>重命名</span></button>{isNativeVault && <button role="menuitem" onClick={() => { setVersionTarget({ sourcePath: `boards/${target.fileName}`, label: target.title }); setBoardMenu(null); }}><History size={15} /><span>版本历史</span></button>}<div className="context-menu-separator" /><button role="menuitem" onClick={() => { setBoardProjectTarget(target); setBoardMenu(null); }}><FolderKanban size={15} /><span>{project ? '查看项目目录' : '整理为项目'}</span></button><div className="context-menu-separator" /><button className="danger" role="menuitem" onClick={() => { setBoardDeleteTarget(target); setBoardMenu(null); }}><Trash2 size={15} /><span>删除白板</span></button></div>;
    })() : null}</ExitPresence>
    <ExitPresence show={Boolean(moveState)}>{moveState ? <div className="project-dialog-backdrop" onPointerDown={(event) => { if (!pendingAction && event.target === event.currentTarget) setMoveState(null); }}><section className="file-move-dialog" role="dialog" aria-modal="true" aria-label="移动到"><h2>移动到</h2><p>选择目标目录</p><div className="file-move-list"><AsyncActionButton actionKey="files:move:root" pendingAction={pendingAction} runAction={runAction} busyLabel="正在移动…" action={async () => { if (moveState.kind === 'card') await moveCardToFolder(moveState.value, ''); else await moveFolder(moveState.value, ''); setMoveState(null); }}><FolderOpen size={15} /><span>Notes 根目录</span></AsyncActionButton>{moveDestinations.map((folder) => <AsyncActionButton key={folder} actionKey={`files:move:${folder}`} pendingAction={pendingAction} runAction={runAction} busyLabel="正在移动…" action={async () => { if (moveState.kind === 'card') await moveCardToFolder(moveState.value, folder); else await moveFolder(moveState.value, folder); setExpandedFolders((current) => new Set([...current, folder])); setMoveState(null); }}><Folder size={15} /><span>{folder}</span></AsyncActionButton>)}</div><footer><button data-modal-close disabled={Boolean(pendingAction)} onClick={() => setMoveState(null)}>取消</button></footer></section></div> : null}</ExitPresence>
    <ExitPresence show={Boolean(deleteState)}>{deleteState ? <div className="project-dialog-backdrop" onPointerDown={(event) => { if (!pendingAction && event.target === event.currentTarget) setDeleteState(null); }}><section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-label="确认删除"><h2>移除“{deleteState.label}”？</h2><p>{deleteState.kind === 'folder' ? `其中 ${deleteState.count} 张卡片及所有子目录会一起移入回收目录；引用它们的白板节点也会被清理。` : 'Markdown 文件会移入 OpenCanvas 回收目录；引用它的白板节点也会被清理。'}</p><footer><button data-modal-close disabled={Boolean(pendingAction)} onClick={() => setDeleteState(null)}>取消</button><AsyncActionButton className="danger" actionKey={`files:delete:${deleteState.kind}`} pendingAction={pendingAction} runAction={runAction} busyLabel="正在移动…" action={async () => { if (deleteState.kind === 'card') await deleteCard(deleteState.value); else await deleteFolder(deleteState.value); setDeleteState(null); }}>移入回收目录</AsyncActionButton></footer></section></div> : null}</ExitPresence>
    <ExitPresence show={Boolean(boardProjectTarget)}>{boardProjectTarget ? <div className="project-dialog-backdrop" onPointerDown={(event) => { if (!pendingAction && event.target === event.currentTarget) setBoardProjectTarget(null); }}><section className="project-dialog" role="dialog" aria-modal="true" aria-label={boardProjectTarget.projectId ? '项目目录' : '整理为项目'}><div className="project-dialog-icon"><FolderKanban size={20} /></div><div className="project-dialog-heading"><h2>{boardProjectTarget.projectId ? '项目目录' : '整理为项目'}</h2><p>{boardProjectTarget.projectId ? '白板引用已绑定到真实目录；文件层级仍可独立整理。' : '为这个白板建立项目目录；白板布局和已有文件层级保持不变。'}</p></div>{boardProjectTarget.projectId ? <div className="project-bound-summary"><span>Notes/</span><strong>{projects.find((item) => item.id === boardProjectTarget.projectId)?.relativePath}</strong><small>解除绑定不会移动或删除任何 Markdown 文件。</small></div> : <div className="project-plan-summary"><div><strong>{boardProjectTarget.placements.filter((item) => item.kind === 'card').length}</strong><span>张白板卡片将按规则整理</span></div></div>}<footer><button data-modal-close disabled={Boolean(pendingAction)} onClick={() => setBoardProjectTarget(null)}>取消</button>{boardProjectTarget.projectId ? <>{isNativeVault && <AsyncActionButton actionKey="project:export" pendingAction={pendingAction} runAction={runAction} busyLabel="正在导出…" action={async () => { await exportBoardBundle(boardProjectTarget.id); setBoardProjectTarget(null); }}>导出项目</AsyncActionButton>}<AsyncActionButton className="danger-subtle" actionKey="project:unbind" pendingAction={pendingAction} runAction={runAction} busyLabel="正在解除…" action={async () => { await unbindBoardProject(boardProjectTarget.id); setBoardProjectTarget(null); }}>解除目录绑定</AsyncActionButton></> : <AsyncActionButton className="primary" actionKey="project:create" pendingAction={pendingAction} runAction={runAction} busyLabel="正在整理…" action={async () => { await organizeBoardAsProject(boardProjectTarget.id, boardProjectTarget.title); setBoardProjectTarget(null); }}>建立项目目录</AsyncActionButton>}</footer></section></div> : null}</ExitPresence>
    <ExitPresence show={Boolean(boardDeleteTarget)}>{boardDeleteTarget ? <div className="project-dialog-backdrop" onPointerDown={(event) => { if (!pendingAction && event.target === event.currentTarget) setBoardDeleteTarget(null); }}><section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-label="删除白板"><h2>删除“{boardDeleteTarget.title}”？</h2><p>白板文件会移入 OpenCanvas 回收目录；卡片 Markdown 不会被删除。</p>{boardDeleteImpact && <div className="delete-impact-summary"><span>{boardDeleteImpact.parents.length ? `${boardDeleteImpact.parents.length} 个引用会从以下白板移除：${boardDeleteImpact.parents.map((item) => item.boardTitle).join('、')}` : '没有其他白板引用它'}</span><span>{boardDeleteImpact.children.length ? `${boardDeleteImpact.children.length} 个下级白板仍会保留：${boardDeleteImpact.children.map((item) => item.boardTitle).join('、')}` : '不包含下级白板'}</span></div>}<footer><button data-modal-close disabled={Boolean(pendingAction)} onClick={() => setBoardDeleteTarget(null)}>取消</button><AsyncActionButton className="danger" actionKey="boards:delete" pendingAction={pendingAction} runAction={runAction} busyLabel="正在移动…" action={async () => { await deleteBoard(boardDeleteTarget.id); setBoardDeleteTarget(null); }}>移入回收目录</AsyncActionButton></footer></section></div> : null}</ExitPresence>
  </aside>;
}
