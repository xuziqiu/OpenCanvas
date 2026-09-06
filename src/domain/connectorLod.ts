export type ConnectorLodMode = 'detailed' | 'dense';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** More detail is affordable and useful when the user is zoomed in. */
export function connectorLodThresholds(zoom: number) {
  const enter = Math.round(clamp(450 * Math.sqrt(clamp(zoom, .2, 2.4)), 320, 680));
  return { enter, exit: Math.round(enter * .72) };
}

/** Hysteresis prevents dense/detail layers from flickering near a threshold. */
export function resolveConnectorLod(current: ConnectorLodMode, visibleCount: number, zoom: number): ConnectorLodMode {
  const thresholds = connectorLodThresholds(zoom);
  if (current === 'dense') return visibleCount < thresholds.exit ? 'detailed' : 'dense';
  return visibleCount > thresholds.enter ? 'dense' : 'detailed';
}
