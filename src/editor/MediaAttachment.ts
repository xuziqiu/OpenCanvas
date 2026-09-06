import { Node, createAtomBlockMarkdownSpec, mergeAttributes } from '@tiptap/core';
import '@tiptap/markdown';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    mediaAttachment: {
      insertMediaAttachment: (attributes: { src: string; mediaType: 'audio' | 'video'; name?: string }) => ReturnType;
    };
  }
}

const markdown = createAtomBlockMarkdownSpec({
  nodeName: 'mediaAttachment',
  name: 'media',
  requiredAttributes: ['src', 'mediaType'],
  allowedAttributes: ['src', 'mediaType', 'name'],
});

function readAttributes(source: string) {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(/([\w-]+)="([^"]*)"/g)) attributes[match[1]] = match[2];
  return attributes;
}

const escapeAttribute = (value: unknown) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

export const MediaAttachment = Node.create({
  ...markdown,
  name: 'mediaAttachment',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      src: { default: '' },
      mediaType: { default: 'audio' },
      name: { default: '' },
    };
  },
  parseHTML() {
    return [
      { tag: 'audio[data-opencanvas-media]', getAttrs: (element) => ({ src: (element as HTMLElement).getAttribute('src'), mediaType: 'audio', name: (element as HTMLElement).dataset.name || '' }) },
      { tag: 'video[data-opencanvas-media]', getAttrs: (element) => ({ src: (element as HTMLElement).getAttribute('src'), mediaType: 'video', name: (element as HTMLElement).dataset.name || '' }) },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    const mediaType = HTMLAttributes.mediaType === 'video' ? 'video' : 'audio';
    return [mediaType, mergeAttributes({ controls: 'true', preload: 'metadata', 'data-opencanvas-media': 'true', 'data-name': HTMLAttributes.name || '', title: HTMLAttributes.name || '' }, { src: HTMLAttributes.src })];
  },
  renderMarkdown(node) {
    const mediaType = node.attrs?.mediaType === 'video' ? 'video' : 'audio';
    const source = escapeAttribute(node.attrs?.src);
    const name = escapeAttribute(node.attrs?.name);
    return `<${mediaType} controls data-opencanvas-media="true" data-name="${name}" src="${source}"></${mediaType}>`;
  },
  markdownTokenizer: {
    name: 'mediaAttachment',
    level: 'block',
    start(source: string) {
      const legacy = source.search(/^:::media(?:\s|$)/m);
      const html = source.search(/^<(?:audio|video)\b/im);
      if (legacy < 0) return html;
      if (html < 0) return legacy;
      return Math.min(legacy, html);
    },
    tokenize(source: string) {
      const legacy = /^:::media(?:\s+\{([^}]*)\})?\s*:::(?:\r?\n|$)/.exec(source);
      if (legacy) return { type: 'mediaAttachment', raw: legacy[0], attributes: readAttributes(legacy[1] || '') };
      const html = /^<(audio|video)\b([^>]*)>(?:\s*<\/\1>)?(?:\r?\n|$)/i.exec(source);
      if (!html) return undefined;
      const attributes = readAttributes(html[2]);
      return {
        type: 'mediaAttachment',
        raw: html[0],
        attributes: {
          src: attributes.src || '',
          mediaType: html[1].toLocaleLowerCase(),
          name: attributes['data-name'] || attributes.title || '',
        },
      };
    },
  },
  addCommands() {
    return {
      insertMediaAttachment: (attributes) => ({ commands }) => commands.insertContent({ type: this.name, attrs: attributes }),
    };
  },
});
