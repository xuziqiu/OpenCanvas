import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Board, BoardPlacement, Card } from '../types';
import BoardPreview from './BoardPreview';

const placement = (index: number): BoardPlacement => ({
  id: `placement-${index}`,
  kind: 'card',
  entityId: `card-${index}`,
  x: index * 10,
  y: 0,
  width: 300,
  height: 180,
  color: 'paper',
});

describe('BoardPreview', () => {
  it('counts a huge board while parsing only the sixteen visible preview chips', () => {
    let bodyReads = 0;
    const cards = Array.from({ length: 5_000 }, (_, index) => {
      const card = {
        id: `card-${index}`,
        fileName: `card-${index}.md`,
        relativePath: `card-${index}.md`,
        title: '',
        createdAt: 'now',
        updatedAt: 'now',
      } as Card;
      Object.defineProperty(card, 'body', {
        enumerable: true,
        get() {
          bodyReads += 1;
          return `正文 ${index}`;
        },
      });
      return card;
    });
    const board: Board = {
      version: 4,
      id: 'huge-board',
      fileName: 'huge.board.json',
      title: '超大嵌套预览',
      placements: Array.from({ length: 5_000 }, (_, index) => placement(index)),
      connectors: [],
      attachments: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      createdAt: 'now',
      updatedAt: 'now',
    };

    const markup = renderToStaticMarkup(<BoardPreview
      board={board}
      cardMap={new Map(cards.map((card) => [card.id, card]))}
      boardMap={new Map([[board.id, board]])}
    />);

    expect(markup).toContain('5000 张卡片，0 个白板');
    expect(markup.match(/kind-card/g)).toHaveLength(16);
    expect(bodyReads).toBe(16);
  });
});
