import { describe, expect, it } from 'vitest';
import { transferBoardPlacements } from './boardTransfer';
import type { Board, BoardPlacement } from '../types';

const placement = (id: string, x: number, y: number, extra: Partial<BoardPlacement> = {}): BoardPlacement => ({
  id, kind: 'card', entityId: `card-${id}`, x, y, width: 100, height: 80, color: 'paper', ...extra,
});
const board = (id: string, placements: BoardPlacement[] = []): Board => ({
  version: 4, id, fileName: `${id}.board.json`, title: id, placements, connectors: [], attachments: [], viewport: { x: 0, y: 0, zoom: 1 }, createdAt: 'before', updatedAt: 'before',
});

describe('cross-whiteboard placement transfer', () => {
  it('moves a nested Section with its members, internal connector and attachment to the right of target content', () => {
    const section = placement('section', 100, 100, { kind: 'text', entityId: undefined, text: 'Section', isFrame: true, width: 320, height: 220, sectionBaseBounds: { x: 90, y: 90, width: 340, height: 240 } });
    const first = placement('first', 140, 140, { sectionId: 'section', sectionIds: ['section'] });
    const second = placement('second', 270, 140, { sectionId: 'section', sectionIds: ['section'] });
    const outside = placement('outside', 520, 140, { sectionId: 'section', sectionIds: ['section'] });
    const source = {
      ...board('source', [section, first, second, outside]),
      connectors: [
        { id: 'internal', from: 'first', to: 'second', controlPoints: [{ id: 'point', x: 230, y: 180 }] },
        { id: 'external', from: 'second', to: 'outside' },
      ],
      attachments: [
        { objectId: 'first', attachedObjectId: 'second', direction: 'right' as const, gap: 6 },
        { objectId: 'second', attachedObjectId: 'outside', direction: 'right' as const, gap: 6 },
      ],
    };
    const target = board('target', [placement('existing', 40, 60, { width: 260, height: 120 })]);
    const result = transferBoardPlacements(source, target, ['section', 'first', 'second'], { now: 'after' })!;

    expect(result.source.placements.map((item) => item.id)).toEqual(['outside']);
    expect(result.source.placements[0]).toMatchObject({ sectionId: undefined, sectionIds: undefined });
    expect(result.source.connectors).toEqual([]);
    expect(result.source.attachments).toEqual([]);
    expect(result.target.placements.find((item) => item.id === 'section')).toMatchObject({ x: 290, y: 50, sectionBaseBounds: undefined });
    expect(result.target.placements.find((item) => item.id === 'first')).toMatchObject({ x: 340, y: 100, sectionId: 'section', sectionIds: ['section'] });
    expect(result.target.connectors[0]).toMatchObject({ id: 'internal', from: 'first', to: 'second', controlPoints: [{ id: 'point', x: 430, y: 140 }] });
    expect(result.target.attachments).toEqual([{ objectId: 'first', attachedObjectId: 'second', direction: 'right', gap: 6 }]);
  });

  it('detaches a split legacy group on both sides of a move', () => {
    const source = board('source', [placement('a', 0, 0, { groupId: 'group' }), placement('b', 120, 0, { groupId: 'group' })]);
    const result = transferBoardPlacements(source, board('target'), ['a'], { targetPosition: { x: 10, y: 20 } })!;
    expect(result.source.placements[0].groupId).toBeUndefined();
    expect(result.target.placements[0]).toMatchObject({ id: 'a', x: 10, y: 20, groupId: undefined });
  });

  it('copies instances with fresh spatial identities while leaving the source unchanged', () => {
    let sequence = 0;
    const source = {
      ...board('source', [placement('a', 20, 30), placement('b', 160, 30)]),
      connectors: [{ id: 'line', from: 'a', to: 'b', controlPoints: [{ id: 'point', x: 130, y: 70 }] }],
    };
    const result = transferBoardPlacements(source, board('target'), ['a', 'b'], { copy: true, targetPosition: { x: 500, y: 200 }, createId: () => `new-${++sequence}` })!;
    expect(result.source).toBe(source);
    expect(result.destinationPlacementIds).toEqual(['new-1', 'new-2']);
    expect(result.target.placements).toMatchObject([
      { id: 'new-1', entityId: 'card-a', x: 500, y: 200 },
      { id: 'new-2', entityId: 'card-b', x: 640, y: 200 },
    ]);
    expect(result.target.connectors[0]).toMatchObject({ id: 'new-3', from: 'new-1', to: 'new-2', controlPoints: [{ id: 'point', x: 610, y: 240 }] });
  });
});
