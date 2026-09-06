import { describe, expect, it } from 'vitest';
import type { WorkspaceStore } from './storeTypes';
import { selectActiveBoard, selectFocusedCard, selectSelectedPlacementIds, selectSidePanelCard } from './selectors';

const state = {
  activeBoardId: 'board-b',
  focusedCardId: 'card-a',
  sidePanelCardId: 'card-b',
  boards: [{ id: 'board-a' }, { id: 'board-b' }],
  cards: [{ id: 'card-a' }, { id: 'card-b' }],
  selection: { kind: 'placement', id: 'p1', ids: ['p1', 'p2'] },
} as unknown as WorkspaceStore;

describe('workspace selectors', () => {
  it('returns entity references instead of subscribing consumers to whole collections', () => {
    expect(selectActiveBoard(state)).toBe(state.boards[1]);
    expect(selectFocusedCard(state)).toBe(state.cards[0]);
    expect(selectSidePanelCard(state)).toBe(state.cards[1]);
  });

  it('normalizes single and multiple placement selections', () => {
    expect(selectSelectedPlacementIds(state)).toEqual(['p1', 'p2']);
    expect(selectSelectedPlacementIds({ ...state, selection: { kind: 'placement', id: 'only' } })).toEqual(['only']);
    expect(selectSelectedPlacementIds({ ...state, selection: null })).toEqual([]);
  });
});
