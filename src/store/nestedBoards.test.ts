import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Board } from '../types';

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
});

const { useWorkspaceStore } = await import('../store');

const now = '2026-01-01T00:00:00.000Z';
const board = (id: string, nested: string[] = []): Board => ({
  version: 4,
  id,
  fileName: `${id}.board.json`,
  title: id,
  placements: nested.map((childId) => ({
    id: `${id}-${childId}`,
    kind: 'board',
    entityId: childId,
    x: 0,
    y: 0,
    width: 430,
    height: 270,
    color: 'blue',
  })),
  connectors: [],
  attachments: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  createdAt: now,
  updatedAt: now,
});

describe('nested whiteboard references', () => {
  beforeEach(() => { vi.useFakeTimers(); storage.clear(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('removes only the selected occurrence while preserving the shared board entity and other parents', () => {
    useWorkspaceStore.setState({
      boards: [board('parent-a', ['shared']), board('parent-b', ['shared']), board('shared')],
      activeBoardId: 'parent-a',
      selection: { kind: 'placement', id: 'parent-a-shared' },
      ready: true,
    });

    useWorkspaceStore.getState().removeSelection();

    const state = useWorkspaceStore.getState();
    expect(state.boards.map((item) => item.id)).toEqual(['parent-a', 'parent-b', 'shared']);
    expect(state.boards.find((item) => item.id === 'parent-a')?.placements).toEqual([]);
    expect(state.boards.find((item) => item.id === 'parent-b')?.placements).toEqual([
      expect.objectContaining({ id: 'parent-b-shared', entityId: 'shared' }),
    ]);
    expect(state.selection).toBeNull();
  });

  it('duplicates a connected nested-board occurrence without forking its entity or losing its Section', () => {
    const parentA = board('parent-a', ['shared']);
    const occurrence = { ...parentA.placements[0], x: 100, y: 100, sectionId: 'section', sectionIds: ['section'] };
    const section = { id: 'section', kind: 'text' as const, text: 'Section', isFrame: true, x: 40, y: 40, width: 900, height: 600, color: 'transparent' };
    const peer = { id: 'peer', kind: 'text' as const, text: 'Peer', x: 520, y: 130, width: 220, height: 90, color: 'transparent', sectionId: 'section', sectionIds: ['section'] };
    parentA.placements = [section, occurrence, peer];
    parentA.connectors = [{ id: 'edge', from: occurrence.id, to: peer.id }];
    useWorkspaceStore.setState({
      boards: [parentA, board('parent-b', ['shared']), board('shared')],
      activeBoardId: parentA.id,
      selection: { kind: 'placement', id: occurrence.id, ids: [occurrence.id, peer.id] },
      commandHistory: { past: [], future: [] },
      ready: true,
    });

    useWorkspaceStore.getState().duplicateSelection();
    const duplicated = useWorkspaceStore.getState();
    const duplicatedBoard = duplicated.boards.find((item) => item.id === parentA.id)!;
    const copyIds = duplicated.selection?.kind === 'placement' ? duplicated.selection.ids! : [];
    const copiedOccurrence = duplicatedBoard.placements.find((item) => copyIds.includes(item.id) && item.kind === 'board')!;
    const copiedPeer = duplicatedBoard.placements.find((item) => copyIds.includes(item.id) && item.kind === 'text')!;
    expect(copiedOccurrence).toMatchObject({ entityId: 'shared', sectionId: section.id, sectionIds: [section.id] });
    expect(copiedPeer).toMatchObject({ sectionId: section.id, sectionIds: [section.id] });
    expect(duplicatedBoard.connectors).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: copiedOccurrence.id, to: copiedPeer.id }),
    ]));
    expect(duplicated.boards.filter((item) => item.id === 'shared')).toHaveLength(1);

    useWorkspaceStore.getState().undo();
    const undone = useWorkspaceStore.getState();
    expect(undone.selection).toEqual({ kind: 'placement', id: occurrence.id, ids: [occurrence.id, peer.id] });
    expect(undone.boards.find((item) => item.id === parentA.id)?.placements.some((item) => copyIds.includes(item.id))).toBe(false);

    useWorkspaceStore.getState().redo();
    const redone = useWorkspaceStore.getState();
    expect(redone.selection).toEqual({ kind: 'placement', id: copyIds[0], ids: copyIds });
    expect(redone.boards.find((item) => item.id === parentA.id)?.connectors).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: copiedOccurrence.id, to: copiedPeer.id }),
    ]));

    useWorkspaceStore.getState().setSelection({ kind: 'placement', id: copiedOccurrence.id, ids: [copiedOccurrence.id] });
    useWorkspaceStore.getState().removeSelection();
    const removed = useWorkspaceStore.getState();
    expect(removed.boards.some((item) => item.id === 'shared')).toBe(true);
    expect(removed.boards.find((item) => item.id === 'parent-b')?.placements.some((item) => item.entityId === 'shared')).toBe(true);
    expect(removed.boards.find((item) => item.id === parentA.id)?.connectors.some((item) => item.from === copiedOccurrence.id || item.to === copiedOccurrence.id)).toBe(false);
    expect(removed.boards.find((item) => item.id === parentA.id)?.connectors).toEqual([expect.objectContaining({ id: 'edge' })]);
  });

  it('connects the nested-board occurrence but rejects its Section container and missing instances', () => {
    const parent = board('parent', ['shared']);
    parent.placements.push(
      { id: 'section', kind: 'text', text: 'Section', isFrame: true, x: 0, y: 0, width: 800, height: 600, color: 'transparent' },
      { id: 'peer', kind: 'text', text: 'Peer', x: 500, y: 100, width: 220, height: 90, color: 'transparent' },
    );
    useWorkspaceStore.setState({
      boards: [parent, board('shared')], activeBoardId: parent.id,
      commandHistory: { past: [], future: [] }, selection: null, ready: true,
    });

    useWorkspaceStore.getState().connectPlacements('parent-shared', 'peer');
    useWorkspaceStore.getState().connectPlacements('section', 'peer');
    useWorkspaceStore.getState().connectPlacements('missing', 'peer');

    expect(useWorkspaceStore.getState().boards.find((item) => item.id === parent.id)?.connectors).toEqual([
      expect.objectContaining({ from: 'parent-shared', to: 'peer' }),
    ]);
    expect(useWorkspaceStore.getState().commandHistory.past).toHaveLength(1);
  });
});
