import { describe, expect, it } from 'vitest';
import { nearestPolyline } from './polylineHitTest';

describe('nearestPolyline', () => {
  it('chooses the visually nearest sampled connector route', () => {
    const horizontal = { id: 'horizontal', hitPoints: [{ x: 0, y: 20 }, { x: 100, y: 20 }] };
    const vertical = { id: 'vertical', hitPoints: [{ x: 70, y: 0 }, { x: 70, y: 100 }] };
    expect(nearestPolyline({ x: 66, y: 74 }, [horizontal, vertical])?.route.id).toBe('vertical');
    expect(nearestPolyline({ x: 20, y: 24 }, [horizontal, vertical])?.route.id).toBe('horizontal');
  });

  it('returns null when there are no route segments', () => {
    expect(nearestPolyline({ x: 0, y: 0 }, [])).toBeNull();
    expect(nearestPolyline({ x: 0, y: 0 }, [{ hitPoints: [{ x: 1, y: 1 }] }])).toBeNull();
  });
});
