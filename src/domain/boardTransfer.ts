import { placementBounds } from './placementOperations';
import { expandSectionsToMaintainPadding, placementSectionIds } from './sectionLayout';
import type { Board, BoardConnector, BoardPlacement } from '../types';

export interface BoardTransferOptions {
  copy?: boolean;
  createId?: () => string;
  targetPosition?: { x: number; y: number };
  now?: string;
}

export interface BoardTransferResult {
  source: Board;
  target: Board;
  destinationPlacementIds: string[];
}

function defaultTargetPosition(target: Board) {
  const bounds = placementBounds(target.placements.filter((placement) => !placement.hidden));
  return bounds ? { x: bounds.x + bounds.width, y: bounds.y } : { x: 140, y: 120 };
}

function translatedConnector(connector: BoardConnector, idMap: ReadonlyMap<string, string>, dx: number, dy: number, createId: () => string, copy: boolean): BoardConnector {
  return {
    ...connector,
    id: copy ? createId() : connector.id,
    from: idMap.get(connector.from)!,
    to: idMap.get(connector.to)!,
    controlPoints: connector.controlPoints?.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy })),
  };
}

/**
 * Move or clone spatial instances into another whiteboard. Card entities stay
 * shared; only their placements change boards. Internal connections, nested
 * Sections and attachments travel with the selection, while relations that
 * would point back into the source board are detached.
 */
export function transferBoardPlacements(
  source: Board,
  target: Board,
  placementIds: Iterable<string>,
  options: BoardTransferOptions = {},
): BoardTransferResult | null {
  if (source.id === target.id) return null;
  const selectedIds = new Set(placementIds);
  const selected = source.placements.filter((placement) => selectedIds.has(placement.id));
  if (!selected.length) return null;
  if (!options.copy && selected.some((placement) => target.placements.some((candidate) => candidate.id === placement.id))) return null;

  const bounds = placementBounds(selected)!;
  const destination = options.targetPosition ?? defaultTargetPosition(target);
  const dx = destination.x - bounds.x;
  const dy = destination.y - bounds.y;
  const createId = options.createId ?? (() => crypto.randomUUID());
  const copy = Boolean(options.copy);
  const idMap = new Map(selected.map((placement) => [placement.id, copy ? createId() : placement.id]));
  const selectedGroupIds = new Set(selected.map((placement) => placement.groupId).filter((value): value is string => Boolean(value)));
  const splitGroupIds = new Set([...selectedGroupIds].filter((groupId) => source.placements.some((placement) => placement.groupId === groupId && !selectedIds.has(placement.id))));
  const copiedGroupIds = new Map<string, string>();

  const destinationPlacements = selected.map((placement): BoardPlacement => {
    const sectionIds = placementSectionIds(placement).filter((sectionId) => selectedIds.has(sectionId)).map((sectionId) => idMap.get(sectionId)!);
    let groupId = splitGroupIds.has(placement.groupId ?? '') ? undefined : placement.groupId;
    if (copy && groupId) {
      if (!copiedGroupIds.has(groupId)) copiedGroupIds.set(groupId, createId());
      groupId = copiedGroupIds.get(groupId);
    }
    return {
      ...placement,
      id: idMap.get(placement.id)!,
      x: placement.x + dx,
      y: placement.y + dy,
      groupId,
      sectionId: sectionIds[0],
      sectionIds: sectionIds.length ? sectionIds : undefined,
      sectionBaseBounds: placement.sectionBaseBounds ? {
        ...placement.sectionBaseBounds,
        x: placement.sectionBaseBounds.x + dx,
        y: placement.sectionBaseBounds.y + dy,
      } : undefined,
    };
  });
  const internalConnectors = source.connectors
    .filter((connector) => selectedIds.has(connector.from) && selectedIds.has(connector.to))
    .map((connector) => translatedConnector(connector, idMap, dx, dy, createId, copy));
  const internalAttachments = source.attachments
    .filter((attachment) => selectedIds.has(attachment.objectId) && selectedIds.has(attachment.attachedObjectId))
    .map((attachment) => ({
      ...attachment,
      objectId: idMap.get(attachment.objectId)!,
      attachedObjectId: idMap.get(attachment.attachedObjectId)!,
    }));
  const now = options.now ?? new Date().toISOString();

  const nextSource = copy ? source : {
    ...source,
    placements: source.placements.filter((placement) => !selectedIds.has(placement.id)).map((placement) => {
      const sectionIds = placementSectionIds(placement).filter((sectionId) => !selectedIds.has(sectionId));
      return {
        ...placement,
        groupId: splitGroupIds.has(placement.groupId ?? '') ? undefined : placement.groupId,
        sectionId: sectionIds[0],
        sectionIds: sectionIds.length ? sectionIds : undefined,
      };
    }),
    connectors: source.connectors.filter((connector) => !selectedIds.has(connector.from) && !selectedIds.has(connector.to)),
    attachments: source.attachments.filter((attachment) => !selectedIds.has(attachment.objectId) && !selectedIds.has(attachment.attachedObjectId)),
    updatedAt: now,
  };
  const nextTarget = {
    ...target,
    placements: expandSectionsToMaintainPadding([...target.placements, ...destinationPlacements]),
    connectors: [...target.connectors, ...internalConnectors],
    attachments: [...target.attachments, ...internalAttachments],
    updatedAt: now,
  };
  return { source: nextSource, target: nextTarget, destinationPlacementIds: destinationPlacements.map((placement) => placement.id) };
}
