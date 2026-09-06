import { Node, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    fileAttachment: {
      insertFileAttachment: (attributes: { src: string; name: string; mimeType?: string; size?: number }) => ReturnType;
    };
  }
}

const escapeAttribute = (value: unknown) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function readAttributes(source: string) {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(/([\w-]+)="([^"]*)"/g)) attributes[match[1]] = match[2];
  return attributes;
}

export const FileAttachment = Node.create({
  name: 'fileAttachment',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      src: { default: '' },
      name: { default: '附件' },
      mimeType: { default: 'application/octet-stream' },
      size: { default: 0 },
    };
  },

  parseHTML() {
    return [{ tag: 'a[data-opencanvas-attachment]', getAttrs: (element) => {
      const node = element as HTMLAnchorElement;
      return { src: node.getAttribute('href') || '', name: node.dataset.name || node.textContent || '附件', mimeType: node.dataset.mimeType || 'application/octet-stream', size: Number(node.dataset.size) || 0 };
    } }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['a', mergeAttributes({
      href: HTMLAttributes.src,
      'data-opencanvas-attachment': 'true',
      'data-name': HTMLAttributes.name,
      'data-mime-type': HTMLAttributes.mimeType,
      'data-size': String(HTMLAttributes.size || 0),
      class: 'file-attachment-node',
    }), String(HTMLAttributes.name || '附件')];
  },

  parseMarkdown(token, helpers) {
    return helpers.createNode('fileAttachment', token.attributes || {});
  },

  renderMarkdown(node) {
    const attrs = node.attrs || {};
    return `<a href="${escapeAttribute(attrs.src)}" data-opencanvas-attachment="true" data-name="${escapeAttribute(attrs.name)}" data-mime-type="${escapeAttribute(attrs.mimeType)}" data-size="${Math.max(0, Number(attrs.size) || 0)}">${escapeAttribute(attrs.name || '附件')}</a>`;
  },

  markdownTokenizer: {
    name: 'fileAttachment',
    level: 'block',
    start: (source: string) => source.search(/^<a\b[^>]*data-opencanvas-attachment=/im),
    tokenize(source: string) {
      const match = /^<a\b([^>]*data-opencanvas-attachment="true"[^>]*)>([\s\S]*?)<\/a>(?:\r?\n|$)/i.exec(source);
      if (!match) return undefined;
      const attrs = readAttributes(match[1]);
      return { type: 'fileAttachment', raw: match[0], attributes: { src: attrs.href || '', name: attrs['data-name'] || match[2] || '附件', mimeType: attrs['data-mime-type'] || 'application/octet-stream', size: Number(attrs['data-size']) || 0 } };
    },
  },

  addCommands() {
    return { insertFileAttachment: (attributes) => ({ commands }) => commands.insertContent({ type: this.name, attrs: attributes }) };
  },
});
