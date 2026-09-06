import { describe, expect, it } from 'vitest';
import type { BoardPlacement } from '../types';
import { FOLDED_CARD_HEIGHT, setCardPlacementsCollapsed } from './cardFold';

const placement = (id: string, overrides: Partial<BoardPlacement> = {}): BoardPlacement => ({
  id, kind: 'card', entityId: `${id}-entity`, x: 10, y: 20, width: 520, height: 310, color: 'paper', ...overrides,
});

describe('folded card geometry', () => {
  it('keeps the expanded height separately and restores it without losing auto-height', () => {
    const folded = setCardPlacementsCollapsed([placement('card', { autoHeight: true, scrollTop: 48 })], new Set(['card']), true);
    expect(folded.placements[0]).toMatchObject({ collapsed: true, height: FOLDED_CARD_HEIGHT, expandedHeight: 310, autoHeight: true, scrollTop: 48 });
    expect([...folded.changedIds]).toEqual(['card']);

    const expanded = setCardPlacementsCollapsed(folded.placements, new Set(['card']), false);
    expect(expanded.placements[0]).toMatchObject({ height: 310, autoHeight: true, scrollTop: 48 });
    expect(expanded.placements[0].collapsed).toBeUndefined();
    expect(expanded.placements[0].expandedHeight).toBeUndefined();
  });

  it('skips locked, non-card, unselected, and already matching placements', () => {
    const values = [
      placement('locked', { locked: true }),
      placement('board', { kind: 'board' }),
      placement('folded', { collapsed: true, height: FOLDED_CARD_HEIGHT, expandedHeight: 200 }),
      placement('other'),
    ];
    const result = setCardPlacementsCollapsed(values, new Set(['locked', 'board', 'folded']), true);
    expect(result.placements).toEqual(values);
    expect(result.changedIds.size).toBe(0);
  });
});
