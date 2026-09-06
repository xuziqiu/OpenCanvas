import { describe, expect, it } from 'vitest';
import type { Board } from '../types';
import { emptyHistory, recordHistory, redoHistory, undoHistory } from './history';

const board = (x: number, id = 'b'): Board => ({
  version: 4, id, fileName: `${id}.board.json`, title: id.toUpperCase(),
  placements: [{ id: 'p', kind: 'text', text: 'x', x, y: 0, width: 100, height: 60, color: 'transparent' }],
  connectors: [], attachments: [], viewport: { x: 0, y: 0, zoom: 1 }, createdAt: 'a', updatedAt: String(x),
});

describe('board command history', () => {
  it('treats a gesture as one reversible entry', () => {
    const history = recordHistory(emptyHistory(), { label: '移动对象', boardId: 'b', before: board(0), after: board(96) });
    expect(history.past).toHaveLength(1);
    const undone = undoHistory(history, board(96))!;
    expect(undone.board.placements[0].x).toBe(0);
    const redone = redoHistory(undone.history, undone.board)!;
    expect(redone.board.placements[0].x).toBe(96);
  });

  it('stores a small delta instead of duplicating a large board', () => {
    const before = board(0);
    before.placements = Array.from({ length: 5000 }, (_, index) => ({ id: `p-${index}`, kind: 'text', text: String(index), x: index * 10, y: 0, width: 100, height: 60, color: 'transparent' }));
    const after = { ...before, placements: before.placements.map((placement, index) => index === 2500 ? { ...placement, x: placement.x + 96 } : placement), updatedAt: 'changed' };
    const history = recordHistory(emptyHistory(), { label: '移动对象', boardId: 'b', before, after });
    expect(history.past[0].placementChanges).toHaveLength(1);
    expect(JSON.stringify(history.past[0]).length).toBeLessThan(JSON.stringify(before).length / 100);
    const undone = undoHistory(history, after)!;
    expect(undone.board.placements[2500].x).toBe(before.placements[2500].x);
  });

  it('preserves ordering across insertions and deletions', () => {
    const before = board(0);
    before.placements.push({ id: 'q', kind: 'text', text: 'q', x: 1, y: 0, width: 100, height: 60, color: 'transparent' });
    const after = { ...before, placements: [{ id: 'n', kind: 'text' as const, text: 'n', x: 2, y: 0, width: 100, height: 60, color: 'transparent' }, before.placements[1]] };
    const history = recordHistory(emptyHistory(), { label: '替换对象', boardId: 'b', before, after });
    expect(undoHistory(history, after)!.board.placements.map((item) => item.id)).toEqual(['p', 'q']);
  });

  it('undoes and redoes each board independently when histories are interleaved', () => {
    let history = emptyHistory();
    history = recordHistory(history, { label: '移动 A', boardId: 'a', before: board(0, 'a'), after: board(10, 'a') });
    history = recordHistory(history, { label: '移动 B', boardId: 'b', before: board(0, 'b'), after: board(20, 'b') });

    const undoneA = undoHistory(history, board(10, 'a'))!;
    expect(undoneA.board.placements[0].x).toBe(0);
    expect(undoneA.history.past.map((entry) => entry.boardId)).toEqual(['b']);

    const undoneB = undoHistory(undoneA.history, board(20, 'b'))!;
    expect(undoneB.board.placements[0].x).toBe(0);
    const redoneA = redoHistory(undoneB.history, undoneA.board)!;
    expect(redoneA.board.placements[0].x).toBe(10);
    const redoneB = redoHistory(redoneA.history, undoneB.board)!;
    expect(redoneB.board.placements[0].x).toBe(20);
  });

  it('keeps another board redo chain when a new action is recorded', () => {
    let history = recordHistory(emptyHistory(), { label: '移动 A', boardId: 'a', before: board(0, 'a'), after: board(10, 'a') });
    history = recordHistory(history, { label: '移动 B', boardId: 'b', before: board(0, 'b'), after: board(20, 'b') });
    history = undoHistory(history, board(20, 'b'))!.history;
    history = recordHistory(history, { label: '再次移动 A', boardId: 'a', before: board(10, 'a'), after: board(30, 'a') });
    expect(history.future.map((entry) => entry.boardId)).toEqual(['b']);
  });
});
