import { describe, expect, it } from 'vitest';
import type { Card } from '../types';
import { resolveWikiLinksForPreview } from './CardMarkdownPreview';

const card: Card = {
  id: 'card-1',
  fileName: '卡片.md',
  relativePath: '项目/卡片.md',
  title: '卡片',
  body: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('Wiki link preview', () => {
  it('resolves paths, aliases, anchors, and embeds without changing source files', () => {
    expect(resolveWikiLinksForPreview('[[项目/卡片#章节|别名]] ![[项目/卡片]]', [card]))
      .toBe('[别名](opencanvas://card/card-1) [嵌入：卡片](opencanvas://card/card-1)');
  });

  it('leaves unresolved Wiki links visible and portable', () => {
    expect(resolveWikiLinksForPreview('[[尚不存在]]', [card])).toBe('[[尚不存在]]');
  });
});
