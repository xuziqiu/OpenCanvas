import type { Point } from './connectorGeometry';

function squaredDistanceToSegment(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return (point.x - start.x) ** 2 + (point.y - start.y) ** 2;
  const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  const x = start.x + ratio * dx;
  const y = start.y + ratio * dy;
  return (point.x - x) ** 2 + (point.y - y) ** 2;
}

export function nearestPolyline<T extends { hitPoints: Point[] }>(point: Point, routes: T[]) {
  let nearest: { route: T; distance: number } | null = null;
  for (const route of routes) {
    for (let index = 0; index < route.hitPoints.length - 1; index += 1) {
      const distance = squaredDistanceToSegment(point, route.hitPoints[index], route.hitPoints[index + 1]);
      if (!nearest || distance < nearest.distance) nearest = { route, distance };
    }
  }
  return nearest ? { route: nearest.route, distance: Math.sqrt(nearest.distance) } : null;
}
