import Highlight from '@tiptap/extension-highlight';
import { Mathematics } from '@tiptap/extension-mathematics';
import Placeholder from '@tiptap/extension-placeholder';
import { TableKit } from '@tiptap/extension-table';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import Underline from '@tiptap/extension-underline';
import { Markdown, MarkdownManager } from '@tiptap/markdown';
import type { JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { MediaAttachment } from './MediaAttachment';
import { WikiLink } from './WikiLink';
import { PortableImage } from './PortableImage';
import { FileAttachment } from './FileAttachment';

export function createCardEditorExtensions() {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      // CardBodyEditor owns link activation so readonly cards and editable
      // documents follow one predictable single-click / Ctrl/Cmd-click rule.
      link: { openOnClick: false },
    }),
    Highlight,
    PortableImage.configure({ allowBase64: false, resize: { enabled: true, minWidth: 80, minHeight: 60, alwaysPreserveAspectRatio: true } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Underline,
    TableKit.configure({ table: { resizable: true } }),
    Mathematics.configure({ katexOptions: { throwOnError: false } }),
    MediaAttachment,
    FileAttachment,
    WikiLink,
    Placeholder.configure({ placeholder: '输入“/”插入内容，输入“@”引用卡片' }),
    Markdown,
  ];
}

const PARSED_MARKDOWN_CACHE_LIMIT = 16;
const parsedMarkdownCache = new Map<string, JSONContent>();
let sharedMarkdownManager: MarkdownManager | null = null;

/**
 * Parse Markdown once per recent document body. TipTap otherwise repeats the
 * Markdown lexer while constructing an Editor, which is visible on long notes
 * and during side-panel/full-page transitions. The cache is deliberately
 * small: source Markdown remains authoritative and the returned JSON is only
 * an initialization representation.
 */
export function parseCardEditorMarkdown(source: string): JSONContent {
  const cached = parsedMarkdownCache.get(source);
  if (cached) {
    parsedMarkdownCache.delete(source);
    parsedMarkdownCache.set(source, cached);
    return cached;
  }
  sharedMarkdownManager ??= new MarkdownManager({ extensions: createCardEditorExtensions() });
  const parsed = sharedMarkdownManager.parse(source);
  parsedMarkdownCache.set(source, parsed);
  if (parsedMarkdownCache.size > PARSED_MARKDOWN_CACHE_LIMIT) {
    const oldest = parsedMarkdownCache.keys().next().value as string | undefined;
    if (oldest !== undefined) parsedMarkdownCache.delete(oldest);
  }
  return parsed;
}
