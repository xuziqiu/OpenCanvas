import type { Selection } from '../store/storeTypes';
import type { Board } from '../types';

/**
 * Keeps an interaction selection usable after board history changes while
 * removing references to objects that no longer exist in the restored state.
 */
export function reconcileSelectionForBoard(selection: Selection, board: Board): Selection {
  if (!selection) return null;
  if (selection.kind === 'connector') {
    return board.connectors.some((connector) => connector.id === selection.id) ? selection : null;
  }

  const requestedIds = selection.ids?.length ? selection.ids : [selection.id];
  const placementIds = new Set(board.placements.map((placement) => placement.id));
  const survivingIds = [...new Set(requestedIds)].filter((id) => placementIds.has(id));
  if (!survivingIds.length) return null;
  const primaryId = survivingIds.includes(selection.id) ? selection.id : survivingIds[0];
  return selection.ids
    ? { kind: 'placement', id: primaryId, ids: survivingIds }
    : { kind: 'placement', id: primaryId };
}

export function remapPlacementSelection(selection: Selection, replacementMap: Record<string, string> | undefined): Selection {
  if (!selection || selection.kind !== 'placement' || !replacementMap || !Object.keys(replacementMap).length) return selection;
  const remap = (id: string) => replacementMap[id] ?? id;
  return {
    kind: 'placement',
    id: remap(selection.id),
    ids: selection.ids?.map(remap),
  };
}
