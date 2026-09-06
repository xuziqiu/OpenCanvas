import { describe, expect, it } from 'vitest';
import type { BoardPlacement } from '../types';
import { DEFAULT_PLACEMENT_DIMENSIONS, FOLDED_CARD_HEIGHT, MINIMUM_SECTION_DIMENSIONS, minimumPlacementDimensions, resetPlacementsToDefaultSize } from './defaultPlacementSize';

const placement = (id: string, kind: BoardPlacement['kind'], overrides: Partial<BoardPlacement> = {}): BoardPlacement => ({
  id, kind, x: 20, y: 30, width: 777, height: 444, color: 'yellow', ...overrides,
});

describe('default placement size', () => {
  it('uses the compact minimum dimensions only while that card instance is folded', () => {
    expect(minimumPlacementDimensions(placement('folded', 'card', { collapsed: true }))).toEqual({ width: 280, height: 62 });
    expect(minimumPlacementDimensions(placement('expanded', 'card'))).toEqual({ width: 300, height: 145 });
    expect(minimumPlacementDimensions(placement('text', 'text'))).toEqual({ width: 300, height: 60 });
    expect(minimumPlacementDimensions(placement('section', 'text', { isFrame: true }))).toEqual(MINIMUM_SECTION_DIMENSIONS);
  });

  it('restores supported selected objects while preserving all non-size fields', () => {
    const result = resetPlacementsToDefaultSize([
      placement('card', 'card', { entityId: 'card-entity', sectionIds: ['section'], zIndex: 7, autoHeight: true }),
      placement('board', 'board', { entityId: 'board-entity' }),
      placement('text', 'text', { text: '文字内容' }),
    ], new Set(['card', 'board', 'text']));

    expect(result.placements).toEqual([
      expect.objectContaining({ id: 'card', ...DEFAULT_PLACEMENT_DIMENSIONS.card, x: 20, y: 30, color: 'yellow', entityId: 'card-entity', sectionIds: ['section'], zIndex: 7, autoHeight: undefined }),
      expect.objectContaining({ id: 'board', ...DEFAULT_PLACEMENT_DIMENSIONS.board, entityId: 'board-entity' }),
      expect.objectContaining({ id: 'text', ...DEFAULT_PLACEMENT_DIMENSIONS.text, text: '文字内容' }),
    ]);
    expect([...result.changedIds]).toEqual(['card', 'board', 'text']);
  });

  it('skips Sections, locked objects, unselected objects and exact defaults', () => {
    const exact = placement('exact', 'card', DEFAULT_PLACEMENT_DIMENSIONS.card);
    const values = [
      placement('section', 'text', { isFrame: true }),
      placement('locked', 'card', { locked: true }),
      placement('unselected', 'board'),
      exact,
    ];
    const result = resetPlacementsToDefaultSize(values, new Set(['section', 'locked', 'exact']));
    expect(result.placements).toEqual(values);
    expect(result.changedIds.size).toBe(0);
  });

  it('resets a folded card without expanding it and restores the default expanded height', () => {
    const result = resetPlacementsToDefaultSize([
      placement('folded', 'card', { collapsed: true, width: 760, height: FOLDED_CARD_HEIGHT, expandedHeight: 420, autoHeight: true }),
    ], new Set(['folded']));
    expect(result.placements[0]).toMatchObject({
      collapsed: true,
      width: DEFAULT_PLACEMENT_DIMENSIONS.card.width,
      height: FOLDED_CARD_HEIGHT,
      expandedHeight: DEFAULT_PLACEMENT_DIMENSIONS.card.height,
      autoHeight: undefined,
    });
  });
});
