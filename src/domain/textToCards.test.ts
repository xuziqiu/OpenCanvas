import { describe, expect, it } from 'vitest';
import type { Board, BoardPlacement } from '../types';
import { convertTextPlacementsToCards } from './textToCards';

const text = (id: string, overrides: Partial<BoardPlacement> = {}): BoardPlacement => ({
  id,
  kind: 'text',
  text: `${id} 正文`,
  x: 20,
  y: 30,
  width: 240,
  height: 80,
  color: 'transparent',
  ...overrides,
});

const board = (): Board => ({
  version: 4,
  id: 'board',
  fileName: 'board.board.json',
  title: '文字转换',
  placements: [
    text('one', { groupId: 'group', sectionId: 'section', sectionIds: ['section'], zIndex: 4 }),
    text('two', { x: 400, width: 640, color: 'yellow' }),
    text('section', { isFrame: true, width: 1200, height: 500 }),
  ],
  connectors: [{ id: 'line', from: 'one', to: 'two', label: '关系' }],
  attachments: [{ objectId: 'one', attachedObjectId: 'two', direction: 'right', gap: 6 }],
  viewport: { x: 0, y: 0, zoom: 1 },
  createdAt: 'old',
  updatedAt: 'old',
});

describe('text to card conversion', () => {
  it('creates independent Markdown cards while preserving spatial relationships', () => {
    const ids = ['card-one', 'placement-one', 'card-two', 'placement-two'];
    const result = convertTextPlacementsToCards(board(), [], ['one', 'two', 'section'], {
      createId: () => ids.shift()!,
      now: 'now',
      projectPath: '项目/资料',
    });

    expect(result.replacementMap).toEqual({ one: 'placement-one', two: 'placement-two' });
    expect(result.cards.map((card) => ({ id: card.id, body: card.body, path: card.relativePath }))).toEqual([
      { id: 'card-one', body: 'one 正文', path: '项目/资料/未命名卡片--card-one.md' },
      { id: 'card-two', body: 'two 正文', path: '项目/资料/未命名卡片--card-two.md' },
    ]);
    expect(result.board.placements).toEqual([
      expect.objectContaining({ id: 'placement-one', kind: 'card', entityId: 'card-one', x: 20, y: 30, width: 520, height: 172, color: 'paper', groupId: 'group', sectionId: 'section', sectionIds: ['section'], zIndex: 4 }),
      expect.objectContaining({ id: 'placement-two', kind: 'card', entityId: 'card-two', x: 400, width: 640, height: 172, color: 'yellow' }),
      expect.objectContaining({ id: 'section', isFrame: true, kind: 'text' }),
    ]);
    expect(result.board.connectors[0]).toMatchObject({ from: 'placement-one', to: 'placement-two', label: '关系' });
    expect(result.board.attachments[0]).toMatchObject({ objectId: 'placement-one', attachedObjectId: 'placement-two' });
  });

  it('does nothing when the selection contains no free-text object', () => {
    const original = board();
    const result = convertTextPlacementsToCards(original, [], ['section'], { createId: () => 'unused', now: 'now' });
    expect(result.board).toBe(original);
    expect(result.createdCards).toEqual([]);
  });
});
