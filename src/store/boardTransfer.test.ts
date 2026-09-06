import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Board, BoardPlacement, Card } from '../types';

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
});

const { useWorkspaceStore } = await import('../store');
const now = '2026-08-16T00:00:00.000Z';
const card: Card = { id: 'card', fileName: 'card.md', relativePath: 'card.md', title: '卡片', body: '', createdAt: now, updatedAt: now };
const cardPlacement = (): BoardPlacement => ({ id: 'card-placement', kind: 'card', entityId: card.id, x: 80, y: 100, width: 300, height: 180, color: 'paper' });
const nestedPlacement = (id: string, entityId: string): BoardPlacement => ({ id, kind: 'board', entityId, x: 500, y: 100, width: 430, height: 270, color: 'blue' });
const board = (id: string, placements: BoardPlacement[] = []): Board => ({
  version: 4, id, fileName: `${id}.board.json`, title: id, placements, connectors: [], attachments: [], viewport: { x: 0, y: 0, zoom: 1 }, createdAt: now, updatedAt: now,
});

describe('store cross-whiteboard transfer history', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    storage.clear();
    useWorkspaceStore.getState().cancelBoardTransaction();
    useWorkspaceStore.setState({
      cards: [card], boards: [board('source', [cardPlacement(), nestedPlacement('target-occurrence', 'target')]), board('target')],
      activeBoardId: 'source', selection: { kind: 'placement', id: 'card-placement', ids: ['card-placement'] },
      commandHistory: { past: [], future: [] }, notices: [], externalChangePaths: [], ready: true,
    });
  });

  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('commits a live drag and target-board mutation as one undoable command', () => {
    const state = useWorkspaceStore.getState();
    state.beginBoardTransaction('移动对象');
    state.updateBoardLayout({ 'card-placement': { x: 520, y: 140 } });
    expect(state.transferPlacementsToBoard('target', ['card-placement'])).toBe(true);

    let current = useWorkspaceStore.getState();
    expect(current.boards.find((item) => item.id === 'source')?.placements.map((item) => item.id)).toEqual(['target-occurrence']);
    expect(current.boards.find((item) => item.id === 'target')?.placements[0]).toMatchObject({ id: 'card-placement', entityId: 'card', x: 140, y: 120 });
    expect(current.commandHistory.past).toHaveLength(1);
    expect(current.selection).toBeNull();

    current.undo();
    current = useWorkspaceStore.getState();
    expect(current.boards.find((item) => item.id === 'source')?.placements.find((item) => item.id === 'card-placement')).toMatchObject({ x: 80, y: 100 });
    expect(current.boards.find((item) => item.id === 'target')?.placements).toEqual([]);

    current.redo();
    current = useWorkspaceStore.getState();
    expect(current.boards.find((item) => item.id === 'source')?.placements.some((item) => item.id === 'card-placement')).toBe(false);
    expect(current.boards.find((item) => item.id === 'target')?.placements[0]).toMatchObject({ id: 'card-placement', entityId: 'card' });
  });

  it('uses Alt-style copy semantics without leaving the source at its transient drag position', () => {
    const state = useWorkspaceStore.getState();
    state.beginBoardTransaction('移动对象');
    state.updateBoardLayout({ 'card-placement': { x: 700, y: 400 } });
    expect(state.transferPlacementsToBoard('target', ['card-placement'], { copy: true })).toBe(true);

    let current = useWorkspaceStore.getState();
    expect(current.boards.find((item) => item.id === 'source')?.placements.find((item) => item.id === 'card-placement')).toMatchObject({ x: 80, y: 100 });
    const copy = current.boards.find((item) => item.id === 'target')?.placements[0];
    expect(copy).toMatchObject({ kind: 'card', entityId: 'card', x: 140, y: 120 });
    expect(copy?.id).not.toBe('card-placement');

    current.undo();
    current = useWorkspaceStore.getState();
    expect(current.boards.find((item) => item.id === 'target')?.placements).toEqual([]);
    expect(current.boards.find((item) => item.id === 'source')?.placements.find((item) => item.id === 'card-placement')).toMatchObject({ x: 80, y: 100 });
  });

  it('copies Section contents into a nested whiteboard without copying the Section frame', () => {
    const section: BoardPlacement = {
      id: 'section', kind: 'text', text: '区块', isFrame: true,
      x: 40, y: 60, width: 480, height: 320, color: 'transparent',
    };
    const member = { ...cardPlacement(), x: 100, y: 120, sectionId: section.id, sectionIds: [section.id] };
    useWorkspaceStore.setState({
      boards: [board('source', [section, member, nestedPlacement('target-occurrence', 'target')]), board('target')],
      activeBoardId: 'source', commandHistory: { past: [], future: [] }, notices: [],
    });

    const state = useWorkspaceStore.getState();
    state.beginBoardTransaction('移动多个对象');
    state.updateBoardLayout({ section: { x: 500, y: 100 }, 'card-placement': { x: 560, y: 160 } });
    expect(state.transferPlacementsToBoard('target', ['section', 'card-placement'], { copy: true })).toBe(true);

    const current = useWorkspaceStore.getState();
    const source = current.boards.find((item) => item.id === 'source')!;
    const target = current.boards.find((item) => item.id === 'target')!;
    expect(source.placements.find((item) => item.id === 'section')).toMatchObject({ x: 40, y: 60 });
    expect(source.placements.find((item) => item.id === 'card-placement')).toMatchObject({ x: 100, y: 120, sectionIds: ['section'] });
    expect(target.placements).toHaveLength(1);
    expect(target.placements[0]).toMatchObject({ kind: 'card', entityId: card.id, sectionId: undefined, sectionIds: undefined });
    expect(target.placements[0].id).not.toBe('card-placement');
  });

  it('moves a complex multi-selection with only its internal connector and restores both boards atomically', () => {
    const first = { ...cardPlacement(), id: 'first', entityId: 'card', x: 80, y: 100 };
    const second = { ...cardPlacement(), id: 'second', entityId: 'card', x: 420, y: 100 };
    const outside = { ...cardPlacement(), id: 'outside', entityId: 'card', x: 760, y: 100 };
    const source = {
      ...board('source', [first, second, outside, nestedPlacement('target-occurrence', 'target')]),
      connectors: [
        { id: 'internal', from: first.id, to: second.id, controlPoints: [{ id: 'bend', x: 350, y: 190 }] },
        { id: 'external', from: second.id, to: outside.id },
      ],
    };
    useWorkspaceStore.setState({
      boards: [source, board('target')], activeBoardId: 'source',
      commandHistory: { past: [], future: [] }, notices: [],
    });

    const state = useWorkspaceStore.getState();
    state.beginBoardTransaction('移动多个对象');
    state.updateBoardLayout({ first: { x: 600, y: 300 }, second: { x: 940, y: 300 } });
    expect(state.transferPlacementsToBoard('target', ['first', 'second'])).toBe(true);

    let current = useWorkspaceStore.getState();
    expect(current.boards.find((item) => item.id === 'source')?.placements.map((item) => item.id)).toEqual(['outside', 'target-occurrence']);
    expect(current.boards.find((item) => item.id === 'source')?.connectors).toEqual([]);
    expect(current.boards.find((item) => item.id === 'target')?.placements.map((item) => item.id)).toEqual(['first', 'second']);
    expect(current.boards.find((item) => item.id === 'target')?.connectors).toMatchObject([{ id: 'internal', from: 'first', to: 'second' }]);

    current.undo();
    current = useWorkspaceStore.getState();
    expect(current.boards.find((item) => item.id === 'source')?.placements.find((item) => item.id === 'first')).toMatchObject({ x: 80, y: 100 });
    expect(current.boards.find((item) => item.id === 'source')?.connectors.map((item) => item.id)).toEqual(['internal', 'external']);
    expect(current.boards.find((item) => item.id === 'target')?.placements).toEqual([]);

    current.redo();
    current = useWorkspaceStore.getState();
    expect(current.boards.find((item) => item.id === 'source')?.connectors).toEqual([]);
    expect(current.boards.find((item) => item.id === 'target')?.connectors.map((item) => item.id)).toEqual(['internal']);
  });

  it('does not create an empty nested-board copy when only a Section frame is supplied', () => {
    const section: BoardPlacement = {
      id: 'section', kind: 'text', text: '区块', isFrame: true,
      x: 40, y: 60, width: 480, height: 320, color: 'transparent',
    };
    useWorkspaceStore.setState({
      boards: [board('source', [section, nestedPlacement('target-occurrence', 'target')]), board('target')],
      activeBoardId: 'source', commandHistory: { past: [], future: [] }, notices: [],
    });

    expect(useWorkspaceStore.getState().transferPlacementsToBoard('target', ['section'], { copy: true })).toBe(false);
    const current = useWorkspaceStore.getState();
    expect(current.boards.find((item) => item.id === 'source')?.placements.some((item) => item.id === 'section')).toBe(true);
    expect(current.boards.find((item) => item.id === 'target')?.placements).toEqual([]);
    expect(current.commandHistory.past).toEqual([]);
  });

  it('rejects moving a nested whiteboard into one of its own descendants', () => {
    useWorkspaceStore.setState({
      boards: [
        board('source', [nestedPlacement('target-occurrence', 'target'), nestedPlacement('ancestor-occurrence', 'ancestor')]),
        board('ancestor', [nestedPlacement('ancestor-target', 'target')]),
        board('target'),
      ],
      activeBoardId: 'source', commandHistory: { past: [], future: [] }, notices: [],
    });
    expect(useWorkspaceStore.getState().transferPlacementsToBoard('target', ['ancestor-occurrence'])).toBe(false);
    const current = useWorkspaceStore.getState();
    expect(current.boards.find((item) => item.id === 'source')?.placements.some((item) => item.id === 'ancestor-occurrence')).toBe(true);
    expect(current.commandHistory.past).toEqual([]);
    expect(current.notices.at(-1)?.title).toBe('无法移入这个白板');
  });
});
