import { describe, expect, it } from 'vitest';
import { edgeAutoScrollVelocity } from './edgeAutoScroll';

describe('drag edge auto-scroll', () => {
  it('accelerates smoothly toward either edge', () => {
    expect(edgeAutoScrollVelocity(100, 100, 500)).toEqual({ direction: 'up', velocity: -18 });
    expect(edgeAutoScrollVelocity(500, 100, 500)).toEqual({ direction: 'down', velocity: 18 });
    expect(edgeAutoScrollVelocity(127, 100, 500).velocity).toBeCloseTo(-4.5, 5);
    expect(edgeAutoScrollVelocity(473, 100, 500).velocity).toBeCloseTo(4.5, 5);
  });

  it('stays still in the safe middle area and outside the viewport', () => {
    expect(edgeAutoScrollVelocity(250, 100, 500)).toEqual({ direction: null, velocity: 0 });
    expect(edgeAutoScrollVelocity(80, 100, 500)).toEqual({ direction: null, velocity: 0 });
    expect(edgeAutoScrollVelocity(520, 100, 500)).toEqual({ direction: null, velocity: 0 });
  });

  it('fails closed for invalid geometry', () => {
    expect(edgeAutoScrollVelocity(Number.NaN, 100, 500)).toEqual({ direction: null, velocity: 0 });
    expect(edgeAutoScrollVelocity(100, 500, 100)).toEqual({ direction: null, velocity: 0 });
  });
});
