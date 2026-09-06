import { create } from 'zustand';
import { emptyHistory, recordHistory, redoHistory, undoHistory } from './domain/history';
import { tidyPlacementPositions } from './domain/tidyLayout';
import { boardToObsidianCanvas, isObsidianCanvasDocument, obsidianCanvasToBoard } from './domain/openFormats';
import { normalizeWorkspaceSnapshot } from './domain/schema';
import { replaceMarkdownTag } from './domain/searchIndex';
import { rewriteMarkdownLinksAfterMoves } from './domain/markdownLinks';
import { arrangePlacementZIndices, clonePlacementPayload, type PlacementClipboardPayload } from './domain/placementOperations';
import { applyPlacementLayoutChange, containingSectionIdsForPlacement, expandSectionsToMaintainPadding, placementFullyContains, placementSectionIds, reconcileSectionMembershipChanges, sectionBoundsForPlacements } from './domain/sectionLayout';
import { findRootBoards, wouldCreateBoardCycle } from './domain/workspaceIndex';
import { WorkspaceSaveScheduler } from './persistence/saveScheduler';
import type { AppNotice, PlacementPosition, WorkspaceStore } from './store/storeTypes';
export type { Selection, WorkspaceStore } from './store/storeTypes';
import { createUiSlice } from './store/uiSlice';
import { boardHistoryAfterDeletion, createNavigationSlice, persistNavigation } from './store/navigationSlice';
import { createDataSlice } from './store/dataSlice';
import { createFileSlice } from './store/fileSlice';
import { changedEntityIds } from './domain/filePlanDiff';
import { normalizeUserFolderPath, persistenceErrorMessage, sanitizeFileName, sanitizePathSegment, sanitizeRelativeFilePath } from './domain/pathNaming';
import { createHistorySlice } from './store/historySlice';
import { reconcileSelectionForBoard, remapPlacementSelection } from './domain/selectionReconciliation';
import { convertTextPlacementsToCards } from './domain/textToCards';
import { transferBoardPlacements } from './domain/boardTransfer';
import { connectorsAfterPlacementMotion } from './domain/connectorMotion';
import { DEFAULT_PLACEMENT_DIMENSIONS, DEFAULT_SECTION_DIMENSIONS, MINIMUM_SECTION_DIMENSIONS, resetPlacementsToDefaultSize } from './domain/defaultPlacementSize';
import type { Board, BoardPlacement, Card, DesktopBoardPlacement, DesktopLayout, ProjectDirectory, WorkspaceSnapshot } from './types';
import { vaultApi } from './vault';

let workspaceLoadPromise: Promise<void> | null = null;
let boardTransaction: { label: string; boardId: string; before: Board } | null = null;
let internalClipboard: PlacementClipboardPayload | null = null;
const announcedRecoveryKeys = new Set<string>();
const LOAD_ISSUE_NOTICE_TITLE = '部分文件正在等待修复';

const id = () => crypto.randomUUID();
const timestamp = () => new Date().toISOString();

function initialSectionMembership(position: PlacementPosition, placement?: BoardPlacement, placements: BoardPlacement[] = []) {
  const explicitSectionIds = [...new Set([
    ...(position.sectionId ? [position.sectionId] : []),
    ...(position.sectionIds ?? []),
  ].filter(Boolean))];
  const sectionIds = explicitSectionIds.length
    ? explicitSectionIds
    : placement
      ? containingSectionIdsForPlacement(placement, [...placements, placement])
      : [];
  return sectionIds.length
    ? { sectionId: sectionIds[0], sectionIds }
    : {};
}

const safeBaseName = sanitizePathSegment;
const normalizeFolderPath = normalizeUserFolderPath;

function pathDirectory(relativePath: string) {
  const index = relativePath.lastIndexOf('/');
  return index < 0 ? '' : relativePath.slice(0, index);
}

function joinPath(parent: string, child: string) {
  return parent ? `${parent}/${child}` : child;
}

function setSaveFailure(error: unknown) {
  const message = persistenceErrorMessage(error);
  useWorkspaceStore.setState({
    saveState: 'error',
    saveError: message,
    notices: [...useWorkspaceStore.getState().notices, { id: id(), tone: 'error' as const, title: '保存没有完成', message }].slice(-5),
  });
}

const saveScheduler = new WorkspaceSaveScheduler({
  canSchedule: () => useWorkspaceStore.getState().externalChangePaths.length === 0,
  canMarkSaved: () => {
    const state = useWorkspaceStore.getState();
    return state.saveState !== 'error' && state.externalChangePaths.length === 0;
  },
  onBlocked: () => useWorkspaceStore.setState({ saveState: 'external-change' }),
  onSaving: () => useWorkspaceStore.setState({ saveState: 'saving', saveError: null }),
  onSaved: () => useWorkspaceStore.setState({ saveState: 'saved', saveError: null, lastSavedAt: timestamp() }),
  onError: setSaveFailure,
});

/** Only the application close handshake may permanently stop new writes. */
export const sealPendingSavesForShutdown = () => saveScheduler.sealAndFlush();

function scheduleSave(key: string, delay: number, task: () => Promise<void>) {
  saveScheduler.schedule(key, delay, task);
}

function scheduleSaveCard(card: Card) {
  scheduleSave(`card:${card.id}`, 220, () => vaultApi.saveCard(card));
}

function scheduleSaveBoard(board: Board) {
  scheduleSave(`board:${board.id}`, 220, () => vaultApi.saveBoard(board));
}

function scheduleSaveDesktop(desktop: DesktopLayout) {
  scheduleSave('desktop', 180, () => vaultApi.saveDesktopLayout(desktop));
}

function clearPendingSaves() {
  saveScheduler.clear();
}

function starterWorkspace(): { card: Card; board: Board } {
  const now = timestamp();
  const cardId = id();
  const boardId = id();
  const card: Card = {
    id: cardId,
    fileName: `欢迎使用-OpenCanvas--${cardId.slice(0, 8)}.md`,
    relativePath: `欢迎使用-OpenCanvas--${cardId.slice(0, 8)}.md`,
    title: '欢迎使用 OpenCanvas',
    body: ['这是一个真正保存在本地的 **Markdown 卡片**。', '', '- 卡片和白板放置实例彼此独立', '- 同一卡片可放到多个白板并保持同步', '- 拖动、缩放、连接均可撤销', '- 输入 `/` 使用块命令，输入 `@` 引用其他卡片'].join('\n'),
    createdAt: now,
    updatedAt: now,
  };
  const board: Board = {
    version: 4,
    id: boardId,
    fileName: `开始这里--${boardId.slice(0, 8)}.board.json`,
    title: '开始这里',
    placements: [
      { id: id(), kind: 'card', entityId: cardId, x: 160, y: 120, width: 520, height: 185, color: 'sand' },
      { id: id(), kind: 'text', text: '把思考放到空间里', x: 185, y: 15, width: 310, height: 92, color: 'transparent' },
    ],
    connectors: [],
    attachments: [],
    viewport: { x: 80, y: 70, zoom: 0.8 },
    createdAt: now,
    updatedAt: now,
  };
  return { card, board };
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get, store) => {
  const announceRecovery = (snapshot: WorkspaceSnapshot) => {
    const recovery = snapshot.recovery;
    if (!recovery) return;
    const recoveryKey = JSON.stringify(recovery);
    if (announcedRecoveryKeys.has(recoveryKey)) return;
    const recoveredWrites = recovery?.recovered.length ?? 0;
    const recoveredImports = recovery?.importTransactions?.length ?? 0;
    const recoveredPlans = recovery?.filePlanTransactions?.length ?? 0;
    const recoveryNotices: AppNotice[] = [];
    if (recoveredWrites + recoveredImports + recoveredPlans > 0) recoveryNotices.push({ id: id(), tone: 'success', title: '已自动恢复知识库', message: `恢复了 ${recoveredWrites} 个异常写入、${recoveredImports} 个导入事务和 ${recoveredPlans} 个文件操作。` });
    if ((recovery?.discarded.length ?? 0) > 0) recoveryNotices.push({ id: id(), tone: 'info', title: '已清理无效临时文件', message: `清理了 ${recovery?.discarded.length ?? 0} 个不完整的临时文件。` });
    if ((recovery?.failedTransactions?.length ?? 0) > 0) recoveryNotices.push({ id: id(), tone: 'error', title: '有文件操作未能自动恢复', message: `${recovery?.failedTransactions?.length ?? 0} 个事务仍需处理。请先运行“知识库完整性检查”，并保留当前知识库副本。` });
    if (!recoveryNotices.length) return;
    set((state) => ({ notices: [...state.notices, ...recoveryNotices].slice(-5) }));
    announcedRecoveryKeys.add(recoveryKey);
  };

  const applyFileState = async (
    cards: Card[],
    boards: Board[],
    projects: ProjectDirectory[],
    folders: string[],
    previousCardPaths: Record<string, string> = {},
    directoryMoves: Array<{ from: string; to: string }> = [],
    trashedCardPaths: string[] = [],
    trashedBoardFileNames: string[] = [],
    trashedDirectoryPaths: string[] = [],
  ) => {
    const normalizedFolders = [...new Set(folders.map(normalizeFolderPath).filter(Boolean))].sort();
    const current = get();
    const writeCardIds = changedEntityIds(current.cards, cards, Object.keys(previousCardPaths));
    const writeBoardIds = changedEntityIds(current.boards, boards);
    for (const card of cards) {
      const key = `card:${card.id}`;
      saveScheduler.cancel(key);
    }
    set({ saveState: 'saving', saveError: null });
    try {
      await vaultApi.applyFilePlan({ cards, boards, projects, folders: normalizedFolders, writeCardIds, writeBoardIds, previousCardPaths, directoryMoves, trashedCardPaths, trashedBoardFileNames, trashedDirectoryPaths });
      set({ cards, boards, projects, folders: normalizedFolders, saveState: 'saved', saveError: null, lastSavedAt: timestamp() });
    } catch (error) {
      setSaveFailure(error);
      throw error;
    }
  };

  const persistWholeWorkspace = async () => {
    const state = get();
    clearPendingSaves();
    set({ saveState: 'saving', saveError: null });
    try {
      await Promise.all([
        vaultApi.applyFilePlan({ cards: state.cards, boards: state.boards, projects: state.projects, folders: state.folders }),
        vaultApi.saveDesktopLayout(state.desktop),
      ]);
      set({ saveState: 'saved', saveError: null, externalChangePaths: [], lastSavedAt: timestamp() });
    } catch (error) {
      setSaveFailure(error);
      throw error;
    }
  };

  const replaceBoard = (board: Board) => {
    set((state) => ({ boards: state.boards.map((item) => item.id === board.id ? board : item) }));
    scheduleSaveBoard(board);
  };

  const mutateActiveBoard = (label: string | null, mutator: (board: Board) => Board, placementReplacementMap?: Record<string, string>) => {
    const activeId = get().activeBoardId;
    const before = get().boards.find((board) => board.id === activeId);
    if (!before) return null;
    const after = mutator(before);
    if (after === before) return before;
    replaceBoard(after);
    if (label && !boardTransaction) {
      set((state) => ({ commandHistory: recordHistory(state.commandHistory, { label, boardId: before.id, before, after, placementReplacementMap }) }));
    }
    return after;
  };

  const relocateFolder = async (folderPath: string, destination: string) => {
    const from = normalizeFolderPath(folderPath);
    const to = normalizeFolderPath(destination);
    if (!from || !to) return false;
    if (from === to) return true;
    const fromKey = from.toLocaleLowerCase();
    const toKey = to.toLocaleLowerCase();
    if (toKey.startsWith(`${fromKey}/`)) return false;
    const state = get();
    const knownFolders = new Set([
      ...state.folders,
      ...state.projects.map((project) => project.relativePath),
      ...state.cards.map((card) => pathDirectory(card.relativePath)).filter(Boolean),
    ]);
    if ([...knownFolders].some((folder) => folder.toLocaleLowerCase() === toKey && folder.toLocaleLowerCase() !== fromKey)) return false;
    const replacePrefix = (value: string) => value === from ? to : value.startsWith(`${from}/`) ? `${to}${value.slice(from.length)}` : value;
    const movedCards = state.cards.map((card) => {
      const relativePath = replacePrefix(card.relativePath);
      return relativePath === card.relativePath ? card : { ...card, relativePath };
    });
    const cards = rewriteMarkdownLinksAfterMoves(state.cards, movedCards, timestamp());
    const projects = state.projects.map((project) => {
      const relativePath = replacePrefix(project.relativePath);
      return relativePath === project.relativePath ? project : { ...project, relativePath };
    });
    const folders = [...new Set([...state.folders.map(replacePrefix), to])];
    await applyFileState(cards, state.boards, projects, folders, {}, [{ from, to }]);
    return true;
  };

  const pastePayload = (payload: PlacementClipboardPayload, position?: { x: number; y: number }) => {
    const board = get().boards.find((item) => item.id === get().activeBoardId);
    if (!board) return;
    const { placements, connectors, attachments } = clonePlacementPayload(payload, id, position, new Set(board.placements.filter((placement) => placement.isFrame).map((placement) => placement.id)));
    const placementReplacementMap = Object.fromEntries(payload.placements.map((placement, index) => [placement.id, placements[index].id]));
    mutateActiveBoard('粘贴对象', (current) => ({ ...current, placements: [...current.placements, ...placements], connectors: [...current.connectors, ...connectors], attachments: [...current.attachments, ...attachments], updatedAt: timestamp() }), placementReplacementMap);
    if (placements.length) set({ selection: { kind: 'placement', id: placements[0].id, ids: placements.map((item) => item.id) } });
  };

  return {
    ...createDataSlice(set, get, store),
    ...createUiSlice(set, get, store),
    ...createNavigationSlice(() => { boardTransaction = null; })(set, get, store),
    ...createFileSlice(set, get, store),
    ...createHistorySlice(set, get, store),

    load: () => {
      if (get().ready) return Promise.resolve();
      if (workspaceLoadPromise) return workspaceLoadPromise;
      workspaceLoadPromise = (async () => {
        const snapshot = await vaultApi.loadWorkspace() as WorkspaceSnapshot;
        if (snapshot.cards.length === 0 && snapshot.boards.length === 0) {
          const { card, board } = starterWorkspace();
          await Promise.all([vaultApi.saveCard(card), vaultApi.saveBoard(board)]);
          get().applySnapshot({ ...snapshot, cards: [card], boards: [board] }, true);
        } else get().applySnapshot(snapshot, true);
        announceRecovery(snapshot);
      })().finally(() => { workspaceLoadPromise = null; });
      return workspaceLoadPromise;
    },

    applySnapshot: (snapshot, preserveNavigation = false) => {
      const current = get();
      const placed = new Set(snapshot.desktop.placements.map((placement) => placement.boardId));
      const missingPlacements = snapshot.boards.filter((board) => !placed.has(board.id)).map((board, index) => ({
        boardId: board.id,
        x: 120 + (index % 3) * 470,
        y: 110 + Math.floor(index / 3) * 310,
        width: 430,
        height: 270,
      }));
      const desktop: DesktopLayout = {
        ...snapshot.desktop,
        placements: [...snapshot.desktop.placements, ...missingPlacements],
      };
      const boardIds = new Set(snapshot.boards.map((board) => board.id));
      const cardIds = new Set(snapshot.cards.map((card) => card.id));
      const canPreserveBoard = preserveNavigation && current.activeBoardId && boardIds.has(current.activeBoardId);
      const existingLoadIssueNotice = current.notices.find((notice) => notice.title === LOAD_ISSUE_NOTICE_TITLE);
      const noticesWithoutLoadIssue = current.notices.filter((notice) => notice.title !== LOAD_ISSUE_NOTICE_TITLE);
      const loadIssueCount = snapshot.loadIssues?.length ?? 0;
      const notices = loadIssueCount > 0
        ? [...noticesWithoutLoadIssue, {
          id: existingLoadIssueNotice?.id ?? id(),
          tone: 'error' as const,
          title: LOAD_ISSUE_NOTICE_TITLE,
          message: `检测到 ${loadIssueCount} 个加载或引用问题；数据原件已保留，可在“恢复与完整性”中逐条查看。`,
        }].slice(-5)
        : noticesWithoutLoadIssue;
      set({
        ready: true,
        vaultPath: snapshot.vaultPath,
        cards: [...snapshot.cards].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        boards: [...snapshot.boards].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        projects: snapshot.projects,
        folders: snapshot.folders,
        desktop,
        workspaceView: canPreserveBoard ? current.workspaceView : 'desktop',
        activeBoardId: canPreserveBoard ? current.activeBoardId : (snapshot.boards[0]?.id ?? null),
        boardHistory: canPreserveBoard ? current.boardHistory.filter((id) => boardIds.has(id)) : [],
        selection: null,
        focusedCardId: preserveNavigation && current.focusedCardId && cardIds.has(current.focusedCardId) ? current.focusedCardId : null,
        focusTransitionSource: preserveNavigation ? current.focusTransitionSource : null,
        sidePanelCardId: preserveNavigation && current.sidePanelCardId && cardIds.has(current.sidePanelCardId) ? current.sidePanelCardId : null,
        sidePanelOpen: preserveNavigation && current.sidePanelCardId && cardIds.has(current.sidePanelCardId) ? current.sidePanelOpen : false,
        commandHistory: emptyHistory(),
        saveState: 'saved',
        saveError: null,
        externalChangePaths: [],
        notices,
      });
      if (missingPlacements.length) scheduleSaveDesktop(desktop);
    },

    chooseVault: async () => {
      set({ saveState: 'saving', saveError: null });
      try {
        const snapshot = await vaultApi.chooseVault() as WorkspaceSnapshot | null;
        if (!snapshot) { set({ saveState: 'saved' }); return; }
        clearPendingSaves();
        if (snapshot.cards.length === 0 && snapshot.boards.length === 0) {
          const { card, board } = starterWorkspace();
          await Promise.all([vaultApi.saveCard(card), vaultApi.saveBoard(board)]);
          get().applySnapshot({ ...snapshot, cards: [card], boards: [board] });
        } else get().applySnapshot(snapshot);
        announceRecovery(snapshot);
        set({ saveState: 'saved', saveError: null, lastSavedAt: timestamp() });
      } catch (error) {
        setSaveFailure(error);
      }
    },
    revealVault: () => vaultApi.revealVault(),
    handleExternalVaultChange: async (event) => {
      const activeElement = document.activeElement as HTMLElement | null;
      const editing = Boolean(activeElement?.matches('input, textarea, [contenteditable="true"]') || activeElement?.closest('[contenteditable="true"]'));
      const dirty = saveScheduler.isDirty() || get().saveState === 'saving' || editing;
      if (dirty) {
        clearPendingSaves();
        set((state) => ({
          saveState: 'external-change',
          externalChangePaths: [...new Set([...state.externalChangePaths, ...event.paths])],
        }));
        return;
      }
      try {
        const snapshot = await vaultApi.loadWorkspace() as WorkspaceSnapshot;
        get().applySnapshot(snapshot, true);
        set({ saveState: 'saved', saveError: null, externalChangePaths: [], lastSavedAt: timestamp() });
      } catch (error) {
        setSaveFailure(error);
      }
    },
    reloadFromDisk: async () => {
      clearPendingSaves();
      set({ saveState: 'saving', saveError: null });
      try {
        const snapshot = await vaultApi.loadWorkspace() as WorkspaceSnapshot;
        get().applySnapshot(snapshot, true);
        set({ saveState: 'saved', saveError: null, externalChangePaths: [], lastSavedAt: timestamp() });
      } catch (error) {
        setSaveFailure(error);
      }
    },
    overwriteExternalChanges: persistWholeWorkspace,
    resolveExternalChange: async (changedPath, resolution) => {
      const normalizedPath = changedPath.replace(/\\/g, '/');
      set({ saveState: 'saving', saveError: null });
      try {
        if (resolution === 'disk') {
          const snapshot = await vaultApi.loadWorkspace() as WorkspaceSnapshot;
          const state = get();
          if (normalizedPath.startsWith('notes/')) {
            const relativePath = normalizedPath.slice('notes/'.length);
            const diskCard = snapshot.cards.find((card) => card.relativePath === relativePath);
            const currentCard = state.cards.find((card) => card.relativePath === relativePath);
            let cards = state.cards;
            let boards = state.boards;
            if (diskCard) cards = [...cards.filter((card) => card.id !== diskCard.id && card.relativePath !== relativePath), diskCard].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            else if (currentCard) {
              cards = cards.filter((card) => card.id !== currentCard.id);
              boards = boards.map((board) => {
                const removedIds = new Set(board.placements.filter((placement) => placement.kind === 'card' && placement.entityId === currentCard.id).map((placement) => placement.id));
                return removedIds.size ? { ...board, placements: board.placements.filter((placement) => !removedIds.has(placement.id)), connectors: board.connectors.filter((connector) => !removedIds.has(connector.from) && !removedIds.has(connector.to)), attachments: board.attachments.filter((attachment) => !removedIds.has(attachment.objectId) && !removedIds.has(attachment.attachedObjectId)) } : board;
              });
            }
            set({ cards, boards });
          } else if (normalizedPath.startsWith('boards/')) {
            const fileName = normalizedPath.slice('boards/'.length);
            const diskBoard = snapshot.boards.find((board) => board.fileName === fileName);
            const boards = diskBoard ? [...get().boards.filter((board) => board.id !== diskBoard.id && board.fileName !== fileName), diskBoard] : get().boards.filter((board) => board.fileName !== fileName);
            set({ boards });
          } else if (normalizedPath === '.opencanvas/desktop.json') set({ desktop: snapshot.desktop });
          else get().applySnapshot(snapshot, true);
        } else {
          const state = get();
          if (normalizedPath.startsWith('notes/')) {
            const card = state.cards.find((item) => `notes/${item.relativePath}` === normalizedPath);
            if (card) await vaultApi.saveCard(card); else await vaultApi.applyFilePlan({ cards: state.cards, boards: state.boards, projects: state.projects, folders: state.folders });
          } else if (normalizedPath.startsWith('boards/')) {
            const board = state.boards.find((item) => `boards/${item.fileName}` === normalizedPath);
            if (board) await vaultApi.saveBoard(board); else await vaultApi.applyFilePlan({ cards: state.cards, boards: state.boards, projects: state.projects, folders: state.folders });
          } else if (normalizedPath === '.opencanvas/desktop.json') await vaultApi.saveDesktopLayout(state.desktop);
          else await vaultApi.applyFilePlan({ cards: state.cards, boards: state.boards, projects: state.projects, folders: state.folders });
        }
        const remaining = get().externalChangePaths.filter((path) => path !== changedPath);
        set({ externalChangePaths: remaining, saveState: remaining.length ? 'external-change' : 'saved', saveError: null, lastSavedAt: timestamp() });
      } catch (error) { setSaveFailure(error); }
    },
    retrySaveAll: persistWholeWorkspace,
    flushPendingSaves: () => saveScheduler.flush(),

    createCard: (title = '未命名卡片', body = '', projectId) => {
      const cardId = id();
      const now = timestamp();
      const fileName = `${safeBaseName(title, 'card')}--${cardId.slice(0, 8)}.md`;
      const project = projectId ? get().projects.find((item) => item.id === projectId) : undefined;
      const card: Card = { id: cardId, fileName, relativePath: joinPath(project?.relativePath ?? '', fileName), title, body, createdAt: now, updatedAt: now };
      set((state) => ({ cards: [card, ...state.cards] }));
      scheduleSaveCard(card);
      return card;
    },

    createCardInFolder: (title = '未命名卡片', folderPath = '') => {
      const cardId = id();
      const now = timestamp();
      const folder = normalizeFolderPath(folderPath);
      const fileName = `${safeBaseName(title, 'card')}--${cardId.slice(0, 8)}.md`;
      const card: Card = { id: cardId, fileName, relativePath: joinPath(folder, fileName), title, body: '', createdAt: now, updatedAt: now };
      set((state) => ({
        cards: [card, ...state.cards],
        folders: folder && !state.folders.includes(folder) ? [...state.folders, folder].sort() : state.folders,
      }));
      scheduleSaveCard(card);
      return card;
    },

    createBoard: (title = '未命名白板', projectId) => {
      const boardId = id();
      const now = timestamp();
      const board: Board = { version: 4, id: boardId, fileName: `${safeBaseName(title, 'board')}--${boardId.slice(0, 8)}.board.json`, title, projectId, placements: [], connectors: [], attachments: [], viewport: { x: 120, y: 90, zoom: 0.8 }, createdAt: now, updatedAt: now };
      set((state) => ({
        boards: [board, ...state.boards],
        desktop: {
          ...state.desktop,
          placements: [
            ...state.desktop.placements,
            { boardId, x: 140 + (state.desktop.placements.length % 3) * 470, y: 120 + Math.floor(state.desktop.placements.length / 3) * 310, width: 430, height: 270 },
          ],
        },
      }));
      scheduleSaveBoard(board);
      scheduleSaveDesktop(get().desktop);
      return board;
    },

    organizeBoardAsProject: async (boardId, requestedName) => {
      const state = get();
      const board = state.boards.find((item) => item.id === boardId);
      if (!board) return null;
      if (board.projectId) return state.projects.find((project) => project.id === board.projectId) ?? null;
      const name = requestedName.trim() || board.title || '未命名项目';
      const basePath = safeBaseName(name, '项目');
      const taken = new Set([
        ...state.folders,
        ...state.projects.map((project) => project.relativePath),
        ...state.cards.map((card) => pathDirectory(card.relativePath)).filter(Boolean),
      ]);
      let relativePath = basePath;
      let suffix = 2;
      while (taken.has(relativePath)) relativePath = `${basePath} ${suffix++}`;
      const project: ProjectDirectory = { id: id(), name, relativePath, createdAt: timestamp() };
      const usedCardIds = new Set(board.placements.filter((placement) => placement.kind === 'card' && placement.entityId).map((placement) => placement.entityId!));
      const previousCardPaths: Record<string, string> = {};
      const movedCards = state.cards.map((card) => {
        if (!usedCardIds.has(card.id) || pathDirectory(card.relativePath)) return card;
        previousCardPaths[card.id] = card.relativePath;
        return { ...card, relativePath: joinPath(relativePath, card.fileName), updatedAt: timestamp() };
      });
      const cards = rewriteMarkdownLinksAfterMoves(state.cards, movedCards, timestamp());
      const boards = state.boards.map((item) => item.id === boardId ? { ...item, projectId: project.id, updatedAt: timestamp() } : item);
      const projects = [...state.projects, project];
      const folders = [...state.folders, relativePath];
      await applyFileState(cards, boards, projects, folders, previousCardPaths);
      get().pushNotice({ tone: 'success', title: '项目目录已建立', message: `白板已绑定到 Notes/${relativePath}` });
      return project;
    },

    unbindBoardProject: async (boardId) => {
      const state = get();
      const board = state.boards.find((item) => item.id === boardId);
      if (!board?.projectId) return false;
      const projectId = board.projectId;
      const boards = state.boards.map((item) => item.id === boardId ? { ...item, projectId: undefined, updatedAt: timestamp() } : item);
      const stillUsed = boards.some((item) => item.projectId === projectId);
      const projects = stillUsed ? state.projects : state.projects.filter((project) => project.id !== projectId);
      await applyFileState(state.cards, boards, projects, state.folders);
      get().pushNotice({ tone: 'success', title: '已解除目录绑定', message: 'Markdown 文件和现有目录均保持原位。' });
      return true;
    },

    exportBoardBundle: async (boardId) => {
      const state = get();
      const root = state.boards.find((board) => board.id === boardId);
      if (!root || !vaultApi.exportBundle) return null;
      const boardIds = new Set<string>();
      const queue = [root.id];
      while (queue.length) {
        const currentId = queue.shift()!;
        if (boardIds.has(currentId)) continue;
        boardIds.add(currentId);
        const current = state.boards.find((board) => board.id === currentId);
        for (const placement of current?.placements ?? []) if (placement.kind === 'board' && placement.entityId) queue.push(placement.entityId);
      }
      const boards = state.boards.filter((board) => boardIds.has(board.id));
      const cardIds = new Set(boards.flatMap((board) => board.placements.filter((placement) => placement.kind === 'card' && placement.entityId).map((placement) => placement.entityId!)));
      const cards = state.cards.filter((card) => cardIds.has(card.id));
      const exportedPath = await vaultApi.exportBundle({ name: `${root.title} 导出`, cards, boards });
      if (exportedPath) get().pushNotice({ tone: 'success', title: '项目已导出', message: exportedPath });
      return exportedPath;
    },

    exportOpenFormat: async (format) => {
      const state = get();
      if (!vaultApi.exportOpenFormat) return null;
      if (format === 'obsidian-canvas') {
        const board = state.boards.find((item) => item.id === state.activeBoardId);
        if (!board) return null;
        const exportedPath = await vaultApi.exportOpenFormat({ format, name: board.title, cards: state.cards, boards: state.boards, activeBoardId: board.id, canvasDocument: boardToObsidianCanvas(board, state.cards, state.boards) });
        if (exportedPath) get().pushNotice({ tone: 'success', title: 'Canvas 已导出', message: exportedPath });
        return exportedPath;
      }
      const exportedPath = await vaultApi.exportOpenFormat({ format, name: 'OpenCanvas 知识库', cards: state.cards, boards: state.boards });
      if (exportedPath) get().pushNotice({ tone: 'success', title: '知识库已导出', message: exportedPath });
      return exportedPath;
    },

    importOpenFormat: async () => {
      const prepared = await get().prepareOpenFormatImport();
      if (!prepared) return false;
      return get().confirmOpenFormatImport('rename');
    },

    prepareOpenFormatImport: async () => {
      const imported = await vaultApi.importOpenFormat?.();
      if (!imported) return false;
      set({ pendingImport: imported });
      return true;
    },

    cancelOpenFormatImport: async () => {
      const pending = get().pendingImport;
      if (pending) await vaultApi.cancelOpenFormatImport?.(pending.sessionId);
      set({ pendingImport: null });
    },

    confirmOpenFormatImport: async (attachmentStrategy = 'rename') => {
      const imported = get().pendingImport;
      if (!imported) return false;
      const state = get();
      try {
        if (imported.format === 'obsidian-canvas') {
          if (!isObsidianCanvasDocument(imported.canvasDocument)) throw new Error('Canvas 文件结构无效');
          const converted = obsidianCanvasToBoard(imported.canvasDocument, imported.name, state.cards, state.boards);
          const sourceByPath = new Map((imported.sourceFiles ?? []).map((file) => [file.relativePath.replace(/\\/g, '/').replace(/^notes\//i, '').toLocaleLowerCase(), file.content]));
          converted.createdCards = converted.createdCards.map((card) => {
            const raw = sourceByPath.get(card.relativePath.toLocaleLowerCase());
            if (!raw) return card;
            const frontmatter = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
            return { ...card, body: frontmatter ? raw.slice(frontmatter[0].length).replace(/\r?\n$/, '') : raw, updatedAt: timestamp() };
          });
          const cards = [...converted.createdCards, ...state.cards];
          const boards = [converted.board, ...state.boards];
          const desktop = { ...state.desktop, placements: [...state.desktop.placements, { boardId: converted.board.id, x: 140, y: 120, width: 430, height: 270 }] };
          await vaultApi.commitOpenFormatImport?.({ sessionId: imported.sessionId, attachmentStrategy, cards: converted.createdCards, boards: [converted.board], desktop });
          set({ cards, boards, desktop, workspaceView: 'board', activeBoardId: converted.board.id, boardHistory: [], selection: null, pendingImport: null });
          get().pushNotice({ tone: 'success', title: 'Canvas 导入完成', message: `已加入 1 个白板和 ${converted.createdCards.length} 张卡片。` });
          return true;
        }
        if (!imported.bundle) throw new Error('OpenCanvas ZIP 缺少清单');
        const normalized = normalizeWorkspaceSnapshot({ cards: imported.bundle.cards, boards: imported.bundle.boards });
        const existingCardIds = new Set(state.cards.map((card) => card.id));
        const existingBoardIds = new Set(state.boards.map((board) => board.id));
        const usedPaths = new Set(state.cards.map((card) => card.relativePath.toLocaleLowerCase()));
        const usedBoardFiles = new Set(state.boards.map((board) => board.fileName.toLocaleLowerCase()));
        const cardIdMap = new Map<string, string>();
        const boardIdMap = new Map<string, string>();
        for (const card of normalized.cards) cardIdMap.set(card.id, existingCardIds.has(card.id) ? id() : card.id);
        for (const board of normalized.boards) boardIdMap.set(board.id, existingBoardIds.has(board.id) ? id() : board.id);
        const importedCards = normalized.cards.map((card) => {
          let relativePath = sanitizeRelativeFilePath(card.relativePath || card.fileName, safeBaseName(card.title, 'card'), '.md');
          if (usedPaths.has(relativePath.toLocaleLowerCase())) {
            const folder = normalizeFolderPath(`导入/${imported.name}`);
            const sanitizedFileName = relativePath.split('/').at(-1)!;
            relativePath = joinPath(folder, sanitizedFileName);
            let suffix = 2;
            while (usedPaths.has(relativePath.toLocaleLowerCase())) relativePath = joinPath(folder, `${sanitizedFileName.replace(/\.md$/i, '')} ${suffix++}.md`);
          }
          usedPaths.add(relativePath.toLocaleLowerCase());
          return { ...card, id: cardIdMap.get(card.id)!, relativePath, updatedAt: timestamp() };
        });
        const importedBoards = normalized.boards.map((board) => {
          const nextId = boardIdMap.get(board.id)!;
          let fileName = sanitizeFileName(board.fileName, safeBaseName(board.title, '导入白板'), '.board.json');
          if (usedBoardFiles.has(fileName.toLocaleLowerCase())) fileName = `${safeBaseName(board.title, '导入白板')}--${nextId.slice(0, 8)}.board.json`;
          let suffix = 2;
          while (usedBoardFiles.has(fileName.toLocaleLowerCase())) fileName = `${safeBaseName(board.title, '导入白板')}--${nextId.slice(0, 8)}-${suffix++}.board.json`;
          usedBoardFiles.add(fileName.toLocaleLowerCase());
          return {
            ...board,
            id: nextId,
            fileName,
            projectId: undefined,
            placements: board.placements.map((placement) => placement.kind === 'card' && placement.entityId ? { ...placement, entityId: cardIdMap.get(placement.entityId) || placement.entityId } : placement.kind === 'board' && placement.entityId ? { ...placement, entityId: boardIdMap.get(placement.entityId) || placement.entityId } : placement),
            updatedAt: timestamp(),
          };
        });
        const nestedIds = new Set(importedBoards.flatMap((board) => board.placements.filter((placement) => placement.kind === 'board' && placement.entityId).map((placement) => placement.entityId!)));
        const roots = importedBoards.filter((board) => !nestedIds.has(board.id));
        const desktop = { ...state.desktop, placements: [...state.desktop.placements, ...roots.map((board, index) => ({ boardId: board.id, x: 140 + (index % 3) * 470, y: 120 + Math.floor(index / 3) * 310, width: 430, height: 270 }))] };
        const committed = await vaultApi.commitOpenFormatImport?.({ sessionId: imported.sessionId, attachmentStrategy, cards: importedCards, boards: importedBoards, desktop }) ?? { attachmentPathMap: {} };
        const rewriteAttachmentPaths = (body: string) => Object.entries(committed.attachmentPathMap).reduce((value, [from, to]) => value.replaceAll(from, to), body);
        const committedCards = importedCards.map((card) => ({ ...card, body: rewriteAttachmentPaths(card.body) }));
        const cards = [...committedCards, ...state.cards];
        const boards = [...importedBoards, ...state.boards];
        set({ cards, boards, desktop, workspaceView: importedBoards.length ? 'board' : state.workspaceView, activeBoardId: importedBoards[0]?.id || state.activeBoardId, boardHistory: [], selection: null, pendingImport: null });
        get().pushNotice({ tone: 'success', title: '知识库导入完成', message: `已加入 ${importedBoards.length} 个白板和 ${committedCards.length} 张卡片。` });
        return true;
      } catch (error) {
        set({ pendingImport: imported, selection: null });
        throw error;
      }
    },

    createFolder: async (requestedName, parentPath = '') => {
      const name = safeBaseName(requestedName, '');
      const parent = normalizeFolderPath(parentPath);
      if (!name) return null;
      const relativePath = joinPath(parent, name);
      const state = get();
      const taken = new Set([...state.folders, ...state.projects.map((project) => project.relativePath)].map((path) => path.toLocaleLowerCase()));
      if (taken.has(relativePath.toLocaleLowerCase())) return null;
      await applyFileState(state.cards, state.boards, state.projects, [...state.folders, relativePath]);
      return relativePath;
    },

    moveCardToFolder: async (cardId, requestedFolder = '') => {
      const state = get();
      const card = state.cards.find((item) => item.id === cardId);
      if (!card) return false;
      const folder = normalizeFolderPath(requestedFolder);
      let fileName = card.fileName;
      let nextPath = joinPath(folder, fileName);
      if (nextPath === card.relativePath) return true;
      const occupied = new Set(state.cards.filter((item) => item.id !== cardId).map((item) => item.relativePath.toLocaleLowerCase()));
      if (occupied.has(nextPath.toLocaleLowerCase())) {
        const extension = fileName.toLowerCase().endsWith('.md') ? '.md' : '';
        const base = extension ? fileName.slice(0, -extension.length) : fileName;
        fileName = `${base}--${card.id.slice(0, 8)}${extension}`;
        nextPath = joinPath(folder, fileName);
      }
      const movedCards = state.cards.map((item) => item.id === cardId ? { ...item, fileName, relativePath: nextPath, updatedAt: timestamp() } : item);
      const cards = rewriteMarkdownLinksAfterMoves(state.cards, movedCards, timestamp());
      await applyFileState(cards, state.boards, state.projects, folder ? [...state.folders, folder] : state.folders, { [cardId]: card.relativePath });
      return true;
    },

    renameFolder: async (folderPath, requestedName) => {
      const from = normalizeFolderPath(folderPath);
      const name = safeBaseName(requestedName, '');
      if (!from || !name) return false;
      return relocateFolder(from, joinPath(pathDirectory(from), name));
    },

    moveFolder: async (folderPath, targetParent = '') => {
      const from = normalizeFolderPath(folderPath);
      if (!from) return false;
      return relocateFolder(from, joinPath(normalizeFolderPath(targetParent), from.split('/').at(-1)!));
    },

    renameCardFile: async (cardId, requestedTitle) => {
      const state = get();
      const card = state.cards.find((item) => item.id === cardId);
      const title = requestedTitle.trim() || '未命名卡片';
      if (!card) return false;
      const directory = pathDirectory(card.relativePath);
      let fileName = `${safeBaseName(title, 'card')}--${card.id.slice(0, 8)}.md`;
      let relativePath = joinPath(directory, fileName);
      const occupied = new Set(state.cards.filter((item) => item.id !== cardId).map((item) => item.relativePath.toLocaleLowerCase()));
      if (occupied.has(relativePath.toLocaleLowerCase())) {
        fileName = `${safeBaseName(title, 'card')}-${card.id.slice(0, 12)}.md`;
        relativePath = joinPath(directory, fileName);
      }
      const next = { ...card, title, fileName, relativePath, updatedAt: timestamp() };
      const renamedCards = state.cards.map((item) => item.id === cardId ? next : item);
      const cards = rewriteMarkdownLinksAfterMoves(state.cards, renamedCards, timestamp());
      await applyFileState(cards, state.boards, state.projects, state.folders, { [cardId]: card.relativePath });
      return true;
    },

    deleteCard: async (cardId) => {
      const state = get();
      const card = state.cards.find((item) => item.id === cardId);
      if (!card) return false;
      const boards = state.boards.map((board) => {
        const removedIds = new Set(board.placements.filter((placement) => placement.kind === 'card' && placement.entityId === cardId).map((placement) => placement.id));
        if (!removedIds.size) return board;
        return {
          ...board,
          placements: board.placements.filter((placement) => !removedIds.has(placement.id)),
          connectors: board.connectors.filter((connector) => !removedIds.has(connector.from) && !removedIds.has(connector.to)),
          attachments: board.attachments.filter((attachment) => !removedIds.has(attachment.objectId) && !removedIds.has(attachment.attachedObjectId)),
          updatedAt: timestamp(),
        };
      });
      await applyFileState(state.cards.filter((item) => item.id !== cardId), boards, state.projects, state.folders, {}, [], [card.relativePath]);
      set((current) => ({
        focusedCardId: current.focusedCardId === cardId ? null : current.focusedCardId,
        sidePanelCardId: current.sidePanelCardId === cardId ? null : current.sidePanelCardId,
        sidePanelOpen: current.sidePanelCardId === cardId ? false : current.sidePanelOpen,
        selection: null,
      }));
      get().pushNotice({ tone: 'success', title: '卡片已移入回收目录', message: card.title || card.fileName });
      return true;
    },

    deleteFolder: async (folderPath) => {
      const from = normalizeFolderPath(folderPath);
      if (!from) return false;
      const state = get();
      const deletedCards = state.cards.filter((card) => pathDirectory(card.relativePath) === from || pathDirectory(card.relativePath).startsWith(`${from}/`));
      const deletedCardIds = new Set(deletedCards.map((card) => card.id));
      const deletedProjects = state.projects.filter((project) => project.relativePath === from || project.relativePath.startsWith(`${from}/`));
      const deletedProjectIds = new Set(deletedProjects.map((project) => project.id));
      const boards = state.boards.map((board) => {
        const removedIds = new Set(board.placements.filter((placement) => placement.kind === 'card' && placement.entityId && deletedCardIds.has(placement.entityId)).map((placement) => placement.id));
        const projectRemoved = Boolean(board.projectId && deletedProjectIds.has(board.projectId));
        if (!removedIds.size && !projectRemoved) return board;
        return {
          ...board,
          projectId: projectRemoved ? undefined : board.projectId,
          placements: board.placements.filter((placement) => !removedIds.has(placement.id)),
          connectors: board.connectors.filter((connector) => !removedIds.has(connector.from) && !removedIds.has(connector.to)),
          attachments: board.attachments.filter((attachment) => !removedIds.has(attachment.objectId) && !removedIds.has(attachment.attachedObjectId)),
          updatedAt: timestamp(),
        };
      });
      await applyFileState(
        state.cards.filter((card) => !deletedCardIds.has(card.id)),
        boards,
        state.projects.filter((project) => !deletedProjectIds.has(project.id)),
        state.folders.filter((folder) => folder !== from && !folder.startsWith(`${from}/`)),
        {},
        [],
        [],
        [],
        [from],
      );
      set((current) => ({
        focusedCardId: current.focusedCardId && deletedCardIds.has(current.focusedCardId) ? null : current.focusedCardId,
        sidePanelCardId: current.sidePanelCardId && deletedCardIds.has(current.sidePanelCardId) ? null : current.sidePanelCardId,
        sidePanelOpen: current.sidePanelCardId && deletedCardIds.has(current.sidePanelCardId) ? false : current.sidePanelOpen,
        selection: null,
      }));
      get().pushNotice({ tone: 'success', title: '文件夹已移入回收目录', message: deletedCards.length ? `${from} · ${deletedCards.length} 张卡片` : from });
      return true;
    },

    deleteBoard: async (boardId) => {
      const state = get();
      const deleted = state.boards.find((board) => board.id === boardId);
      if (!deleted) return false;
      const boards = state.boards.filter((board) => board.id !== boardId).map((board) => {
        const removedIds = new Set(board.placements.filter((placement) => placement.kind === 'board' && placement.entityId === boardId).map((placement) => placement.id));
        if (!removedIds.size) return board;
        return {
          ...board,
          placements: board.placements.filter((placement) => !removedIds.has(placement.id)),
          connectors: board.connectors.filter((connector) => !removedIds.has(connector.from) && !removedIds.has(connector.to)),
          attachments: board.attachments.filter((attachment) => !removedIds.has(attachment.objectId) && !removedIds.has(attachment.attachedObjectId)),
          updatedAt: timestamp(),
        };
      });
      await applyFileState(state.cards, boards, state.projects, state.folders, {}, [], [], [deleted.fileName]);
      const desktop = { ...state.desktop, placements: state.desktop.placements.filter((placement) => placement.boardId !== boardId) };
      const remainingBoardIds = boards.map((board) => board.id);
      const deletedActiveBoard = state.activeBoardId === boardId;
      const navigation = deletedActiveBoard
        ? { workspaceView: 'desktop' as const, activeBoardId: findRootBoards(boards)[0]?.id ?? boards[0]?.id ?? null, boardHistory: [] }
        : {
            workspaceView: state.workspaceView,
            activeBoardId: state.activeBoardId,
            boardHistory: boardHistoryAfterDeletion(state.boardHistory, boardId, remainingBoardIds),
          };
      set({ desktop, ...navigation, selection: null });
      persistNavigation(navigation);
      scheduleSaveDesktop(desktop);
      get().pushNotice({ tone: 'success', title: '白板已移入回收目录', message: deleted.title });
      return true;
    },

    updateDesktopPlacement: (boardId, changes) => {
      set((state) => {
        const existingIndex = state.desktop.placements.findIndex((placement) => placement.boardId === boardId);
        const desktop = {
          ...state.desktop,
          placements: existingIndex >= 0
            ? state.desktop.placements.map((placement, index) => index === existingIndex ? { ...placement, ...changes } : placement)
            : [...state.desktop.placements, { boardId, x: 120, y: 100, width: 430, height: 270, ...changes }],
        };
        scheduleSaveDesktop(desktop);
        return { desktop };
      });
    },
    updateDesktopPlacements: (changes) => {
      set((state) => {
        const desktop = {
          ...state.desktop,
          placements: state.desktop.placements.map((placement) => changes[placement.boardId] ? { ...placement, ...changes[placement.boardId] } : placement),
        };
        scheduleSaveDesktop(desktop);
        return { desktop };
      });
    },
    setDesktopViewport: (viewport) => set((state) => {
      const desktop = { ...state.desktop, viewport };
      scheduleSaveDesktop(desktop);
      return { desktop };
    }),

    updateCard: (cardId, changes) => {
      let updated: Card | undefined;
      set((state) => ({ cards: state.cards.map((card) => {
        if (card.id !== cardId) return card;
        updated = { ...card, ...changes, updatedAt: timestamp() };
        return updated;
      }) }));
      if (updated) scheduleSaveCard(updated);
    },

    renameTag: async (oldTag, nextTag) => {
      const cleaned = nextTag.trim().replace(/^#/, '').replace(/\s+/g, '-');
      if (!cleaned) return;
      const state = get();
      const cards = state.cards.map((card) => {
        const body = replaceMarkdownTag(card.body, oldTag, cleaned);
        if (body === card.body) return card;
        return { ...card, body, updatedAt: timestamp() };
      });
      await applyFileState(cards, state.boards, state.projects, state.folders);
    },

    deleteTag: async (tag) => {
      const state = get();
      const cards = state.cards.map((card) => {
        const body = replaceMarkdownTag(card.body, tag);
        if (body === card.body) return card;
        return { ...card, body, updatedAt: timestamp() };
      });
      await applyFileState(cards, state.boards, state.projects, state.folders);
    },

    updateBoard: (boardId, changes, options) => {
      const state = get();
      const before = state.boards.find((board) => board.id === boardId);
      if (!before) return;
      const after = { ...before, ...changes, updatedAt: timestamp() };
      replaceBoard(after);
      if (boardId === state.activeBoardId && !boardTransaction) {
        set((state) => ({ commandHistory: recordHistory(state.commandHistory, { label: '重命名白板', boardId, before, after }) }));
      } else if (!boardTransaction && !options?.mergeCreated) {
        const active = state.boards.find((board) => board.id === state.activeBoardId);
        if (active) set((current) => ({ commandHistory: recordHistory(current.commandHistory, { label: '重命名嵌套白板', boardId: active.id, before: active, after: active, relatedBoardChanges: [{ before, after }] }) }));
      }
    },

    createCardPlacement: (position = { x: 140, y: 120 }) => {
      const state = get();
      const active = state.boards.find((board) => board.id === state.activeBoardId);
      if (!active) return null;
      const cardId = id();
      const now = timestamp();
      const title = '未命名卡片';
      const fileName = `${safeBaseName(title, 'card')}--${cardId.slice(0, 8)}.md`;
      const project = active.projectId ? state.projects.find((item) => item.id === active.projectId) : undefined;
      const card: Card = { id: cardId, fileName, relativePath: joinPath(project?.relativePath ?? '', fileName), title, body: '', createdAt: now, updatedAt: now };
      const basePlacement: BoardPlacement = {
        id: id(), kind: 'card', entityId: card.id, x: position.x, y: position.y,
        width: Math.max(300, position.width ?? DEFAULT_PLACEMENT_DIMENSIONS.card.width),
        height: Math.max(145, position.height ?? DEFAULT_PLACEMENT_DIMENSIONS.card.height),
        color: 'paper',
      };
      const placement = { ...basePlacement, ...initialSectionMembership(position, basePlacement, active.placements) };
      const nextBoard = { ...active, placements: expandSectionsToMaintainPadding([...active.placements, placement]), updatedAt: now };
      const commandHistory = recordHistory(state.commandHistory, { label: '新建卡片', boardId: active.id, before: active, after: nextBoard, createdCards: [card] });
      set({ cards: [card, ...state.cards], boards: state.boards.map((board) => board.id === active.id ? nextBoard : board), commandHistory, selection: { kind: 'placement', id: placement.id, ids: [placement.id] } });
      scheduleSaveCard(card);
      scheduleSaveBoard(nextBoard);
      return placement;
    },
    createNestedBoardPlacement: (position = { x: 140, y: 120 }) => {
      const state = get();
      const active = state.boards.find((board) => board.id === state.activeBoardId);
      if (!active) return null;
      const boardId = id();
      const now = timestamp();
      const title = '嵌套白板';
      const child: Board = { version: 4, id: boardId, fileName: `${safeBaseName(title, 'board')}--${boardId.slice(0, 8)}.board.json`, title, projectId: active.projectId, placements: [], connectors: [], attachments: [], viewport: { x: 120, y: 90, zoom: 0.8 }, createdAt: now, updatedAt: now };
      const desktopPlacement: DesktopBoardPlacement = { boardId, x: 140 + (state.desktop.placements.length % 3) * 470, y: 120 + Math.floor(state.desktop.placements.length / 3) * 310, width: 430, height: 270 };
      const basePlacement: BoardPlacement = {
        id: id(), kind: 'board', entityId: child.id, x: position.x, y: position.y,
        width: Math.max(300, position.width ?? DEFAULT_PLACEMENT_DIMENSIONS.board.width),
        height: Math.max(145, position.height ?? DEFAULT_PLACEMENT_DIMENSIONS.board.height),
        color: 'blue',
      };
      const placement = { ...basePlacement, ...initialSectionMembership(position, basePlacement, active.placements) };
      const nextBoard = { ...active, placements: expandSectionsToMaintainPadding([...active.placements, placement]), updatedAt: now };
      const commandHistory = recordHistory(state.commandHistory, { label: '新建嵌套白板', boardId: active.id, before: active, after: nextBoard, createdBoards: [child], createdDesktopPlacements: [desktopPlacement] });
      set({ boards: [child, ...state.boards.map((board) => board.id === active.id ? nextBoard : board)], desktop: { ...state.desktop, placements: [...state.desktop.placements, desktopPlacement] }, commandHistory, selection: { kind: 'placement', id: placement.id, ids: [placement.id] } });
      scheduleSaveBoard(child);
      scheduleSaveBoard(nextBoard);
      scheduleSaveDesktop(get().desktop);
      return placement;
    },
    addCardPlacement: (cardId, position = { x: 140, y: 120 }) => {
      const state = get();
      const active = state.boards.find((board) => board.id === state.activeBoardId);
      if (!active || !state.cards.some((card) => card.id === cardId)) return null;
      const basePlacement: BoardPlacement = {
        id: id(), kind: 'card', entityId: cardId, x: position.x, y: position.y,
        width: Math.max(300, position.width ?? DEFAULT_PLACEMENT_DIMENSIONS.card.width),
        height: Math.max(145, position.height ?? DEFAULT_PLACEMENT_DIMENSIONS.card.height),
        color: 'paper',
      };
      const placement = { ...basePlacement, ...initialSectionMembership(position, basePlacement, active.placements) };
      mutateActiveBoard('放置卡片', (board) => ({ ...board, placements: expandSectionsToMaintainPadding([...board.placements, placement]), updatedAt: timestamp() }));
      set({ selection: { kind: 'placement', id: placement.id } });
      return placement;
    },
    addBoardPlacement: (boardId, position = { x: 140, y: 120 }) => {
      const state = get();
      const active = state.boards.find((board) => board.id === state.activeBoardId);
      if (!active || !state.boards.some((board) => board.id === boardId) || wouldCreateBoardCycle(state.boards, active.id, boardId)) {
        if (state.activeBoardId && boardId !== state.activeBoardId) state.pushNotice({ tone: 'info', title: '无法嵌套这个白板', message: '这样会形成循环嵌套；请从现有层级进入或调整白板关系。' });
        return null;
      }
      const basePlacement: BoardPlacement = {
        id: id(), kind: 'board', entityId: boardId, x: position.x, y: position.y,
        width: Math.max(300, position.width ?? DEFAULT_PLACEMENT_DIMENSIONS.board.width),
        height: Math.max(145, position.height ?? DEFAULT_PLACEMENT_DIMENSIONS.board.height),
        color: 'blue',
      };
      const placement = { ...basePlacement, ...initialSectionMembership(position, basePlacement, active.placements) };
      mutateActiveBoard('放置嵌套白板', (board) => ({ ...board, placements: expandSectionsToMaintainPadding([...board.placements, placement]), updatedAt: timestamp() }));
      set({ selection: { kind: 'placement', id: placement.id } });
      return placement;
    },
    addTextPlacement: (position = { x: 160, y: 140 }) => {
      const state = get();
      const active = state.boards.find((board) => board.id === state.activeBoardId);
      if (!active) return null;
      const basePlacement: BoardPlacement = { id: id(), kind: 'text', text: '输入文字', x: position.x, y: position.y, width: 300, height: 90, color: 'transparent' };
      const placement = { ...basePlacement, ...initialSectionMembership(position, basePlacement, active.placements) };
      mutateActiveBoard('添加文字', (board) => ({ ...board, placements: expandSectionsToMaintainPadding([...board.placements, placement]), updatedAt: timestamp() }));
      set({ selection: { kind: 'placement', id: placement.id } });
      return placement;
    },
    addSectionPlacement: (position = { x: 160, y: 140 }) => {
      const state = get();
      const active = state.boards.find((board) => board.id === state.activeBoardId);
      if (!active) return null;
      const sectionNumber = active.placements.filter((placement) => placement.isFrame).length + 1;
      const basePlacement: BoardPlacement = {
        id: id(), kind: 'text', text: `区块 ${sectionNumber}`, isFrame: true,
        x: position.x, y: position.y,
        width: Math.max(MINIMUM_SECTION_DIMENSIONS.width, position.width ?? DEFAULT_SECTION_DIMENSIONS.width),
        height: Math.max(MINIMUM_SECTION_DIMENSIONS.height, position.height ?? DEFAULT_SECTION_DIMENSIONS.height),
        color: 'transparent',
        zIndex: Math.min(0, ...active.placements.map((placement) => placement.zIndex ?? 0)) - 1,
      };
      const requestedParents = new Set([
        ...(position.sectionId ? [position.sectionId] : []),
        ...(position.sectionIds ?? []),
      ]);
      const parentIds = active.placements
        .filter((placement) => placement.isFrame && requestedParents.has(placement.id) && placementFullyContains(placement, basePlacement))
        .map((placement) => placement.id);
      const placement: BoardPlacement = parentIds.length
        ? { ...basePlacement, sectionId: parentIds[0], sectionIds: parentIds }
        : basePlacement;
      const parentSet = new Set(parentIds);
      mutateActiveBoard('创建区块', (board) => {
        const existing = board.placements.map((candidate) => {
          if (parentSet.has(candidate.id) || !placementFullyContains(placement, candidate)) return candidate;
          const sectionIds = [...new Set([...placementSectionIds(candidate), placement.id])];
          return { ...candidate, sectionId: sectionIds[0], sectionIds };
        });
        return { ...board, placements: expandSectionsToMaintainPadding([placement, ...existing]), updatedAt: timestamp() };
      });
      set({ selection: { kind: 'placement', id: placement.id, ids: [placement.id] } });
      return placement;
    },
    updatePlacement: (placementId, changes) => mutateActiveBoard(null, (board) => ({ ...board, placements: board.placements.map((placement) => placement.id === placementId ? { ...placement, ...changes } : placement), updatedAt: timestamp() })),
    updatePlacements: (changes) => mutateActiveBoard(null, (board) => ({ ...board, placements: board.placements.map((placement) => changes[placement.id] ? { ...placement, ...changes[placement.id] } : placement), updatedAt: timestamp() })),
    updateBoardLayout: (changes, options) => mutateActiveBoard(null, (board) => {
      const placements = board.placements.map((placement) => {
        const change = changes[placement.id];
        if (!change) return placement;
        return applyPlacementLayoutChange(placement, change);
      });
      return {
        ...board,
        placements: expandSectionsToMaintainPadding(placements),
        connectors: connectorsAfterPlacementMotion(board.connectors, board.placements, changes, options),
        // Legacy auto-push attachments are intentionally cleared. Snapping only
        // changes the object being manipulated and never pushes its neighbours.
        attachments: [],
        updatedAt: timestamp(),
      };
    }),
    settleBoardLayout: (movedIds) => mutateActiveBoard(null, (board) => {
      const changes = reconcileSectionMembershipChanges(board.placements, movedIds);
      if (!Object.keys(changes).length) return board;
      return {
        ...board,
        placements: expandSectionsToMaintainPadding(board.placements.map((placement) => changes[placement.id]
          ? { ...placement, ...changes[placement.id] }
          : placement)),
        updatedAt: timestamp(),
      };
    }),
    transferPlacementsToBoard: (targetBoardId, placementIds, options = {}) => {
      const state = get();
      const source = state.boards.find((board) => board.id === state.activeBoardId);
      const target = state.boards.find((board) => board.id === targetBoardId);
      if (!source || !target || source.id === target.id) return false;
      const transaction = boardTransaction?.boardId === source.id ? boardTransaction : null;
      const transferSource = options.copy && transaction ? transaction.before : source;
      // Copying a dragged Section into a nested whiteboard includes its concrete
      // contents but not the Section frame itself. Moving remains a
      // structural transfer and therefore keeps the frame.
      const transferIds = options.copy
        ? placementIds.filter((placementId) => !transferSource.placements.find((placement) => placement.id === placementId)?.isFrame)
        : placementIds;
      if (!transferIds.length) return false;
      const selected = transferSource.placements.filter((placement) => transferIds.includes(placement.id));
      if (selected.some((placement) => placement.kind === 'board' && placement.entityId && wouldCreateBoardCycle(state.boards, target.id, placement.entityId))) {
        state.pushNotice({ tone: 'info', title: '无法移入这个白板', message: '移动后会形成循环嵌套，请选择其他白板。' });
        return false;
      }
      const result = transferBoardPlacements(transferSource, target, transferIds, { copy: options.copy, createId: id, now: timestamp() });
      if (!result) return false;
      boardTransaction = null;
      const commandHistory = recordHistory(state.commandHistory, {
        label: options.copy ? '复制到嵌套白板' : '移入嵌套白板',
        boardId: source.id,
        before: transaction?.before ?? source,
        after: result.source,
        relatedBoardChanges: [{ before: target, after: result.target }],
      });
      set({
        boards: state.boards.map((board) => board.id === source.id ? result.source : board.id === target.id ? result.target : board),
        commandHistory,
        selection: null,
      });
      scheduleSaveBoard(result.source);
      scheduleSaveBoard(result.target);
      get().pushNotice({
        tone: 'success',
        title: options.copy ? `已复制到「${target.title}」` : `已移入「${target.title}」`,
        message: `${result.destinationPlacementIds.length} 个对象已${options.copy ? '复制' : '移动'}到嵌套白板。`,
      });
      return true;
    },
    connectPlacements: (from, to, options = {}) => {
      if (from === to) return;
      mutateActiveBoard('连接对象', (board) => {
        const source = board.placements.find((placement) => placement.id === from);
        const target = board.placements.find((placement) => placement.id === to);
        return !source || !target || source.isFrame || target.isFrame || board.connectors.some((connector) => connector.from === from && connector.to === to) ? board : ({
          ...board,
          connectors: [...board.connectors, { id: id(), from, to, color: 'neutral', lineStyle: 'curve', arrow: 'end', width: 3.5, ...options }],
          updatedAt: timestamp(),
        });
      });
    },
    updateConnector: (connectorId, changes) => mutateActiveBoard('修改连接', (board) => ({ ...board, connectors: board.connectors.map((connector) => connector.id === connectorId ? { ...connector, ...changes } : connector), updatedAt: timestamp() })),

    removeSelection: () => {
      const selection = get().selection;
      if (!selection) return;
      mutateActiveBoard('删除对象', (board) => {
        if (selection.kind === 'connector') return { ...board, connectors: board.connectors.filter((connector) => connector.id !== selection.id), updatedAt: timestamp() };
        const ids = new Set(selection.ids?.length ? selection.ids : [selection.id]);
        const removedSections = board.placements.filter((placement) => placement.isFrame && ids.has(placement.id));
        const removedLegacyGroups = new Set(removedSections.map((placement) => placement.groupId).filter((value): value is string => Boolean(value)));
        return {
          ...board,
          placements: board.placements.filter((placement) => !ids.has(placement.id)).map((placement) => {
            const sectionIds = placementSectionIds(placement).filter((sectionId) => !ids.has(sectionId));
            return {
              ...placement,
              sectionId: sectionIds[0],
              sectionIds: sectionIds.length ? sectionIds : undefined,
              sectionBaseBounds: placement.isFrame ? undefined : placement.sectionBaseBounds,
              groupId: placement.groupId && removedLegacyGroups.has(placement.groupId) ? undefined : placement.groupId,
            };
          }),
          connectors: board.connectors.filter((connector) => !ids.has(connector.from) && !ids.has(connector.to)),
          attachments: board.attachments.filter((attachment) => !ids.has(attachment.objectId) && !ids.has(attachment.attachedObjectId)),
          updatedAt: timestamp(),
        };
      });
      set({ selection: null });
    },

    duplicateSelection: () => {
      const board = get().boards.find((item) => item.id === get().activeBoardId);
      const selection = get().selection;
      if (!board || selection?.kind !== 'placement') return;
      const ids = new Set(selection.ids?.length ? selection.ids : [selection.id]);
      pastePayload({ type: 'opencanvas/placements', placements: board.placements.filter((item) => ids.has(item.id)), connectors: board.connectors.filter((item) => ids.has(item.from) && ids.has(item.to)), attachments: board.attachments.filter((item) => ids.has(item.objectId) && ids.has(item.attachedObjectId)) });
    },
    duplicateSelectionAsIndependentCards: () => {
      const state = get();
      const board = state.boards.find((item) => item.id === state.activeBoardId);
      const selection = state.selection;
      if (!board || selection?.kind !== 'placement') return;
      const ids = new Set(selection.ids?.length ? selection.ids : [selection.id]);
      const sources = board.placements.filter((placement) => ids.has(placement.id) && placement.kind === 'card' && placement.entityId);
      if (!sources.length) return;
      const now = timestamp();
      const cards: Card[] = [];
      const placements: BoardPlacement[] = [];
      const placementReplacementMap: Record<string, string> = {};
      const project = board.projectId ? state.projects.find((item) => item.id === board.projectId) : undefined;
      for (const placement of sources) {
        const source = state.cards.find((card) => card.id === placement.entityId);
        if (!source) continue;
        const cardId = id();
        const title = `${source.title || '未命名卡片'} 副本`;
        const fileName = `${safeBaseName(title, 'card')}--${cardId.slice(0, 8)}.md`;
        cards.push({
          id: cardId,
          fileName,
          relativePath: joinPath(project?.relativePath ?? '', fileName),
          title,
          body: source.body,
          createdAt: now,
          updatedAt: now,
        });
        const placementId = id();
        placementReplacementMap[placement.id] = placementId;
        placements.push({ ...placement, id: placementId, entityId: cardId, x: placement.x + 32, y: placement.y + 32 });
      }
      if (!placements.length) return;
      const nextBoard = { ...board, placements: [...board.placements, ...placements], updatedAt: now };
      const commandHistory = recordHistory(state.commandHistory, {
        label: '复制为独立卡片',
        boardId: board.id,
        before: board,
        after: nextBoard,
        createdCards: cards,
        placementReplacementMap,
      });
      set((current) => ({
        cards: [...cards, ...current.cards],
        boards: current.boards.map((item) => item.id === board.id ? nextBoard : item),
        commandHistory,
        selection: { kind: 'placement', id: placements[0].id, ids: placements.map((placement) => placement.id) },
      }));
      cards.forEach(scheduleSaveCard);
      scheduleSaveBoard(nextBoard);
    },
    convertSelectedTextToCards: () => {
      const state = get();
      const board = state.boards.find((item) => item.id === state.activeBoardId);
      const selection = state.selection;
      if (!board || selection?.kind !== 'placement') return;
      const selectedIds = selection.ids?.length ? selection.ids : [selection.id];
      const project = board.projectId ? state.projects.find((item) => item.id === board.projectId) : undefined;
      const converted = convertTextPlacementsToCards(board, state.cards, selectedIds, {
        createId: id,
        now: timestamp(),
        projectPath: project?.relativePath,
      });
      if (!converted.createdCards.length) return;
      const nextSelection = reconcileSelectionForBoard(
        remapPlacementSelection(selection, converted.replacementMap),
        converted.board,
      );
      const commandHistory = recordHistory(state.commandHistory, {
        label: converted.createdCards.length === 1 ? '文字转为卡片' : `文字转为 ${converted.createdCards.length} 张卡片`,
        boardId: board.id,
        before: board,
        after: converted.board,
        createdCards: converted.createdCards,
        placementReplacementMap: converted.replacementMap,
      });
      set((current) => ({
        cards: converted.cards,
        boards: current.boards.map((item) => item.id === board.id ? converted.board : item),
        commandHistory,
        selection: nextSelection,
      }));
      converted.createdCards.forEach(scheduleSaveCard);
      scheduleSaveBoard(converted.board);
    },
    copySelection: async () => {
      const board = get().boards.find((item) => item.id === get().activeBoardId);
      const selection = get().selection;
      if (!board || selection?.kind !== 'placement') return;
      const ids = new Set(selection.ids?.length ? selection.ids : [selection.id]);
      internalClipboard = { type: 'opencanvas/placements', placements: board.placements.filter((item) => ids.has(item.id)), connectors: board.connectors.filter((item) => ids.has(item.from) && ids.has(item.to)), attachments: board.attachments.filter((item) => ids.has(item.objectId) && ids.has(item.attachedObjectId)) };
      try { await navigator.clipboard.writeText(JSON.stringify(internalClipboard)); } catch { /* In-memory clipboard remains available. */ }
    },
    pasteSelection: async (position) => {
      let payload = internalClipboard;
      try {
        const parsed = JSON.parse(await navigator.clipboard.readText()) as PlacementClipboardPayload;
        if (parsed.type === 'opencanvas/placements' && Array.isArray(parsed.placements)) payload = parsed;
      } catch { /* Use the in-memory clipboard. */ }
      if (payload) pastePayload(payload, position);
    },

    arrangeSelection: (direction) => {
      const selection = get().selection;
      if (selection?.kind !== 'placement') return;
      const ids = new Set(selection.ids?.length ? selection.ids : [selection.id]);
      mutateActiveBoard(direction === 'front' ? '移到最上层' : '移到最下层', (board) => {
        return { ...board, placements: arrangePlacementZIndices(board.placements, ids, direction), updatedAt: timestamp() };
      });
    },

    tidySelection: (action) => {
      const selection = get().selection;
      if (selection?.kind !== 'placement') return;
      const ids = new Set(selection.ids?.length ? selection.ids : [selection.id]);
      if (ids.size < 2) return;
      mutateActiveBoard('整理对象', (board) => {
        // Position locking is an OpenCanvas extension. Keep its meaning uniform:
        // every geometry-changing gesture or batch operation leaves locked objects
        // (and the spatial attachments between locked objects) untouched.
        const selected = board.placements.filter((placement) => ids.has(placement.id) && !placement.locked);
        if (selected.length < 2) return board;
        const movedIds = new Set(selected.map((placement) => placement.id));
        const positions = tidyPlacementPositions(selected, action);
        return {
          ...board,
          placements: board.placements.map((placement) => positions[placement.id] ? { ...placement, ...positions[placement.id] } : placement),
          attachments: board.attachments.filter((attachment) => !movedIds.has(attachment.objectId) && !movedIds.has(attachment.attachedObjectId)),
          updatedAt: timestamp(),
        };
      });
    },

    resetSelectionSize: () => {
      const selection = get().selection;
      if (selection?.kind !== 'placement') return;
      const selectedIds = new Set(selection.ids?.length ? selection.ids : [selection.id]);
      mutateActiveBoard('恢复默认尺寸', (board) => {
        const reset = resetPlacementsToDefaultSize(board.placements, selectedIds);
        if (!reset.changedIds.size) return board;
        return {
          ...board,
          placements: expandSectionsToMaintainPadding(reset.placements),
          attachments: board.attachments.filter((attachment) => !reset.changedIds.has(attachment.objectId) && !reset.changedIds.has(attachment.attachedObjectId)),
          updatedAt: timestamp(),
        };
      });
    },

    fitSelectionToContent: async (cardHeights = {}, cardWidths = {}) => {
      const { fitPlacementsToContent } = await import('./domain/fitPlacementContent');
      const selection = get().selection;
      if (selection?.kind !== 'placement') return;
      const selectedIds = new Set(selection.ids?.length ? selection.ids : [selection.id]);
      mutateActiveBoard('适应内容', (board) => {
        const fitted = fitPlacementsToContent(board.placements, selectedIds, cardHeights, cardWidths);
        if (!fitted.changedIds.size) return board;
        return {
          ...board,
          placements: expandSectionsToMaintainPadding(fitted.placements),
          attachments: board.attachments.filter((attachment) => !fitted.changedIds.has(attachment.objectId) && !fitted.changedIds.has(attachment.attachedObjectId)),
          updatedAt: timestamp(),
        };
      });
    },

    syncAutoHeightPlacements: async (cardHeights) => {
      const { syncAutoHeightPlacementSizes } = await import('./domain/fitPlacementContent');
      mutateActiveBoard(null, (board) => {
        const synced = syncAutoHeightPlacementSizes(board.placements, cardHeights);
        if (!synced.changedIds.size) return board;
        return {
          ...board,
          placements: expandSectionsToMaintainPadding(synced.placements),
          attachments: board.attachments.filter((attachment) => !synced.changedIds.has(attachment.objectId) && !synced.changedIds.has(attachment.attachedObjectId)),
          updatedAt: timestamp(),
        };
      });
    },

    setCardPlacementsCollapsed: async (placementIds, collapsed) => {
      const { setCardPlacementsCollapsed } = await import('./domain/cardFold');
      const selectedIds = new Set(placementIds);
      mutateActiveBoard(collapsed ? '折叠卡片' : '展开卡片', (board) => {
        const folded = setCardPlacementsCollapsed(board.placements, selectedIds, collapsed);
        if (!folded.changedIds.size) return board;
        return {
          ...board,
          placements: expandSectionsToMaintainPadding(folded.placements),
          attachments: board.attachments.filter((attachment) => !folded.changedIds.has(attachment.objectId) && !folded.changedIds.has(attachment.attachedObjectId)),
          updatedAt: timestamp(),
        };
      });
    },

    setSelectionColor: (color) => {
      const selection = get().selection;
      if (selection?.kind !== 'placement') return;
      const ids = new Set(selection.ids?.length ? selection.ids : [selection.id]);
      mutateActiveBoard('修改对象颜色', (board) => ({
        ...board,
        placements: board.placements.map((placement) => ids.has(placement.id) ? { ...placement, color } : placement),
        updatedAt: timestamp(),
      }));
    },

    groupSelection: () => {
      const state = get();
      const ids = state.selection?.kind === 'placement' ? (state.selection.ids?.length ? state.selection.ids : [state.selection.id]) : [];
      if (ids.length < 2) return;
      const groupId = id();
      mutateActiveBoard('组合对象', (board) => ({ ...board, placements: board.placements.map((placement) => ids.includes(placement.id) ? { ...placement, groupId } : placement) }));
    },

    ungroupSelection: () => {
      const state = get();
      const ids = state.selection?.kind === 'placement' ? (state.selection.ids?.length ? state.selection.ids : [state.selection.id]) : [];
      const groupIds = new Set(state.boards.find((board) => board.id === state.activeBoardId)?.placements.filter((placement) => ids.includes(placement.id) && placement.groupId).map((placement) => placement.groupId!) || []);
      if (!groupIds.size) return;
      mutateActiveBoard('取消组合', (board) => ({ ...board, placements: board.placements.map((placement) => placement.groupId && groupIds.has(placement.groupId) ? { ...placement, groupId: undefined } : placement) }));
    },

    frameSelection: () => {
      const state = get();
      const ids = state.selection?.kind === 'placement' ? (state.selection.ids?.length ? state.selection.ids : [state.selection.id]) : [];
      const active = state.boards.find((board) => board.id === state.activeBoardId);
      const objects = active?.placements.filter((placement) => ids.includes(placement.id)) || [];
      if (!active || !objects.length) return null;
      const bounds = sectionBoundsForPlacements(objects);
      if (!bounds) return null;
      const frameId = id();
      const sectionNumber = active.placements.filter((placement) => placement.isFrame).length + 1;
      const frame: BoardPlacement = { id: frameId, kind: 'text', text: `区块 ${sectionNumber}`, ...bounds, color: 'transparent', isFrame: true, zIndex: Math.min(0, ...objects.map((item) => item.zIndex ?? 0)) - 1 };
      mutateActiveBoard('创建区块', (board) => ({
        ...board,
        placements: [
          frame,
          ...board.placements.map((placement) => {
            if (!ids.includes(placement.id)) return placement;
            const sectionIds = [...new Set([...placementSectionIds(placement), frameId])];
            return { ...placement, sectionId: sectionIds[0], sectionIds };
          }),
        ],
      }));
      set({ selection: { kind: 'placement', id: frameId, ids: [frameId] } });
      return frame;
    },

    setSelectionLocked: (locked) => {
      const state = get();
      const ids = state.selection?.kind === 'placement' ? (state.selection.ids?.length ? state.selection.ids : [state.selection.id]) : [];
      if (!ids.length) return;
      mutateActiveBoard(locked ? '锁定对象' : '解锁对象', (board) => ({ ...board, placements: board.placements.map((placement) => ids.includes(placement.id) ? { ...placement, locked } : placement) }));
    },

    styleConnectorsForSelection: (changes) => {
      const state = get();
      const ids = state.selection?.kind === 'placement' ? new Set(state.selection.ids?.length ? state.selection.ids : [state.selection.id]) : new Set<string>();
      if (!ids.size) return;
      mutateActiveBoard('批量设置连接线', (board) => ({ ...board, connectors: board.connectors.map((connector) => ids.has(connector.from) && ids.has(connector.to) ? { ...connector, ...changes } : connector) }));
    },

    beginBoardTransaction: (label) => {
      const board = get().boards.find((item) => item.id === get().activeBoardId);
      if (board && !boardTransaction) boardTransaction = { label, boardId: board.id, before: board };
    },
    commitBoardTransaction: () => {
      const transaction = boardTransaction;
      boardTransaction = null;
      if (!transaction) return;
      const after = get().boards.find((board) => board.id === transaction.boardId);
      if (!after) return;
      set((state) => ({ commandHistory: recordHistory(state.commandHistory, { ...transaction, after }) }));
    },
    cancelBoardTransaction: () => {
      const transaction = boardTransaction;
      boardTransaction = null;
      if (!transaction) return;
      replaceBoard(transaction.before);
    },
    undo: () => {
      boardTransaction = null;
      const state = get();
      const current = state.boards.find((board) => board.id === state.activeBoardId);
      if (!current) return;
      const result = undoHistory(state.commandHistory, current);
      if (!result) return;
      const reverseReplacementMap = result.entry.placementReplacementMap
        ? Object.fromEntries(Object.entries(result.entry.placementReplacementMap).map(([before, after]) => [after, before]))
        : undefined;
      const selection = reconcileSelectionForBoard(remapPlacementSelection(state.selection, reverseReplacementMap), result.board);
      const createdCards = result.entry.createdCards ?? [];
      const createdBoards = result.entry.createdBoards ?? [];
      if (!createdCards.length && !createdBoards.length) {
        replaceBoard(result.board);
        result.entry.relatedBoardChanges?.forEach((change) => replaceBoard(change.before));
        set({ commandHistory: result.history, selection });
        return;
      }
      // Preserve edits and path changes made after entity creation so redo
      // restores the latest entity rather than its initial command snapshot.
      const liveCreatedCards = createdCards.map((card) => state.cards.find((currentCard) => currentCard.id === card.id) ?? card);
      const liveCreatedBoards = createdBoards.map((board) => state.boards.find((currentBoard) => currentBoard.id === board.id) ?? board);
      const commandHistory = {
        ...result.history,
        future: result.history.future.map((entry) => entry === result.entry ? { ...entry, createdCards: liveCreatedCards, createdBoards: liveCreatedBoards } : entry),
      };
      const createdIds = new Set(liveCreatedCards.map((card) => card.id));
      const createdBoardIds = new Set(liveCreatedBoards.map((board) => board.id));
      const nextCards = state.cards.filter((card) => !createdIds.has(card.id));
      const nextBoards = state.boards.filter((board) => !createdBoardIds.has(board.id)).map((board) => board.id === result.board.id ? result.board : board);
      const nextDesktop = { ...state.desktop, placements: state.desktop.placements.filter((placement) => !createdBoardIds.has(placement.boardId)) };
      liveCreatedCards.forEach((card) => saveScheduler.cancel(`card:${card.id}`));
      liveCreatedBoards.forEach((board) => saveScheduler.cancel(`board:${board.id}`));
      saveScheduler.cancel(`board:${result.board.id}`);
      set({ cards: nextCards, boards: nextBoards, desktop: nextDesktop, commandHistory, selection });
      if (liveCreatedBoards.length) scheduleSaveDesktop(nextDesktop);
      scheduleSave(`history-entities:${result.board.id}`, 20, () => vaultApi.applyFilePlan({
        cards: nextCards,
        boards: nextBoards,
        projects: state.projects,
        folders: state.folders,
        writeCardIds: [],
        writeBoardIds: [result.board.id],
        trashedCardPaths: liveCreatedCards.map((card) => card.relativePath),
        trashedBoardFileNames: liveCreatedBoards.map((board) => board.fileName),
      }));
    },
    redo: () => {
      boardTransaction = null;
      const state = get();
      const current = state.boards.find((board) => board.id === state.activeBoardId);
      if (!current) return;
      const result = redoHistory(state.commandHistory, current);
      if (!result) return;
      const selection = reconcileSelectionForBoard(remapPlacementSelection(state.selection, result.entry.placementReplacementMap), result.board);
      const createdCards = result.entry.createdCards ?? [];
      const createdBoards = result.entry.createdBoards ?? [];
      if (!createdCards.length && !createdBoards.length) {
        replaceBoard(result.board);
        result.entry.relatedBoardChanges?.forEach((change) => replaceBoard(change.after));
        set({ commandHistory: result.history, selection });
        return;
      }
      const createdIds = new Set(createdCards.map((card) => card.id));
      const createdBoardIds = new Set(createdBoards.map((board) => board.id));
      const nextCards = [...createdCards.filter((card) => !state.cards.some((currentCard) => currentCard.id === card.id)), ...state.cards];
      const nextBoards = [...createdBoards.filter((board) => !state.boards.some((currentBoard) => currentBoard.id === board.id)), ...state.boards.map((board) => board.id === result.board.id ? result.board : board)];
      const restoredDesktopPlacements = result.entry.createdDesktopPlacements ?? [];
      const nextDesktop = { ...state.desktop, placements: [...state.desktop.placements, ...restoredDesktopPlacements.filter((placement) => !state.desktop.placements.some((current) => current.boardId === placement.boardId))] };
      saveScheduler.cancel(`history-entities:${result.board.id}`);
      set({ cards: nextCards, boards: nextBoards, desktop: nextDesktop, commandHistory: result.history, selection });
      if (createdBoards.length) scheduleSaveDesktop(nextDesktop);
      scheduleSave(`history-entities:${result.board.id}`, 20, () => vaultApi.applyFilePlan({
        cards: nextCards,
        boards: nextBoards,
        projects: state.projects,
        folders: state.folders,
        writeCardIds: [...createdIds],
        writeBoardIds: [result.board.id, ...createdBoardIds],
      }));
    },

    // View navigation is persisted, but it is not a content edit. Keeping the
    // semantic modification time stable also lets the native vault avoid
    // filling file history with pan/zoom-only revisions.
    setViewport: (viewport) => mutateActiveBoard(null, (board) => ({ ...board, viewport })),
  };
});
