import { describe, expect, it } from 'vitest';
import { filterConnectorsForViewport, filterVisibleConnectors, filterVisiblePlacements, viewportWorldBounds } from './viewportCulling';
import type { BoardPlacement } from '../types';

const placement = (id: string, x: number, y: number): BoardPlacement => ({ id, kind: 'text', text: id, x, y, width: 100, height: 80, color: 'paper' });

describe('viewport culling', () => {
  it('converts the screen viewport to an overscanned world rectangle', () => {
    expect(viewportWorldBounds({ x: -100, y: -50, zoom: 2 }, { width: 800, height: 600 }, 200)).toEqual({ x: -50, y: -75, width: 600, height: 500 });
  });

  it('keeps intersecting and explicitly pinned placements', () => {
    const result = filterVisiblePlacements([placement('near', 20, 20), placement('far', 5000, 5000), placement('editing', -4000, -4000)], { x: 0, y: 0, width: 500, height: 400 }, ['editing']);
    expect(result.map((item) => item.id)).toEqual(['near', 'editing']);
  });

  it('keeps connectors touching visible nodes plus a selected offscreen connector', () => {
    const connectors = [
      { id: 'visible', from: 'a', to: 'b' },
      { id: 'hidden', from: 'c', to: 'd' },
      { id: 'selected', from: 'x', to: 'y' },
    ];
    expect(filterVisibleConnectors(connectors, ['a'], ['selected']).map((item) => item.id)).toEqual(['visible', 'selected']);
  });

  it('keeps a route crossing the viewport even when both endpoint cards are offscreen', () => {
    const placements = new Map([
      ['left', { id: 'left', kind: 'card' as const, entityId: 'a', x: -600, y: 100, width: 100, height: 100, color: 'paper' }],
      ['right', { id: 'right', kind: 'card' as const, entityId: 'b', x: 600, y: 100, width: 100, height: 100, color: 'paper' }],
      ['away', { id: 'away', kind: 'card' as const, entityId: 'c', x: 700, y: 700, width: 100, height: 100, color: 'paper' }],
    ]);
    const connectors = [
      { id: 'crossing', from: 'left', to: 'right' },
      { id: 'away', from: 'right', to: 'away' },
    ];
    expect(filterConnectorsForViewport(connectors, [], [], placements, { x: 0, y: 0, width: 300, height: 300 }).map((item) => item.id)).toEqual(['crossing']);
  });
});
