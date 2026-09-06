import type { BoardConnector, BoardPlacement } from '../types';

export interface ConnectorMotionOptions {
  /**
   * Only object movement opts into this behavior. Resizing and layout tools
   * can update the same placement fields without translating route anchors.
   */
  translateInternalControlPoints?: boolean;
}

const nearlyEqual = (left: number, right: number) => Math.abs(left - right) < 1e-6;

/**
 * Keep a manually shaped connection attached to a set of objects that moves
 * as one unit. A connection crossing the moving-set boundary keeps its world
 * keypoints; only connections whose two endpoints share the same translation
 * carry their keypoints and manual label anchor with them.
 */
export function connectorsAfterPlacementMotion(
  connectors: BoardConnector[],
  placements: BoardPlacement[],
  changes: Record<string, Partial<BoardPlacement>>,
  options: ConnectorMotionOptions = {},
) {
  if (!options.translateInternalControlPoints) return connectors;
  const placementById = new Map(placements.map((placement) => [placement.id, placement]));
  const deltas = new Map<string, { x: number; y: number }>();
  for (const [placementId, change] of Object.entries(changes)) {
    const placement = placementById.get(placementId);
    if (!placement) continue;
    deltas.set(placementId, {
      x: (change.x ?? placement.x) - placement.x,
      y: (change.y ?? placement.y) - placement.y,
    });
  }

  let changed = false;
  const next = connectors.map((connector) => {
    const fromDelta = deltas.get(connector.from);
    const toDelta = deltas.get(connector.to);
    if (
      !fromDelta
      || !toDelta
      || !nearlyEqual(fromDelta.x, toDelta.x)
      || !nearlyEqual(fromDelta.y, toDelta.y)
      || (nearlyEqual(fromDelta.x, 0) && nearlyEqual(fromDelta.y, 0))
      || !connector.controlPoints?.length
    ) return connector;
    changed = true;
    return {
      ...connector,
      controlPoints: connector.controlPoints.map((point) => ({
        ...point,
        x: point.x + fromDelta.x,
        y: point.y + fromDelta.y,
      })),
    };
  });
  return changed ? next : connectors;
}
