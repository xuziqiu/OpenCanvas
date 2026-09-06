import type { Board, Card } from '../types';

function resolvePortablePath(sourcePath: string, targetPath: string) {
  const target = targetPath.replace(/\\/g, '/').replace(/^\//, '');
  const base = targetPath.startsWith('/') ? [] : sourcePath.replace(/\\/g, '/').split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') base.pop(); else base.push(part);
  }
  return base.join('/').toLocaleLowerCase();
}

export interface WorkspaceIndex {
  tags: Map<string, string[]>;
  backlinks: Map<string, string[]>;
  outlinks: Map<string, string[]>;
  placementsByCard: Map<string, Array<{ boardId: string; placementId: string }>>;
}

interface ParsedCardIndex {
  title: string;
  relativePath: string;
  fileName: string;
  body: string;
  tags: string[];
  stableTargets: string[];
  portableTargets: Array<{ value: string; wiki: boolean }>;
}

function parseCardIndex(card: Card): ParsedCardIndex {
  return {
    title: card.title,
    relativePath: card.relativePath,
    fileName: card.fileName,
    body: card.body,
    tags: [...card.body.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)].map((match) => match[1].toLocaleLowerCase()),
    stableTargets: [...card.body.matchAll(/opencanvas:\/\/card\/([a-zA-Z0-9-]+)/g)].map((match) => match[1]),
    portableTargets: [
      ...[...card.body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].map((match) => ({ value: match[1], wiki: true })),
      ...[...card.body.matchAll(/\[[^\]]*\]\((?!opencanvas:)([^)]+\.md)(?:#[^)]+)?\)/gi)].map((match) => ({ value: decodeURIComponent(match[1]), wiki: false })),
    ],
  };
}

/**
 * Reuses parsed Markdown and placement topology across keystrokes. Editing one
 * long card must not repeatedly regex-scan the entire vault or a 5,000-node
 * board just to refresh its backlink panel.
 */
export class IncrementalWorkspaceIndex {
  private parsedCards = new Map<string, ParsedCardIndex>();
  private resolvedContributions = new Map<string, { tags: string[]; targets: string[] }>();
  private previousCards: Card[] | null = null;
  private previousBoards: Board[] | null = null;
  private cardOrder = new Map<string, number>();
  private cardIds = new Set<string>();
  private cardByTitle = new Map<string, string>();
  private cardByPath = new Map<string, string>();
  private placementIndex = new Map<string, Array<{ boardId: string; placementId: string }>>();
  private result: WorkspaceIndex = { tags: new Map(), backlinks: new Map(), outlinks: new Map(), placementsByCard: this.placementIndex };
  private parseCount = 0;
  private fullRebuildCount = 0;
  private incrementalUpdateCount = 0;

  private structureMatches(cards: Card[]) {
    return Boolean(this.previousCards
      && cards.length === this.previousCards.length
      && cards.every((card, index) => {
        const previous = this.previousCards![index];
        return card.id === previous.id
          && card.title === previous.title
          && card.relativePath === previous.relativePath
          && card.fileName === previous.fileName;
      }));
  }

  private parsedMatches(card: Card, parsed?: ParsedCardIndex) {
    return Boolean(parsed
      && parsed.title === card.title
      && parsed.relativePath === card.relativePath
      && parsed.fileName === card.fileName
      && parsed.body === card.body);
  }

  private insertByCardOrder(map: Map<string, string[]>, key: string, cardId: string) {
    const current = map.get(key);
    if (!current) { map.set(key, [cardId]); return; }
    if (current.includes(cardId)) return;
    const order = this.cardOrder.get(cardId) ?? Number.MAX_SAFE_INTEGER;
    const insertionIndex = current.findIndex((currentId) => (this.cardOrder.get(currentId) ?? Number.MAX_SAFE_INTEGER) > order);
    if (insertionIndex < 0) current.push(cardId); else current.splice(insertionIndex, 0, cardId);
  }

  private removeFromArrayMap(map: Map<string, string[]>, key: string, value: string) {
    const current = map.get(key);
    if (!current) return;
    const index = current.indexOf(value);
    if (index >= 0) current.splice(index, 1);
    if (!current.length) map.delete(key);
  }

  private resolveContribution(card: Card, parsed: ParsedCardIndex) {
    const targets: string[] = [];
    const addTarget = (targetId?: string, allowSelf = false) => {
      if (targetId && (allowSelf || targetId !== card.id) && !targets.includes(targetId)) targets.push(targetId);
    };
    for (const targetId of parsed.stableTargets) if (this.cardIds.has(targetId)) addTarget(targetId, true);
    for (const rawTarget of parsed.portableTargets) {
      const target = rawTarget.wiki ? rawTarget.value.trim().toLocaleLowerCase() : resolvePortablePath(card.relativePath, rawTarget.value.trim());
      addTarget(this.cardByPath.get(target) ?? this.cardByTitle.get(target.replace(/\.md$/i, '')));
    }
    return { tags: [...new Set(parsed.tags)], targets };
  }

  private removeContribution(cardId: string) {
    const contribution = this.resolvedContributions.get(cardId);
    if (!contribution) return;
    for (const tag of contribution.tags) this.removeFromArrayMap(this.result.tags, tag, cardId);
    for (const targetId of contribution.targets) this.removeFromArrayMap(this.result.backlinks, targetId, cardId);
    this.result.outlinks.delete(cardId);
    this.resolvedContributions.delete(cardId);
  }

  private addContribution(card: Card) {
    const parsed = this.parsedCards.get(card.id)!;
    const contribution = this.resolveContribution(card, parsed);
    this.resolvedContributions.set(card.id, contribution);
    for (const tag of contribution.tags) this.insertByCardOrder(this.result.tags, tag, card.id);
    if (contribution.targets.length) this.result.outlinks.set(card.id, [...contribution.targets]);
    for (const targetId of contribution.targets) this.insertByCardOrder(this.result.backlinks, targetId, card.id);
  }

  private rebuildCardRelations(cards: Card[]) {
    this.cardOrder = new Map(cards.map((card, index) => [card.id, index]));
    this.cardIds = new Set(cards.map((card) => card.id));
    this.cardByTitle = new Map(cards.map((card) => [card.title.trim().toLocaleLowerCase(), card.id]));
    this.cardByPath = new Map(cards.flatMap((card) => [[card.relativePath.toLocaleLowerCase(), card.id] as const, [card.fileName.toLocaleLowerCase(), card.id] as const]));
    this.resolvedContributions.clear();
    this.result = { tags: new Map(), backlinks: new Map(), outlinks: new Map(), placementsByCard: this.placementIndex };
    for (const card of cards) this.addContribution(card);
    this.fullRebuildCount += 1;
  }

  update(cards: Card[], boards: Board[]): WorkspaceIndex {
    if (cards === this.previousCards && boards === this.previousBoards) return this.result;
    const structureMatches = this.structureMatches(cards);
    const liveIds = new Set(cards.map((card) => card.id));
    for (const id of this.parsedCards.keys()) if (!liveIds.has(id)) this.parsedCards.delete(id);
    const changedCards: Card[] = [];
    for (const card of cards) {
      if (this.parsedMatches(card, this.parsedCards.get(card.id))) continue;
      this.parsedCards.set(card.id, parseCardIndex(card));
      this.parseCount += 1;
      changedCards.push(card);
    }

    if (boards !== this.previousBoards) {
      const placementsByCard = new Map<string, Array<{ boardId: string; placementId: string }>>();
      for (const board of boards) {
        for (const placement of board.placements) {
          if (placement.kind !== 'card' || !placement.entityId) continue;
          const current = placementsByCard.get(placement.entityId);
          const entry = { boardId: board.id, placementId: placement.id };
          if (current) current.push(entry); else placementsByCard.set(placement.entityId, [entry]);
        }
      }
      this.placementIndex = placementsByCard;
      this.result.placementsByCard = placementsByCard;
    }

    if (!structureMatches) {
      this.rebuildCardRelations(cards);
    } else if (changedCards.length) {
      for (const card of changedCards) this.removeContribution(card.id);
      for (const card of changedCards) this.addContribution(card);
      this.incrementalUpdateCount += 1;
    }

    this.previousCards = cards;
    this.previousBoards = boards;
    return this.result;
  }

  stats() {
    return {
      parsedCards: this.parsedCards.size,
      parseCount: this.parseCount,
      fullRebuildCount: this.fullRebuildCount,
      incrementalUpdateCount: this.incrementalUpdateCount,
    };
  }
}

const sharedWorkspaceIndex = new IncrementalWorkspaceIndex();

export function buildWorkspaceIndex(cards: Card[], boards: Board[]): WorkspaceIndex {
  return sharedWorkspaceIndex.update(cards, boards);
}

function visitBoardGraph(boardById: Map<string, Board>, starts: string[], visited: Set<string>, stopId?: string) {
  const pending = [...starts];
  while (pending.length) {
    const boardId = pending.pop()!;
    if (boardId === stopId) return true;
    if (visited.has(boardId)) continue;
    visited.add(boardId);
    const board = boardById.get(boardId);
    if (!board) continue;
    for (const placement of board.placements) {
      if (placement.kind === 'board' && placement.entityId && !visited.has(placement.entityId)) pending.push(placement.entityId);
    }
  }
  return false;
}

/** Root boards live on the desktop; nested placements are references, not folders. */
export function findRootBoards(boards: Board[]): Board[] {
  const boardById = new Map(boards.map((board) => [board.id, board]));
  const nestedIds = new Set(boards.flatMap((board) => board.placements
    .filter((placement) => placement.kind === 'board' && placement.entityId)
    .map((placement) => placement.entityId!)));
  const roots = boards.filter((board) => !nestedIds.has(board.id));
  const reachable = new Set<string>();
  visitBoardGraph(boardById, roots.map((board) => board.id), reachable);
  // Corrupt or imported cyclic graphs must still retain a desktop entry.
  for (const board of boards) if (!reachable.has(board.id)) { roots.push(board); visitBoardGraph(boardById, [board.id], reachable); }
  return roots;
}

export function wouldCreateBoardCycle(boards: Board[], parentBoardId: string, childBoardId: string) {
  if (parentBoardId === childBoardId) return true;
  const boardById = new Map(boards.map((board) => [board.id, board]));
  return visitBoardGraph(boardById, [childBoardId], new Set(), parentBoardId);
}

export function boardReferenceImpact(boards: Board[], boardId: string) {
  const target = boards.find((board) => board.id === boardId);
  return {
    parents: boards.flatMap((board) => board.placements
      .filter((placement) => placement.kind === 'board' && placement.entityId === boardId)
      .map((placement) => ({ boardId: board.id, boardTitle: board.title, placementId: placement.id }))),
    children: target?.placements.flatMap((placement) => placement.kind === 'board' && placement.entityId
      ? [{ boardId: placement.entityId, boardTitle: boards.find((board) => board.id === placement.entityId)?.title ?? '缺失白板' }]
      : []) ?? [],
  };
}
