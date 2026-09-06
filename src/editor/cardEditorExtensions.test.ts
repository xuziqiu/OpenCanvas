import { describe, expect, it } from 'vitest';
import { createCardEditorExtensions, parseCardEditorMarkdown } from './cardEditorExtensions';

describe('card editor extensions', () => {
  it('delegates link opening to the card interaction policy', () => {
    const starterKit = createCardEditorExtensions()[0];
    expect((starterKit.options as { link?: { openOnClick?: boolean } }).link?.openOnClick).toBe(false);
  });

  it('registers the underline extension used by the formatting toolbar', () => {
    expect(createCardEditorExtensions().map((extension) => extension.name)).toContain('underline');
  });

  it('reuses the parsed representation for a recent long Markdown body', () => {
    const markdown = Array.from({ length: 1200 }, (_, index) => `段落 ${index + 1}`).join('\n\n');
    const first = parseCardEditorMarkdown(markdown);
    const second = parseCardEditorMarkdown(markdown);
    expect(second).toBe(first);
    expect(first.content?.length).toBe(1200);
  });

  it('keeps a soft newline in paragraph text and parses an explicit hard break as a node', () => {
    const parsed = parseCardEditorMarkdown('第一行\n第二行\n\n第三段  \n硬换行');
    expect(parsed.content?.[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: '第一行\n第二行' }],
    });
    expect(parsed.content?.[1]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: '第三段' }, { type: 'hardBreak' }, { type: 'text', text: '硬换行' }],
    });
  });
});
