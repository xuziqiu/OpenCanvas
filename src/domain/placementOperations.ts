import type { BoardAttachment, BoardConnector, BoardPlacement } from '../types';

export interface PlacementClipboardPayload {
  type: 'opencanvas/placements';
  placements: BoardPlacement[];
  connectors: BoardConnector[];
  attachments?: BoardAttachment[];
}

export function arrangePlacementZIndices(
  placements: BoardPlacement[],
  selectedIds: Iterable<string>,
  direction: 'front' | 'back' | 'forward' | 'backward',
) {
  const selected = new Set(selectedIds);
  if (!selected.size) return placements;
  const ordered = placements
    .map((placement, index) => ({ placement, index, z: placement.zIndex ?? 0 }))
    .filter(({ placement }) => selected.has(placement.id))
    .sort((left, right) => left.z - right.z || left.index - right.index);
  if (!ordered.length) return placements;

  const values = placements.map((placement) => placement.zIndex ?? 0);
  if (direction === 'forward' || direction === 'backward') {
    // "One layer" is a visual-order operation, not arithmetic on an opaque
    // z-index. Real boards accumulate sparse and duplicate values after import,
    // grouping and repeated front/back commands; adding 1 can therefore leave
    // the selected object visibly in exactly the same place. Move every
    // contiguous selected block across its nearest unselected neighbour, then
    // normalize the ranks while preserving the resulting stable order.
    const stack = placements
      .map((placement, index) => ({ placement, index, z: placement.zIndex ?? 0 }))
      .sort((left, right) => left.z - right.z || left.index - right.index);
    let changed = false;
    if (direction === 'forward') {
      for (let index = stack.length - 2; index >= 0; index -= 1) {
        if (!selected.has(stack[index].placement.id) || selected.has(stack[index + 1].placement.id)) continue;
        [stack[index], stack[index + 1]] = [stack[index + 1], stack[index]];
        changed = true;
      }
    } else {
      for (let index = 1; index < stack.length; index += 1) {
        if (!selected.has(stack[index].placement.id) || selected.has(stack[index - 1].placement.id)) continue;
        [stack[index - 1], stack[index]] = [stack[index], stack[index - 1]];
        changed = true;
      }
    }
    if (!changed) return placements;
    const start = Math.min(0, ...values);
    const zById = new Map(stack.map(({ placement }, index) => [placement.id, start + index]));
    return placements.map((placement) => ({ ...placement, zIndex: zById.get(placement.id) }));
  }
  const start = direction === 'front' ? Math.max(0, ...values) + 1 : Math.min(0, ...values) - ordered.length;
  const zById = new Map(ordered.map(({ placement }, index) => [placement.id, start + index]));
  return placements.map((placement) => zById.has(placement.id)
    ? { ...placement, zIndex: zById.get(placement.id) }
    : placement);
}

/** Clone spatial instances while preserving entity references and isolating copied groups. */
export function clonePlacementPayload(
  payload: PlacementClipboardPayload,
  createId: () => string,
  position?: { x: number; y: number },
  validSectionIds?: ReadonlySet<string>,
) {
  const idMap = new Map(payload.placements.map((placement) => [placement.id, createId()]));
  const groupIdMap = new Map<string, string>();
  const minX = payload.placements.length ? Math.min(...payload.placements.map((placement) => placement.x)) : 0;
  const minY = payload.placements.length ? Math.min(...payload.placements.map((placement) => placement.y)) : 0;
  const offset = position ? { x: position.x - minX, y: position.y - minY } : { x: 32, y: 32 };
  const placements = payload.placements.map((placement) => {
    let groupId = placement.groupId;
    if (groupId) {
      if (!groupIdMap.has(groupId)) groupIdMap.set(groupId, createId());
      groupId = groupIdMap.get(groupId)!;
    }
    const copiedSectionIds = [...new Set([
      ...(placement.sectionIds ?? []),
      ...(placement.sectionId ? [placement.sectionId] : []),
    ].map((sectionId) => idMap.get(sectionId) ?? (validSectionIds?.has(sectionId) ? sectionId : undefined)).filter((sectionId): sectionId is string => Boolean(sectionId)))];
    return {
      ...placement,
      id: idMap.get(placement.id)!,
      groupId,
      sectionId: copiedSectionIds[0],
      sectionIds: copiedSectionIds.length ? copiedSectionIds : undefined,
      sectionBaseBounds: undefined,
      x: placement.x + offset.x,
      y: placement.y + offset.y,
    };
  });
  const connectors = payload.connectors
    .filter((connector) => idMap.has(connector.from) && idMap.has(connector.to))
    .map((connector) => ({ ...connector, id: createId(), from: idMap.get(connector.from)!, to: idMap.get(connector.to)! }));
  const attachments = (payload.attachments ?? [])
    .filter((attachment) => idMap.has(attachment.objectId) && idMap.has(attachment.attachedObjectId))
    .map((attachment) => ({ ...attachment, objectId: idMap.get(attachment.objectId)!, attachedObjectId: idMap.get(attachment.attachedObjectId)! }));
  return { placements, connectors, attachments };
}

export interface PlacementBounds { x: number; y: number; width: number; height: number }

export function placementBounds(placements: BoardPlacement[]): PlacementBounds | null {
  if (!placements.length) return null;
  const x = Math.min(...placements.map((placement) => placement.x));
  const y = Math.min(...placements.map((placement) => placement.y));
  const right = Math.max(...placements.map((placement) => placement.x + placement.width));
  const bottom = Math.max(...placements.map((placement) => placement.y + placement.height));
  return { x, y, width: right - x, height: bottom - y };
}

export function resizePlacementGroup(
  placements: BoardPlacement[],
  from: PlacementBounds,
  to: PlacementBounds,
) {
  const scaleX = from.width > 0 ? to.width / from.width : 1;
  const scaleY = from.height > 0 ? to.height / from.height : 1;
  return Object.fromEntries(placements.map((placement) => [placement.id, {
    x: to.x + (placement.x - from.x) * scaleX,
    y: to.y + (placement.y - from.y) * scaleY,
    width: placement.width * scaleX,
    height: placement.height * scaleY,
  }]));
}
