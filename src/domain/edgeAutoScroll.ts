export type EdgeAutoScrollDirection = 'up' | 'down' | null;

/**
 * Smooth, distance-sensitive velocity for dragging near a scroll viewport.
 * The quadratic curve stays quiet at the activation boundary but becomes
 * decisive near the edge, avoiding the jerky fixed-step feel of dragover.
 */
export function edgeAutoScrollVelocity(
  pointerY: number,
  top: number,
  bottom: number,
  zone = 54,
  maximum = 18,
): { direction: EdgeAutoScrollDirection; velocity: number } {
  if (!Number.isFinite(pointerY) || bottom <= top || zone <= 0 || maximum <= 0) return { direction: null, velocity: 0 };
  const upperDistance = pointerY - top;
  if (upperDistance >= 0 && upperDistance < zone) {
    const strength = 1 - upperDistance / zone;
    return { direction: 'up', velocity: -maximum * strength * strength };
  }
  const lowerDistance = bottom - pointerY;
  if (lowerDistance >= 0 && lowerDistance < zone) {
    const strength = 1 - lowerDistance / zone;
    return { direction: 'down', velocity: maximum * strength * strength };
  }
  return { direction: null, velocity: 0 };
}
