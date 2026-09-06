import type { StateCreator } from 'zustand';
import type { NavigationState, WorkspaceStore } from './storeTypes';

export type NavigationSlice = Pick<NavigationState, 'workspaceView' | 'activeBoardId' | 'boardHistory'>
  & Pick<WorkspaceStore, 'openBoard' | 'showDesktop' | 'openBoardPath' | 'goBack'>;

const NAVIGATION_KEY = 'opencanvas.navigation';

function savedNavigation(): Pick<NavigationState, 'workspaceView' | 'activeBoardId' | 'boardHistory'> {
  try {
    const parsed = JSON.parse(localStorage.getItem(NAVIGATION_KEY) || '{}') as Partial<NavigationState>;
    return {
      workspaceView: parsed.workspaceView === 'board' ? 'board' : 'desktop',
      activeBoardId: typeof parsed.activeBoardId === 'string' ? parsed.activeBoardId : null,
      boardHistory: Array.isArray(parsed.boardHistory) ? parsed.boardHistory.filter((id): id is string => typeof id === 'string') : [],
    };
  } catch {
    return { workspaceView: 'desktop', activeBoardId: null, boardHistory: [] };
  }
}

export function persistNavigation(value: Pick<NavigationState, 'workspaceView' | 'activeBoardId' | 'boardHistory'>) {
  try { localStorage.setItem(NAVIGATION_KEY, JSON.stringify(value)); } catch { /* Navigation remains usable without storage. */ }
}

export function sanitizeBoardHistory(boardHistory: string[], activeBoardId: string | null, validBoardIds: Iterable<string>) {
  const valid = new Set(validBoardIds);
  const seen = new Set<string>(activeBoardId ? [activeBoardId] : []);
  return boardHistory.filter((id) => {
    if (!valid.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Deleting one ancestor breaks only the occurrence prefix through that board.
 * Descendants after it still form a valid path from the newly promoted root.
 */
export function boardHistoryAfterDeletion(boardHistory: string[], deletedBoardId: string, remainingBoardIds: Iterable<string>) {
  const deletedIndex = boardHistory.lastIndexOf(deletedBoardId);
  const survivingSuffix = deletedIndex >= 0 ? boardHistory.slice(deletedIndex + 1) : boardHistory;
  const remaining = new Set(remainingBoardIds);
  return survivingSuffix.filter((id) => remaining.has(id));
}

export function boardNavigationTransition(activeBoardId: string | null, boardHistory: string[], boardId: string, remember: boolean) {
  return {
    workspaceView: 'board' as const,
    activeBoardId: boardId,
    boardHistory: remember && activeBoardId ? [...boardHistory, activeBoardId] : [],
    selection: null,
    focusedCardId: null,
    focusTransitionSource: null,
    tool: 'select' as const,
  };
}

export function boardBackTransition(activeBoardId: string | null, boardHistory: string[]) {
  const previous = boardHistory.at(-1);
  if (previous) {
    return {
      workspaceView: 'board' as const,
      activeBoardId: previous,
      boardHistory: boardHistory.slice(0, -1),
    };
  }
  return {
    workspaceView: 'desktop' as const,
    activeBoardId,
    boardHistory: [],
  };
}

export const createNavigationSlice = (
  cancelBoardTransaction: () => void,
): StateCreator<WorkspaceStore, [], [], NavigationSlice> => (set, get) => ({
  ...savedNavigation(),

  openBoard: (boardId, remember = false) => {
    cancelBoardTransaction();
    const state = get();
    if (!state.boards.some((board) => board.id === boardId)) return;
    const next = boardNavigationTransition(state.activeBoardId, state.boardHistory, boardId, remember);
    set(next);
    persistNavigation(next);
  },
  showDesktop: () => {
    cancelBoardTransaction();
    const navigation = { workspaceView: 'desktop' as const, activeBoardId: get().activeBoardId, boardHistory: [] };
    set({ ...navigation, selection: null, focusedCardId: null, focusTransitionSource: null, tool: 'select' });
    persistNavigation(navigation);
  },
  openBoardPath: (boardId, history) => {
    cancelBoardTransaction();
    const state = get();
    const boardIds = state.boards.map((board) => board.id);
    if (!boardIds.includes(boardId)) return;
    const navigation = { workspaceView: 'board' as const, activeBoardId: boardId, boardHistory: sanitizeBoardHistory(history, boardId, boardIds) };
    set({ ...navigation, selection: null, focusedCardId: null, focusTransitionSource: null, tool: 'select' });
    persistNavigation(navigation);
  },
  goBack: () => {
    cancelBoardTransaction();
    const state = get();
    const navigation = boardBackTransition(state.activeBoardId, sanitizeBoardHistory(state.boardHistory, state.activeBoardId, state.boards.map((board) => board.id)));
    set({ ...navigation, selection: null, focusedCardId: null, focusTransitionSource: null, tool: 'select' });
    persistNavigation(navigation);
  },
});
