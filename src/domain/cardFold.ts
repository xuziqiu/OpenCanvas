import type { BoardPlacement } from '../types';
import { DEFAULT_PLACEMENT_DIMENSIONS, FOLDED_CARD_HEIGHT } from './defaultPlacementSize';

/** Folded cards retain their expanded geometry while rendering a fixed-height title strip. */
export { FOLDED_CARD_HEIGHT } from './defaultPlacementSize';

export interface CardFoldResult {
  placements: BoardPlacement[];
  changedIds: Set<string>;
}

export function setCardPlacementsCollapsed(
  placements: BoardPlacement[],
  placementIds: ReadonlySet<string>,
  collapsed: boolean,
): CardFoldResult {
  const changedIds = new Set<string>();
  const next = placements.map((placement) => {
    if (!placementIds.has(placement.id)
      || placement.kind !== 'card'
      || placement.locked
      || Boolean(placement.collapsed) === collapsed) return placement;
    changedIds.add(placement.id);
    if (collapsed) return {
      ...placement,
      collapsed: true,
      expandedHeight: placement.height,
      height: FOLDED_CARD_HEIGHT,
    };
    return {
      ...placement,
      collapsed: undefined,
      expandedHeight: undefined,
      height: placement.expandedHeight ?? DEFAULT_PLACEMENT_DIMENSIONS.card.height,
    };
  });
  return { placements: next, changedIds };
}
