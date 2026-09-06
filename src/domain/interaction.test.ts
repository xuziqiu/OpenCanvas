import { describe, expect, it } from 'vitest';
import { normalizedWheelDelta, rectangleContains, rectanglesIntersect, screenToWorld, shouldUseInnerScroll, snapBoxToNearbyObjects, snapResizeBoxToNearbyObjects, worldToScreen, zoomViewportAtPoint } from './interaction';

describe('canvas coordinate kernel', () => {
  it('round-trips screen and world coordinates', () => {
    const viewport = { x: 120, y: -40, zoom: .8 };
    const world = screenToWorld({ x: 520, y: 200 }, viewport);
    expect(worldToScreen(world, viewport)).toEqual({ x: 520, y: 200 });
  });

  it('keeps coordinate round-trips subpixel-accurate across Windows display scales', () => {
    const viewport = { x: 119.375, y: -41.625, zoom: .8375 };
    for (const scale of [1, 1.25, 1.5, 1.75, 2]) {
      const screen = { x: 521.25 * scale, y: 203.75 * scale };
      const roundTrip = worldToScreen(screenToWorld(screen, viewport), viewport);
      expect(Math.abs(roundTrip.x - screen.x)).toBeLessThan(.5);
      expect(Math.abs(roundTrip.y - screen.y)).toBeLessThan(.5);
    }
  });

  it('selects objects intersecting a marquee, not only contained objects', () => {
    expect(rectanglesIntersect({ x: 0, y: 0, width: 100, height: 100 }, { x: 90, y: 90, width: 40, height: 40 })).toBe(true);
  });

  it('requires complete containment for section marquee selection', () => {
    expect(rectangleContains({ x: 0, y: 0, width: 100, height: 100 }, { x: 10, y: 10, width: 80, height: 80 })).toBe(true);
    expect(rectangleContains({ x: 0, y: 0, width: 100, height: 100 }, { x: 90, y: 90, width: 20, height: 20 })).toBe(false);
  });

  it('routes wheel input inside only for an overflowing card in edit mode', () => {
    expect(shouldUseInnerScroll({ editing: true, scrollHeight: 500, clientHeight: 200, deltaY: 80 })).toBe(true);
    expect(shouldUseInnerScroll({ editing: false, scrollHeight: 500, clientHeight: 200, deltaY: 80 })).toBe(false);
    expect(shouldUseInnerScroll({ editing: true, scrollHeight: 180, clientHeight: 200, deltaY: 80 })).toBe(false);
  });

  it('routes horizontal table gestures without treating zero-axis input as scroll', () => {
    const horizontal = { editing: true, scrollHeight: 100, clientHeight: 100, scrollWidth: 640, clientWidth: 300 };
    expect(shouldUseInnerScroll({ ...horizontal, deltaX: 45 })).toBe(true);
    expect(shouldUseInnerScroll({ ...horizontal, deltaY: 45 })).toBe(false);
    expect(shouldUseInnerScroll({ ...horizontal })).toBe(false);
  });

  it('normalizes mouse-wheel modes and keeps the world point under a high-DPI pointer', () => {
    expect(normalizedWheelDelta(3, 1)).toBe(48);
    expect(normalizedWheelDelta(1, 2, 900)).toBe(240);
    const pointer = { x: 713.25, y: 418.5 };
    const viewport = { x: 117.5, y: -42.25, zoom: .83 };
    const worldBefore = screenToWorld(pointer, viewport);
    const next = zoomViewportAtPoint(viewport, pointer, normalizedWheelDelta(1.5, 0), .0018, .2, 2.4);
    const worldAfter = screenToWorld(pointer, next);
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 10);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 10);
  });

  it('accumulates small touchpad deltas instead of losing events in one frame', () => {
    const pointer = { x: 500, y: 300 };
    let viewport = { x: 0, y: 0, zoom: 1 };
    for (let index = 0; index < 20; index += 1) viewport = zoomViewportAtPoint(viewport, pointer, .7, .0018, .2, 2.4);
    expect(viewport.zoom).toBeCloseTo(Math.exp(-14 * .0018), 10);
  });

  it('snaps a moving box to nearby object edges and centers', () => {
    const moving = { id: 'moving', x: 42, y: 118, width: 150, height: 80 };
    const neighbor = { id: 'neighbor', x: 200, y: 100, width: 100, height: 100 };
    expect(snapBoxToNearbyObjects(moving, [neighbor])).toEqual({
      x: 44,
      y: 120,
      snappedX: 197,
      snappedY: 203,
      guides: [
        { axis: 'x', position: 197, from: 97, to: 203, targetIds: ['neighbor'] },
        { axis: 'y', position: 203, from: 44, to: 303, targetIds: ['neighbor'] },
      ],
      spacingGuides: [
        { axis: 'x', from: 194, to: 200, cross: 160, gap: 6, objectId: 'moving', attachedObjectId: 'neighbor' },
      ],
    });
  });

  it('aligns transparent 3-unit edges and leaves a visible 6-unit gutter', () => {
    const moving = { id: 'moving', x: 93, y: 120, width: 100, height: 80 };
    const neighbor = { id: 'neighbor', x: 200, y: 100, width: 120, height: 120 };
    const result = snapBoxToNearbyObjects(moving, [neighbor]);
    expect(result.x).toBe(94);
    expect(result.y).toBe(120);
    expect(result.spacingGuides).toEqual([
      { axis: 'x', from: 194, to: 200, cross: 160, gap: 6, objectId: 'moving', attachedObjectId: 'neighbor' },
    ]);
    expect(neighbor).toEqual({ id: 'neighbor', x: 200, y: 100, width: 120, height: 120 });
  });

  it('keeps contact snapping strict without widening normal alignment range', () => {
    const neighbor = { id: 'neighbor', x: 200, y: 100, width: 120, height: 120 };
    const looseContact = snapBoxToNearbyObjects({ id: 'moving', x: 86, y: 120, width: 100, height: 80 }, [neighbor]);
    expect(looseContact.x).toBe(86);
    expect(looseContact.spacingGuides).toEqual([]);

    const distantAlignment = snapBoxToNearbyObjects(
      { id: 'moving', x: 210, y: 700, width: 100, height: 80 },
      [{ id: 'far-above', x: 200, y: 100, width: 100, height: 100 }],
    );
    expect(distantAlignment.x).toBe(210);
    expect(distantAlignment.guides).toEqual([]);
  });

  it('keeps the stricter contact gap threshold stable in screen pixels', () => {
    const neighbor = { id: 'neighbor', x: 200, y: 100, width: 120, height: 120 };
    expect(snapBoxToNearbyObjects({ id: 'moving', x: 84, y: 120, width: 100, height: 80 }, [neighbor], { zoom: .5 }).x).toBe(94);
    expect(snapBoxToNearbyObjects({ id: 'moving', x: 91.5, y: 120, width: 100, height: 80 }, [neighbor], { zoom: 2 }).x).toBe(94);
    expect(snapBoxToNearbyObjects({ id: 'moving', x: 78, y: 120, width: 100, height: 80 }, [neighbor], { zoom: .5 }).x).toBe(78);
    expect(snapBoxToNearbyObjects({ id: 'moving', x: 90, y: 120, width: 100, height: 80 }, [neighbor], { zoom: 2 }).x).toBe(90);
  });

  it('stays free outside the local magnet and lets Alt bypass snapping', () => {
    const moving = { id: 'moving', x: 42, y: 118, width: 150, height: 80 };
    const far = { id: 'far', x: 500, y: 500, width: 100, height: 100 };
    expect(snapBoxToNearbyObjects(moving, [far])).toEqual({ x: 42, y: 118, snappedX: null, snappedY: null, guides: [], spacingGuides: [] });
    const neighbor = { id: 'neighbor', x: 200, y: 100, width: 100, height: 100 };
    expect(snapBoxToNearbyObjects(moving, [neighbor], { disabled: true })).toEqual({ x: 42, y: 118, snappedX: null, snappedY: null, guides: [], spacingGuides: [] });
  });

  it('uses a broader, stronger alignment search while Shift is held', () => {
    const moving = { id: 'moving', x: 850, y: 300, width: 100, height: 100 };
    const neighbor = { id: 'neighbor', x: 980, y: 100, width: 100, height: 100 };
    expect(snapBoxToNearbyObjects(moving, [neighbor]).x).toBe(850);
    expect(snapBoxToNearbyObjects(moving, [neighbor], { enhanced: true }).x).toBe(874);
  });

  it('keeps move snapping tolerance stable in screen pixels across zoom levels', () => {
    const neighbor = { id: 'neighbor', x: 200, y: 100, width: 100, height: 100 };
    const nearAtHalfZoom = snapBoxToNearbyObjects({ id: 'moving', x: 224, y: 100, width: 100, height: 100 }, [neighbor], { zoom: .5 });
    const nearAtDoubleZoom = snapBoxToNearbyObjects({ id: 'moving', x: 206, y: 100, width: 100, height: 100 }, [neighbor], { zoom: 2 });
    expect(nearAtHalfZoom.x).toBe(200);
    expect(nearAtDoubleZoom.x).toBe(200);
  });

  it('snaps resized right and bottom edges while leaving neighbors stationary', () => {
    const moving = { id: 'moving', x: 0, y: 0, width: 198, height: 138 };
    const rightNeighbor = { id: 'right', x: 205, y: 20, width: 80, height: 20 };
    const bottomNeighbor = { id: 'bottom', x: 20, y: 145, width: 40, height: 60 };
    const result = snapResizeBoxToNearbyObjects(moving, [rightNeighbor, bottomNeighbor]);
    expect(result.width).toBe(199);
    expect(result.height).toBe(139);
    expect(result.spacingGuides).toEqual(expect.arrayContaining([
      { axis: 'x', from: 199, to: 205, cross: 30, gap: 6, objectId: 'moving', attachedObjectId: 'right' },
      { axis: 'y', from: 139, to: 145, cross: 40, gap: 6, objectId: 'moving', attachedObjectId: 'bottom' },
    ]));
    expect(rightNeighbor.x).toBe(205);
    expect(bottomNeighbor.y).toBe(145);
  });

  it('lets Alt bypass resize snapping', () => {
    const moving = { id: 'moving', x: 0, y: 0, width: 198, height: 138 };
    const neighbor = { id: 'right', x: 205, y: 20, width: 80, height: 20 };
    expect(snapResizeBoxToNearbyObjects(moving, [neighbor], { disabled: true })).toEqual({ x: 0, y: 0, width: 198, height: 138, guides: [], spacingGuides: [] });
  });

  it('keeps resize snapping tolerance stable in screen pixels across zoom levels', () => {
    const neighbor = { id: 'neighbor', x: 300, y: 0, width: 100, height: 100 };
    // Target the neighbor's far edge, not its contact-gap guide: contact
    // snapping intentionally keeps its own stricter six-pixel threshold.
    expect(snapResizeBoxToNearbyObjects({ id: 'moving', x: 0, y: 0, width: 424, height: 100 }, [neighbor], { zoom: .5 }).width).toBe(400);
    expect(snapResizeBoxToNearbyObjects({ id: 'moving', x: 0, y: 0, width: 406, height: 100 }, [neighbor], { zoom: 2 }).width).toBe(400);
  });

  it('snaps resized left and top edges while keeping the opposite corner fixed', () => {
    const moving = { id: 'moving', x: 104, y: 104, width: 100, height: 80 };
    const leftNeighbor = { id: 'left', x: 0, y: 110, width: 96, height: 20 };
    const topNeighbor = { id: 'top', x: 110, y: 0, width: 20, height: 96 };
    const result = snapResizeBoxToNearbyObjects(moving, [leftNeighbor, topNeighbor], { edges: { left: true, top: true } });
    expect(result.x).toBe(102);
    expect(result.y).toBe(102);
    expect(result.width).toBe(102);
    expect(result.height).toBe(82);
    expect(result.spacingGuides).toEqual(expect.arrayContaining([
      { axis: 'x', from: 96, to: 102, cross: 120, gap: 6, objectId: 'moving', attachedObjectId: 'left' },
      { axis: 'y', from: 96, to: 102, cross: 120, gap: 6, objectId: 'moving', attachedObjectId: 'top' },
    ]));
  });
});
