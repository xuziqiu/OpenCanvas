import { describe, expect, it } from 'vitest';
import type { BoardPlacement } from '../types';
import { arrangePlacementZIndices, clonePlacementPayload, placementBounds, resizePlacementGroup } from './placementOperations';

const placement = (id: string, zIndex?: number, groupId?: string): BoardPlacement => ({
  id, kind: 'card', entityId: `card-${id}`, x: 0, y: 0, width: 300, height: 180, color: 'paper', zIndex, groupId,
});

describe('placement operations', () => {
  it('moves a stable multi-selection above and below every existing z-index', () => {
    const source = [placement('a', 3), placement('b'), placement('c', 12), placement('d', -4)];
    const front = arrangePlacementZIndices(source, ['a', 'b'], 'front');
    expect(front.map((item) => item.zIndex)).toEqual([14, 13, 12, -4]);
    const back = arrangePlacementZIndices(front, ['a', 'b'], 'back');
    expect(back.map((item) => item.zIndex)).toEqual([-5, -6, 12, -4]);
    expect(arrangePlacementZIndices(source, ['a'], 'forward').map((item) => item.zIndex)).toEqual([-1, -3, -2, -4]);
    expect(arrangePlacementZIndices(source, ['a'], 'backward').map((item) => item.zIndex)).toEqual([-3, -2, -1, -4]);
  });

  it('moves selected blocks by one visible neighbour across sparse and duplicate ranks', () => {
    const sparse = [placement('back', -20), placement('a', 3), placement('b', 3), placement('front', 80)];
    const forward = arrangePlacementZIndices(sparse, ['a', 'b'], 'forward');
    expect([...forward].sort((left, right) => left.zIndex! - right.zIndex!).map((item) => item.id)).toEqual(['back', 'front', 'a', 'b']);
    const backward = arrangePlacementZIndices(sparse, ['a', 'b'], 'backward');
    expect([...backward].sort((left, right) => left.zIndex! - right.zIndex!).map((item) => item.id)).toEqual(['a', 'b', 'back', 'front']);
    expect(arrangePlacementZIndices(sparse, ['front'], 'forward')).toBe(sparse);
    expect(arrangePlacementZIndices(sparse, ['back'], 'backward')).toBe(sparse);
  });

  it('gives a pasted group a new identity without splitting its copied members', () => {
    let sequence = 0;
    const result = clonePlacementPayload({
      type: 'opencanvas/placements',
      placements: [placement('a', 1, 'original-group'), placement('b', 2, 'original-group')],
      connectors: [{ id: 'edge', from: 'a', to: 'b' }],
      attachments: [],
    }, () => `new-${++sequence}`);
    expect(result.placements[0].groupId).toBe(result.placements[1].groupId);
    expect(result.placements[0].groupId).not.toBe('original-group');
    expect(result.connectors[0]).toMatchObject({ from: result.placements[0].id, to: result.placements[1].id });
  });

  it('remaps every copied Section relation and drops references outside the payload', () => {
    let sequence = 0;
    const outer = { ...placement('outer'), kind: 'text' as const, isFrame: true };
    const inner = { ...placement('inner'), kind: 'text' as const, isFrame: true, sectionId: outer.id, sectionIds: [outer.id] };
    const card = { ...placement('card'), sectionId: outer.id, sectionIds: [outer.id, inner.id, 'not-copied'] };
    const result = clonePlacementPayload({ type: 'opencanvas/placements', placements: [outer, inner, card], connectors: [] }, () => `copy-${++sequence}`);
    expect(result.placements[1].sectionIds).toEqual([result.placements[0].id]);
    expect(result.placements[2].sectionIds).toEqual([result.placements[0].id, result.placements[1].id]);
    expect(result.placements[2].sectionId).toBe(result.placements[0].id);
  });

  it('keeps a same-board Section relation without leaking it into another board', () => {
    let sequence = 0;
    const card = { ...placement('card'), sectionId: 'existing-section', sectionIds: ['existing-section'] };
    const local = clonePlacementPayload(
      { type: 'opencanvas/placements', placements: [card], connectors: [] },
      () => `local-${++sequence}`,
      undefined,
      new Set(['existing-section']),
    );
    const foreign = clonePlacementPayload(
      { type: 'opencanvas/placements', placements: [card], connectors: [] },
      () => `foreign-${++sequence}`,
    );
    expect(local.placements[0]).toMatchObject({ sectionId: 'existing-section', sectionIds: ['existing-section'] });
    expect(foreign.placements[0]).toMatchObject({ sectionId: undefined, sectionIds: undefined });
  });

  it('resizes a multi-selection around one shared bounding box', () => {
    const left = { ...placement('left'), x: 10, y: 20, width: 300, height: 180 };
    const right = { ...placement('right'), x: 410, y: 120, width: 300, height: 180 };
    const bounds = placementBounds([left, right]);
    expect(bounds).toEqual({ x: 10, y: 20, width: 700, height: 280 });
    expect(resizePlacementGroup([left, right], bounds!, { x: 10, y: 20, width: 1400, height: 560 })).toEqual({
      left: { x: 10, y: 20, width: 600, height: 360 },
      right: { x: 810, y: 220, width: 600, height: 360 },
    });
  });
});
