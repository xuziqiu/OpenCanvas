import { describe, expect, it } from 'vitest';
import { boardBackTransition, boardHistoryAfterDeletion, boardNavigationTransition, sanitizeBoardHistory } from './navigationSlice';

describe('board navigation transitions', () => {
  it('opens a root board with a fresh path', () => {
    expect(boardNavigationTransition('old', ['root'], 'new', false)).toMatchObject({
      workspaceView: 'board', activeBoardId: 'new', boardHistory: [], selection: null, tool: 'select',
    });
  });

  it('records the current board when entering a nested board', () => {
    expect(boardNavigationTransition('parent', ['root'], 'child', true)).toMatchObject({
      activeBoardId: 'child', boardHistory: ['root', 'parent'],
    });
  });

  it('does not add a phantom history entry when no board is active', () => {
    expect(boardNavigationTransition(null, [], 'first', true).boardHistory).toEqual([]);
  });

  it('supports five nested levels and resets the path when opening another root', () => {
    let active: string | null = 'root';
    let history: string[] = [];
    for (const child of ['two', 'three', 'four', 'five']) {
      const next = boardNavigationTransition(active, history, child, true);
      active = next.activeBoardId;
      history = next.boardHistory;
    }
    expect(history).toEqual(['root', 'two', 'three', 'four']);
    expect(boardNavigationTransition(active, history, 'other-root', false).boardHistory).toEqual([]);
  });

  it('returns through the exact occurrence path and then reaches the desktop', () => {
    expect(boardBackTransition('shared-child', ['root-b', 'middle'])).toEqual({
      workspaceView: 'board', activeBoardId: 'middle', boardHistory: ['root-b'],
    });
    expect(boardBackTransition('root-b', [])).toEqual({
      workspaceView: 'desktop', activeBoardId: 'root-b', boardHistory: [],
    });
  });

  it('keeps separate occurrence paths when one whiteboard is referenced by multiple parents', () => {
    const throughA = boardNavigationTransition('parent-a', ['root-a'], 'shared-child', true);
    const throughB = boardNavigationTransition('parent-b', ['root-b'], 'shared-child', true);
    expect(throughA.boardHistory).toEqual(['root-a', 'parent-a']);
    expect(throughB.boardHistory).toEqual(['root-b', 'parent-b']);
    expect(boardBackTransition(throughA.activeBoardId, throughA.boardHistory).activeBoardId).toBe('parent-a');
    expect(boardBackTransition(throughB.activeBoardId, throughB.boardHistory).activeBoardId).toBe('parent-b');
  });

  it('keeps the surviving occurrence suffix when an ancestor board is deleted', () => {
    const valid = ['middle', 'parent', 'child'];
    expect(boardHistoryAfterDeletion(['root', 'middle', 'parent'], 'root', valid)).toEqual(['middle', 'parent']);
    expect(boardHistoryAfterDeletion(['root', 'middle', 'parent'], 'middle', ['root', 'parent', 'child'])).toEqual(['parent']);
    expect(boardHistoryAfterDeletion(['root', 'middle', 'parent'], 'parent', ['root', 'middle', 'child'])).toEqual([]);
  });

  it('drops stale and cyclic ids before opening or returning through a persisted path', () => {
    expect(sanitizeBoardHistory(['root', 'missing', 'middle', 'root', 'child'], 'child', ['root', 'middle', 'child'])).toEqual(['root', 'middle']);
  });
});
