import type { BoardPlacement } from '../types';

export const FOLDED_CARD_HEIGHT = 62;
export const FOLDED_CARD_MIN_WIDTH = 280;
export const DEFAULT_SECTION_DIMENSIONS = { width: 600, height: 480 } as const;
export const MINIMUM_SECTION_DIMENSIONS = { width: 100, height: 100 } as const;

export const DEFAULT_PLACEMENT_DIMENSIONS = {
  card: { width: 520, height: 185 },
  board: { width: 430, height: 270 },
  text: { width: 300, height: 90 },
} as const;

export function minimumPlacementDimensions(placement: Pick<BoardPlacement, 'kind' | 'collapsed' | 'isFrame'>) {
  if (placement.isFrame) return MINIMUM_SECTION_DIMENSIONS;
  return {
    width: placement.kind === 'card' && placement.collapsed ? FOLDED_CARD_MIN_WIDTH : 300,
    height: placement.kind === 'card' && placement.collapsed
      ? FOLDED_CARD_HEIGHT
      : placement.kind === 'text' ? 60 : 145,
  };
}

export interface DefaultSizeResult {
  placements: BoardPlacement[];
  changedIds: Set<string>;
}

/** Restores selected supported objects to the same dimensions used at creation. */
export function resetPlacementsToDefaultSize(placements: BoardPlacement[], selectedIds: ReadonlySet<string>): DefaultSizeResult {
  const changedIds = new Set<string>();
  const next = placements.map((placement) => {
    if (!selectedIds.has(placement.id) || placement.locked || placement.isFrame) return placement;
    const defaultDimensions = DEFAULT_PLACEMENT_DIMENSIONS[placement.kind];
    if (!defaultDimensions) return placement;
    const dimensions = placement.kind === 'card' && placement.collapsed
      ? { width: defaultDimensions.width, height: FOLDED_CARD_HEIGHT, expandedHeight: defaultDimensions.height }
      : defaultDimensions;
    if (placement.width === dimensions.width
      && placement.height === dimensions.height
      && (placement.kind !== 'card' || !placement.collapsed || placement.expandedHeight === defaultDimensions.height)
      && (placement.kind !== 'card' || !placement.autoHeight)) return placement;
    changedIds.add(placement.id);
    return { ...placement, ...dimensions, autoHeight: placement.kind === 'card' ? undefined : placement.autoHeight };
  });
  return { placements: next, changedIds };
}
