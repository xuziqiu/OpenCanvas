import { describe, expect, it } from 'vitest';
import { createMinimapLayout, minimapMeshPaths, minimapPointForWorld, minimapViewportRect, worldPointForMinimap } from './minimap';

describe('minimap geometry', () => {
  const objects = [
    { id: 'a', kind: 'card', x: -100, y: 20, width: 200, height: 100 },
    { id: 'b', kind: 'board', x: 500, y: 320, width: 300, height: 180 },
  ];

  it('roundtrips world positions through the minimap transform', () => {
    const layout = createMinimapLayout(objects, 180, 116);
    const world = { x: 280, y: 210 };
    const point = minimapPointForWorld(world, layout);
    expect(worldPointForMinimap(point, layout).x).toBeCloseTo(world.x);
    expect(worldPointForMinimap(point, layout).y).toBeCloseTo(world.y);
  });

  it('clamps navigation and the visible viewport inside the padded surface', () => {
    const layout = createMinimapLayout(objects, 180, 116);
    const clamped = worldPointForMinimap({ x: -200, y: 999 }, layout);
    expect(clamped.x).toBeCloseTo(layout.minX);
    expect(clamped.y).toBeCloseTo(layout.maxY);
    const rect = minimapViewportRect({ x: 10000, y: -10000, zoom: .2 }, { width: 1200, height: 800 }, layout);
    expect(rect.left).toBeGreaterThanOrEqual(layout.padding);
    expect(rect.top).toBeGreaterThanOrEqual(layout.padding);
    expect(rect.left + rect.width).toBeLessThanOrEqual(layout.width - layout.padding);
    expect(rect.top + rect.height).toBeLessThanOrEqual(layout.height - layout.padding);
  });

  it('collapses thousands of objects into a bounded number of SVG paths', () => {
    const many = Array.from({ length: 5000 }, (_, index) => ({
      x: (index % 100) * 380,
      y: Math.floor(index / 100) * 270,
      width: 320,
      height: 210,
      kind: index % 17 === 0 ? 'board' : 'card',
    }));
    const layout = createMinimapLayout(many, 180, 116);
    const paths = minimapMeshPaths(many, layout, (item) => item.kind);
    expect(paths.size).toBe(2);
    expect([...paths.values()].join('').match(/M/g)).toHaveLength(5000);
  });
});
