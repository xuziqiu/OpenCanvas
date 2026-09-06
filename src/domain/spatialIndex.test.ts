import { describe, expect, it } from 'vitest';
import { buildSpatialGridIndex } from './spatialIndex';
import type { BoardPlacement } from '../types';

describe('spatial grid index', () => {
  it('returns intersecting and pinned placements without duplicates', () => {
    const placements: BoardPlacement[] = [{ id: 'a', kind: 'text', x: 0, y: 0, width: 800, height: 800, color: 'paper' }, { id: 'b', kind: 'text', x: 2000, y: 2000, width: 100, height: 100, color: 'paper' }];
    const index = buildSpatialGridIndex(placements, 200);
    expect(index.query({ x: 50, y: 50, width: 100, height: 100 }).map((item) => item.id)).toEqual(['a']);
    expect(index.query({ x: 50, y: 50, width: 100, height: 100 }, ['b']).map((item) => item.id).sort()).toEqual(['a', 'b']);
  });

  it('keeps a 10000-object whiteboard query bounded to nearby cells', () => {
    const placements: BoardPlacement[] = Array.from({ length: 10_000 }, (_, index) => ({ id: String(index), kind: 'text', x: (index % 100) * 500, y: Math.floor(index / 100) * 400, width: 220, height: 160, color: 'paper' }));
    const spatial = buildSpatialGridIndex(placements);
    const result = spatial.query({ x: 10_000, y: 8_000, width: 1600, height: 900 });
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThan(100);
  });

  it('preserves board order across queried cells and pinned placements', () => {
    const placements: BoardPlacement[] = [
      { id: 'first', kind: 'text', x: 1200, y: 0, width: 100, height: 100, color: 'paper' },
      { id: 'second', kind: 'text', x: 0, y: 0, width: 100, height: 100, color: 'paper' },
      { id: 'third', kind: 'text', x: 2400, y: 0, width: 100, height: 100, color: 'paper' },
    ];
    const index = buildSpatialGridIndex(placements, 400);
    expect(index.query({ x: -20, y: -20, width: 500, height: 500 }, ['third', 'first']).map((item) => item.id)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });
});
