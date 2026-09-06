import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Board, BoardPlacement } from '../types';

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
});

const { useWorkspaceStore } = await import('../store');
const now = '2026-08-15T00:00:00.000Z';
const placement = (id: string, overrides: Partial<BoardPlacement> = {}): BoardPlacement => ({
  id, kind: 'card', x: 100, y: 120, width: 100, height: 80, color: 'paper', ...overrides,
});
const board = (): Board => ({
  version: 4, id: 'board', fileName: 'board.board.json', title: '适应内容历史',
  placements: [
    placement('section', { kind: 'text', text: '区块', isFrame: true, x: 0, y: 0, width: 800, height: 600, sectionBaseBounds: { x: 20, y: 20, width: 700, height: 500 } }),
    placement('card', { entityId: 'card-entity', sectionId: 'section', sectionIds: ['section'] }),
    placement('nested', { kind: 'board', entityId: 'nested-board', x: 400, y: 300, width: 120, height: 90, sectionId: 'section', sectionIds: ['section'] }),
  ],
  connectors: [],
  attachments: [{ objectId: 'section', attachedObjectId: 'card', direction: 'right', gap: 6 }],
  viewport: { x: 0, y: 0, zoom: 1 }, createdAt: now, updatedAt: now,
});

describe('fit-to-content store command', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    storage.clear();
    useWorkspaceStore.setState({
      cards: [], boards: [board()], projects: [], folders: [], activeBoardId: 'board',
      selection: { kind: 'placement', id: 'section', ids: ['section'] },
      commandHistory: { past: [], future: [] }, externalChangePaths: [], ready: true,
    });
  });

  afterEach(async () => {
    await useWorkspaceStore.getState().flushPendingSaves();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('fits the Section, clears stale attachments and preserves selection through undo/redo', async () => {
    await useWorkspaceStore.getState().fitSelectionToContent();
    let state = useWorkspaceStore.getState();
    expect(state.boards[0].placements.find((item) => item.id === 'section')).toMatchObject({ x: 60, y: 80, width: 500, height: 350, sectionBaseBounds: undefined });
    expect(state.boards[0].attachments).toEqual([]);
    expect(state.commandHistory.past.at(-1)?.label).toBe('适应内容');
    expect(state.selection).toEqual({ kind: 'placement', id: 'section', ids: ['section'] });

    state.undo();
    state = useWorkspaceStore.getState();
    expect(state.boards[0].placements.find((item) => item.id === 'section')).toMatchObject({ x: 0, y: 0, width: 800, height: 600, sectionBaseBounds: { x: 20, y: 20, width: 700, height: 500 } });
    expect(state.boards[0].attachments).toHaveLength(1);
    expect(state.selection).toEqual({ kind: 'placement', id: 'section', ids: ['section'] });

    state.redo();
    state = useWorkspaceStore.getState();
    expect(state.boards[0].placements.find((item) => item.id === 'section')).toMatchObject({ x: 60, y: 80, width: 500, height: 350 });
    expect(state.selection).toEqual({ kind: 'placement', id: 'section', ids: ['section'] });
  });

  it('fits a card, follows later content height without history, and manual resize exits auto height', async () => {
    useWorkspaceStore.setState({ selection: { kind: 'placement', id: 'card', ids: ['card'] } });
    await useWorkspaceStore.getState().fitSelectionToContent({ card: 280 });
    let state = useWorkspaceStore.getState();
    expect(state.boards[0].placements.find((item) => item.id === 'card')).toMatchObject({ height: 280, autoHeight: true, scrollTop: 0 });
    expect(state.commandHistory.past.at(-1)?.label).toBe('适应内容');
    const historyLength = state.commandHistory.past.length;

    await state.syncAutoHeightPlacements({ card: 340 });
    state = useWorkspaceStore.getState();
    expect(state.boards[0].placements.find((item) => item.id === 'card')).toMatchObject({ height: 340, autoHeight: true });
    expect(state.commandHistory.past).toHaveLength(historyLength);

    state.updateBoardLayout({ card: { height: 210 } });
    state = useWorkspaceStore.getState();
    expect(state.boards[0].placements.find((item) => item.id === 'card')).toMatchObject({ height: 210, autoHeight: undefined });
    await state.syncAutoHeightPlacements({ card: 500 });
    expect(useWorkspaceStore.getState().boards[0].placements.find((item) => item.id === 'card')).toMatchObject({ height: 210, autoHeight: undefined });
  });

  it('folds cards in one history step and fits the folded title width independently', async () => {
    useWorkspaceStore.setState({ selection: { kind: 'placement', id: 'card', ids: ['card'] } });
    await useWorkspaceStore.getState().setCardPlacementsCollapsed(['card'], true);
    let state = useWorkspaceStore.getState();
    expect(state.boards[0].placements.find((item) => item.id === 'card')).toMatchObject({ collapsed: true, height: 62, expandedHeight: 80 });
    expect(state.commandHistory.past.at(-1)?.label).toBe('折叠卡片');

    await state.fitSelectionToContent({}, { card: 336 });
    state = useWorkspaceStore.getState();
    expect(state.boards[0].placements.find((item) => item.id === 'card')).toMatchObject({ collapsed: true, width: 336, height: 62, expandedHeight: 80 });
    state.undo();
    expect(useWorkspaceStore.getState().boards[0].placements.find((item) => item.id === 'card')).toMatchObject({ collapsed: true, width: 100 });

    await useWorkspaceStore.getState().setCardPlacementsCollapsed(['card'], false);
    state = useWorkspaceStore.getState();
    expect(state.boards[0].placements.find((item) => item.id === 'card')).toMatchObject({ height: 80 });
    expect(state.boards[0].placements.find((item) => item.id === 'card')?.collapsed).toBeUndefined();
    expect(state.commandHistory.past.at(-1)?.label).toBe('展开卡片');
  });
});
