import { describe, expect, it } from 'vitest';
import { automaticLabelCandidates, connectorLabelMetrics, resolveConnectorLabelLayout } from './connectorLabelLayout';

describe('connector label layout', () => {
  it('truncates only the visible label while keeping a bounded mask', () => {
    const metrics = connectorLabelMetrics('超'.repeat(40));
    expect(metrics.displayLabel.endsWith('…')).toBe(true);
    expect([...metrics.displayLabel]).toHaveLength(30);
    expect(metrics.width).toBeLessThanOrEqual(260);
  });

  it('offers stable route positions from the middle outwards', () => {
    const candidates = automaticLabelCandidates([{ x: 0, y: 0 }, { x: 100, y: 0 }], { x: 50, y: 0 }, 0);
    expect(candidates.map(({ point }) => point.x)).toEqual([50, 38, 62, 26, 74, 16, 84]);
    expect(candidates.every(({ point }) => point.y === 0)).toBe(true);
  });

  it('moves an automatic label to another point on the route when labels collide', () => {
    const requests = [
      { id: 'a', label: '关系标签', manual: false, candidates: automaticLabelCandidates([{ x: 0, y: 0 }, { x: 220, y: 0 }], { x: 110, y: 0 }, 0) },
      { id: 'b', label: '关系标签', manual: false, candidates: automaticLabelCandidates([{ x: 0, y: 0 }, { x: 220, y: 0 }], { x: 110, y: 0 }, 0) },
    ];
    const result = resolveConnectorLabelLayout(requests, []);
    expect(result.get('a')?.point).toEqual({ x: 110, y: 0 });
    expect(result.get('b')?.point).not.toEqual({ x: 110, y: 0 });
    expect(result.get('b')?.point.y).toBe(0);
  });

  it('reserves manual label space without changing the manual position', () => {
    const result = resolveConnectorLabelLayout([
      { id: 'manual', label: '固定标签', manual: true, candidates: [{ point: { x: 100, y: 50 }, insertionIndex: -1 }] },
      { id: 'auto', label: '自动标签', manual: false, candidates: [{ point: { x: 100, y: 50 }, insertionIndex: 0 }, { point: { x: 170, y: 50 }, insertionIndex: 0 }] },
    ], []);
    expect(result.get('manual')?.point).toEqual({ x: 100, y: 50 });
    expect(result.get('auto')?.point).toEqual({ x: 170, y: 50 });
  });

  it('avoids card bounds before accepting the preferred midpoint', () => {
    const result = resolveConnectorLabelLayout([
      { id: 'auto', label: '避让卡片', manual: false, candidates: [{ point: { x: 100, y: 50 }, insertionIndex: 0 }, { point: { x: 190, y: 50 }, insertionIndex: 0 }] },
    ], [{ x: 70, y: 30, width: 60, height: 40 }]);
    expect(result.get('auto')?.point).toEqual({ x: 190, y: 50 });
  });
});
