import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Card } from '../types';
import CardMarkdownPreview from './CardMarkdownPreview';

function cardWithBody(body: string): Card {
  return {
    id: 'format-card',
    fileName: '格式卡片.md',
    relativePath: '格式卡片.md',
    title: '格式卡片',
    body,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('readonly card formatting', () => {
  it('renders TipTap underline and highlight syntax instead of exposing source markers', () => {
    const html = renderToStaticMarkup(<CardMarkdownPreview card={cardWithBody('++==对付==++')} cards={[]} />);
    expect(html).toContain('<u><mark>对付</mark></u>');
    expect(html).not.toContain('++==');
  });

  it('keeps standalone marks and ordinary plus signs intact', () => {
    const html = renderToStaticMarkup(<CardMarkdownPreview card={cardWithBody('C++，++下划线++，==高亮==')} cards={[]} />);
    expect(html).toContain('C++，<u>下划线</u>，<mark>高亮</mark>');
  });

  it('renders resized portable HTML images in the non-editing preview', () => {
    const html = renderToStaticMarkup(<CardMarkdownPreview
      card={cardWithBody('<img src="attachments/diagram.png" alt="结构图" width="480">')}
      cards={[]}
    />);
    expect(html).toContain('<img src="opencanvas-asset://vault/attachments/diagram.png" alt="结构图" width="480"/>');
  });

  it('keeps the local attachment protocol for ordinary Markdown images', () => {
    const html = renderToStaticMarkup(<CardMarkdownPreview
      card={cardWithBody('![截图](attachments/example.png)')}
      cards={[]}
    />);
    expect(html).toContain('<img src="opencanvas-asset://vault/attachments/example.png" alt="截图"/>');
  });

  it('keeps a Markdown soft newline in the readonly paragraph for CSS parity with ProseMirror', () => {
    const html = renderToStaticMarkup(<CardMarkdownPreview card={cardWithBody('第一行\n第二行')} cards={[]} />);
    expect(html).toContain('<p>第一行\n第二行</p>');
  });
});
