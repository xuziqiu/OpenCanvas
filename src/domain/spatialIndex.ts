import type { BoardPlacement } from '../types';
import { rectanglesIntersect } from './interaction';

export interface SpatialGridIndex {
  size: number;
  cellSize: number;
  query(bounds: { x: number; y: number; width: number; height: number }, pinnedIds?: Iterable<string>): BoardPlacement[];
}

const cellKey = (x: number, y: number) => `${x}:${y}`;

export function buildSpatialGridIndex(placements: BoardPlacement[], cellSize = 640): SpatialGridIndex {
  const cells = new Map<string, BoardPlacement[]>();
  const byId = new Map(placements.map((placement) => [placement.id, placement]));
  const orderById = new Map(placements.map((placement, index) => [placement.id, index]));
  for (const placement of placements) {
    const left = Math.floor(placement.x / cellSize); const right = Math.floor((placement.x + placement.width) / cellSize);
    const top = Math.floor(placement.y / cellSize); const bottom = Math.floor((placement.y + placement.height) / cellSize);
    for (let x = left; x <= right; x += 1) for (let y = top; y <= bottom; y += 1) {
      const key = cellKey(x, y);
      const cell = cells.get(key);
      if (cell) cell.push(placement); else cells.set(key, [placement]);
    }
  }
  return {
    size: placements.length,
    cellSize,
    query(bounds, pinnedIds = []) {
      const candidates = new Map<string, BoardPlacement>();
      const pinned = new Set(pinnedIds);
      const left = Math.floor(bounds.x / cellSize); const right = Math.floor((bounds.x + bounds.width) / cellSize);
      const top = Math.floor(bounds.y / cellSize); const bottom = Math.floor((bounds.y + bounds.height) / cellSize);
      for (let x = left; x <= right; x += 1) for (let y = top; y <= bottom; y += 1) for (const placement of cells.get(cellKey(x, y)) || []) candidates.set(placement.id, placement);
      for (const id of pinned) { const placement = byId.get(id); if (placement) candidates.set(id, placement); }
      return [...candidates.values()]
        .filter((placement) => rectanglesIntersect(bounds, placement) || pinned.has(placement.id))
        .sort((leftPlacement, rightPlacement) => (orderById.get(leftPlacement.id) ?? 0) - (orderById.get(rightPlacement.id) ?? 0));
    },
  };
}
