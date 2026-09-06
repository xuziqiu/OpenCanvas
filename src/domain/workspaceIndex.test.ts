import { describe, expect, it } from 'vitest';
import { boardReferenceImpact, buildWorkspaceIndex, findRootBoards, IncrementalWorkspaceIndex, wouldCreateBoardCycle } from './workspaceIndex';
import type { Board, Card } from '../types';

describe('workspace index', () => {
  it('indexes stable references, tags, and multiple placements of one card', () => {
    const cards: Card[] = [
      { id: 'a', fileName: 'a.md', relativePath: 'a.md', title: 'A', body: '#topic [B](opencanvas://card/b)', createdAt: '', updatedAt: '' },
      { id: 'b', fileName: 'b.md', relativePath: 'b.md', title: 'B', body: '', createdAt: '', updatedAt: '' },
    ];
    const boards: Board[] = [{ version: 4, id: 'board', fileName: 'b.board.json', title: 'B', placements: [
      { id: 'p1', kind: 'card', entityId: 'b', x: 0, y: 0, width: 1, height: 1, color: 'paper' },
      { id: 'p2', kind: 'card', entityId: 'b', x: 2, y: 2, width: 1, height: 1, color: 'paper' },
    ], connectors: [], attachments: [], viewport: { x: 0, y: 0, zoom: 1 }, createdAt: '', updatedAt: '' }];
    const index = buildWorkspaceIndex(cards, boards);
    expect(index.tags.get('topic')).toEqual(['a']);
    expect(index.backlinks.get('b')).toEqual(['a']);
    expect(index.outlinks.get('a')).toEqual(['b']);
    expect(index.placementsByCard.get('b')).toHaveLength(2);
  });

  it('places only non-nested boards on the desktop', () => {
    const board = (id: string, nested?: string): Board => ({ version: 4, id, fileName: `${id}.board.json`, title: id, placements: nested ? [
      { id: `placement-${nested}`, kind: 'board', entityId: nested, x: 0, y: 0, width: 1, height: 1, color: 'paper' },
    ] : [], connectors: [], attachments: [], viewport: { x: 0, y: 0, zoom: 1 }, createdAt: '', updatedAt: '' });
    expect(findRootBoards([board('root', 'nested'), board('nested'), board('other')]).map((item) => item.id)).toEqual(['root', 'other']);
    expect(wouldCreateBoardCycle([board('root', 'nested'), board('nested')], 'nested', 'root')).toBe(true);
    expect(wouldCreateBoardCycle([board('root', 'nested'), board('nested'), board('other')], 'other', 'nested')).toBe(false);
  });

  it('keeps one desktop entry for every otherwise unreachable nesting cycle', () => {
    const board = (id: string, nested?: string): Board => ({ version: 4, id, fileName: `${id}.board.json`, title: id, placements: nested ? [
      { id: `placement-${id}-${nested}`, kind: 'board', entityId: nested, x: 0, y: 0, width: 1, height: 1, color: 'paper' },
    ] : [], connectors: [], attachments: [], viewport: { x: 0, y: 0, zoom: 1 }, createdAt: '', updatedAt: '' });
    expect(findRootBoards([board('a', 'b'), board('b', 'a'), board('root', 'child'), board('child')]).map((item) => item.id)).toEqual(['root', 'a']);
  });

  it('handles a deeply nested imported graph without recursive stack growth', () => {
    const boards: Board[] = Array.from({ length: 10_000 }, (_, index) => ({
      version: 4,
      id: `deep-${index}`,
      fileName: `deep-${index}.board.json`,
      title: `Deep ${index}`,
      placements: index === 9_999 ? [] : [{
        id: `deep-placement-${index}`,
        kind: 'board',
        entityId: `deep-${index + 1}`,
        x: 0,
        y: 0,
        width: 430,
        height: 270,
        color: 'paper',
      }],
      connectors: [],
      attachments: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      createdAt: '',
      updatedAt: '',
    }));

    expect(findRootBoards(boards).map((board) => board.id)).toEqual(['deep-0']);
    expect(wouldCreateBoardCycle(boards, 'deep-0', 'deep-9999')).toBe(false);
    expect(wouldCreateBoardCycle(boards, 'deep-9999', 'deep-0')).toBe(true);
  });

  it('indexes portable wiki links and relative Markdown links as backlinks', () => {
    const cards: Card[] = [
      { id: 'a', fileName: 'a.md', relativePath: 'a.md', title: 'A', body: '[[B]] 与 [C](资料/c.md)', createdAt: '', updatedAt: '' },
      { id: 'b', fileName: 'b.md', relativePath: 'b.md', title: 'B', body: '', createdAt: '', updatedAt: '' },
      { id: 'c', fileName: 'c.md', relativePath: '资料/c.md', title: 'C', body: '', createdAt: '', updatedAt: '' },
    ];
    const index = buildWorkspaceIndex(cards, []);
    expect(index.backlinks.get('b')).toEqual(['a']);
    expect(index.backlinks.get('c')).toEqual(['a']);
    expect(index.outlinks.get('a')).toEqual(['b', 'c']);
  });

  it('reparses only the changed card and reuses unchanged board topology', () => {
    const cache = new IncrementalWorkspaceIndex();
    const cards: Card[] = [
      { id: 'a', fileName: 'a.md', relativePath: 'a.md', title: 'A', body: '#one [[B]]', createdAt: '', updatedAt: '' },
      { id: 'b', fileName: 'b.md', relativePath: 'b.md', title: 'B', body: '', createdAt: '', updatedAt: '' },
    ];
    const boards: Board[] = [{ version: 4, id: 'board', fileName: 'board.json', title: 'Board', placements: [
      { id: 'placement', kind: 'card', entityId: 'a', x: 0, y: 0, width: 1, height: 1, color: 'paper' },
    ], connectors: [], attachments: [], viewport: { x: 0, y: 0, zoom: 1 }, createdAt: '', updatedAt: '' }];
    const first = cache.update(cards, boards);
    expect(cache.stats()).toEqual({ parsedCards: 2, parseCount: 2, fullRebuildCount: 1, incrementalUpdateCount: 0 });
    expect(cache.update(cards, boards)).toBe(first);
    const changed = [{ ...cards[0], body: '#two [[B]]' }, cards[1]];
    const second = cache.update(changed, boards);
    expect(cache.stats()).toEqual({ parsedCards: 2, parseCount: 3, fullRebuildCount: 1, incrementalUpdateCount: 1 });
    expect(second).toBe(first);
    expect(second.placementsByCard).toBe(first.placementsByCard);
    expect(second.tags.get('one')).toBeUndefined();
    expect(second.tags.get('two')).toEqual(['a']);
    expect(second.backlinks.get('b')).toEqual(['a']);
  });

  it('updates one body contribution without rebuilding a large vault relation graph', () => {
    const cache = new IncrementalWorkspaceIndex();
    const cards: Card[] = Array.from({ length: 2_000 }, (_, index) => ({
      id: `card-${index}`,
      fileName: `card-${index}.md`,
      relativePath: `notes/card-${index}.md`,
      title: `Card ${index}`,
      body: index === 0 ? '#before [target](opencanvas://card/card-1)' : `body ${index}`,
      createdAt: '',
      updatedAt: '',
    }));
    const first = cache.update(cards, []);
    const changed = [{ ...cards[0], body: '#after [target](opencanvas://card/card-2)' }, ...cards.slice(1)];
    const second = cache.update(changed, []);
    expect(second).toBe(first);
    expect(cache.stats()).toEqual({ parsedCards: 2_000, parseCount: 2_001, fullRebuildCount: 1, incrementalUpdateCount: 1 });
    expect(second.tags.get('before')).toBeUndefined();
    expect(second.tags.get('after')).toEqual(['card-0']);
    expect(second.backlinks.get('card-1')).toBeUndefined();
    expect(second.backlinks.get('card-2')).toEqual(['card-0']);
  });

  it('rebuilds portable link resolution when a card title changes', () => {
    const cache = new IncrementalWorkspaceIndex();
    const cards: Card[] = [
      { id: 'source', fileName: 'source.md', relativePath: 'source.md', title: 'Source', body: '[[Target]]', createdAt: '', updatedAt: '' },
      { id: 'target', fileName: 'target.md', relativePath: 'target.md', title: 'Target', body: '', createdAt: '', updatedAt: '' },
    ];
    expect(cache.update(cards, []).backlinks.get('target')).toEqual(['source']);
    const renamed = [cards[0], { ...cards[1], title: 'Renamed' }];
    expect(cache.update(renamed, []).backlinks.get('target')).toBeUndefined();
    expect(cache.stats().fullRebuildCount).toBe(2);
  });

  it('reports parent references and contained child boards before entity deletion', () => {
    const makeBoard = (id: string, nested: string[] = []): Board => ({ version: 4, id, fileName: `${id}.board.json`, title: id, placements: nested.map((child) => ({ id: `${id}-${child}`, kind: 'board', entityId: child, x: 0, y: 0, width: 1, height: 1, color: 'paper' })), connectors: [], attachments: [], viewport: { x: 0, y: 0, zoom: 1 }, createdAt: '', updatedAt: '' });
    const boards = [makeBoard('parent-a', ['target']), makeBoard('parent-b', ['target']), makeBoard('target', ['child']), makeBoard('child')];
    expect(boardReferenceImpact(boards, 'target')).toEqual({
      parents: [
        { boardId: 'parent-a', boardTitle: 'parent-a', placementId: 'parent-a-target' },
        { boardId: 'parent-b', boardTitle: 'parent-b', placementId: 'parent-b-target' },
      ],
      children: [{ boardId: 'child', boardTitle: 'child' }],
    });
  });
});
