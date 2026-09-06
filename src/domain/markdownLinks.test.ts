import { describe, expect, it } from 'vitest';
import type { Card } from '../types';
import { rewriteMarkdownLinksAfterMoves } from './markdownLinks';

const card = (id: string, title: string, relativePath: string, body = ''): Card => ({ id, title, relativePath, fileName: relativePath.split('/').at(-1)!, body, createdAt: 'old', updatedAt: 'old' });

describe('Markdown link moves', () => {
  it('rewrites links from stationary and moved sources to the same target entity', () => {
    const before = [card('source', '来源', 'source.md', '[目标](target.md)'), card('target', '目标', 'target.md')];
    const after = [before[0], { ...before[1], relativePath: '项目/target.md' }];
    expect(rewriteMarkdownLinksAfterMoves(before, after, 'now')[0].body).toBe('[目标](项目/target.md)');

    const movedBoth = [{ ...before[0], relativePath: '资料/source.md' }, { ...before[1], relativePath: '项目/target.md' }];
    expect(rewriteMarkdownLinksAfterMoves(before, movedBoth, 'now')[0].body).toBe('[目标](../项目/target.md)');
  });

  it('updates title-based and path-based Wiki links without changing aliases or headings', () => {
    const before = [card('source', '来源', 'source.md', '[[旧标题#章节|别名]] [[资料/旧标题]]'), card('target', '旧标题', '资料/旧标题.md')];
    const after = [before[0], { ...before[1], title: '新标题', relativePath: '项目/新标题.md', fileName: '新标题.md' }];
    expect(rewriteMarkdownLinksAfterMoves(before, after, 'now')[0].body).toBe('[[新标题#章节|别名]] [[项目/新标题]]');
  });

  it('leaves external and unresolved Markdown paths byte-for-byte unchanged', () => {
    const source = card('source', '来源', 'source.md', '[网页](https://example.com/a.md) [缺失](missing.md)');
    expect(rewriteMarkdownLinksAfterMoves([source], [source], 'now')[0]).toBe(source);
  });
});
