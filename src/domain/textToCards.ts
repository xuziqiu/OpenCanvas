import { sanitizePathSegment } from './pathNaming';
import type { Board, BoardPlacement, Card } from '../types';

const TEXT_TO_CARD_MIN_WIDTH = 520;
const TEXT_TO_CARD_HEIGHT_DELTA = 92;

interface TextToCardsOptions {
  createId: () => string;
  now: string;
  projectPath?: string;
}

export interface TextToCardsResult {
  board: Board;
  cards: Card[];
  createdCards: Card[];
  replacementMap: Record<string, string>;
}

const joinPath = (parent: string, child: string) => parent ? `${parent}/${child}` : child;

/** Replaces every selected free-text object with an independent Markdown card. */
export function convertTextPlacementsToCards(
  board: Board,
  cards: Card[],
  selectedIds: string[],
  options: TextToCardsOptions,
): TextToCardsResult {
  const selected = new Set(selectedIds);
  const sources = board.placements.filter((placement) => selected.has(placement.id) && placement.kind === 'text' && !placement.isFrame);
  if (!sources.length) return { board, cards, createdCards: [], replacementMap: {} };

  const replacementMap: Record<string, string> = {};
  const createdCards: Card[] = [];
  const replacements = new Map<string, BoardPlacement>();
  for (const source of sources) {
    const cardId = options.createId();
    const placementId = options.createId();
    const title = '未命名卡片';
    const fileName = `${sanitizePathSegment(title, 'card')}--${cardId.slice(0, 8)}.md`;
    createdCards.push({
      id: cardId,
      fileName,
      relativePath: joinPath(options.projectPath ?? '', fileName),
      title,
      body: source.text ?? '',
      createdAt: options.now,
      updatedAt: options.now,
    });
    replacementMap[source.id] = placementId;
    replacements.set(source.id, {
      ...source,
      id: placementId,
      kind: 'card',
      entityId: cardId,
      text: undefined,
      width: Math.max(source.width, TEXT_TO_CARD_MIN_WIDTH),
      height: source.height + TEXT_TO_CARD_HEIGHT_DELTA,
      color: source.color === 'transparent' ? 'paper' : source.color,
    });
  }

  const remap = (placementId: string) => replacementMap[placementId] ?? placementId;
  return {
    cards: [...createdCards, ...cards],
    createdCards,
    replacementMap,
    board: {
      ...board,
      placements: board.placements.map((placement) => replacements.get(placement.id) ?? placement),
      connectors: board.connectors.map((connector) => ({ ...connector, from: remap(connector.from), to: remap(connector.to) })),
      attachments: board.attachments.map((attachment) => ({
        ...attachment,
        objectId: remap(attachment.objectId),
        attachedObjectId: remap(attachment.attachedObjectId),
      })),
      updatedAt: options.now,
    },
  };
}
