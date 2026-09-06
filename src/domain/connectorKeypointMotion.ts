import type { BoardConnector } from '../types';
import type { Point } from './connectorGeometry';

export type ConnectorControlPoint = NonNullable<BoardConnector['controlPoints']>[number];

/**
 * Elbow points describe a movable segment, not a free 2D waypoint.
 * A horizontal segment moves vertically; a vertical segment moves horizontally.
 * Curve points and label anchors have no direction and remain freely movable.
 */
export function moveConnectorControlPoint(point: ConnectorControlPoint, target: Point): ConnectorControlPoint {
  if (point.direction === 'horizontal') return { ...point, y: target.y };
  if (point.direction === 'vertical') return { ...point, x: target.x };
  return { ...point, x: target.x, y: target.y };
}
