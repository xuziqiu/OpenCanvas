import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SECTION_DIMENSIONS } from '../domain/defaultPlacementSize';
import type { Board, BoardPlacement, Card } from '../types';

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
});

const { useWorkspaceStore } = await import('../store');
const now = '2026-08-16T00:00:00.000Z';
const section = (): BoardPlacement => ({
  id: 'section', kind: 'text', text: '区块', isFrame: true,
  x: 0, y: 0, width: 300, height: 180, color: 'transparent',
});
const board = (id: string): Board => ({
  version: 4, id, fileName: `${id}.board.json`, title: id,
  placements: id === 'parent' ? [section()] : [], connectors: [], attachments: [],
  viewport: { x: 0, y: 0, zoom: 1 }, createdAt: now, updatedAt: now,
});
const card: Card = {
  id: 'card', fileName: 'card.md', relativePath: 'card.md', title: '卡片', body: '',
  createdAt: now, updatedAt: now,
};

describe('create objects inside a Section', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    storage.clear();
    useWorkspaceStore.setState({
      cards: [card], boards: [board('parent'), board('nested')], projects: [], folders: [],
      activeBoardId: 'parent', selection: null,
      commandHistory: { past: [], future: [] }, externalChangePaths: [], ready: true,
    });
  });

  afterEach(async () => {
    await useWorkspaceStore.getState().flushPendingSaves();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each([
    ['card', () => useWorkspaceStore.getState().addCardPlacement('card', { x: 240, y: 80, sectionId: 'section' })],
    ['text', () => useWorkspaceStore.getState().addTextPlacement({ x: 260, y: 150, sectionIds: ['section'] })],
    ['board', () => useWorkspaceStore.getState().addBoardPlacement('nested', { x: 250, y: 160, sectionId: 'section', sectionIds: ['section'] })],
  ] as const)('creates a %s with membership, elastic padding and atomic undo/redo', (kind, create) => {
    const placement = create();
    expect(placement).not.toBeNull();

    let state = useWorkspaceStore.getState();
    let active = state.boards.find((item) => item.id === 'parent')!;
    const created = active.placements.find((item) => item.id === placement!.id)!;
    const grownSection = active.placements.find((item) => item.id === 'section')!;
    expect(created).toMatchObject({ kind, sectionId: 'section', sectionIds: ['section'] });
    expect(grownSection.sectionBaseBounds).toEqual({ x: 0, y: 0, width: 300, height: 180 });
    expect(grownSection.x).toBeLessThanOrEqual(created.x - 40);
    expect(grownSection.y).toBeLessThanOrEqual(created.y - 40);
    expect(grownSection.x + grownSection.width).toBeGreaterThanOrEqual(created.x + created.width + 40);
    expect(grownSection.y + grownSection.height).toBeGreaterThanOrEqual(created.y + created.height + 40);
    expect(state.selection).toEqual({ kind: 'placement', id: created.id });
    expect(state.commandHistory.past).toHaveLength(1);

    state.undo();
    state = useWorkspaceStore.getState();
    active = state.boards.find((item) => item.id === 'parent')!;
    expect(active.placements).toEqual([section()]);

    state.redo();
    state = useWorkspaceStore.getState();
    active = state.boards.find((item) => item.id === 'parent')!;
    expect(active.placements.find((item) => item.id === created.id)).toMatchObject({ sectionId: 'section', sectionIds: ['section'] });
    expect(active.placements.find((item) => item.id === 'section')?.sectionBaseBounds).toEqual({ x: 0, y: 0, width: 300, height: 180 });
  });

  it('keeps ordinary creation unrelated when no Section was targeted', () => {
    const placement = useWorkspaceStore.getState().addCardPlacement('card', { x: 240, y: 80 })!;
    const active = useWorkspaceStore.getState().boards.find((item) => item.id === 'parent')!;
    expect(active.placements.find((item) => item.id === placement.id)).not.toHaveProperty('sectionId');
    expect(active.placements.find((item) => item.id === 'section')).toEqual(section());
  });

  it.each([
    ['new card', () => useWorkspaceStore.getState().createCardPlacement({ x: 120, y: 120 })],
    ['existing card', () => useWorkspaceStore.getState().addCardPlacement('card', { x: 120, y: 120 })],
    ['text', () => useWorkspaceStore.getState().addTextPlacement({ x: 120, y: 120 })],
    ['existing whiteboard', () => useWorkspaceStore.getState().addBoardPlacement('nested', { x: 120, y: 120 })],
    ['new whiteboard', () => useWorkspaceStore.getState().createNestedBoardPlacement({ x: 120, y: 120 })],
  ] as const)('automatically relates a fully contained %s created without an explicit Section id', (_label, create) => {
    const largeSection = { ...section(), width: 900, height: 700 };
    useWorkspaceStore.setState({
      boards: [{ ...board('parent'), placements: [largeSection] }, board('nested')],
      activeBoardId: 'parent', commandHistory: { past: [], future: [] }, selection: null,
    });
    const placement = create();
    expect(placement).not.toBeNull();
    expect(useWorkspaceStore.getState().boards.find((item) => item.id === 'parent')?.placements.find((item) => item.id === placement!.id)).toMatchObject({
      sectionId: largeSection.id,
      sectionIds: [largeSection.id],
    });
  });

  it('persists a Section color as one undoable board command', () => {
    useWorkspaceStore.getState().setSelection({ kind: 'placement', id: 'section', ids: ['section'] });
    useWorkspaceStore.getState().setSelectionColor('blue');

    let state = useWorkspaceStore.getState();
    expect(state.boards[0].placements.find((item) => item.id === 'section')?.color).toBe('blue');
    expect(state.commandHistory.past.at(-1)?.label).toBe('修改对象颜色');
    expect(state.selection).toEqual({ kind: 'placement', id: 'section', ids: ['section'] });

    state.undo();
    state = useWorkspaceStore.getState();
    expect(state.boards[0].placements.find((item) => item.id === 'section')?.color).toBe('transparent');
    expect(state.selection).toEqual({ kind: 'placement', id: 'section', ids: ['section'] });

    state.redo();
    expect(useWorkspaceStore.getState().boards[0].placements.find((item) => item.id === 'section')?.color).toBe('blue');
  });

  it('creates a default nested Section, adopts contained objects and keeps the whole hierarchy in one history step', () => {
    const parent = { ...section(), width: 1000, height: 800 };
    const existing: BoardPlacement = {
      id: 'existing', kind: 'card', entityId: 'card', x: 220, y: 210,
      width: 200, height: 120, color: 'paper', sectionId: parent.id, sectionIds: [parent.id],
    };
    useWorkspaceStore.setState({
      boards: [{ ...board('parent'), placements: [parent, existing] }, board('nested')],
      selection: { kind: 'placement', id: parent.id, ids: [parent.id] },
      commandHistory: { past: [], future: [] },
    });

    const created = useWorkspaceStore.getState().addSectionPlacement({ x: 100, y: 100, sectionId: parent.id })!;
    let state = useWorkspaceStore.getState();
    let active = state.boards.find((item) => item.id === 'parent')!;
    expect(created).toMatchObject({
      kind: 'text', isFrame: true, text: '区块 2', x: 100, y: 100,
      ...DEFAULT_SECTION_DIMENSIONS, sectionId: parent.id, sectionIds: [parent.id],
    });
    expect(active.placements.find((item) => item.id === existing.id)).toMatchObject({
      sectionId: parent.id,
      sectionIds: [parent.id, created.id],
    });
    expect(state.selection).toEqual({ kind: 'placement', id: created.id, ids: [created.id] });
    expect(state.commandHistory.past).toHaveLength(1);

    state.undo();
    state = useWorkspaceStore.getState();
    active = state.boards.find((item) => item.id === 'parent')!;
    expect(active.placements).toEqual([parent, existing]);

    state.redo();
    active = useWorkspaceStore.getState().boards.find((item) => item.id === 'parent')!;
    expect(active.placements.find((item) => item.id === created.id)).toMatchObject({ sectionIds: [parent.id] });
    expect(active.placements.find((item) => item.id === existing.id)?.sectionIds).toEqual([parent.id, created.id]);
  });

  it('does not claim a parent Section when the new default rectangle is not contained', () => {
    const created = useWorkspaceStore.getState().addSectionPlacement({ x: 250, y: 150, sectionId: 'section' })!;
    expect(created).toMatchObject({ x: 250, y: 150, ...DEFAULT_SECTION_DIMENSIONS });
    expect(created).not.toHaveProperty('sectionId');
    expect(useWorkspaceStore.getState().boards[0].placements.find((item) => item.id === 'section')).toEqual(section());
  });

  it('uses a drawn rectangle, clamps it to the Section minimum and adopts only fully contained objects', () => {
    const inside: BoardPlacement = { id: 'inside', kind: 'card', entityId: 'card', x: 120, y: 120, width: 80, height: 60, color: 'paper' };
    const crossing: BoardPlacement = { id: 'crossing', kind: 'text', text: '跨过边界', x: 280, y: 180, width: 80, height: 60, color: 'transparent' };
    useWorkspaceStore.setState({
      boards: [{ ...board('parent'), placements: [inside, crossing] }, board('nested')],
      commandHistory: { past: [], future: [] },
    });

    const drawn = useWorkspaceStore.getState().addSectionPlacement({ x: 80, y: 80, width: 240, height: 180 })!;
    let active = useWorkspaceStore.getState().boards.find((item) => item.id === 'parent')!;
    expect(drawn).toMatchObject({ x: 80, y: 80, width: 240, height: 180 });
    expect(active.placements.find((item) => item.id === 'inside')?.sectionIds).toEqual([drawn.id]);
    expect(active.placements.find((item) => item.id === 'crossing')).not.toHaveProperty('sectionId');

    useWorkspaceStore.getState().undo();
    const tiny = useWorkspaceStore.getState().addSectionPlacement({ x: 500, y: 500, width: 20, height: 30 })!;
    active = useWorkspaceStore.getState().boards.find((item) => item.id === 'parent')!;
    expect(active.placements.find((item) => item.id === tiny.id)).toMatchObject({ width: 100, height: 100 });
  });

  it('uses dragged card and sub-whiteboard dimensions while enforcing their minimums', () => {
    const cardPlacement = useWorkspaceStore.getState().addCardPlacement('card', { x: 20, y: 30, width: 360, height: 170 })!;
    expect(cardPlacement).toMatchObject({ x: 20, y: 30, width: 360, height: 170 });
    useWorkspaceStore.getState().undo();

    const boardPlacement = useWorkspaceStore.getState().addBoardPlacement('nested', { x: 40, y: 50, width: 120, height: 80 })!;
    expect(boardPlacement).toMatchObject({ x: 40, y: 50, width: 300, height: 145 });
  });
});
