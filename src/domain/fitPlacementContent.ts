import type { BoardPlacement } from '../types';
import { FOLDED_CARD_MIN_WIDTH } from './defaultPlacementSize';
import { SECTION_PADDING, sectionBoundsForPlacements, sectionMembers } from './sectionLayout';

export interface FitSectionsResult {
  placements: BoardPlacement[];
  changedIds: Set<string>;
}

const CARD_FIXED_CHROME_HEIGHT = 39;
const CARD_MIN_FITTED_HEIGHT = 145;

export function cardHeightForContent(contentHeight: number) {
  return Math.max(CARD_MIN_FITTED_HEIGHT, Math.ceil(CARD_FIXED_CHROME_HEIGHT + Math.max(0, contentHeight)));
}

function sameGeometry(left: BoardPlacement, right: Pick<BoardPlacement, 'x' | 'y' | 'width' | 'height'>) {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

/** Shrink or grow selected Sections to the exact bounds of their related content. */
export function fitSectionsToContent(
  placements: BoardPlacement[],
  selectedIds: ReadonlySet<string>,
  padding = SECTION_PADDING,
): FitSectionsResult {
  let next = placements;
  const changedIds = new Set<string>();
  // Fit inner Sections first so a simultaneously selected parent measures the
  // child's final rectangle instead of retaining space for its old bounds.
  const sections = placements
    .filter((placement) => selectedIds.has(placement.id) && placement.isFrame && !placement.locked)
    .sort((left, right) => left.width * left.height - right.width * right.height);

  for (const original of sections) {
    const section = next.find((placement) => placement.id === original.id);
    if (!section) continue;
    const members = sectionMembers(section, next);
    const bounds = sectionBoundsForPlacements(members, padding);
    if (!bounds) continue;
    if (sameGeometry(section, bounds) && !section.sectionBaseBounds) continue;
    changedIds.add(section.id);
    next = next.map((placement) => placement.id === section.id
      ? { ...placement, ...bounds, sectionBaseBounds: undefined }
      : placement);
  }

  return { placements: next, changedIds };
}

/** Fit expanded cards first, then Sections from inner to outer in one result. */
export function fitPlacementsToContent(
  placements: BoardPlacement[],
  selectedIds: ReadonlySet<string>,
  cardHeights: Readonly<Record<string, number>> = {},
  cardWidths: Readonly<Record<string, number>> = {},
  padding = SECTION_PADDING,
): FitSectionsResult {
  const cardChangedIds = new Set<string>();
  const fittedCards = placements.map((placement) => {
    const measuredHeight = cardHeights[placement.id];
    const measuredWidth = cardWidths[placement.id];
    if (!selectedIds.has(placement.id)
      || placement.kind !== 'card'
      || placement.locked) return placement;
    if (placement.collapsed) {
      if (!Number.isFinite(measuredWidth)) return placement;
      const width = Math.max(FOLDED_CARD_MIN_WIDTH, Math.ceil(measuredWidth));
      if (placement.width === width) return placement;
      cardChangedIds.add(placement.id);
      return { ...placement, width };
    }
    if (!Number.isFinite(measuredHeight)) return placement;
    const height = Math.max(CARD_MIN_FITTED_HEIGHT, Math.ceil(measuredHeight));
    if (placement.height === height && placement.autoHeight && (placement.scrollTop ?? 0) === 0) return placement;
    cardChangedIds.add(placement.id);
    return { ...placement, height, autoHeight: true, scrollTop: 0 };
  });
  const sections = fitSectionsToContent(fittedCards, selectedIds, padding);
  return { placements: sections.placements, changedIds: new Set([...cardChangedIds, ...sections.changedIds]) };
}

export function syncAutoHeightPlacementSizes(
  placements: BoardPlacement[],
  cardHeights: Readonly<Record<string, number>>,
): FitSectionsResult {
  const changedIds = new Set<string>();
  const next = placements.map((placement) => {
    const measuredHeight = cardHeights[placement.id];
    if (placement.kind !== 'card' || placement.collapsed || !placement.autoHeight || placement.locked || !Number.isFinite(measuredHeight)) return placement;
    const height = Math.max(CARD_MIN_FITTED_HEIGHT, Math.ceil(measuredHeight));
    if (height === placement.height && (placement.scrollTop ?? 0) === 0) return placement;
    changedIds.add(placement.id);
    return { ...placement, height, scrollTop: 0 };
  });
  return { placements: next, changedIds };
}
