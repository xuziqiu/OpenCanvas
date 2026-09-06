import type { AlignmentBox, AlignmentGuideLine } from './interaction';
import type { BoardPlacement } from '../types';

export const SECTION_PADDING = 40;
const SECTION_SNAP_SCREEN_RANGE = 9;

export interface SectionSnapResult {
  x: number;
  y: number;
  guides: AlignmentGuideLine[];
}

type PlacementBounds = Pick<BoardPlacement, 'x' | 'y' | 'width' | 'height'>;

/** Apply direct geometry edits without turning a translated auto-grow into a manual resize. */
export function applyPlacementLayoutChange(placement: BoardPlacement, change: Partial<BoardPlacement>) {
  if (!placement.isFrame) return placement.kind === 'card'
    && Object.prototype.hasOwnProperty.call(change, 'height')
    && !Object.prototype.hasOwnProperty.call(change, 'autoHeight')
    ? { ...placement, ...change, autoHeight: undefined }
    : { ...placement, ...change };
  // A pointer gesture can provide the manual Section base explicitly. This is
  // required once a stationary locked member has temporarily grown an edge:
  // the rendered rectangle and the manual drag origin are then different, so
  // deriving the next base from the rendered x/y would accumulate a false
  // extra translation on the following pointer frame.
  if (Object.prototype.hasOwnProperty.call(change, 'sectionBaseBounds')) return { ...placement, ...change };
  const widthChanged = Object.prototype.hasOwnProperty.call(change, 'width');
  const heightChanged = Object.prototype.hasOwnProperty.call(change, 'height');
  if (widthChanged || heightChanged) return { ...placement, ...change, sectionBaseBounds: undefined };
  if (!placement.sectionBaseBounds) return { ...placement, ...change };
  const nextX = change.x ?? placement.x;
  const nextY = change.y ?? placement.y;
  return {
    ...placement,
    ...change,
    sectionBaseBounds: {
      ...placement.sectionBaseBounds,
      x: placement.sectionBaseBounds.x + nextX - placement.x,
      y: placement.sectionBaseBounds.y + nextY - placement.y,
    },
  };
}

export function placementSectionIds(placement: BoardPlacement) {
  return [...new Set([
    ...(placement.sectionIds ?? []),
    ...(placement.sectionId ? [placement.sectionId] : []),
  ].filter(Boolean))];
}

function sectionsForPlacement(placement: BoardPlacement, placements: BoardPlacement[]) {
  const ids = new Set(placementSectionIds(placement));
  const explicit = placements.filter((candidate) => candidate.isFrame && candidate.id !== placement.id && ids.has(candidate.id));
  if (explicit.length || !placement.groupId) return explicit;
  // Boards created before sectionId existed used one groupId for the frame
  // and its contents. Keep those boards readable while new relations remain
  // independent from ordinary object groups.
  return placements.filter((candidate) => candidate.isFrame && candidate.id !== placement.id && candidate.groupId === placement.groupId);
}

export function sectionMembers(section: BoardPlacement, placements: BoardPlacement[]) {
  return placements.filter((placement) => {
    if (placement.id === section.id) return false;
    const ids = placementSectionIds(placement);
    if (ids.length) return ids.includes(section.id);
    return Boolean(section.groupId && placement.groupId === section.groupId);
  });
}

/** Every nested member, returned once in stable board order. */
export function sectionDescendants(section: BoardPlacement, placements: BoardPlacement[]) {
  const descendantIds = new Set<string>();
  const pending = [section.id];
  while (pending.length) {
    const sectionId = pending.shift()!;
    const activeSection = placements.find((placement) => placement.id === sectionId && placement.isFrame);
    if (!activeSection) continue;
    for (const member of sectionMembers(activeSection, placements)) {
      if (descendantIds.has(member.id) || member.id === section.id) continue;
      descendantIds.add(member.id);
      if (member.isFrame) pending.push(member.id);
    }
  }
  return placements.filter((placement) => descendantIds.has(placement.id));
}

/**
 * Expand an explicit drag selection with the movable contents of every
 * selected Section. Parent/child Sections can both participate in a
 * multi-selection; stable de-duplication guarantees that nested objects still
 * receive exactly one translation per pointer frame.
 */
export function sectionDragPlacementIds(requestedIds: Iterable<string>, placements: BoardPlacement[]) {
  return [...new Set([...requestedIds].flatMap((placementId) => {
    const placement = placements.find((candidate) => candidate.id === placementId);
    if (!placement?.isFrame) return placement ? [placementId] : [];
    return [placementId, ...sectionDescendants(placement, placements)
      .filter((member) => !member.locked)
      .map((member) => member.id)];
  }))];
}

/** Objects carried by a moved ancestor Section keep their existing relation. */
export function sectionMembershipRoots(movedIds: Iterable<string>, placements: BoardPlacement[]) {
  const moved = new Set(movedIds);
  return placements
    .filter((placement) => moved.has(placement.id))
    .filter((placement) => !placementSectionIds(placement).some((sectionId) => moved.has(sectionId)))
    .map((placement) => placement.id);
}

/**
 * Objects whose spatial relationship may have changed after a gesture.
 *
 * A moved Section normally carries its descendants, so settling only the
 * outer roots avoids needless relation churn. Locked descendants are the
 * important exception: their geometry stays fixed while the Section moves or
 * resizes around them. Include every descendant of a manipulated Section so a
 * stationary locked object is detached once the Section fully leaves it, while
 * ordinary carried members simply reconcile to the same relation.
 */
export function sectionMembershipSettlementIds(movedIds: Iterable<string>, placements: BoardPlacement[]) {
  const moved = new Set(movedIds);
  const roots = sectionMembershipRoots(moved, placements);
  const descendants = placements
    .filter((placement) => moved.has(placement.id) && placement.isFrame)
    .flatMap((section) => sectionDescendants(section, placements).map((member) => member.id));
  return [...new Set([...roots, ...descendants])];
}

/** The smallest containing Section is the active inner-padding snap target. */
export function sectionForPlacement(placement: BoardPlacement, placements: BoardPlacement[]) {
  return sectionsForPlacement(placement, placements)
    .sort((left, right) => left.width * left.height - right.width * right.height)[0];
}

export function sectionBoundsForPlacements(placements: BoardPlacement[], padding = SECTION_PADDING) {
  if (!placements.length) return null;
  const left = Math.min(...placements.map((placement) => placement.x));
  const top = Math.min(...placements.map((placement) => placement.y));
  const right = Math.max(...placements.map((placement) => placement.x + placement.width));
  const bottom = Math.max(...placements.map((placement) => placement.y + placement.height));
  return {
    x: left - padding,
    y: top - padding,
    width: right - left + padding * 2,
    height: bottom - top + padding * 2,
  };
}

function rectanglesOverlap(left: PlacementBounds, right: PlacementBounds) {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function fullyContains(container: PlacementBounds, inner: PlacementBounds) {
  return container.x <= inner.x
    && container.y <= inner.y
    && container.x + container.width >= inner.x + inner.width
    && container.y + container.height >= inner.y + inner.height;
}

/** Public geometry predicate used by atomic Section creation commands. */
export function placementFullyContains(container: PlacementBounds, inner: PlacementBounds) {
  return fullyContains(container, inner);
}

function sameBounds(left: PlacementBounds, right: PlacementBounds) {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

/** Section relations implied by a placement's current geometry. */
export function containingSectionIdsForPlacement(placement: BoardPlacement, placements: BoardPlacement[]) {
  const ownDescendants = placement.isFrame
    ? new Set(sectionDescendants(placement, placements).map((member) => member.id))
    : new Set<string>();
  const existingSectionIds = new Set(placementSectionIds(placement));
  return placements
    .filter((section) => {
      if (!section.isFrame || section.id === placement.id || ownDescendants.has(section.id)) return false;
      if (placement.isFrame) return fullyContains(section, placement) && !sameBounds(section, placement);
      // Containment hysteresis prevents ordinary objects from flickering in and out:
      // a new Section requires complete containment, while an established
      // relation survives until the object no longer overlaps at all.
      return existingSectionIds.has(section.id)
        ? rectanglesOverlap(section, placement)
        : fullyContains(section, placement);
    })
    .map((section) => section.id);
}

/** Live Section targets for the roots whose geometry is being manipulated. */
export function prospectiveSectionIdsForPlacements(placements: BoardPlacement[], movedIds: Iterable<string>) {
  const roots = sectionMembershipRoots(movedIds, placements);
  return [...new Set(roots.flatMap((id) => {
    const placement = placements.find((candidate) => candidate.id === id);
    return placement ? containingSectionIdsForPlacement(placement, placements) : [];
  }))];
}

/**
 * Recompute membership only after a manipulation commits. Ordinary objects
 * enter a Section only after full containment, retain that relation while
 * overlapping, and detach after fully leaving. A nested Section always
 * requires full containment. Sections keep an explicit membership relation
 * instead of behaving like ordinary groups.
 */
export function reconcileSectionMembershipChanges(placements: BoardPlacement[], movedIds: Iterable<string>) {
  const moved = new Set(movedIds);
  const sections = placements.filter((placement) => placement.isFrame);
  const changes: Record<string, Partial<BoardPlacement>> = {};
  for (const placement of placements) {
    if (!moved.has(placement.id)) continue;
    const nextIds = containingSectionIdsForPlacement(placement, placements);
    const previousIds = placementSectionIds(placement).filter((id) => sections.some((section) => section.id === id));
    if (previousIds.length === nextIds.length && previousIds.every((id, index) => id === nextIds[index])) continue;
    changes[placement.id] = {
      sectionId: nextIds[0],
      sectionIds: nextIds.length ? nextIds : undefined,
    };
  }
  return changes;
}

/** Snap a card's outer edges to the Section's inner padding boundary. */
export function snapBoxToSectionPadding(
  moving: AlignmentBox,
  section: BoardPlacement | undefined,
  options: { disabled?: boolean; zoom?: number; padding?: number } = {},
): SectionSnapResult {
  if (!section || options.disabled) return { x: moving.x, y: moving.y, guides: [] };
  const padding = options.padding ?? SECTION_PADDING;
  const zoom = Math.max(.05, options.zoom ?? 1);
  const range = SECTION_SNAP_SCREEN_RANGE / zoom;
  const leftInset = section.x + padding;
  const rightInset = section.x + section.width - padding;
  const topInset = section.y + padding;
  const bottomInset = section.y + section.height - padding;
  const xCandidates = [
    { distance: Math.abs(moving.x - leftInset), x: leftInset, guide: leftInset },
    { distance: Math.abs(moving.x + moving.width - rightInset), x: rightInset - moving.width, guide: rightInset },
  ].sort((a, b) => a.distance - b.distance);
  const yCandidates = [
    { distance: Math.abs(moving.y - topInset), y: topInset, guide: topInset },
    { distance: Math.abs(moving.y + moving.height - bottomInset), y: bottomInset - moving.height, guide: bottomInset },
  ].sort((a, b) => a.distance - b.distance);
  const xSnap = xCandidates[0].distance <= range ? xCandidates[0] : null;
  const ySnap = yCandidates[0].distance <= range ? yCandidates[0] : null;
  const guides: AlignmentGuideLine[] = [];
  if (xSnap) guides.push({ axis: 'x', position: xSnap.guide, from: topInset, to: bottomInset, targetIds: [section.id] });
  if (ySnap) guides.push({ axis: 'y', position: ySnap.guide, from: leftInset, to: rightInset, targetIds: [section.id] });
  return { x: xSnap?.x ?? moving.x, y: ySnap?.y ?? moving.y, guides };
}

function unionBounds(left: PlacementBounds, right: PlacementBounds) {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const rightEdge = Math.max(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: rightEdge - x, height: bottomEdge - y };
}

/**
 * Sections are elastic minimum bounds. Manual bounds are preserved as a base;
 * content may expand an edge live, and the edge returns to that base when the
 * pressure disappears. Completely detached former members are ignored so a
 * Section never stretches across the whole canvas during an exit drag.
 */
export function expandSectionsToMaintainPadding(placements: BoardPlacement[], padding = SECTION_PADDING) {
  let result = placements;
  const passCount = Math.max(1, placements.filter((placement) => placement.isFrame).length + 1);
  for (let pass = 0; pass < passCount; pass += 1) {
    let changed = false;
    result = result.map((section) => {
      if (!section.isFrame) return section;
      const base = section.sectionBaseBounds ?? {
        x: section.x,
        y: section.y,
        width: section.width,
        height: section.height,
      };
      // Always test pressure against the manual base, never the already-grown
      // rectangle. Otherwise an expanded edge would keep chasing a departing
      // member across the canvas one animation frame at a time.
      const attachedMembers = sectionMembers(section, result).filter((member) => rectanglesOverlap(base, member));
      const required = sectionBoundsForPlacements(attachedMembers, padding);
      const target = required ? unionBounds(base, required) : base;
      const hadAutomaticBounds = Boolean(section.sectionBaseBounds);
      const needsAutomaticBounds = !sameBounds(target, base);
      const nextBaseBounds = needsAutomaticBounds
        ? (section.sectionBaseBounds ?? base)
        : undefined;
      if (sameBounds(section, target)
        && hadAutomaticBounds === Boolean(nextBaseBounds)
        && (!nextBaseBounds || section.sectionBaseBounds === nextBaseBounds)) return section;
      changed = true;
      return { ...section, ...target, sectionBaseBounds: nextBaseBounds };
    });
    if (!changed) break;
  }
  return result;
}
