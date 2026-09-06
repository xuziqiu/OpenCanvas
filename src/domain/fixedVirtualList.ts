export interface FixedVirtualRange {
  start: number;
  end: number;
  offset: number;
  totalHeight: number;
}

/**
 * Return the small contiguous slice needed to render a fixed-height list.
 * `end` is exclusive so the result can be passed directly to Array#slice.
 */
export function fixedVirtualRange(
  itemCount: number,
  rowHeight: number,
  viewportHeight: number,
  scrollTop: number,
  overscan = 5,
): FixedVirtualRange {
  const count = Math.max(0, Math.floor(itemCount));
  const height = Math.max(1, rowHeight);
  const viewport = Math.max(0, viewportHeight);
  const maximumScroll = Math.max(0, count * height - viewport);
  const scroll = Math.min(maximumScroll, Math.max(0, scrollTop));
  const padding = Math.max(0, Math.floor(overscan));
  const start = Math.max(0, Math.floor(scroll / height) - padding);
  const visibleEnd = Math.ceil((scroll + viewport) / height);
  const end = Math.min(count, Math.max(start, visibleEnd + padding));
  return { start, end, offset: start * height, totalHeight: count * height };
}

/** Keep a row visible without jumping when it is already inside the viewport. */
export function scrollTopToRevealFixedRow(
  index: number,
  rowHeight: number,
  viewportHeight: number,
  scrollTop: number,
) {
  const height = Math.max(1, rowHeight);
  const viewport = Math.max(height, viewportHeight);
  const current = Math.max(0, scrollTop);
  const top = Math.max(0, index) * height;
  const bottom = top + height;
  if (top < current) return top;
  if (bottom > current + viewport) return Math.max(0, bottom - viewport);
  return current;
}
