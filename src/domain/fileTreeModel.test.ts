import { describe, expect, it } from 'vitest';
import type { Card } from '../types';
import { buildVisibleFileTreeRows } from './fileTreeModel';

const card = (id: string, relativePath: string, title = id): Card => ({
  id,
  relativePath,
  fileName: relativePath.split('/').at(-1) ?? `${id}.md`,
  title,
  body: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('visible file-tree model', () => {
  const folders = ['项目', '项目/资料', '项目/资料/摘录', '归档'];
  const cards = [card('root', '根笔记.md'), card('brief', '项目/说明.md'), card('quote', '项目/资料/摘录/引用.md')];

  it('flattens only expanded branches with stable hierarchy metadata', () => {
    const rows = buildVisibleFileTreeRows({ folders, cards, expandedFolders: new Set(['', '项目', '项目/资料']) });
    expect(rows.map((row) => row.key)).toEqual([
      'root',
      'folder:归档',
      'folder:项目',
      'folder:项目/资料',
      'folder:项目/资料/摘录',
      'card:brief',
      'card:root',
    ]);
    expect(rows.find((row) => row.key === 'folder:项目/资料')).toMatchObject({ depth: 1, parentKey: 'folder:项目', expanded: true });
    expect(rows.find((row) => row.key === 'card:brief')).toMatchObject({ depth: 1, parentKey: 'folder:项目' });
  });

  it('temporarily expands only ancestors of search matches', () => {
    const rows = buildVisibleFileTreeRows({
      folders,
      cards: [cards[2]],
      expandedFolders: new Set(),
      searchQuery: '引用',
    });
    expect(rows.map((row) => row.key)).toEqual([
      'root',
      'folder:项目',
      'folder:项目/资料',
      'folder:项目/资料/摘录',
      'card:quote',
    ]);
    expect(rows.filter((row) => row.kind === 'folder').every((row) => row.expanded)).toBe(true);
  });

  it('finds a folder by name even when no card matched', () => {
    const rows = buildVisibleFileTreeRows({ folders, cards: [], expandedFolders: new Set(), searchQuery: '资料' });
    expect(rows.map((row) => row.key)).toEqual(['root', 'folder:项目', 'folder:项目/资料']);
  });

  it('inserts an inline creation row immediately inside its parent', () => {
    const rows = buildVisibleFileTreeRows({ folders, cards, expandedFolders: new Set(['', '项目']), newItem: { kind: 'card', parentPath: '项目' } });
    const parentIndex = rows.findIndex((row) => row.key === 'folder:项目');
    expect(rows[parentIndex + 1]).toMatchObject({ kind: 'new', parentPath: '项目', depth: 1 });
  });

  it('materializes missing directory ancestors from Markdown paths', () => {
    const rows = buildVisibleFileTreeRows({
      folders: [],
      cards: [card('deep', '项目/资料/深层笔记.md')],
      expandedFolders: new Set(['', '项目', '项目/资料']),
    });
    expect(rows.map((row) => row.key)).toEqual(['root', 'folder:项目', 'folder:项目/资料', 'card:deep']);
    expect(rows.at(-1)).toMatchObject({ depth: 2, parentKey: 'folder:项目/资料' });
  });

  it('builds a 5000-file expanded tree without recursive duplicate rows', () => {
    const largeCards = Array.from({ length: 5000 }, (_, index) => card(`card-${index}`, `批量/card-${index}.md`));
    const rows = buildVisibleFileTreeRows({ folders: ['批量'], cards: largeCards, expandedFolders: new Set(['', '批量']) });
    expect(rows).toHaveLength(5002);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it('collapses the Notes root without losing its child count metadata', () => {
    const rows = buildVisibleFileTreeRows({ folders, cards, expandedFolders: new Set() });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'root', expanded: false, hasChildren: true });
  });
});
