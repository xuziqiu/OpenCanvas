import type { Board, BoardConnector, BoardPlacement, Card } from '../types';
import { reconcileSectionMembershipChanges } from './sectionLayout';

interface ObsidianCanvasNode {
  id: string;
  type: 'file' | 'text' | 'link' | 'group';
  x: number;
  y: number;
  width: number;
  height: number;
  file?: string;
  text?: string;
  url?: string;
  label?: string;
  color?: string;
}

interface ObsidianCanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: 'top' | 'right' | 'bottom' | 'left';
  toSide?: 'top' | 'right' | 'bottom' | 'left';
  fromEnd?: 'none' | 'arrow';
  toEnd?: 'none' | 'arrow';
  label?: string;
  color?: string;
}

export interface ObsidianCanvasDocument {
  nodes: ObsidianCanvasNode[];
  edges: ObsidianCanvasEdge[];
}

const normalizePath = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^notes\//i, '');

export function boardToObsidianCanvas(board: Board, cards: Card[], boards: Board[]): ObsidianCanvasDocument {
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const boardById = new Map(boards.map((item) => [item.id, item]));
  const nodes: ObsidianCanvasNode[] = board.placements.map((placement) => {
    const base = { id: placement.id, x: placement.x, y: placement.y, width: placement.width, height: placement.height, color: placement.color || undefined };
    if (placement.isFrame) return { ...base, type: 'group', label: placement.text || '框架' };
    if (placement.kind === 'card') {
      const card = placement.entityId ? cardById.get(placement.entityId) : undefined;
      return card ? { ...base, type: 'file', file: `notes/${card.relativePath}` } : { ...base, type: 'text', text: '缺失的卡片引用' };
    }
    if (placement.kind === 'board') {
      const nested = placement.entityId ? boardById.get(placement.entityId) : undefined;
      return { ...base, type: 'link', url: `opencanvas-board://${placement.entityId || ''}`, label: nested?.title || '嵌套白板' };
    }
    return { ...base, type: 'text', text: placement.text || '' };
  });
  const edges: ObsidianCanvasEdge[] = board.connectors.map((connector) => ({
    id: connector.id,
    fromNode: connector.from,
    toNode: connector.to,
    fromSide: connector.fromAnchor,
    toSide: connector.toAnchor,
    fromEnd: connector.arrow === 'start' || connector.arrow === 'both' ? 'arrow' : 'none',
    toEnd: connector.arrow === 'end' || connector.arrow === 'both' ? 'arrow' : 'none',
    label: connector.label || undefined,
    color: connector.color || undefined,
  }));
  return { nodes, edges };
}

export function obsidianCanvasToBoard(
  input: ObsidianCanvasDocument,
  title: string,
  existingCards: Card[],
  existingBoards: Board[],
  makeId: () => string = () => crypto.randomUUID(),
): { board: Board; createdCards: Card[] } {
  const now = new Date().toISOString();
  const cardsByPath = new Map(existingCards.map((card) => [normalizePath(card.relativePath).toLocaleLowerCase(), card]));
  const boardsById = new Map(existingBoards.map((board) => [board.id, board]));
  const createdCards: Card[] = [];
  const placements: BoardPlacement[] = [];
  const retainedNodeIds = new Set<string>();

  for (const node of input.nodes || []) {
    const base = { id: String(node.id || makeId()), x: Number(node.x) || 0, y: Number(node.y) || 0, width: Math.max(80, Number(node.width) || 320), height: Math.max(48, Number(node.height) || 220), color: node.color || '#ffffff' };
    if (node.type === 'file' && node.file) {
      const relativePath = normalizePath(node.file);
      let card = cardsByPath.get(relativePath.toLocaleLowerCase());
      if (!card) {
        const cardId = makeId();
        const fileName = relativePath.split('/').pop() || `card--${cardId.slice(0, 8)}.md`;
        card = { id: cardId, fileName, relativePath, title: fileName.replace(/\.md$/i, ''), body: '', createdAt: now, updatedAt: now };
        cardsByPath.set(relativePath.toLocaleLowerCase(), card);
        createdCards.push(card);
      }
      placements.push({ ...base, kind: 'card', entityId: card.id });
      retainedNodeIds.add(base.id);
      continue;
    }
    if (node.type === 'link' && node.url?.startsWith('opencanvas-board://')) {
      const boardId = node.url.slice('opencanvas-board://'.length);
      if (boardsById.has(boardId)) {
        placements.push({ ...base, kind: 'board', entityId: boardId });
        retainedNodeIds.add(base.id);
        continue;
      }
    }
    if (node.type === 'text' || node.type === 'group' || node.type === 'link') {
      placements.push({ ...base, kind: 'text', text: node.text || node.label || node.url || '', isFrame: node.type === 'group' || undefined });
      retainedNodeIds.add(base.id);
    }
  }

  const connectors: BoardConnector[] = (input.edges || []).filter((edge) => retainedNodeIds.has(edge.fromNode) && retainedNodeIds.has(edge.toNode)).map((edge) => ({
    id: String(edge.id || makeId()),
    from: edge.fromNode,
    to: edge.toNode,
    label: edge.label,
    color: edge.color,
    lineStyle: 'curve',
    arrow: edge.fromEnd === 'arrow' && edge.toEnd === 'arrow' ? 'both' : edge.fromEnd === 'arrow' ? 'start' : edge.toEnd === 'arrow' ? 'end' : 'none',
    fromAnchor: edge.fromSide,
    toAnchor: edge.toSide,
  }));
  const sectionChanges = reconcileSectionMembershipChanges(placements, placements.map((placement) => placement.id));
  const relatedPlacements = placements.map((placement) => sectionChanges[placement.id]
    ? { ...placement, ...sectionChanges[placement.id] }
    : placement);
  const boardId = makeId();
  return {
    board: { version: 4, id: boardId, fileName: `${title || '导入白板'}--${boardId.slice(0, 8)}.board.json`, title: title || '导入白板', placements: relatedPlacements, connectors, attachments: [], viewport: { x: 120, y: 90, zoom: 0.8 }, createdAt: now, updatedAt: now },
    createdCards,
  };
}

export function isObsidianCanvasDocument(value: unknown): value is ObsidianCanvasDocument {
  if (!value || typeof value !== 'object') return false;
  const data = value as { nodes?: unknown; edges?: unknown };
  return Array.isArray(data.nodes) && Array.isArray(data.edges);
}
