const ASSET_SCHEME = 'opencanvas-asset://vault/';

export interface MarkdownDocumentParts {
  frontmatter: string;
  body: string;
}

/** Preserve frontmatter byte-for-byte while the rich-text editor owns the body. */
export function splitMarkdownDocument(markdown: string): MarkdownDocumentParts {
  if (!markdown.startsWith('---\n') && !markdown.startsWith('---\r\n')) {
    return { frontmatter: '', body: markdown };
  }
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/);
  if (!match) return { frontmatter: '', body: markdown };
  return { frontmatter: match[0], body: markdown.slice(match[0].length) };
}

export function joinMarkdownDocument(parts: MarkdownDocumentParts) {
  return `${parts.frontmatter}${parts.body}`;
}

export function toEditorMarkdown(markdown: string) {
  return markdown
    .replace(/(!\[[^\]]*\]\()attachments\//g, `$1${ASSET_SCHEME}attachments/`)
    .replace(/(src=")attachments\//g, `$1${ASSET_SCHEME}attachments/`);
}

export function toSourceMarkdown(markdown: string) {
  // Keep URL escapes in portable Markdown. A path such as `中文 图.png` must
  // remain `%E4%B8%AD%E6%96%87%20%E5%9B%BE.png` inside a Markdown destination;
  // localAttachmentPath decodes it only when the file is opened.
  return markdown.replace(/opencanvas-asset:\/\/vault\/attachments\/([^\s)"']+)/g, (_match, fileName: string) => `attachments/${fileName}`);
}

export function localAttachmentPath(value: string | null | undefined) {
  if (!value) return null;
  let relative = value;
  const prefix = 'opencanvas-asset://vault/';
  if (relative.startsWith(prefix)) relative = decodeURIComponent(relative.slice(prefix.length));
  relative = relative.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!relative.startsWith('attachments/') || relative.includes('../')) return null;
  return relative;
}
