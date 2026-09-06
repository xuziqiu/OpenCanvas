import { BookOpen, Search, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import manual from '../../docs/user-guide.md?raw';
import { isComposingKeyboardEvent } from '../domain/keyboard';

type UserGuideProps = {
  onClose: () => void;
};

type ManualSection = {
  id: string;
  title: string;
  content: string;
};

function plainText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(plainText).join('');
  if (node && typeof node === 'object' && 'props' in node) return plainText((node as { props: { children?: ReactNode } }).props.children);
  return '';
}

function headingId(value: string) {
  return value
    .trim()
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s/、，。：“”‘’（）()]+/g, '-')
    .replace(/[^\p{Letter}\p{Number}-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function manualSections(markdown: string): ManualSection[] {
  const matches = [...markdown.matchAll(/^##\s+(.+)$/gm)];
  return matches.map((match, index) => ({
    title: match[1].trim(),
    id: headingId(match[1]),
    content: markdown.slice(match.index ?? 0, matches[index + 1]?.index ?? markdown.length),
  })).filter((section) => section.title !== '目录');
}

function decodedHash(href: string) {
  try { return decodeURIComponent(href.slice(1)); } catch { return href.slice(1); }
}

export default function UserGuide({ onClose }: UserGuideProps) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const sections = useMemo(() => manualSections(manual), []);
  const results = useMemo(() => {
    const term = query.trim().toLocaleLowerCase('zh-CN');
    if (!term) return [];
    return sections.filter((section) => section.content.toLocaleLowerCase('zh-CN').includes(term));
  }, [query, sections]);

  useEffect(() => {
    searchRef.current?.focus();
    const close = (event: KeyboardEvent) => {
      if (!isComposingKeyboardEvent(event) && event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);

  const goToSection = (id: string) => {
    articleRef.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  return <section className="user-guide-dialog" role="dialog" aria-modal="true" aria-labelledby="user-guide-title">
    <header>
      <div className="user-guide-heading"><span><BookOpen size={20} /></span><div><h2 id="user-guide-title">OpenCanvas 用户手册</h2><p>版本 1.0.10 · 离线内置，与当前应用同步</p></div></div>
      <button className="user-guide-close" aria-label="关闭用户手册" title="关闭" onClick={onClose}><X size={18} /></button>
    </header>
    <div className="user-guide-layout">
      <aside className="user-guide-navigation" aria-label="手册目录">
        <label className="user-guide-search"><Search size={15} /><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索手册" aria-label="搜索用户手册" autoFocus /></label>
        {query.trim() ? <div className="user-guide-search-results"><small>{results.length ? `找到 ${results.length} 个相关章节` : '没有匹配章节'}</small>{results.map((section) => <button key={section.id} onClick={() => goToSection(section.id)}>{section.title}</button>)}</div> : <nav>{sections.map((section) => <button key={section.id} onClick={() => goToSection(section.id)}>{section.title}</button>)}</nav>}
      </aside>
      <article className="user-guide-content" ref={articleRef}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h1: ({ children }) => <h1 id={headingId(plainText(children))}>{children}</h1>,
            h2: ({ children }) => <h2 id={headingId(plainText(children))}>{children}</h2>,
            h3: ({ children }) => <h3 id={headingId(plainText(children))}>{children}</h3>,
            a: ({ href, children }) => href?.startsWith('#')
              ? <a href={href} onClick={(event) => { event.preventDefault(); goToSection(decodedHash(href)); }}>{children}</a>
              : <span className="user-guide-document-link" title={href}>{children}</span>,
          }}
        >{manual}</ReactMarkdown>
      </article>
    </div>
    <footer><span>提示：按 Esc 随时关闭；数据安全和故障排查位于第 14–18 章。</span><button data-modal-close onClick={onClose}>完成</button></footer>
  </section>;
}
