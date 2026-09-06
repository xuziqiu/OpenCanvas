import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Board, BoardPlacement } from '../types';

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
});

const { useWorkspaceStore } = await import('../store');

const now = '2026-01-01T00:00:00.000Z';
const placement = (id: string, x: number, locked = false): BoardPlacement => ({
  id,
  kind: 'text',
  text: id,
  x,
  y: 40,
  width: 100,
  height: 80,
  color: 'paper',
  locked,
});

const board = (): Board => ({
  version: 4,
  id: 'board',
  fileName: 'board.board.json',
  title: 'Lock semantics',
  placements: [
    placement('locked-a', 10, true),
    placement('locked-b', 140, true),
    placement('free-a', 300),
    placement('free-b', 520),
  ],
  connectors: [],
  attachments: [
    { objectId: 'locked-a', attachedObjectId: 'locked-b', direction: 'right', gap: 6 },
    { objectId: 'locked-b', attachedObjectId: 'free-a', direction: 'right', gap: 6 },
  ],
  viewport: { x: 0, y: 0, zoom: 1 },
  createdAt: now,
  updatedAt: now,
});

describe('locked placement geometry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    storage.clear();
    useWorkspaceStore.setState({
      boards: [board()],
      activeBoardId: 'board',
      selection: { kind: 'placement', id: 'free-a', ids: ['locked-a', 'locked-b', 'free-a', 'free-b'] },
      commandHistory: { past: [], future: [] },
      ready: true,
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('tidies only unlocked selected objects and preserves locked-only attachments', () => {
    useWorkspaceStore.getState().tidySelection('align-left');

    const active = useWorkspaceStore.getState().boards[0];
    expect(Object.fromEntries(active.placements.map((item) => [item.id, item.x]))).toEqual({
      'locked-a': 10,
      'locked-b': 140,
      'free-a': 300,
      'free-b': 300,
    });
    expect(active.attachments).toEqual([
      expect.objectContaining({ objectId: 'locked-a', attachedObjectId: 'locked-b' }),
    ]);
  });

  it('does not create history or detach anything when fewer than two unlocked objects can move', () => {
    useWorkspaceStore.setState({
      boards: [board()],
      selection: { kind: 'placement', id: 'locked-a', ids: ['locked-a', 'locked-b', 'free-a'] },
    });
    const before = useWorkspaceStore.getState().boards[0];

    useWorkspaceStore.getState().tidySelection('stack-vertical');

    expect(useWorkspaceStore.getState().boards[0]).toBe(before);
  });

  it('keeps surviving multi-selection active through undo and redo', () => {
    useWorkspaceStore.setState({ selection: { kind: 'placement', id: 'free-a', ids: ['free-a', 'free-b'] } });
    useWorkspaceStore.getState().tidySelection('align-left');
    expect(useWorkspaceStore.getState().boards[0].placements.find((item) => item.id === 'free-b')?.x).toBe(300);

    useWorkspaceStore.getState().undo();
    expect(useWorkspaceStore.getState().boards[0].placements.find((item) => item.id === 'free-b')?.x).toBe(520);
    expect(useWorkspaceStore.getState().selection).toEqual({ kind: 'placement', id: 'free-a', ids: ['free-a', 'free-b'] });

    useWorkspaceStore.getState().redo();
    expect(useWorkspaceStore.getState().boards[0].placements.find((item) => item.id === 'free-b')?.x).toBe(300);
    expect(useWorkspaceStore.getState().selection).toEqual({ kind: 'placement', id: 'free-a', ids: ['free-a', 'free-b'] });
  });
});
