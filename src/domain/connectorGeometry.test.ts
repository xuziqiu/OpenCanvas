import { describe, expect, it } from 'vitest';
import { connectorGeometry } from './connectorGeometry';

describe('connectorGeometry', () => {
  it('gives a keypoint-free curve explicit initial endpoint directions', () => {
    const geometry = connectorGeometry({ x: 0, y: 0 }, { x: 200, y: 120 }, 'curve', [], { start: 'bottom', end: 'left' });
    expect(geometry.d).toMatch(/^M 0 0 C 0 [\d.]+, [\d.]+ 120, 200 120$/);
    expect(geometry.insertions).toHaveLength(1);
  });

  it('creates an insertion point for every curve segment', () => {
    const geometry = connectorGeometry({ x: 0, y: 0 }, { x: 300, y: 0 }, 'curve', [{ x: 100, y: 80 }, { x: 220, y: -40 }]);
    expect(geometry.insertions.map((item) => item.index)).toEqual([0, 1, 2]);
  });

  it('keeps orthogonal paths axis aligned and offers handles on their visible legs', () => {
    const geometry = connectorGeometry({ x: 0, y: 0 }, { x: 160, y: 80 }, 'orthogonal');
    expect(geometry.d).toBe('M 0 0 L 80 0 L 80 80 L 160 80');
    expect(geometry.insertions.length).toBeGreaterThanOrEqual(3);
    expect(geometry.insertions.map((item) => item.direction)).toEqual(['horizontal', 'vertical', 'horizontal']);
    expect(geometry.labelPoint).toEqual(geometry.insertions[1].point);
  });

  it('uses exact segment midpoints for straight routes', () => {
    const geometry = connectorGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 'straight', [{ x: 40, y: 30 }]);
    expect(geometry.insertions).toEqual([{ point: { x: 20, y: 15 }, index: 0 }, { point: { x: 70, y: 15 }, index: 1 }]);
  });

  it('keeps coincident endpoints finite while preserving their initial directions', () => {
    const geometry = connectorGeometry({ x: 80, y: 80 }, { x: 80, y: 80 }, 'curve', [], { start: 'right', end: 'top' });
    expect(geometry.d).not.toMatch(/NaN|Infinity/);
    expect(geometry.insertions).toHaveLength(1);
    expect(geometry.labelPoint.x).toBeTypeOf('number');
    expect(geometry.labelPoint.y).toBeTypeOf('number');
  });

  it('keeps insertion indexes tied to logical segments in a multi-keypoint orthogonal route', () => {
    const geometry = connectorGeometry({ x: 0, y: 0 }, { x: 360, y: 120 }, 'orthogonal', [{ x: 100, y: 80 }, { x: 250, y: 20 }]);
    expect(new Set(geometry.insertions.map((item) => item.index))).toEqual(new Set([0, 1, 2]));
    expect(geometry.d).not.toMatch(/NaN|Infinity/);
  });
});
