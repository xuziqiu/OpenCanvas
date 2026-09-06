import { describe, expect, it } from 'vitest';
import { fixedVirtualRange, scrollTopToRevealFixedRow } from './fixedVirtualList';

describe('fixed-height virtual list', () => {
  it('keeps a 5000-row surface to a small overscanned DOM window', () => {
    const range = fixedVirtualRange(5000, 32, 420, 32 * 2400, 6);
    expect(range).toEqual({
      start: 2394,
      end: 2420,
      offset: 76_608,
      totalHeight: 160_000,
    });
    expect(range.end - range.start).toBeLessThan(30);
  });

  it('clamps empty, leading and trailing ranges', () => {
    expect(fixedVirtualRange(0, 32, 420, 200)).toEqual({ start: 0, end: 0, offset: 0, totalHeight: 0 });
    expect(fixedVirtualRange(10, 32, 96, -100, 2)).toMatchObject({ start: 0, end: 5 });
    expect(fixedVirtualRange(10, 32, 96, 99_999, 2)).toMatchObject({ start: 5, end: 10 });
  });

  it('only scrolls enough to reveal the requested row', () => {
    expect(scrollTopToRevealFixedRow(4, 32, 160, 0)).toBe(0);
    expect(scrollTopToRevealFixedRow(5, 32, 160, 0)).toBe(32);
    expect(scrollTopToRevealFixedRow(2, 32, 160, 200)).toBe(64);
    expect(scrollTopToRevealFixedRow(8, 32, 160, 160)).toBe(160);
  });
});
