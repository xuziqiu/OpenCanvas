import type { PlacementKind } from '../types';
import type { BoardPlacement } from '../types';
import { rectangleContains, rectanglesIntersect } from './interaction';

type Rect = { x: number; y: number; width: number; height: number };

export function isAdditiveSelectionModifier({
  shiftKey,
  ctrlKey,
  metaKey,
}: {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}) {
  return shiftKey || ctrlKey || metaKey;
}

export function marqueeHitsPlacement(area: Rect, placement: BoardPlacement) {
  return placement.isFrame ? rectangleContains(area, placement) : rectanglesIntersect(area, placement);
}

export function isAdditivePlacementClick({
  kind,
  targetIsCardToolbar,
  shiftKey,
  ctrlKey,
  metaKey,
}: {
  kind: PlacementKind;
  targetIsCardToolbar: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}) {
  if (!isAdditiveSelectionModifier({ shiftKey, ctrlKey, metaKey })) return false;
  if (shiftKey) return true;
  // The card body keeps its stronger one-click-to-edit meaning. Additive
  // selection belongs to the reserved card toolbar instead.
  return kind !== 'card' || targetIsCardToolbar;
}

export function togglePlacementId(selectedIds: readonly string[], placementId: string) {
  return selectedIds.includes(placementId)
    ? selectedIds.filter((id) => id !== placementId)
    : [...selectedIds, placementId];
}
