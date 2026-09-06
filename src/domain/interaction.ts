import type { Viewport } from '../types';

export type CanvasInteraction =
  | { mode: 'idle' }
  | { mode: 'panning'; pointerId: number }
  | { mode: 'marquee'; pointerId: number }
  | { mode: 'drawing-section'; pointerId: number }
  | { mode: 'moving'; pointerId: number; placementIds: string[] }
  | { mode: 'resizing'; pointerId: number; placementId: string }
  | { mode: 'connecting'; fromId: string }
  | { mode: 'editing'; placementId: string };

export const idleInteraction: CanvasInteraction = { mode: 'idle' };

export interface AlignmentBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AlignmentSnapResult {
  x: number;
  y: number;
  snappedX: number | null;
  snappedY: number | null;
  guides: AlignmentGuideLine[];
  spacingGuides: SpacingGuideLine[];
}

export interface ResizeSnapResult {
  x: number;
  y: number;
  width: number;
  height: number;
  guides: AlignmentGuideLine[];
  spacingGuides: SpacingGuideLine[];
}

export interface ResizeEdges {
  left?: boolean;
  right?: boolean;
  top?: boolean;
  bottom?: boolean;
}

export interface AlignmentGuideLine {
  axis: 'x' | 'y';
  position: number;
  from: number;
  to: number;
  targetIds: string[];
}

interface SpacingGuideLine {
  axis: 'x' | 'y';
  from: number;
  to: number;
  cross: number;
  gap: number;
  objectId: string;
  attachedObjectId: string;
}

const OBJECT_TRANSPARENT_EDGE = 3;

type SnapOptions = { disabled?: boolean; enhanced?: boolean; zoom?: number };

function screenScaledRange(value: number, zoom = 1) {
  const safeZoom = Number.isFinite(zoom) ? Math.max(.05, zoom) : 1;
  return value / safeZoom;
}

function overlapAmount(startA: number, endA: number, startB: number, endB: number) {
  return Math.min(endA, endB) - Math.max(startA, startB);
}

function nearestGuide(current: number, length: number, guides: number[], detectionRange: number) {
  let next = current;
  let snappedGuide: number | null = null;
  let nearestDistance = detectionRange;
  for (const guide of guides) {
    const options = [
      { distance: Math.abs(current - guide), value: guide },
      { distance: Math.abs(current + length - guide), value: guide - length },
      { distance: Math.abs(current + length / 2 - guide), value: guide - length / 2 },
    ];
    for (const option of options) {
      if (option.distance < nearestDistance) {
        nearestDistance = option.distance;
        next = option.value;
        snappedGuide = guide;
      }
    }
  }
  return { value: next, guide: snappedGuide };
}

function nearestEndGuide(end: number, guides: number[], detectionRange: number) {
  let value = end;
  let snappedGuide: number | null = null;
  let nearestDistance = detectionRange;
  for (const guide of guides) {
    const distance = Math.abs(end - guide);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      value = guide;
      snappedGuide = guide;
    }
  }
  return { value, guide: snappedGuide };
}

/**
 * Magnetic object alignment uses nearby object edges and centers: only
 * nearby objects contribute edge/center guides. Shift strengthens the magnet;
 * Alt is our explicit free-drag escape hatch.
 */
export function snapBoxToNearbyObjects(
  moving: AlignmentBox,
  candidates: AlignmentBox[],
  options: SnapOptions = {},
): AlignmentSnapResult {
  if (options.disabled) return { x: moving.x, y: moving.y, snappedX: null, snappedY: null, guides: [], spacingGuides: [] };
  const enhanced = Boolean(options.enhanced);
  const horizontalMargin = enhanced ? 5000 : screenScaledRange(50, options.zoom);
  const verticalMargin = enhanced ? 1000 : screenScaledRange(50, options.zoom);
  const detectionRange = screenScaledRange(enhanced ? 50 : 15, options.zoom);
  const contactRange = screenScaledRange(enhanced ? 12 : 6, options.zoom);
  const edge = OBJECT_TRANSPARENT_EDGE;
  const alignmentMoving = {
    ...moving,
    x: moving.x - edge,
    y: moving.y - edge,
    width: moving.width + edge * 2,
    height: moving.height + edge * 2,
  };
  const alignmentCandidates = candidates.map((candidate) => ({
    ...candidate,
    x: candidate.x - edge,
    y: candidate.y - edge,
    width: candidate.width + edge * 2,
    height: candidate.height + edge * 2,
  }));
  const localArea = {
    x: alignmentMoving.x - horizontalMargin,
    y: alignmentMoving.y - verticalMargin,
    width: alignmentMoving.width + horizontalMargin * 2,
    height: alignmentMoving.height + verticalMargin * 2,
  };
  const nearby = alignmentCandidates.filter((candidate) => rectanglesIntersect(localArea, candidate));
  const xGuides = nearby.flatMap((candidate) => [candidate.x, candidate.x + candidate.width, candidate.x + candidate.width / 2]);
  const yGuides = nearby.flatMap((candidate) => [candidate.y, candidate.y + candidate.height, candidate.y + candidate.height / 2]);
  const x = nearestGuide(alignmentMoving.x, alignmentMoving.width, xGuides, detectionRange);
  const y = nearestGuide(alignmentMoving.y, alignmentMoving.height, yGuides, detectionRange);
  const snappedMoving = { ...moving, x: x.value + edge, y: y.value + edge };
  const guides: AlignmentGuideLine[] = [];
  if (x.guide !== null) {
    const targets = nearby.filter((candidate) => [candidate.x, candidate.x + candidate.width, candidate.x + candidate.width / 2].some((guide) => Math.abs(guide - x.guide!) < .001));
    guides.push({
      axis: 'x',
      position: x.guide,
      from: Math.min(snappedMoving.y, ...targets.map((candidate) => candidate.y)),
      to: Math.max(snappedMoving.y + snappedMoving.height, ...targets.map((candidate) => candidate.y + candidate.height)),
      targetIds: targets.map((candidate) => candidate.id),
    });
  }
  if (y.guide !== null) {
    const targets = nearby.filter((candidate) => [candidate.y, candidate.y + candidate.height, candidate.y + candidate.height / 2].some((guide) => Math.abs(guide - y.guide!) < .001));
    guides.push({
      axis: 'y',
      position: y.guide,
      from: Math.min(snappedMoving.x, ...targets.map((candidate) => candidate.x)),
      to: Math.max(snappedMoving.x + snappedMoving.width, ...targets.map((candidate) => candidate.x + candidate.width)),
      targetIds: targets.map((candidate) => candidate.id),
    });
  }
  const visualCandidates = candidates.filter((candidate) => nearby.some((item) => item.id === candidate.id));
  const visualGap = edge * 2;
  const spacingGuides: SpacingGuideLine[] = [];
  const horizontalNeighbor = visualCandidates.find((candidate) =>
    overlapAmount(snappedMoving.y, snappedMoving.y + moving.height, candidate.y, candidate.y + candidate.height) > 0
    && (Math.abs(snappedMoving.x + moving.width + visualGap - candidate.x) < .001
      || Math.abs(candidate.x + candidate.width + visualGap - snappedMoving.x) < .001));
  if (horizontalNeighbor) {
    const movingOnLeft = snappedMoving.x < horizontalNeighbor.x;
    const from = movingOnLeft ? snappedMoving.x + moving.width : horizontalNeighbor.x + horizontalNeighbor.width;
    const to = movingOnLeft ? horizontalNeighbor.x : snappedMoving.x;
    const overlapTop = Math.max(snappedMoving.y, horizontalNeighbor.y);
    const overlapBottom = Math.min(snappedMoving.y + moving.height, horizontalNeighbor.y + horizontalNeighbor.height);
    spacingGuides.push({ axis: 'x', from, to, cross: (overlapTop + overlapBottom) / 2, gap: visualGap, objectId: moving.id, attachedObjectId: horizontalNeighbor.id });
  }
  const verticalNeighbor = visualCandidates.find((candidate) =>
    overlapAmount(snappedMoving.x, snappedMoving.x + moving.width, candidate.x, candidate.x + candidate.width) > 0
    && (Math.abs(snappedMoving.y + moving.height + visualGap - candidate.y) < .001
      || Math.abs(candidate.y + candidate.height + visualGap - snappedMoving.y) < .001));
  if (verticalNeighbor) {
    const movingOnTop = snappedMoving.y < verticalNeighbor.y;
    const from = movingOnTop ? snappedMoving.y + moving.height : verticalNeighbor.y + verticalNeighbor.height;
    const to = movingOnTop ? verticalNeighbor.y : snappedMoving.y;
    const overlapLeft = Math.max(snappedMoving.x, verticalNeighbor.x);
    const overlapRight = Math.min(snappedMoving.x + moving.width, verticalNeighbor.x + verticalNeighbor.width);
    spacingGuides.push({ axis: 'y', from, to, cross: (overlapLeft + overlapRight) / 2, gap: visualGap, objectId: moving.id, attachedObjectId: verticalNeighbor.id });
  }
  const rejectHorizontalContact = spacingGuides.some((guide) => guide.axis === 'x')
    && Math.abs(snappedMoving.x - moving.x) > contactRange;
  const rejectVerticalContact = spacingGuides.some((guide) => guide.axis === 'y')
    && Math.abs(snappedMoving.y - moving.y) > contactRange;
  return {
    x: rejectHorizontalContact ? moving.x : snappedMoving.x,
    y: rejectVerticalContact ? moving.y : snappedMoving.y,
    snappedX: rejectHorizontalContact ? null : x.guide,
    snappedY: rejectVerticalContact ? null : y.guide,
    guides: guides.filter((guide) => !(rejectHorizontalContact && guide.axis === 'x') && !(rejectVerticalContact && guide.axis === 'y')),
    spacingGuides: spacingGuides.filter((guide) => !(rejectHorizontalContact && guide.axis === 'x') && !(rejectVerticalContact && guide.axis === 'y')),
  };
}

/** Snap only the edges currently being resized; the opposite edges stay fixed. */
export function snapResizeBoxToNearbyObjects(
  moving: AlignmentBox,
  candidates: AlignmentBox[],
  options: SnapOptions & { edges?: ResizeEdges } = {},
): ResizeSnapResult {
  if (options.disabled) return { x: moving.x, y: moving.y, width: moving.width, height: moving.height, guides: [], spacingGuides: [] };
  const enhanced = Boolean(options.enhanced);
  const edges = options.edges ?? { right: true, bottom: true };
  const horizontalMargin = enhanced ? 5000 : screenScaledRange(50, options.zoom);
  const verticalMargin = enhanced ? 1000 : screenScaledRange(50, options.zoom);
  const detectionRange = screenScaledRange(enhanced ? 50 : 15, options.zoom);
  const contactRange = screenScaledRange(enhanced ? 12 : 6, options.zoom);
  const edge = OBJECT_TRANSPARENT_EDGE;
  const alignmentMoving = {
    ...moving,
    x: moving.x - edge,
    y: moving.y - edge,
    width: moving.width + edge * 2,
    height: moving.height + edge * 2,
  };
  const alignmentCandidates = candidates.map((candidate) => ({
    ...candidate,
    x: candidate.x - edge,
    y: candidate.y - edge,
    width: candidate.width + edge * 2,
    height: candidate.height + edge * 2,
  }));
  const localArea = {
    x: alignmentMoving.x - horizontalMargin,
    y: alignmentMoving.y - verticalMargin,
    width: alignmentMoving.width + horizontalMargin * 2,
    height: alignmentMoving.height + verticalMargin * 2,
  };
  const nearby = alignmentCandidates.filter((candidate) => rectanglesIntersect(localArea, candidate));
  const xGuides = nearby.flatMap((candidate) => [candidate.x, candidate.x + candidate.width, candidate.x + candidate.width / 2]);
  const yGuides = nearby.flatMap((candidate) => [candidate.y, candidate.y + candidate.height, candidate.y + candidate.height / 2]);
  const leftSnap = edges.left ? nearestEndGuide(alignmentMoving.x, xGuides, detectionRange) : { value: alignmentMoving.x, guide: null };
  const rightSnap = edges.right ? nearestEndGuide(alignmentMoving.x + alignmentMoving.width, xGuides, detectionRange) : { value: alignmentMoving.x + alignmentMoving.width, guide: null };
  const topSnap = edges.top ? nearestEndGuide(alignmentMoving.y, yGuides, detectionRange) : { value: alignmentMoving.y, guide: null };
  const bottomSnap = edges.bottom ? nearestEndGuide(alignmentMoving.y + alignmentMoving.height, yGuides, detectionRange) : { value: alignmentMoving.y + alignmentMoving.height, guide: null };
  const fixedRight = moving.x + moving.width;
  const fixedBottom = moving.y + moving.height;
  const x = edges.left ? leftSnap.value + edge : moving.x;
  const y = edges.top ? topSnap.value + edge : moving.y;
  const width = edges.left ? fixedRight - x : edges.right ? rightSnap.value - moving.x - edge : moving.width;
  const height = edges.top ? fixedBottom - y : edges.bottom ? bottomSnap.value - moving.y - edge : moving.height;
  const resized = { ...moving, x, y, width, height };
  const guides: AlignmentGuideLine[] = [];

  if (leftSnap.guide !== null) {
    const targets = nearby.filter((candidate) => [candidate.x, candidate.x + candidate.width, candidate.x + candidate.width / 2].some((guide) => Math.abs(guide - leftSnap.guide!) < .001));
    guides.push({
      axis: 'x', position: leftSnap.guide,
      from: Math.min(resized.y - edge, ...targets.map((candidate) => candidate.y)),
      to: Math.max(resized.y + resized.height + edge, ...targets.map((candidate) => candidate.y + candidate.height)),
      targetIds: targets.map((candidate) => candidate.id),
    });
  }
  if (rightSnap.guide !== null) {
    const targets = nearby.filter((candidate) => [candidate.x, candidate.x + candidate.width, candidate.x + candidate.width / 2].some((guide) => Math.abs(guide - rightSnap.guide!) < .001));
    guides.push({
      axis: 'x', position: rightSnap.guide,
      from: Math.min(resized.y - edge, ...targets.map((candidate) => candidate.y)),
      to: Math.max(resized.y + resized.height + edge, ...targets.map((candidate) => candidate.y + candidate.height)),
      targetIds: targets.map((candidate) => candidate.id),
    });
  }
  if (topSnap.guide !== null) {
    const targets = nearby.filter((candidate) => [candidate.y, candidate.y + candidate.height, candidate.y + candidate.height / 2].some((guide) => Math.abs(guide - topSnap.guide!) < .001));
    guides.push({
      axis: 'y', position: topSnap.guide,
      from: Math.min(resized.x - edge, ...targets.map((candidate) => candidate.x)),
      to: Math.max(resized.x + resized.width + edge, ...targets.map((candidate) => candidate.x + candidate.width)),
      targetIds: targets.map((candidate) => candidate.id),
    });
  }
  if (bottomSnap.guide !== null) {
    const targets = nearby.filter((candidate) => [candidate.y, candidate.y + candidate.height, candidate.y + candidate.height / 2].some((guide) => Math.abs(guide - bottomSnap.guide!) < .001));
    guides.push({
      axis: 'y', position: bottomSnap.guide,
      from: Math.min(resized.x - edge, ...targets.map((candidate) => candidate.x)),
      to: Math.max(resized.x + resized.width + edge, ...targets.map((candidate) => candidate.x + candidate.width)),
      targetIds: targets.map((candidate) => candidate.id),
    });
  }

  const visualCandidates = candidates.filter((candidate) => nearby.some((item) => item.id === candidate.id));
  const visualGap = edge * 2;
  const spacingGuides: SpacingGuideLine[] = [];
  const leftNeighbor = edges.left && visualCandidates.find((candidate) =>
    overlapAmount(resized.y, resized.y + resized.height, candidate.y, candidate.y + candidate.height) > 0
    && Math.abs(candidate.x + candidate.width + visualGap - resized.x) < .001);
  if (leftNeighbor) {
    const overlapTop = Math.max(resized.y, leftNeighbor.y);
    const overlapBottom = Math.min(resized.y + resized.height, leftNeighbor.y + leftNeighbor.height);
    spacingGuides.push({ axis: 'x', from: leftNeighbor.x + leftNeighbor.width, to: resized.x, cross: (overlapTop + overlapBottom) / 2, gap: visualGap, objectId: moving.id, attachedObjectId: leftNeighbor.id });
  }
  const rightNeighbor = visualCandidates.find((candidate) =>
    edges.right
    &&
    overlapAmount(resized.y, resized.y + resized.height, candidate.y, candidate.y + candidate.height) > 0
    && Math.abs(resized.x + resized.width + visualGap - candidate.x) < .001);
  if (rightNeighbor) {
    const overlapTop = Math.max(resized.y, rightNeighbor.y);
    const overlapBottom = Math.min(resized.y + resized.height, rightNeighbor.y + rightNeighbor.height);
    spacingGuides.push({ axis: 'x', from: resized.x + resized.width, to: rightNeighbor.x, cross: (overlapTop + overlapBottom) / 2, gap: visualGap, objectId: moving.id, attachedObjectId: rightNeighbor.id });
  }
  const topNeighbor = edges.top && visualCandidates.find((candidate) =>
    overlapAmount(resized.x, resized.x + resized.width, candidate.x, candidate.x + candidate.width) > 0
    && Math.abs(candidate.y + candidate.height + visualGap - resized.y) < .001);
  if (topNeighbor) {
    const overlapLeft = Math.max(resized.x, topNeighbor.x);
    const overlapRight = Math.min(resized.x + resized.width, topNeighbor.x + topNeighbor.width);
    spacingGuides.push({ axis: 'y', from: topNeighbor.y + topNeighbor.height, to: resized.y, cross: (overlapLeft + overlapRight) / 2, gap: visualGap, objectId: moving.id, attachedObjectId: topNeighbor.id });
  }
  const bottomNeighbor = visualCandidates.find((candidate) =>
    edges.bottom
    &&
    overlapAmount(resized.x, resized.x + resized.width, candidate.x, candidate.x + candidate.width) > 0
    && Math.abs(resized.y + resized.height + visualGap - candidate.y) < .001);
  if (bottomNeighbor) {
    const overlapLeft = Math.max(resized.x, bottomNeighbor.x);
    const overlapRight = Math.min(resized.x + resized.width, bottomNeighbor.x + bottomNeighbor.width);
    spacingGuides.push({ axis: 'y', from: resized.y + resized.height, to: bottomNeighbor.y, cross: (overlapLeft + overlapRight) / 2, gap: visualGap, objectId: moving.id, attachedObjectId: bottomNeighbor.id });
  }
  const rejectHorizontalContact = spacingGuides.some((guide) => guide.axis === 'x')
    && Math.max(Math.abs(x - moving.x), Math.abs(width - moving.width)) > contactRange;
  const rejectVerticalContact = spacingGuides.some((guide) => guide.axis === 'y')
    && Math.max(Math.abs(y - moving.y), Math.abs(height - moving.height)) > contactRange;
  return {
    x: rejectHorizontalContact ? moving.x : x,
    y: rejectVerticalContact ? moving.y : y,
    width: rejectHorizontalContact ? moving.width : width,
    height: rejectVerticalContact ? moving.height : height,
    guides: guides.filter((guide) => !(rejectHorizontalContact && guide.axis === 'x') && !(rejectVerticalContact && guide.axis === 'y')),
    spacingGuides: spacingGuides.filter((guide) => !(rejectHorizontalContact && guide.axis === 'x') && !(rejectVerticalContact && guide.axis === 'y')),
  };
}

export function screenToWorld(point: { x: number; y: number }, viewport: Viewport) {
  return { x: (point.x - viewport.x) / viewport.zoom, y: (point.y - viewport.y) / viewport.zoom };
}

export function worldToScreen(point: { x: number; y: number }, viewport: Viewport) {
  return { x: point.x * viewport.zoom + viewport.x, y: point.y * viewport.zoom + viewport.y };
}

export function normalizedWheelDelta(deltaY: number, deltaMode: number, pageHeight = 800) {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * pageHeight : deltaY;
  return Math.max(-240, Math.min(240, pixels));
}

/** Zoom around the pointer in CSS-pixel space, independent of devicePixelRatio. */
export function zoomViewportAtPoint(viewport: Viewport, pointer: { x: number; y: number }, wheelDelta: number, sensitivity: number, minZoom: number, maxZoom: number): Viewport {
  const zoom = Math.max(minZoom, Math.min(maxZoom, viewport.zoom * Math.exp(-wheelDelta * sensitivity)));
  const world = screenToWorld(pointer, viewport);
  return { zoom, x: pointer.x - world.x * zoom, y: pointer.y - world.y * zoom };
}

export function rectanglesIntersect(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function rectangleContains(outer: { x: number; y: number; width: number; height: number }, inner: { x: number; y: number; width: number; height: number }) {
  return inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

export interface InnerScrollMetrics {
  editing: boolean;
  scrollHeight: number;
  clientHeight: number;
  scrollWidth?: number;
  clientWidth?: number;
  deltaX?: number;
  deltaY?: number;
}

/**
 * Route a wheel gesture to a selected card only when a scrollable surface
 * overflows along that gesture's axis. Deliberately do not inspect scrollTop /
 * scrollLeft: once a selected card owns a scrollbar, reaching its boundary
 * must not unexpectedly turn the same gesture into canvas zoom.
 */
export function shouldUseInnerScroll({
  editing,
  scrollHeight,
  clientHeight,
  scrollWidth = 0,
  clientWidth = 0,
  deltaX = 0,
  deltaY = 0,
}: InnerScrollMetrics) {
  if (!editing) return false;
  const vertical = Math.abs(deltaY) > .01 && scrollHeight > clientHeight + 1;
  const horizontal = Math.abs(deltaX) > .01 && scrollWidth > clientWidth + 1;
  return vertical || horizontal;
}
