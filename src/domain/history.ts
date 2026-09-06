import type { Board, BoardConnector, BoardPlacement, Card, DesktopBoardPlacement } from '../types';

interface IndexedChange<T> {
  id: string;
  before?: T;
  after?: T;
  beforeIndex: number;
  afterIndex: number;
}

interface BoardScalarState {
  version: Board['version'];
  fileName: string;
  title: string;
  projectId?: string;
  viewport: Board['viewport'];
  createdAt: string;
  updatedAt: string;
}

export interface BoardHistoryEntry {
  label: string;
  boardId: string;
  scalarBefore: BoardScalarState;
  scalarAfter: BoardScalarState;
  placementChanges: IndexedChange<BoardPlacement>[];
  connectorChanges: IndexedChange<BoardConnector>[];
  attachmentsBefore?: Board['attachments'];
  attachmentsAfter?: Board['attachments'];
  /** Entities born with this spatial command and removed/restored by undo/redo. */
  createdCards?: Card[];
  /** Boards born with this spatial command and removed/restored by undo/redo. */
  createdBoards?: Board[];
  createdDesktopPlacements?: DesktopBoardPlacement[];
  /** Non-active board entities changed by a command on this board. */
  relatedBoardChanges?: Array<{ before: Board; after: Board }>;
  /** Old placement id to replacement placement id for type-conversion commands. */
  placementReplacementMap?: Record<string, string>;
}

export interface BoardHistoryCandidate {
  label: string;
  boardId: string;
  before: Board;
  after: Board;
  createdCards?: Card[];
  createdBoards?: Board[];
  createdDesktopPlacements?: DesktopBoardPlacement[];
  relatedBoardChanges?: Array<{ before: Board; after: Board }>;
  placementReplacementMap?: Record<string, string>;
}

export interface BoardHistory {
  past: BoardHistoryEntry[];
  future: BoardHistoryEntry[];
}

export const emptyHistory = (): BoardHistory => ({ past: [], future: [] });

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function scalarState(board: Board): BoardScalarState {
  return {
    version: board.version,
    fileName: board.fileName,
    title: board.title,
    projectId: board.projectId,
    viewport: board.viewport,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
  };
}

function diffIndexed<T extends { id: string }>(before: T[], after: T[]): IndexedChange<T>[] {
  const beforeMap = new Map(before.map((item, index) => [item.id, { item, index }]));
  const afterMap = new Map(after.map((item, index) => [item.id, { item, index }]));
  const changes: IndexedChange<T>[] = [];
  for (const id of new Set([...beforeMap.keys(), ...afterMap.keys()])) {
    const previous = beforeMap.get(id);
    const next = afterMap.get(id);
    if (previous && next && previous.index === next.index && same(previous.item, next.item)) continue;
    changes.push({ id, before: previous?.item, after: next?.item, beforeIndex: previous?.index ?? -1, afterIndex: next?.index ?? -1 });
  }
  return changes;
}

function createEntry(candidate: BoardHistoryCandidate): BoardHistoryEntry | null {
  const scalarBefore = scalarState(candidate.before);
  const scalarAfter = scalarState(candidate.after);
  const placementChanges = diffIndexed(candidate.before.placements, candidate.after.placements);
  const connectorChanges = diffIndexed(candidate.before.connectors, candidate.after.connectors);
  const attachmentsChanged = !same(candidate.before.attachments, candidate.after.attachments);
  const relatedBoardChanges = candidate.relatedBoardChanges?.filter((change) => !same(change.before, change.after));
  if (!placementChanges.length && !connectorChanges.length && !attachmentsChanged && same(scalarBefore, scalarAfter) && !relatedBoardChanges?.length) return null;
  return {
    label: candidate.label,
    boardId: candidate.boardId,
    scalarBefore,
    scalarAfter,
    placementChanges,
    connectorChanges,
    attachmentsBefore: attachmentsChanged ? candidate.before.attachments : undefined,
    attachmentsAfter: attachmentsChanged ? candidate.after.attachments : undefined,
    createdCards: candidate.createdCards?.length ? candidate.createdCards : undefined,
    createdBoards: candidate.createdBoards?.length ? candidate.createdBoards : undefined,
    createdDesktopPlacements: candidate.createdDesktopPlacements?.length ? candidate.createdDesktopPlacements : undefined,
    relatedBoardChanges: relatedBoardChanges?.length ? relatedBoardChanges : undefined,
    placementReplacementMap: candidate.placementReplacementMap && Object.keys(candidate.placementReplacementMap).length
      ? candidate.placementReplacementMap
      : undefined,
  };
}

function applyIndexed<T extends { id: string }>(current: T[], changes: IndexedChange<T>[], direction: 'before' | 'after'): T[] {
  if (!changes.length) return current;
  const changedIds = new Set(changes.map((change) => change.id));
  const unchanged = current.filter((item) => !changedIds.has(item.id));
  const desired = changes
    .map((change) => ({ item: change[direction], index: change[`${direction}Index`] }))
    .filter((value): value is { item: T; index: number } => Boolean(value.item) && value.index >= 0)
    .sort((left, right) => left.index - right.index);
  const result = [...unchanged];
  for (const value of desired) result.splice(Math.min(value.index, result.length), 0, value.item);
  return result;
}

function applyEntry(current: Board, entry: BoardHistoryEntry, direction: 'before' | 'after'): Board {
  const scalar = direction === 'before' ? entry.scalarBefore : entry.scalarAfter;
  return {
    ...current,
    ...scalar,
    placements: applyIndexed(current.placements, entry.placementChanges, direction),
    connectors: applyIndexed(current.connectors, entry.connectorChanges, direction),
    attachments: (direction === 'before' ? entry.attachmentsBefore : entry.attachmentsAfter) ?? current.attachments,
  };
}

export function recordHistory(history: BoardHistory, candidate: BoardHistoryCandidate, limit = 100): BoardHistory {
  const entry = createEntry(candidate);
  if (!entry) return history;
  return {
    past: [...history.past, entry].slice(-limit),
    // A new action invalidates redo only for its own board. Other boards are
    // independent work surfaces and keep their redo chains.
    future: history.future.filter((item) => item.boardId !== candidate.boardId),
  };
}

export function undoHistory(history: BoardHistory, current: Board) {
  let index = -1;
  for (let itemIndex = history.past.length - 1; itemIndex >= 0; itemIndex -= 1) {
    if (history.past[itemIndex].boardId === current.id) { index = itemIndex; break; }
  }
  if (index < 0) return null;
  const entry = history.past[index];
  return {
    board: applyEntry(current, entry, 'before'),
    entry,
    history: { past: history.past.filter((_, itemIndex) => itemIndex !== index), future: [entry, ...history.future] },
  };
}

export function redoHistory(history: BoardHistory, current: Board) {
  const index = history.future.findIndex((entry) => entry.boardId === current.id);
  if (index < 0) return null;
  const entry = history.future[index];
  return {
    board: applyEntry(current, entry, 'after'),
    entry,
    history: { past: [...history.past, entry], future: history.future.filter((_, itemIndex) => itemIndex !== index) },
  };
}
