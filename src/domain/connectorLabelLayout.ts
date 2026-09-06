import type { Point } from './connectorGeometry';

export interface ConnectorLabelCandidate {
  point: Point;
  insertionIndex: number;
}

export interface ConnectorLabelRequest {
  id: string;
  label: string;
  manual: boolean;
  candidates: ConnectorLabelCandidate[];
}

export interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

const CONNECTOR_LABEL_HEIGHT = 22;

export function connectorLabelMetrics(label: string) {
  const glyphs = [...label];
  const displayLabel = glyphs.length > 30 ? `${glyphs.slice(0, 29).join('')}…` : label;
  return {
    displayLabel,
    width: Math.min(260, Math.max(30, [...displayLabel].length * 11 + 16)),
    height: CONNECTOR_LABEL_HEIGHT,
  };
}

function pointAtFraction(points: Point[], fraction: number): Point | null {
  if (points.length < 2) return null;
  const lengths: number[] = [];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const length = Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
    lengths.push(length);
    total += length;
  }
  if (total < .001) return { ...points[0] };
  let remaining = total * fraction;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    if (remaining <= length || index === lengths.length - 1) {
      const ratio = length < .001 ? 0 : Math.min(1, remaining / length);
      return {
        x: points[index].x + (points[index + 1].x - points[index].x) * ratio,
        y: points[index].y + (points[index + 1].y - points[index].y) * ratio,
      };
    }
    remaining -= length;
  }
  return { ...points.at(-1)! };
}

/**
 * Keep automatic labels on their route. The center remains the preferred
 * central position; progressively wider samples are fallback slots for
 * avoiding cards and other connector labels.
 */
export function automaticLabelCandidates(hitPoints: Point[], preferred: Point, insertionIndex: number): ConnectorLabelCandidate[] {
  const candidates: ConnectorLabelCandidate[] = [{ point: preferred, insertionIndex }];
  for (const fraction of [.38, .62, .26, .74, .16, .84]) {
    const point = pointAtFraction(hitPoints, fraction);
    if (!point || candidates.some((candidate) => Math.hypot(candidate.point.x - point.x, candidate.point.y - point.y) < 2)) continue;
    // The original midpoint affordance stays hidden: the label itself is now
    // the draggable keypoint for this automatically chosen route position.
    candidates.push({ point, insertionIndex });
  }
  return candidates;
}

function labelRect(point: Point, label: string): RectLike {
  const metrics = connectorLabelMetrics(label);
  return {
    x: point.x - metrics.width / 2,
    y: point.y - metrics.height / 2,
    width: metrics.width,
    height: metrics.height,
  };
}

function intersects(left: RectLike, right: RectLike, gap = 0) {
  return left.x < right.x + right.width + gap
    && left.x + left.width + gap > right.x
    && left.y < right.y + right.height + gap
    && left.y + left.height + gap > right.y;
}

/**
 * Resolve all visible labels in one stable pass. Manually positioned labels
 * never move, but reserve their space before automatic labels are placed.
 */
export function resolveConnectorLabelLayout(requests: ConnectorLabelRequest[], obstacles: RectLike[]) {
  const resolved = new Map<string, ConnectorLabelCandidate>();
  const occupiedLabels: RectLike[] = [];
  const manual = requests.filter((request) => request.manual);
  const automatic = requests.filter((request) => !request.manual);

  for (const request of manual) {
    const candidate = request.candidates[0];
    if (!candidate) continue;
    resolved.set(request.id, candidate);
    occupiedLabels.push(labelRect(candidate.point, request.label));
  }

  for (const request of automatic) {
    if (!request.candidates.length) continue;
    let best = request.candidates[0];
    let bestScore = Number.POSITIVE_INFINITY;
    for (let index = 0; index < request.candidates.length; index += 1) {
      const candidate = request.candidates[index];
      const rect = labelRect(candidate.point, request.label);
      const cardCollisions = obstacles.filter((obstacle) => intersects(rect, obstacle, 5)).length;
      const labelCollisions = occupiedLabels.filter((occupied) => intersects(rect, occupied, 6)).length;
      const score = cardCollisions * 100 + labelCollisions * 1000 + index;
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
        if (score === index && cardCollisions === 0 && labelCollisions === 0) break;
      }
    }
    resolved.set(request.id, best);
    occupiedLabels.push(labelRect(best.point, request.label));
  }

  return resolved;
}
