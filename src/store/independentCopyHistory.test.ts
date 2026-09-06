import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Board, Card } from '../types';

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
});

const { useWorkspaceStore } = await import('../store');
const now = '2026-08-15T00:00:00.000Z';
const sourceCard: Card = {
  id: 'source-card', fileName: '源卡片.md', relativePath: '源卡片.md', title: '源卡片', body: '源正文', createdAt: now, updatedAt: now,
};
const board = (): Board => ({
  version: 4, id: 'board', fileName: 'board.board.json', title: '独立复制历史',
  placements: [{ id: 'source-placement', kind: 'card', entityId: sourceCard.id, x: 80, y: 90, width: 520, height: 260, color: 'yellow', zIndex: 4 }],
  connectors: [], attachments: [], viewport: { x: 0, y: 0, zoom: 1 }, createdAt: now, updatedAt: now,
});

describe('independent card copy history', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    storage.clear();
    useWorkspaceStore.setState({
      cards: [sourceCard], boards: [board()], projects: [], folders: [], activeBoardId: 'board',
      selection: { kind: 'placement', id: 'source-placement', ids: ['source-placement'] },
      commandHistory: { past: [], future: [] }, externalChangePaths: [], ready: true,
    });
  });

  afterEach(async () => {
    await useWorkspaceStore.getState().flushPendingSaves();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('removes and restores the Markdown entity with continuous source/copy selection', async () => {
    useWorkspaceStore.getState().duplicateSelectionAsIndependentCards();
    let state = useWorkspaceStore.getState();
    const copyPlacement = state.boards[0].placements.find((placement) => placement.id !== 'source-placement')!;
    const copyCard = state.cards.find((card) => card.id === copyPlacement.entityId)!;
    expect(copyPlacement).toMatchObject({ x: 112, y: 122, width: 520, height: 260, color: 'yellow', zIndex: 4 });
    expect(copyCard).toMatchObject({ title: '源卡片 副本', body: '源正文' });
    expect(state.selection).toEqual({ kind: 'placement', id: copyPlacement.id, ids: [copyPlacement.id] });

    useWorkspaceStore.getState().updateCard(copyCard.id, { body: '复制后继续编辑的正文' });
    useWorkspaceStore.getState().undo();
    state = useWorkspaceStore.getState();
    expect(state.cards).toEqual([sourceCard]);
    expect(state.boards[0].placements).toHaveLength(1);
    expect(state.selection).toEqual({ kind: 'placement', id: 'source-placement', ids: ['source-placement'] });

    await useWorkspaceStore.getState().flushPendingSaves();
    const undoneSnapshot = JSON.parse(storage.get('opencanvas.workspace.v4')!);
    expect(undoneSnapshot.cards.map((card: Card) => card.id)).toEqual([sourceCard.id]);

    useWorkspaceStore.getState().redo();
    state = useWorkspaceStore.getState();
    expect(state.cards.find((card) => card.id === copyCard.id)?.body).toBe('复制后继续编辑的正文');
    expect(state.boards[0].placements.map((placement) => placement.id)).toEqual(['source-placement', copyPlacement.id]);
    expect(state.selection).toEqual({ kind: 'placement', id: copyPlacement.id, ids: [copyPlacement.id] });

    await useWorkspaceStore.getState().flushPendingSaves();
    const redoneSnapshot = JSON.parse(storage.get('opencanvas.workspace.v4')!);
    expect(redoneSnapshot.cards.find((card: Card) => card.id === copyCard.id)?.body).toBe('复制后继续编辑的正文');
  });
});
