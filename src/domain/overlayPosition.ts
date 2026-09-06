export interface OverlayPositionInput {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
}

/** Keep floating UI reachable even when the window is smaller than the menu. */
export function clampOverlayPosition({ x, y, width, height, viewportWidth, viewportHeight, margin = 8 }: OverlayPositionInput) {
  const safeMargin = Math.max(0, Math.min(margin, viewportWidth / 2, viewportHeight / 2));
  const availableWidth = Math.max(0, viewportWidth - safeMargin * 2);
  const availableHeight = Math.max(0, viewportHeight - safeMargin * 2);
  const fittedWidth = Math.min(Math.max(0, width), availableWidth);
  const fittedHeight = Math.min(Math.max(0, height), availableHeight);
  const maxX = Math.max(safeMargin, viewportWidth - safeMargin - fittedWidth);
  const maxY = Math.max(safeMargin, viewportHeight - safeMargin - fittedHeight);
  return {
    x: Math.min(maxX, Math.max(safeMargin, x)),
    y: Math.min(maxY, Math.max(safeMargin, y)),
    maxWidth: availableWidth,
    maxHeight: availableHeight,
  };
}

export function caretMenuPosition(
  caret: { left: number; top: number; bottom: number },
  container: { left: number; top: number; width: number },
  viewport: { width: number; height: number },
  menu: { width: number; height: number },
  margin = 8,
) {
  const left = Math.max(margin, Math.min(viewport.width - menu.width - margin, caret.left));
  const below = caret.bottom + 7;
  const above = caret.top - menu.height - 7;
  const top = below + menu.height <= viewport.height - margin ? below : Math.max(margin, above);
  return { left: left - container.left, top: top - container.top };
}
