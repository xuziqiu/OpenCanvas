import { describe, expect, it } from 'vitest';
import { hasPointerDragIntent, POINTER_DRAG_THRESHOLD_PX } from './pointerDragIntent';

describe('pointer drag intent', () => {
  it('keeps sub-threshold movement as a click and starts exactly at three CSS pixels', () => {
    const start = { x: 100, y: 200 };
    expect(POINTER_DRAG_THRESHOLD_PX).toBe(3);
    expect(hasPointerDragIntent(start, { x: 102.9, y: 200 })).toBe(false);
    expect(hasPointerDragIntent(start, { x: 103, y: 200 })).toBe(true);
  });

  it('uses radial distance instead of treating diagonal jitter more harshly', () => {
    const start = { x: 0, y: 0 };
    expect(hasPointerDragIntent(start, { x: 2, y: 2 })).toBe(false);
    expect(hasPointerDragIntent(start, { x: 2.2, y: 2.2 })).toBe(true);
  });
});
