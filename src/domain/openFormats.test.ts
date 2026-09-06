import { describe, expect, it } from 'vitest';
import { boardToObsidianCanvas, obsidianCanvasToBoard } from './openFormats';
import type { Board, Card } from '../types';

const card: Card = { id: 'card-a', fileName: 'A.md', relativePath: '资料/A.md', title: 'A', body: '正文', createdAt: 'now', updatedAt: 'now' };
const board: Board = { version: 4, id: 'board-a', fileName: 'A.board.json', title: 'A board', placements: [{ id: 'node-a', kind: 'card', entityId: card.id, x: 10, y: 20, width: 300, height: 180, color: '#fff' }, { id: 'text-a', kind: 'text', text: '注释', x: 400, y: 20, width: 180, height: 80, color: '#fff' }], connectors: [{ id: 'edge-a', from: 'node-a', to: 'text-a', arrow: 'both', label: '关系', fromAnchor: 'right', toAnchor: 'left' }], attachments: [], viewport: { x: 0, y: 0, zoom: 1 }, createdAt: 'now', updatedAt: 'now' };

describe('open canvas formats', () => {
  it('exports portable Obsidian Canvas file and preserves paths and arrows', () => {
    const result = boardToObsidianCanvas(board, [card], [board]);
    expect(result.nodes[0]).toMatchObject({ type: 'file', file: 'notes/资料/A.md' });
    expect(result.edges[0]).toMatchObject({ fromEnd: 'arrow', toEnd: 'arrow', label: '关系' });
  });

  it('imports existing file nodes without duplicating cards', () => {
    const ids = ['new-board'];
    const result = obsidianCanvasToBoard(boardToObsidianCanvas(board, [card], [board]), '导入', [card], [board], () => ids.shift() || 'fallback');
    expect(result.createdCards).toHaveLength(0);
    expect(result.board.placements[0]).toMatchObject({ kind: 'card', entityId: 'card-a' });
    expect(result.board.connectors[0].arrow).toBe('both');
  });

  it('creates a Markdown card record for an unknown file node', () => {
    const ids = ['new-card', 'new-board'];
    const result = obsidianCanvasToBoard({ nodes: [{ id: 'n', type: 'file', file: 'notes/新目录/新笔记.md', x: 0, y: 0, width: 200, height: 100 }], edges: [] }, '导入', [], [], () => ids.shift() || 'fallback');
    expect(result.createdCards[0]).toMatchObject({ id: 'new-card', relativePath: '新目录/新笔记.md', title: '新笔记' });
    expect(result.board.placements[0].entityId).toBe('new-card');
  });

  it('round-trips nested-board references when the target board exists', () => {
    const child: Board = { ...board, id: 'child-board', fileName: 'child.board.json', title: '子白板', placements: [], connectors: [] };
    const parent: Board = { ...board, id: 'parent-board', placements: [{ id: 'nested-node', kind: 'board', entityId: child.id, x: 10, y: 20, width: 430, height: 270, color: 'blue' }], connectors: [] };
    const document = boardToObsidianCanvas(parent, [], [parent, child]);
    expect(document.nodes[0]).toMatchObject({ type: 'link', url: 'opencanvas-board://child-board', label: '子白板' });
    const result = obsidianCanvasToBoard(document, '重新导入', [], [child], () => 'imported-parent');
    expect(result.board.placements[0]).toMatchObject({ kind: 'board', entityId: 'child-board' });
  });

  it('drops dangling edges but preserves anchors and arrow direction for valid ones', () => {
    const result = obsidianCanvasToBoard({
      nodes: [
        { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 80 },
        { id: 'b', type: 'text', text: 'B', x: 200, y: 0, width: 100, height: 80 },
      ],
      edges: [
        { id: 'valid', fromNode: 'a', toNode: 'b', fromSide: 'right', toSide: 'left', fromEnd: 'none', toEnd: 'arrow', label: '有效' },
        { id: 'dangling', fromNode: 'a', toNode: 'missing', toEnd: 'arrow' },
      ],
    }, '连线导入', [], [], () => 'board-id');
    expect(result.board.connectors).toHaveLength(1);
    expect(result.board.connectors[0]).toMatchObject({ id: 'valid', fromAnchor: 'right', toAnchor: 'left', arrow: 'end', label: '有效' });
  });

  it('preserves Obsidian Canvas groups as named OpenCanvas frames', () => {
    const framed: Board = { ...board, placements: [{ id: 'frame', kind: 'text', text: '研究区', isFrame: true, x: 0, y: 0, width: 600, height: 400, color: 'transparent' }], connectors: [] };
    const document = boardToObsidianCanvas(framed, [], [framed]);
    expect(document.nodes[0]).toMatchObject({ type: 'group', label: '研究区' });
    const result = obsidianCanvasToBoard(document, '导入框架', [], [], () => 'board-id');
    expect(result.board.placements[0]).toMatchObject({ kind: 'text', text: '研究区', isFrame: true });
  });

  it('rebuilds overlapping and nested multi-Section relations from Canvas group geometry', () => {
    const result = obsidianCanvasToBoard({
      nodes: [
        { id: 'outer', type: 'group', label: '外层', x: 0, y: 0, width: 700, height: 500 },
        { id: 'inner', type: 'group', label: '内层', x: 80, y: 80, width: 520, height: 300 },
        { id: 'overlap', type: 'group', label: '交叠', x: 450, y: 120, width: 360, height: 300 },
        { id: 'card', type: 'file', file: 'notes/共享.md', x: 470, y: 180, width: 100, height: 90 },
      ],
      edges: [],
    }, '多区块', [], [], () => 'generated');

    const byId = new Map(result.board.placements.map((placement) => [placement.id, placement]));
    expect(byId.get('inner')).toMatchObject({ sectionId: 'outer', sectionIds: ['outer'] });
    expect(byId.get('overlap')?.sectionIds).toBeUndefined();
    expect(byId.get('card')).toMatchObject({ sectionId: 'outer', sectionIds: ['outer', 'inner', 'overlap'] });
  });
});
