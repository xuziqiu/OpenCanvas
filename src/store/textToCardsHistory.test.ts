import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Board, BoardPlacement, Card, ProjectDirectory } from '../types';

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
});

const { useWorkspaceStore } = await import('../store');
const now = '2026-08-15T00:00:00.000Z';

const textPlacement = (id: string, x: number, overrides: Partial<BoardPlacement> = {}): BoardPlacement => ({
  id, kind: 'text', text: `${id} 的内容`, x, y: 80, width: 260, height: 110, color: 'transparent', ...overrides,
});
const existingCard: Card = {
  id: 'existing-card', fileName: '已有卡片.md', relativePath: '项目/已有卡片.md', title: '已有卡片', body: '保持原样', createdAt: now, updatedAt: now,
};
const project: ProjectDirectory = { id: 'project', name: '项目', relativePath: '项目', createdAt: now };
const board = (): Board => ({
  version: 4, id: 'board', fileName: 'board.board.json', title: '文字转换命令', projectId: project.id,
  placements: [
    { id: 'existing-placement', kind: 'card', entityId: existingCard.id, x: 20, y: 20, width: 520, height: 320, color: 'paper' },
    textPlacement('text-a', 620, { groupId: 'group', sectionId: 'section', sectionIds: ['section'], zIndex: 3 }),
    textPlacement('text-b', 980, { width: 700, color: 'blue' }),
    textPlacement('section', 560, { isFrame: true, width: 1300, height: 600 }),
  ],
  connectors: [{ id: 'line', from: 'existing-placement', to: 'text-a', label: '指向' }],
  attachments: [{ objectId: 'text-a', attachedObjectId: 'text-b', direction: 'right', gap: 6 }],
  viewport: { x: 0, y: 0, zoom: 1 }, createdAt: now, updatedAt: now,
});

describe('text-object to independent-card store command', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    storage.clear();
    useWorkspaceStore.setState({
      cards: [existingCard], boards: [board()], projects: [project], folders: [], activeBoardId: 'board',
      selection: { kind: 'placement', id: 'text-a', ids: ['existing-placement', 'text-a', 'text-b', 'section'] },
      commandHistory: { past: [], future: [] }, externalChangePaths: [], ready: true,
    });
  });

  afterEach(async () => {
    await useWorkspaceStore.getState().flushPendingSaves();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('converts only free text, keeps mixed selection and remaps relations in one history command', () => {
    useWorkspaceStore.getState().convertSelectedTextToCards();
    const state = useWorkspaceStore.getState();
    const active = state.boards[0];
    const converted = active.placements.filter((placement) => placement.kind === 'card' && placement.entityId !== existingCard.id);
    const convertedIds = converted.map((placement) => placement.id);

    expect(converted).toHaveLength(2);
    expect(state.cards.filter((card) => card.id !== existingCard.id)).toEqual([
      expect.objectContaining({ title: '未命名卡片', body: 'text-a 的内容', relativePath: expect.stringMatching(/^项目\/未命名卡片--.+\.md$/) }),
      expect.objectContaining({ title: '未命名卡片', body: 'text-b 的内容', relativePath: expect.stringMatching(/^项目\/未命名卡片--.+\.md$/) }),
    ]);
    expect(converted[0]).toMatchObject({ x: 620, y: 80, width: 520, height: 202, color: 'paper', groupId: 'group', sectionId: 'section', sectionIds: ['section'], zIndex: 3 });
    expect(converted[1]).toMatchObject({ x: 980, width: 700, height: 202, color: 'blue' });
    expect(active.placements).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'existing-placement', kind: 'card' }),
      expect.objectContaining({ id: 'section', kind: 'text', isFrame: true }),
    ]));
    expect(active.connectors[0]).toMatchObject({ from: 'existing-placement', to: convertedIds[0] });
    expect(active.attachments[0]).toMatchObject({ objectId: convertedIds[0], attachedObjectId: convertedIds[1] });
    expect(state.selection).toEqual({ kind: 'placement', id: convertedIds[0], ids: ['existing-placement', ...convertedIds, 'section'] });
    expect(state.commandHistory.past[0]).toMatchObject({
      label: '文字转为 2 张卡片', createdCards: expect.any(Array),
      placementReplacementMap: { 'text-a': convertedIds[0], 'text-b': convertedIds[1] },
    });
  });

  it('undoes and redoes entities, placements, selection and relations together', async () => {
    useWorkspaceStore.getState().convertSelectedTextToCards();
    const convertedState = useWorkspaceStore.getState();
    const createdCards = convertedState.cards.filter((card) => card.id !== existingCard.id);
    const convertedIds = convertedState.boards[0].placements
      .filter((placement) => placement.kind === 'card' && placement.entityId !== existingCard.id)
      .map((placement) => placement.id);

    useWorkspaceStore.getState().undo();
    let state = useWorkspaceStore.getState();
    expect(state.cards).toEqual([existingCard]);
    expect(state.boards[0].placements.map((placement) => placement.id)).toEqual(['existing-placement', 'text-a', 'text-b', 'section']);
    expect(state.boards[0].connectors[0]).toMatchObject({ from: 'existing-placement', to: 'text-a' });
    expect(state.boards[0].attachments[0]).toMatchObject({ objectId: 'text-a', attachedObjectId: 'text-b' });
    expect(state.selection).toEqual({ kind: 'placement', id: 'text-a', ids: ['existing-placement', 'text-a', 'text-b', 'section'] });

    await useWorkspaceStore.getState().flushPendingSaves();
    const undoneSnapshot = JSON.parse(storage.get('opencanvas.workspace.v4')!);
    expect(undoneSnapshot.cards).toEqual([expect.objectContaining({ id: existingCard.id })]);
    expect(undoneSnapshot.boards[0].placements.map((placement: BoardPlacement) => placement.id)).toContain('text-a');

    useWorkspaceStore.getState().redo();
    state = useWorkspaceStore.getState();
    expect(state.cards).toEqual([...createdCards, existingCard]);
    expect(state.boards[0].placements.map((placement) => placement.id)).toEqual(['existing-placement', ...convertedIds, 'section']);
    expect(state.selection).toEqual({ kind: 'placement', id: convertedIds[0], ids: ['existing-placement', ...convertedIds, 'section'] });

    await useWorkspaceStore.getState().flushPendingSaves();
    const redoneSnapshot = JSON.parse(storage.get('opencanvas.workspace.v4')!);
    expect(redoneSnapshot.cards.map((card: Card) => card.id)).toEqual(expect.arrayContaining(createdCards.map((card) => card.id)));
    expect(redoneSnapshot.boards[0].placements.map((placement: BoardPlacement) => placement.id)).toEqual(['existing-placement', ...convertedIds, 'section']);
  });
});
