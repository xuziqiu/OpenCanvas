import { Node, mergeAttributes } from '@tiptap/core';
import '@tiptap/markdown';

function wikiLabel(raw: string) {
  const [targetAndAnchor, alias] = raw.split('|', 2);
  if (alias?.trim()) return alias.trim();
  const target = targetAndAnchor.split('#', 1)[0].replace(/\\/g, '/');
  return target.split('/').at(-1)?.replace(/\.md$/i, '') || targetAndAnchor;
}

/** Keeps Obsidian-style Wiki links as portable source instead of escaped plain text. */
export const WikiLink = Node.create({
  name: 'wikiLink',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      raw: { default: '' },
      embed: { default: false },
    };
  },

  parseHTML() {
    return [{
      tag: 'a[data-wiki-link]',
      getAttrs: (element) => ({
        raw: (element as HTMLElement).dataset.wikiLink || '',
        embed: (element as HTMLElement).dataset.wikiEmbed === 'true',
      }),
    }];
  },

  renderHTML({ HTMLAttributes }) {
    const raw = String(HTMLAttributes.raw || '');
    const embed = Boolean(HTMLAttributes.embed);
    return ['a', mergeAttributes({
      href: '#',
      'data-wiki-link': raw,
      'data-wiki-embed': String(embed),
      class: embed ? 'wiki-link wiki-embed' : 'wiki-link',
      title: `${embed ? '嵌入' : '引用'}：${raw}`,
    }), `${embed ? '!' : ''}${wikiLabel(raw)}`];
  },

  parseMarkdown(token, helpers) {
    return helpers.createNode('wikiLink', {
      raw: String(token.rawTarget || ''),
      embed: Boolean(token.embed),
    });
  },

  renderMarkdown(node) {
    const raw = String(node.attrs?.raw || '');
    return `${node.attrs?.embed ? '!' : ''}[[${raw}]]`;
  },

  markdownTokenizer: {
    name: 'wikiLink',
    level: 'inline',
    start: (source: string) => {
      const plain = source.indexOf('[[');
      const embedded = source.indexOf('![[');
      if (plain < 0) return embedded;
      if (embedded < 0) return plain;
      return Math.min(plain, embedded);
    },
    tokenize(source: string) {
      const match = /^(!)?\[\[([^\]\n]+)\]\]/.exec(source);
      if (!match) return undefined;
      return { type: 'wikiLink', raw: match[0], rawTarget: match[2], embed: Boolean(match[1]) };
    },
  },
});
