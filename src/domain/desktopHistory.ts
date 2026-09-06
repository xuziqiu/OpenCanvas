import type { DesktopBoardPlacement } from '../types';

interface DesktopPlacementChange {
  boardId: string;
  before: DesktopBoardPlacement;
  after: DesktopBoardPlacement;
}

export interface DesktopHistoryEntry {
  label: string;
  changes: DesktopPlacementChange[];
}

export interface DesktopHistory {
  past: DesktopHistoryEntry[];
  future: DesktopHistoryEntry[];
}

export const emptyDesktopHistory = (): DesktopHistory => ({ past: [], future: [] });

const same = (left: DesktopBoardPlacement, right: DesktopBoardPlacement) => (
  left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
);

function createEntry(label: string, before: DesktopBoardPlacement[], after: DesktopBoardPlacement[]): DesktopHistoryEntry | null {
  const afterMap = new Map(after.map((placement) => [placement.boardId, placement]));
  const changes = before.flatMap((previous) => {
    const next = afterMap.get(previous.boardId);
    return next && !same(previous, next) ? [{ boardId: previous.boardId, before: { ...previous }, after: { ...next } }] : [];
  });
  return changes.length ? { label, changes } : null;
}

function applyEntry(current: DesktopBoardPlacement[], entry: DesktopHistoryEntry, direction: 'before' | 'after') {
  const replacements = new Map(entry.changes.map((change) => [change.boardId, change[direction]]));
  return current.map((placement) => replacements.get(placement.boardId) ?? placement);
}

export function recordDesktopHistory(history: DesktopHistory, label: string, before: DesktopBoardPlacement[], after: DesktopBoardPlacement[], limit = 60): DesktopHistory {
  const entry = createEntry(label, before, after);
  if (!entry) return history;
  return { past: [...history.past, entry].slice(-limit), future: [] };
}

export function undoDesktopHistory(history: DesktopHistory, current: DesktopBoardPlacement[]) {
  const entry = history.past.at(-1);
  if (!entry) return null;
  return {
    placements: applyEntry(current, entry, 'before'),
    history: { past: history.past.slice(0, -1), future: [entry, ...history.future] },
  };
}

export function redoDesktopHistory(history: DesktopHistory, current: DesktopBoardPlacement[]) {
  const entry = history.future[0];
  if (!entry) return null;
  return {
    placements: applyEntry(current, entry, 'after'),
    history: { past: [...history.past, entry], future: history.future.slice(1) },
  };
}
