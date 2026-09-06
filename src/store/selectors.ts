import type { WorkspaceStore } from './storeTypes';

export const selectActiveBoard = (state: WorkspaceStore) => state.boards.find((board) => board.id === state.activeBoardId);
export const selectFocusedCard = (state: WorkspaceStore) => state.cards.find((card) => card.id === state.focusedCardId);
export const selectSidePanelCard = (state: WorkspaceStore) => state.cards.find((card) => card.id === state.sidePanelCardId);

export function selectSelectedPlacementIds(state: WorkspaceStore) {
  if (state.selection?.kind !== 'placement') return [];
  return state.selection.ids?.length ? state.selection.ids : [state.selection.id];
}
