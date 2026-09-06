import type { BoardConnector } from '../types';

/**
 * Route keypoints are style-specific, but a manually positioned label uses
 * the first point as its spatial anchor. Preserve that anchor when changing
 * curve/orthogonal/straight styles so the label does not visibly jump.
 */
export function controlPointsForConnectorStyleChange(connector: BoardConnector) {
  const labelAnchor = connector.label?.trim() ? connector.controlPoints?.[0] : undefined;
  return labelAnchor ? [{ ...labelAnchor }] : [];
}
