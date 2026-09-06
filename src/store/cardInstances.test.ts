import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Board, Card } from '../types';

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
});

const { useWorkspaceStore } = await import('../store');

const now = '2026-01-01T00:00:00.000Z';
const card: Card = { id: 'card', fileName: 'card.md', relativePath: 'card.md', title: '共享卡片', body: '旧正文', createdAt: now, updatedAt: now };
const board = (id: string, width: number, scrollTop: number): Board => ({
  version: 4,
  id,
  fileName: `${id}.board.json`,
  title: id,
  placements: [{ id: `placement-${id}`, kind: 'card', entityId: card.id, x: 0, y: 0, width, height: 200, color: 'paper', scrollTop }],
  connectors: [],
  attachments: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  createdAt: now,
  updatedAt: now,
});

describe('shared card instances', () => {
  beforeEach(() => { vi.useFakeTimers(); storage.clear(); });
  afterEach(() => vi.useRealTimers());

  it('shares entity content across three boards while keeping geometry and scroll independent', async () => {
    useWorkspaceStore.setState({ cards: [card], boards: [board('one', 320, 10), board('two', 480, 90), board('three', 600, 170)], activeBoardId: 'two', ready: true });
    useWorkspaceStore.getState().updateCard(card.id, { body: '同步后的正文' });
    useWorkspaceStore.getState().updatePlacement('placement-two', { width: 520, scrollTop: 140 });
    await vi.advanceTimersByTimeAsync(250);

    const state = useWorkspaceStore.getState();
    expect(state.cards[0].body).toBe('同步后的正文');
    expect(state.boards.map((item) => item.placements[0].width)).toEqual([320, 520, 600]);
    expect(state.boards.map((item) => item.placements[0].scrollTop)).toEqual([10, 140, 170]);
  });
});
