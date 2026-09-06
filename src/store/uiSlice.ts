import type { StateCreator } from 'zustand';
import type { AppNotice, BoardState, EditorState, NavigationState, NotificationState, WorkspaceStore } from './storeTypes';

type CardFocusState = Pick<NavigationState, 'focusedCardId' | 'focusTransitionSource' | 'sidePanelCardId' | 'sidePanelOpen'>;

export type UiSlice = BoardState
  & EditorState
  & CardFocusState
  & NotificationState
  & Pick<WorkspaceStore, 'setSelection' | 'focusCard' | 'openCardInSidePanel' | 'setTool' | 'toggleDarkMode' | 'pushNotice' | 'dismissNotice'>;

export function focusCardTransition(state: CardFocusState, focusedCardId: string | null, source: 'canvas' | 'side-panel' = 'canvas'): Partial<CardFocusState> {
  return focusedCardId
    ? { focusedCardId, focusTransitionSource: source, sidePanelOpen: false }
    : {
        focusedCardId: null,
        focusTransitionSource: null,
        sidePanelOpen: state.focusTransitionSource === 'side-panel' && Boolean(state.sidePanelCardId),
      };
}

export function sidePanelTransition(state: CardFocusState, sidePanelCardId: string | null): Partial<CardFocusState> {
  return sidePanelCardId
    ? { sidePanelCardId, sidePanelOpen: true, focusedCardId: null, focusTransitionSource: null }
    : { sidePanelCardId: state.sidePanelCardId, sidePanelOpen: false };
}

export const createUiSlice: StateCreator<WorkspaceStore, [], [], UiSlice> = (set, get) => ({
  selection: null,
  focusedCardId: null,
  focusTransitionSource: null,
  sidePanelCardId: null,
  sidePanelOpen: false,
  tool: 'select',
  darkMode: localStorage.getItem('opencanvas.theme') !== 'light',
  notices: [],

  setSelection: (selection) => set({ selection }),
  focusCard: (focusedCardId, source = 'canvas') => set(focusCardTransition(get(), focusedCardId, source)),
  openCardInSidePanel: (sidePanelCardId) => set(sidePanelTransition(get(), sidePanelCardId)),
  setTool: (tool) => set({ tool }),
  toggleDarkMode: () => set((state) => {
    const darkMode = !state.darkMode;
    localStorage.setItem('opencanvas.theme', darkMode ? 'dark' : 'light');
    return { darkMode };
  }),
  pushNotice: (notice) => set((state) => ({ notices: [...state.notices, { ...notice, id: crypto.randomUUID() } as AppNotice].slice(-5) })),
  dismissNotice: (noticeId) => set((state) => ({ notices: state.notices.filter((notice) => notice.id !== noticeId) })),
});
