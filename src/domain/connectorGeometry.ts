export type Point = { x: number; y: number };
export type AnchorSide = 'top' | 'right' | 'bottom' | 'left';
export type ConnectorLineStyle = 'curve' | 'orthogonal' | 'straight';
type ConnectorInsertionPoint = { point: Point; index: number; direction?: 'vertical' | 'horizontal' };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const sideVector = (side: AnchorSide): Point => side === 'top' ? { x: 0, y: -1 } : side === 'right' ? { x: 1, y: 0 } : side === 'bottom' ? { x: 0, y: 1 } : { x: -1, y: 0 };

function cubicPoint(a: Point, c1: Point, c2: Point, b: Point, t: number): Point {
  const mt = 1 - t;
  return {
    x: mt ** 3 * a.x + 3 * mt ** 2 * t * c1.x + 3 * mt * t ** 2 * c2.x + t ** 3 * b.x,
    y: mt ** 3 * a.y + 3 * mt ** 2 * t * c1.y + 3 * mt * t ** 2 * c2.y + t ** 3 * b.y,
  };
}

/** Build the visible route and one insertion affordance for every editable segment. */
export function connectorGeometry(
  start: Point,
  end: Point,
  style: ConnectorLineStyle = 'curve',
  keypoints: Point[] = [],
  endpointDirections?: { start: AnchorSide; end: AnchorSide },
) {
  const route = [start, ...keypoints, end];
  const insertions: ConnectorInsertionPoint[] = [];
  const hitPoints: Point[] = [start];
  let d = `M ${start.x} ${start.y}`;

  if (style === 'curve') {
    for (let index = 0; index < route.length - 1; index += 1) {
      const previous = route[index - 1] ?? route[index];
      const current = route[index];
      const next = route[index + 1];
      const following = route[index + 2] ?? next;
      let c1 = { x: current.x + (next.x - previous.x) / 6, y: current.y + (next.y - previous.y) / 6 };
      let c2 = { x: next.x - (following.x - current.x) / 6, y: next.y - (following.y - current.y) / 6 };
      if (endpointDirections && index === 0) {
        const vector = sideVector(endpointDirections.start);
        const strength = clamp(Math.hypot(next.x - current.x, next.y - current.y) * .28, 34, 140);
        c1 = { x: current.x + vector.x * strength, y: current.y + vector.y * strength };
      }
      if (endpointDirections && index === route.length - 2) {
        const vector = sideVector(endpointDirections.end);
        const strength = clamp(Math.hypot(next.x - current.x, next.y - current.y) * .28, 34, 140);
        c2 = { x: next.x + vector.x * strength, y: next.y + vector.y * strength };
      }
      d += ` C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${next.x} ${next.y}`;
      insertions.push({ point: cubicPoint(current, c1, c2, next, .5), index });
      for (let sample = 1; sample <= 8; sample += 1) hitPoints.push(cubicPoint(current, c1, c2, next, sample / 8));
    }
  } else if (style === 'orthogonal') {
    for (let index = 0; index < route.length - 1; index += 1) {
      const current = route[index];
      const next = route[index + 1];
      const dx = Math.abs(next.x - current.x);
      const dy = Math.abs(next.y - current.y);
      const segmentPoints = dx < .001 || dy < .001 ? [next] : dx >= dy
        ? [{ x: (current.x + next.x) / 2, y: current.y }, { x: (current.x + next.x) / 2, y: next.y }, next]
        : [{ x: current.x, y: (current.y + next.y) / 2 }, { x: next.x, y: (current.y + next.y) / 2 }, next];
      let segmentStart = current;
      for (const segmentEnd of segmentPoints) {
        d += ` L ${segmentEnd.x} ${segmentEnd.y}`;
        if (Math.hypot(segmentEnd.x - segmentStart.x, segmentEnd.y - segmentStart.y) > 18) insertions.push({
          point: midpoint(segmentStart, segmentEnd),
          index,
          direction: Math.abs(segmentEnd.x - segmentStart.x) < .001 ? 'vertical' : 'horizontal',
        });
        hitPoints.push(segmentEnd);
        segmentStart = segmentEnd;
      }
    }
  } else {
    for (let index = 0; index < route.length - 1; index += 1) {
      const next = route[index + 1];
      d += ` L ${next.x} ${next.y}`;
      insertions.push({ point: midpoint(route[index], next), index });
      hitPoints.push(next);
    }
  }

  return { d, insertions, hitPoints, labelPoint: insertions[Math.floor((insertions.length - 1) / 2)]?.point ?? midpoint(start, end) };
}
