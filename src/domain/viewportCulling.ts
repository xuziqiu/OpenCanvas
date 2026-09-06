import type { BoardConnector, BoardPlacement, Viewport } from '../types';
import { rectanglesIntersect } from './interaction';

export function viewportWorldBounds(viewport: Viewport, size: { width: number; height: number }, overscanPixels = 360) {
  const overscan = overscanPixels / viewport.zoom;
  return {
    x: -viewport.x / viewport.zoom - overscan,
    y: -viewport.y / viewport.zoom - overscan,
    width: size.width / viewport.zoom + overscan * 2,
    height: size.height / viewport.zoom + overscan * 2,
  };
}

export function filterVisiblePlacements(placements: BoardPlacement[], bounds: { x: number; y: number; width: number; height: number }, pinnedIds: Iterable<string> = []) {
  const pinned = new Set(pinnedIds);
  return placements.filter((placement) => pinned.has(placement.id) || rectanglesIntersect(bounds, placement));
}

export function filterVisibleConnectors(connectors: BoardConnector[], visiblePlacementIds: Iterable<string>, pinnedIds: Iterable<string> = []) {
  const visible = new Set(visiblePlacementIds);
  const pinned = new Set(pinnedIds);
  return connectors.filter((connector) => pinned.has(connector.id) || visible.has(connector.from) || visible.has(connector.to));
}

function connectorIntersectsBounds(
  connector: BoardConnector,
  placementsById: ReadonlyMap<string, BoardPlacement>,
  bounds: { x: number; y: number; width: number; height: number },
) {
  const from = placementsById.get(connector.from);
  const to = placementsById.get(connector.to);
  if (!from || !to) return false;
  const points = [
    { x: from.x + from.width / 2, y: from.y + from.height / 2 },
    ...(connector.controlPoints ?? []),
    { x: to.x + to.width / 2, y: to.y + to.height / 2 },
  ];
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));
  return rectanglesIntersect(bounds, { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) });
}

export function filterConnectorsForViewport(
  connectors: BoardConnector[],
  visiblePlacementIds: Iterable<string>,
  pinnedIds: Iterable<string>,
  placementsById: ReadonlyMap<string, BoardPlacement>,
  bounds: { x: number; y: number; width: number; height: number },
) {
  const endpointVisible = new Set(visiblePlacementIds);
  const pinned = new Set(pinnedIds);
  return connectors.filter((connector) => pinned.has(connector.id)
    || endpointVisible.has(connector.from)
    || endpointVisible.has(connector.to)
    || connectorIntersectsBounds(connector, placementsById, bounds));
}
