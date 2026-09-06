import Image from '@tiptap/extension-image';

const escapeAttribute = (value: unknown) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

function readAttributes(source: string) {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(/([\w-]+)="([^"]*)"/g)) attributes[match[1]] = match[2];
  return attributes;
}

/** Markdown images stay Markdown; resized images use portable standard HTML. */
export const PortableImage = Image.extend({
  renderMarkdown(node) {
    const src = String(node.attrs?.src || '');
    const alt = String(node.attrs?.alt || '');
    const title = String(node.attrs?.title || '');
    const width = typeof node.attrs?.width === 'number' && Number.isFinite(node.attrs.width) ? node.attrs.width : null;
    const height = typeof node.attrs?.height === 'number' && Number.isFinite(node.attrs.height) ? node.attrs.height : null;
    if (width === null && height === null) {
      return title ? `![${alt}](${src} "${title}")` : `![${alt}](${src})`;
    }
    const dimensions = `${width !== null ? ` width="${Math.max(1, Math.round(width))}"` : ''}${height !== null ? ` height="${Math.max(1, Math.round(height))}"` : ''}`;
    return `<img src="${escapeAttribute(src)}" alt="${escapeAttribute(alt)}"${title ? ` title="${escapeAttribute(title)}"` : ''}${dimensions}>`;
  },

  markdownTokenizer: {
    name: 'portableHtmlImage',
    level: 'block',
    start: (source: string) => source.search(/^<img\b/im),
    tokenize(source: string) {
      const match = /^<img\b([^>]*)>(?:\r?\n|$)/i.exec(source);
      if (!match) return undefined;
      const attrs = readAttributes(match[1]);
      if (!attrs.src) return undefined;
      return {
        type: 'image',
        raw: match[0],
        href: attrs.src,
        text: attrs.alt || '',
        title: attrs.title || null,
        width: attrs.width ? Number(attrs.width) : null,
        height: attrs.height ? Number(attrs.height) : null,
      };
    },
  },

  parseMarkdown(token, helpers) {
    return helpers.createNode('image', {
      src: token.href,
      title: token.title,
      alt: token.text,
      width: Number.isFinite(token.width) ? token.width : null,
      height: Number.isFinite(token.height) ? token.height : null,
    });
  },
});
