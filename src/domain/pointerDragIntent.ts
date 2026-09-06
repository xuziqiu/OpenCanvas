export const POINTER_DRAG_THRESHOLD_PX = 3;

/**
 * A press remains a click until the pointer travels the shared screen-space
 * threshold. Keeping this in CSS pixels makes cards and connector handles feel
 * identical at every canvas zoom level.
 */
export function hasPointerDragIntent(
  start: { x: number; y: number },
  current: { x: number; y: number },
  threshold = POINTER_DRAG_THRESHOLD_PX,
) {
  return Math.hypot(current.x - start.x, current.y - start.y) >= threshold;
}
