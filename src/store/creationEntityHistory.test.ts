import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Board } from '../types';

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
});

const { useWorkspaceStore } = await import('../store');
const now = '2026-08-16T00:00:00.000Z';
const root: Board = {
  version: 4, id: 'root', fileName: 'root.board.json', title: '根白板',
  placements: [], connectors: [], attachments: [], viewport: { x: 0, y: 0, zoom: 1 },
  createdAt: now, updatedAt: now,
};

describe('creation entity history', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    storage.clear();
    useWorkspaceStore.setState({
      cards: [], boards: [root], projects: [], folders: [], activeBoardId: root.id,
      desktop: { viewport: { x: 0, y: 0, zoom: 1 }, placements: [{ boardId: root.id, x: 0, y: 0, width: 430, height: 270 }] },
      selection: null, commandHistory: { past: [], future: [] }, externalChangePaths: [], ready: true,
    });
  });

  afterEach(async () => {
    await useWorkspaceStore.getState().flushPendingSaves();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('removes and restores a newly created Markdown card with its placement', () => {
    const placement = useWorkspaceStore.getState().createCardPlacement({ x: 20, y: 30, width: 360, height: 170 })!;
    const cardId = placement.entityId!;
    expect(useWorkspaceStore.getState().cards.some((card) => card.id === cardId)).toBe(true);
    expect(useWorkspaceStore.getState().commandHistory.past.at(-1)?.createdCards?.[0].id).toBe(cardId);

    useWorkspaceStore.getState().undo();
    expect(useWorkspaceStore.getState().cards.some((card) => card.id === cardId)).toBe(false);
    expect(useWorkspaceStore.getState().boards[0].placements).toEqual([]);

    useWorkspaceStore.getState().redo();
    expect(useWorkspaceStore.getState().cards.some((card) => card.id === cardId)).toBe(true);
    expect(useWorkspaceStore.getState().boards.find((board) => board.id === root.id)?.placements[0]).toMatchObject({ id: placement.id, entityId: cardId, width: 360, height: 170 });
  });

  it('does not promote an undone nested whiteboard to the desktop root', () => {
    const placement = useWorkspaceStore.getState().createNestedBoardPlacement({ x: 50, y: 60, width: 350, height: 200 })!;
    const childId = placement.entityId!;
    expect(useWorkspaceStore.getState().boards.some((board) => board.id === childId)).toBe(true);
    expect(useWorkspaceStore.getState().desktop.placements.some((item) => item.boardId === childId)).toBe(true);

    useWorkspaceStore.getState().undo();
    expect(useWorkspaceStore.getState().boards.some((board) => board.id === childId)).toBe(false);
    expect(useWorkspaceStore.getState().desktop.placements.some((item) => item.boardId === childId)).toBe(false);

    useWorkspaceStore.getState().redo();
    expect(useWorkspaceStore.getState().boards.some((board) => board.id === childId)).toBe(true);
    expect(useWorkspaceStore.getState().desktop.placements.filter((item) => item.boardId === childId)).toHaveLength(1);
    expect(useWorkspaceStore.getState().boards.find((board) => board.id === root.id)?.placements[0]).toMatchObject({ id: placement.id, entityId: childId });
  });

  it('undoes an existing nested whiteboard rename before undoing its creation', () => {
    const placement = useWorkspaceStore.getState().createNestedBoardPlacement()!;
    const childId = placement.entityId!;
    useWorkspaceStore.getState().updateBoard(childId, { title: '新的子白板标题' });
    expect(useWorkspaceStore.getState().boards.find((board) => board.id === childId)?.title).toBe('新的子白板标题');
    expect(useWorkspaceStore.getState().commandHistory.past.at(-1)?.relatedBoardChanges?.[0]).toMatchObject({ before: { title: '嵌套白板' }, after: { title: '新的子白板标题' } });

    useWorkspaceStore.getState().undo();
    expect(useWorkspaceStore.getState().boards.find((board) => board.id === childId)?.title).toBe('嵌套白板');
    expect(useWorkspaceStore.getState().boards.find((board) => board.id === root.id)?.placements.some((item) => item.id === placement.id)).toBe(true);

    useWorkspaceStore.getState().redo();
    expect(useWorkspaceStore.getState().boards.find((board) => board.id === childId)?.title).toBe('新的子白板标题');
  });
});
