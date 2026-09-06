import { describe, expect, it } from 'vitest';
import type { Board } from '../types';
import { reconcileSelectionForBoard, remapPlacementSelection } from './selectionReconciliation';

const board = (placementIds: string[], connectorIds: string[] = []): Board => ({
  version: 4,
  id: 'board',
  fileName: 'board.board.json',
  title: 'Selection history',
  placements: placementIds.map((id, index) => ({ id, kind: 'text', text: id, x: index * 120, y: 0, width: 100, height: 80, color: 'transparent' })),
  connectors: connectorIds.map((id) => ({ id, from: placementIds[0], to: placementIds[1] })),
  attachments: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('selection reconciliation after board history', () => {
  it('preserves an unchanged multi-selection for continuous layout work', () => {
    const selection = { kind: 'placement' as const, id: 'b', ids: ['a', 'b', 'c'] };
    expect(reconcileSelectionForBoard(selection, board(['a', 'b', 'c']))).toEqual(selection);
  });

  it('filters removed placements and chooses a surviving primary placement', () => {
    expect(reconcileSelectionForBoard(
      { kind: 'placement', id: 'b', ids: ['a', 'b', 'c', 'a'] },
      board(['a', 'c']),
    )).toEqual({ kind: 'placement', id: 'a', ids: ['a', 'c'] });
  });

  it('clears a selection when undo removes its newly created object', () => {
    expect(reconcileSelectionForBoard({ kind: 'placement', id: 'section', ids: ['section'] }, board(['card']))).toBeNull();
  });

  it('preserves or clears a connector selection according to the restored board', () => {
    expect(reconcileSelectionForBoard({ kind: 'connector', id: 'line' }, board(['a', 'b'], ['line']))).toEqual({ kind: 'connector', id: 'line' });
    expect(reconcileSelectionForBoard({ kind: 'connector', id: 'line' }, board(['a', 'b']))).toBeNull();
  });
});

describe('placement selection remapping', () => {
  it('preserves mixed multi-selection order while replacing converted placement ids', () => {
    expect(remapPlacementSelection(
      { kind: 'placement', id: 'text-a', ids: ['card', 'text-a', 'text-b', 'section'] },
      { 'text-a': 'card-a', 'text-b': 'card-b' },
    )).toEqual({ kind: 'placement', id: 'card-a', ids: ['card', 'card-a', 'card-b', 'section'] });
  });

  it('does not alter connector selection', () => {
    const selection = { kind: 'connector' as const, id: 'line' };
    expect(remapPlacementSelection(selection, { line: 'something-else' })).toBe(selection);
  });
});
