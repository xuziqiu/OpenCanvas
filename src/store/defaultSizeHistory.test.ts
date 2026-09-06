import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Board, BoardPlacement } from '../types';

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
});

const { useWorkspaceStore } = await import('../store');
const now = '2026-08-15T00:00:00.000Z';
const placement = (id: string, kind: BoardPlacement['kind'], x: number, overrides: Partial<BoardPlacement> = {}): BoardPlacement => ({
  id, kind, x, y: 100, width: 200, height: 100, color: 'paper', ...overrides,
});
const board = (): Board => ({
  version: 4, id: 'board', fileName: 'board.board.json', title: '默认尺寸历史',
  placements: [
    placement('section', 'text', 50, { y: 50, width: 400, height: 250, isFrame: true, text: '区块' }),
    placement('card', 'card', 100, { entityId: 'card-entity', sectionId: 'section', sectionIds: ['section'] }),
    placement('nested', 'board', 720, { entityId: 'nested-board', width: 900, height: 500 }),
    placement('locked-text', 'text', 1680, { text: '锁定', width: 620, height: 260, locked: true }),
  ],
  connectors: [],
  attachments: [
    { objectId: 'card', attachedObjectId: 'nested', direction: 'right', gap: 6 },
    { objectId: 'locked-text', attachedObjectId: 'section', direction: 'left', gap: 6 },
  ],
  viewport: { x: 0, y: 0, zoom: 1 }, createdAt: now, updatedAt: now,
});

describe('default-size store command', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    storage.clear();
    useWorkspaceStore.setState({
      cards: [], boards: [board()], projects: [], folders: [], activeBoardId: 'board',
      selection: { kind: 'placement', id: 'card', ids: ['section', 'card', 'nested', 'locked-text'] },
      commandHistory: { past: [], future: [] }, externalChangePaths: [], ready: true,
    });
  });

  afterEach(async () => {
    await useWorkspaceStore.getState().flushPendingSaves();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('resets eligible objects, grows their Section and preserves selection through undo/redo', () => {
    useWorkspaceStore.getState().resetSelectionSize();
    let state = useWorkspaceStore.getState();
    const active = state.boards[0];
    expect(active.placements.find((item) => item.id === 'card')).toMatchObject({ width: 520, height: 185, x: 100, y: 100 });
    expect(active.placements.find((item) => item.id === 'nested')).toMatchObject({ width: 430, height: 270, x: 720, y: 100 });
    expect(active.placements.find((item) => item.id === 'locked-text')).toMatchObject({ width: 620, height: 260, locked: true });
    expect(active.placements.find((item) => item.id === 'section')).toMatchObject({ x: 50, y: 50, width: 610, height: 275, sectionBaseBounds: { x: 50, y: 50, width: 400, height: 250 } });
    expect(active.attachments).toEqual([{ objectId: 'locked-text', attachedObjectId: 'section', direction: 'left', gap: 6 }]);
    expect(state.commandHistory.past.at(-1)?.label).toBe('恢复默认尺寸');

    useWorkspaceStore.getState().undo();
    state = useWorkspaceStore.getState();
    expect(state.boards[0].placements.find((item) => item.id === 'card')).toMatchObject({ width: 200, height: 100 });
    expect(state.boards[0].placements.find((item) => item.id === 'nested')).toMatchObject({ width: 900, height: 500 });
    const restoredSection = state.boards[0].placements.find((item) => item.id === 'section');
    expect(restoredSection).toMatchObject({ width: 400, height: 250 });
    expect(restoredSection?.sectionBaseBounds).toBeUndefined();
    expect(state.boards[0].attachments).toHaveLength(2);
    expect(state.selection).toEqual({ kind: 'placement', id: 'card', ids: ['section', 'card', 'nested', 'locked-text'] });

    useWorkspaceStore.getState().redo();
    state = useWorkspaceStore.getState();
    expect(state.boards[0].placements.find((item) => item.id === 'card')).toMatchObject({ width: 520, height: 185 });
    expect(state.boards[0].placements.find((item) => item.id === 'section')).toMatchObject({ width: 610, height: 275 });
    expect(state.selection).toEqual({ kind: 'placement', id: 'card', ids: ['section', 'card', 'nested', 'locked-text'] });
  });
});
