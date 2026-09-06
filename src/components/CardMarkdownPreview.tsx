import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import type { Card } from '../types';
import { localAttachmentPath } from '../editor/markdownDocument';
import { remarkExtendedMarks } from '../editor/remarkExtendedMarks';
import { vaultApi } from '../vault';

const ASSET_SCHEME = 'opencanvas-asset://vault/';

function previewUrlTransform(url: string) {
  return url.startsWith(ASSET_SCHEME) ? url : defaultUrlTransform(url);
}

function portableMarkdown(markdown: string) {
  return markdown
    .replace(/(!\[[^\]]*\]\()attachments\//g, `$1${ASSET_SCHEME}attachments/`)
    .replace(/(src=["'])attachments\//gi, `$1${ASSET_SCHEME}attachments/`)
    .replace(/<a\b([^>]*data-opencanvas-attachment="true"[^>]*)>[\s\S]*?<\/a>/gi, (_match, attributes: string) => {
      const read = (name: string) => attributes.match(new RegExp(`${name}="([^"]*)"`, 'i'))?.[1] || '';
      const source = read('href').replace(/^attachments\//, `${ASSET_SCHEME}attachments/`);
      const name = read('data-name') || '附件';
      const mimeType = read('data-mime-type') || '文件';
      const size = Number(read('data-size')) || 0;
      const sizeLabel = size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : size >= 1024 ? `${Math.round(size / 1024)} KB` : `${size} B`;
      return `[${name} · ${mimeType} · ${sizeLabel}](${source})`;
    })
    .replace(/<(audio|video)\b([^>]*)>(?:<\/\1>)?/gi, (_match, mediaType: string, attributes: string) => {
      const read = (name: string) => attributes.match(new RegExp(`${name}="([^"]*)"`, 'i'))?.[1] || '';
      const source = read('src').replace(/^attachments\//, `${ASSET_SCHEME}attachments/`);
      const name = read('data-name') || (mediaType.toLocaleLowerCase() === 'video' ? '视频' : '音频');
      return source ? `[${name}](${source})` : name;
    })
    .replace(/:::media\s+\{([^}]*)\}\s*:::/g, (_match, attributes: string) => {
      const read = (name: string) => attributes.match(new RegExp(`${name}="([^"]*)"`))?.[1] || '';
      const source = read('src').replace(/^attachments\//, `${ASSET_SCHEME}attachments/`);
      const name = read('name') || (read('mediaType') === 'video' ? '视频' : '音频');
      return `[${name}](${source})`;
    });
}

export function resolveWikiLinksForPreview(markdown: string, cards: Card[]) {
  return markdown.replace(/(!)?\[\[([^\]\n]+)\]\]/g, (source, embed: string | undefined, raw: string) => {
    const [targetAndAnchor, alias] = raw.split('|', 2);
    const target = targetAndAnchor.split('#', 1)[0].replace(/\\/g, '/').replace(/^\.\//, '');
    const normalized = target.replace(/\.md$/i, '').toLocaleLowerCase();
    const baseName = normalized.split('/').at(-1) || normalized;
    const matched = cards.find((candidate) =>
      candidate.relativePath.replace(/\.md$/i, '').toLocaleLowerCase() === normalized
      || candidate.title.toLocaleLowerCase() === normalized
      || candidate.title.toLocaleLowerCase() === baseName
    );
    if (!matched) return source;
    const label = alias?.trim() || matched.title || baseName;
    return `[${embed ? `嵌入：${label}` : label}](opencanvas://card/${matched.id})`;
  });
}

export default function CardMarkdownPreview({ card, cards, onOpenCard }: { card: Card; cards: Card[]; onOpenCard?: (cardId: string) => void }) {
  return <div className="card-markdown-preview card-prosemirror">
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkExtendedMarks]}
      rehypePlugins={[rehypeRaw]}
      urlTransform={previewUrlTransform}
      components={{
        table: ({ children, ...props }) => <div className="markdown-table-scroll" role="region" aria-label="表格，可横向滚动" tabIndex={0}><table {...props}>{children}</table></div>,
        a: ({ href, children, ...props }) => <a {...props} href={href} onClick={(event) => {
          if (href?.startsWith('opencanvas://card/')) {
            event.preventDefault();
            event.stopPropagation();
            onOpenCard?.(href.slice('opencanvas://card/'.length));
            return;
          }
          const attachmentPath = localAttachmentPath(href);
          if (attachmentPath) {
            event.preventDefault();
            event.stopPropagation();
            void vaultApi.openAttachment?.(attachmentPath);
            return;
          }
          if (/^(https?:|mailto:)/i.test(href || '')) {
            event.preventDefault();
            event.stopPropagation();
            void vaultApi.openExternal?.(href!);
          }
        }}>{children}</a>,
      }}
    >{resolveWikiLinksForPreview(portableMarkdown(card.body), cards)}</ReactMarkdown>
  </div>;
}
