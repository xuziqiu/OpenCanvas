import type { Viewport } from '../types';

export interface MinimapObject {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MinimapLayout {
  width: number;
  height: number;
  padding: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  scale: number;
  contentLeft: number;
  contentTop: number;
  contentRight: number;
  contentBottom: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const coordinate = (value: number) => Number(value.toFixed(2));

export function createMinimapLayout(objects: MinimapObject[], width: number, height: number, padding = 9): MinimapLayout {
  const source = objects.length ? objects : [{ x: 0, y: 0, width: 1, height: 1 }];
  const minX = source.reduce((value, item) => Math.min(value, item.x), Number.POSITIVE_INFINITY);
  const minY = source.reduce((value, item) => Math.min(value, item.y), Number.POSITIVE_INFINITY);
  const maxX = source.reduce((value, item) => Math.max(value, item.x + item.width), Number.NEGATIVE_INFINITY);
  const maxY = source.reduce((value, item) => Math.max(value, item.y + item.height), Number.NEGATIVE_INFINITY);
  const scale = Math.min(
    Math.max(1, width - padding * 2) / Math.max(1, maxX - minX),
    Math.max(1, height - padding * 2) / Math.max(1, maxY - minY),
  );
  const contentWidth = Math.max(1, maxX - minX) * scale;
  const contentHeight = Math.max(1, maxY - minY) * scale;
  const contentLeft = padding + (Math.max(1, width - padding * 2) - contentWidth) / 2;
  const contentTop = padding + (Math.max(1, height - padding * 2) - contentHeight) / 2;
  return {
    width,
    height,
    padding,
    minX,
    minY,
    maxX,
    maxY,
    scale,
    contentLeft,
    contentTop,
    contentRight: contentLeft + contentWidth,
    contentBottom: contentTop + contentHeight,
  };
}

export function minimapPointForWorld(point: { x: number; y: number }, layout: MinimapLayout) {
  return {
    x: layout.contentLeft + (point.x - layout.minX) * layout.scale,
    y: layout.contentTop + (point.y - layout.minY) * layout.scale,
  };
}

export function worldPointForMinimap(point: { x: number; y: number }, layout: MinimapLayout) {
  const x = clamp(point.x, layout.contentLeft, layout.contentRight);
  const y = clamp(point.y, layout.contentTop, layout.contentBottom);
  return {
    x: layout.minX + (x - layout.contentLeft) / layout.scale,
    y: layout.minY + (y - layout.contentTop) / layout.scale,
  };
}

export function minimapViewportRect(viewport: Viewport, canvas: { width: number; height: number }, layout: MinimapLayout) {
  const worldLeft = -viewport.x / viewport.zoom;
  const worldTop = -viewport.y / viewport.zoom;
  const rawLeft = layout.contentLeft + (worldLeft - layout.minX) * layout.scale;
  const rawTop = layout.contentTop + (worldTop - layout.minY) * layout.scale;
  const rawRight = rawLeft + canvas.width / viewport.zoom * layout.scale;
  const rawBottom = rawTop + canvas.height / viewport.zoom * layout.scale;
  const left = clamp(rawLeft, layout.contentLeft, layout.contentRight - 2);
  const top = clamp(rawTop, layout.contentTop, layout.contentBottom - 2);
  const right = clamp(rawRight, left + 2, layout.contentRight);
  const bottom = clamp(rawBottom, top + 2, layout.contentBottom);
  return { left, top, width: Math.max(2, right - left), height: Math.max(2, bottom - top) };
}

/** Collapse any number of minimap objects into one SVG path per visual group. */
export function minimapMeshPaths<T extends MinimapObject>(objects: T[], layout: MinimapLayout, groupFor: (object: T) => string) {
  const groups = new Map<string, string[]>();
  for (const object of objects) {
    const point = minimapPointForWorld(object, layout);
    const width = Math.max(1.4, object.width * layout.scale);
    const height = Math.max(1.4, object.height * layout.scale);
    const command = `M${coordinate(point.x)} ${coordinate(point.y)}h${coordinate(width)}v${coordinate(height)}h-${coordinate(width)}Z`;
    const key = groupFor(object);
    const commands = groups.get(key) ?? [];
    commands.push(command);
    groups.set(key, commands);
  }
  return new Map([...groups].map(([key, commands]) => [key, commands.join('')]));
}
