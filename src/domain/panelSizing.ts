export const LEFT_SIDEBAR_MIN = 208;
export const LEFT_SIDEBAR_MAX = 420;
export const RIGHT_SIDEBAR_MIN = 320;
export const RIGHT_SIDEBAR_MAX = 720;

export function clampPanelWidth(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.round(Math.min(max, Math.max(min, value)));
}

export function nextPanelWidth(current: number, delta: number, side: 'left' | 'right') {
  const min = side === 'left' ? LEFT_SIDEBAR_MIN : RIGHT_SIDEBAR_MIN;
  const max = side === 'left' ? LEFT_SIDEBAR_MAX : RIGHT_SIDEBAR_MAX;
  return clampPanelWidth(current + delta, min, max);
}

export function resolvePanelResize(startWidth: number, latestWidth: number, cancelled: boolean) {
  return cancelled ? startWidth : latestWidth;
}
