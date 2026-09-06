import { Hash, RefreshCw, Search } from 'lucide-react';
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { IncrementalSearchIndex, searchWorkspace, type SearchRecord } from '../domain/searchIndex';
import { isComposingKeyboardEvent } from '../domain/keyboard';
import ExitPresence from './ExitPresence';
import { useWorkspaceStore } from '../store';
import type { Board, Card } from '../types';
import { CardIcon, WhiteboardIcon } from './icons/ProductIcons';

type QuickResult = {
  kind: 'board' | 'card' | 'tag';
  id: string;
  title: string;
  detail: string;
  badge: string;
};

const resultDomId = (result: QuickResult) => `quick-open-${result.kind}-${result.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
const parsedTime = (value: string) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const QUICK_OPEN_EXIT_MS = 170;

function boardResult(board: Board): QuickResult {
  const cardCount = board.placements.filter((placement) => placement.kind === 'card').length;
  const boardCount = board.placements.filter((placement) => placement.kind === 'board').length;
  return {
    kind: 'board',
    id: board.id,
    title: board.title || '未命名白板',
    detail: `${cardCount} 张卡片${boardCount ? ` · ${boardCount} 个子白板` : ''}`,
    badge: '白板',
  };
}

function cardResult(card: Card, detail = card.relativePath): QuickResult {
  return { kind: 'card', id: card.id, title: card.title || '未命名卡片', detail, badge: '卡片' };
}

function collectTags(records: SearchRecord[]) {
  const tags = new Map<string, string[]>();
  for (const record of records) {
    if (record.kind !== 'card') continue;
    for (const tag of record.tags) tags.set(tag, [...(tags.get(tag) ?? []), record.id]);
  }
  return tags;
}

export default function QuickOpen() {
  const boards = useWorkspaceStore((state) => state.boards);
  const cards = useWorkspaceStore((state) => state.cards);
  const activeBoardId = useWorkspaceStore((state) => state.activeBoardId);
  const focusedCardId = useWorkspaceStore((state) => state.focusedCardId);
  const sidePanelCardId = useWorkspaceStore((state) => state.sidePanelCardId);
  const openBoard = useWorkspaceStore((state) => state.openBoard);
  const focusCard = useWorkspaceStore((state) => state.focusCard);
  const renameTag = useWorkspaceStore((state) => state.renameTag);
  const deleteTag = useWorkspaceStore((state) => state.deleteTag);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [activeIndex, setActiveIndex] = useState(0);
  const [editingTag, setEditingTag] = useState<{ original: string; draft: string; confirmDelete: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const resultRefs = useRef(new Map<string, HTMLButtonElement>());
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const restoreFocusTimerRef = useRef<number | null>(null);
  const openRef = useRef(open);
  const searchIndexRef = useRef(new IncrementalSearchIndex());

  useEffect(() => { openRef.current = open; }, [open]);

  useEffect(() => {
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const warm = () => searchIndexRef.current.update(cards, boards);
    if (idleWindow.requestIdleCallback) {
      const handle = idleWindow.requestIdleCallback(warm, { timeout: 700 });
      return () => idleWindow.cancelIdleCallback?.(handle);
    }
    const handle = window.setTimeout(warm, 120);
    return () => window.clearTimeout(handle);
  }, [boards, cards]);

  const searchRecords = useMemo(() => open ? searchIndexRef.current.update(cards, boards) : [], [boards, cards, open]);
  const tags = useMemo(() => collectTags(searchRecords), [searchRecords]);

  const results = useMemo<QuickResult[]>(() => {
    const normalized = deferredQuery.trim().toLocaleLowerCase();
    if (!normalized) {
      const current: QuickResult[] = [];
      const seen = new Set<string>();
      const push = (result?: QuickResult) => {
        if (!result) return;
        const key = `${result.kind}:${result.id}`;
        if (!seen.has(key)) { seen.add(key); current.push(result); }
      };
      const activeBoard = boards.find((board) => board.id === activeBoardId);
      const currentCard = cards.find((card) => card.id === (focusedCardId ?? sidePanelCardId));
      push(activeBoard ? boardResult(activeBoard) : undefined);
      push(currentCard ? cardResult(currentCard) : undefined);
      [...boards].sort((a, b) => parsedTime(b.updatedAt) - parsedTime(a.updatedAt)).forEach((board) => push(boardResult(board)));
      [...cards].sort((a, b) => parsedTime(b.updatedAt) - parsedTime(a.updatedAt)).forEach((card) => push(cardResult(card)));
      const frequentTags = [...tags.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'zh-CN')).slice(0, 6)
        .map(([tag, ids]) => ({ kind: 'tag' as const, id: tag, title: `#${tag}`, detail: `${ids.length} 张卡片`, badge: '标签' }));
      return [...current.slice(0, 24), ...frequentTags].slice(0, 30);
    }

    const tagQuery = normalized.startsWith('#') ? normalized.slice(1) : null;
    const effectiveQuery = tagQuery === null ? deferredQuery : `tag:${tagQuery}`;
    const entityResults = searchWorkspace(searchRecords, effectiveQuery, 40).map(({ record, snippet }) => {
      if (record.kind === 'board') {
        const board = boards.find((item) => item.id === record.id);
        return board ? boardResult(board) : { kind: 'board' as const, id: record.id, title: record.title, detail: record.path, badge: '白板' };
      }
      const card = cards.find((item) => item.id === record.id);
      const detail = `${record.path}${snippet && snippet !== record.path ? ` · ${snippet}` : ''}`;
      return card ? cardResult(card, detail) : { kind: 'card' as const, id: record.id, title: record.title, detail, badge: '卡片' };
    });
    const canSuggestTags = tagQuery === null && !/\b(?:type|tag|path):/i.test(normalized);
    const tagNeedle = (tagQuery ?? normalized).replace(/^#/, '');
    const tagResults = (canSuggestTags ? [...tags.entries()] : [])
      .filter(([tag]) => tag.includes(tagNeedle))
      .sort((a, b) => Number(b[0] === tagNeedle) - Number(a[0] === tagNeedle) || b[1].length - a[1].length || a[0].localeCompare(b[0], 'zh-CN'))
      .map(([tag, ids]) => ({ kind: 'tag' as const, id: tag, title: `#${tag}`, detail: `${ids.length} 张卡片`, badge: '标签' }));
    return [...tagResults, ...entityResults].slice(0, 40);
  }, [activeBoardId, boards, cards, deferredQuery, focusedCardId, searchRecords, sidePanelCardId, tags]);

  const closeDialog = useCallback((restoreFocus = true) => {
    openRef.current = false;
    setOpen(false);
    setQuery('');
    setEditingTag(null);
    if (restoreFocusTimerRef.current !== null) window.clearTimeout(restoreFocusTimerRef.current);
    restoreFocusTimerRef.current = null;
    if (restoreFocus) {
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      restoreFocusTimerRef.current = window.setTimeout(() => {
        // Presence unmounts on the same duration. Restore on the next frame so
        // the departing modal can no longer reclaim focus or flash its ring.
        window.requestAnimationFrame(() => {
          if (!openRef.current) restoreFocusRef.current?.focus({ preventScroll: true });
        });
        restoreFocusTimerRef.current = null;
      }, reducedMotion ? 0 : QUICK_OPEN_EXIT_MS);
    }
  }, []);

  const showDialog = useCallback((initialQuery = '') => {
    if (restoreFocusTimerRef.current !== null) window.clearTimeout(restoreFocusTimerRef.current);
    restoreFocusTimerRef.current = null;
    if (!openRef.current) restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    openRef.current = true;
    setQuery(initialQuery);
    setActiveIndex(0);
    setOpen(true);
  }, []);

  useEffect(() => () => {
    if (restoreFocusTimerRef.current !== null) window.clearTimeout(restoreFocusTimerRef.current);
  }, []);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (isComposingKeyboardEvent(event)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault();
        if (openRef.current) closeDialog(); else showDialog();
      }
    };
    const openWithQuery = (event: Event) => showDialog((event as CustomEvent<string>).detail ?? '');
    window.addEventListener('keydown', keydown);
    window.addEventListener('opencanvas:quick-open', openWithQuery);
    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('opencanvas:quick-open', openWithQuery);
    };
  }, [closeDialog, showDialog]);

  useLayoutEffect(() => {
    if (open) inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => { setActiveIndex(0); }, [query]);
  useEffect(() => { setActiveIndex((current) => Math.max(0, Math.min(results.length - 1, current))); }, [results.length]);
  useLayoutEffect(() => {
    const result = results[activeIndex];
    if (result) resultRefs.current.get(`${result.kind}:${result.id}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, results]);
  useEffect(() => { if (editingTag) window.requestAnimationFrame(() => tagInputRef.current?.focus()); }, [editingTag?.original]);

  const choose = (result: QuickResult) => {
    if (result.kind === 'tag') { setQuery(`#${result.id}`); return; }
    if (result.kind === 'board') openBoard(result.id);
    else focusCard(result.id);
    closeDialog(false);
  };

  const applyTagRename = async () => {
    if (!editingTag) return;
    const next = editingTag.draft.trim().replace(/^#/, '');
    if (next && next !== editingTag.original) await renameTag(editingTag.original, next);
    setEditingTag(null);
  };

  const activeResult = results[activeIndex];
  const pendingSearch = query !== deferredQuery;
  return <ExitPresence show={open} duration={QUICK_OPEN_EXIT_MS}>{open ? <div className="quick-open-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) closeDialog(); }}>
    <section className="quick-open-dialog" role="dialog" aria-modal="true" aria-label="快速打开" onKeyDown={(event) => { if (!isComposingKeyboardEvent(event.nativeEvent) && event.key === 'Escape') { event.preventDefault(); closeDialog(); } }}>
      <label className={pendingSearch ? 'is-searching' : ''}>
        {pendingSearch ? <RefreshCw className="quick-open-spinner" size={17} /> : <Search size={17} />}
        <input
          ref={inputRef}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls="quick-open-results"
          aria-activedescendant={activeResult ? resultDomId(activeResult) : undefined}
          value={query}
          placeholder="搜索卡片、白板或标签…"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (isComposingKeyboardEvent(event.nativeEvent)) return;
            if (event.key === 'Escape') { event.preventDefault(); closeDialog(); }
            if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex((current) => Math.max(0, Math.min(results.length - 1, current + 1))); }
            if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((current) => Math.max(0, current - 1)); }
            if (event.key === 'Home') { event.preventDefault(); setActiveIndex(0); }
            if (event.key === 'End') { event.preventDefault(); setActiveIndex(Math.max(0, results.length - 1)); }
            if (event.key === 'PageDown') { event.preventDefault(); setActiveIndex((current) => Math.min(results.length - 1, current + 8)); }
            if (event.key === 'PageUp') { event.preventDefault(); setActiveIndex((current) => Math.max(0, current - 8)); }
            if (event.key === 'Enter' && results[activeIndex]) { event.preventDefault(); choose(results[activeIndex]); }
          }}
        />
        <kbd>Esc</kbd>
      </label>
      <div id="quick-open-results" className="quick-open-results" role="listbox" aria-label={query ? '搜索结果' : '最近打开'} aria-busy={pendingSearch}>
        {results.map((result, resultIndex) => <button
          id={resultDomId(result)}
          ref={(element) => {
            const key = `${result.kind}:${result.id}`;
            if (element) resultRefs.current.set(key, element); else resultRefs.current.delete(key);
          }}
          key={`${result.kind}-${result.id}`}
          role="option"
          aria-selected={resultIndex === activeIndex}
          className={`quick-open-result is-${result.kind}${resultIndex === activeIndex ? ' active' : ''}`}
          onMouseEnter={() => setActiveIndex(resultIndex)}
          onClick={() => choose(result)}
          onContextMenu={(event) => {
            if (result.kind !== 'tag') return;
            event.preventDefault();
            setEditingTag({ original: result.id, draft: result.id, confirmDelete: false });
          }}
          title={result.kind === 'tag' ? '右键可重命名或删除标签' : undefined}
        >
          <span className="quick-open-result-icon">{result.kind === 'board' ? <WhiteboardIcon size={17} /> : result.kind === 'card' ? <CardIcon size={17} /> : <Hash size={17} />}</span>
          <span className="quick-open-result-copy"><strong>{result.title}</strong><small>{result.detail}</small></span>
          <span className="quick-open-result-badge">{result.badge}</span>
        </button>)}
        {!results.length && <p>{pendingSearch ? '正在搜索…' : '没有匹配内容'}</p>}
      </div>
      <footer><span>{results.length} 项</span><span>↑↓ 选择</span><span>Enter 打开</span><span><kbd>Ctrl K</kbd> 关闭</span></footer>
    </section>
    <ExitPresence show={Boolean(editingTag)}>{editingTag ? <div className="quick-tag-dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) setEditingTag(null); }}>
      <section className="quick-tag-dialog" role="dialog" aria-modal="true" aria-label={`管理标签 ${editingTag.original}`} onKeyDown={(event) => { if (!isComposingKeyboardEvent(event.nativeEvent) && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditingTag(null); } }}>
        <header><Hash size={16} /><strong>管理标签</strong></header>
        <label>名称<input ref={tagInputRef} value={editingTag.draft} onChange={(event) => setEditingTag({ ...editingTag, draft: event.target.value, confirmDelete: false })} onKeyDown={(event) => {
          if (isComposingKeyboardEvent(event.nativeEvent)) return;
          if (event.key === 'Enter') { event.preventDefault(); applyTagRename(); }
          if (event.key === 'Escape') { event.preventDefault(); setEditingTag(null); }
        }} /></label>
        {editingTag.confirmDelete && <p>将从 {tags.get(editingTag.original)?.length ?? 0} 张卡片移除 <strong>#{editingTag.original}</strong>，卡片本身不会删除。</p>}
        <footer>
          <button className="danger" onClick={async () => {
            if (!editingTag.confirmDelete) { setEditingTag({ ...editingTag, confirmDelete: true }); return; }
            await deleteTag(editingTag.original);
            setEditingTag(null);
          }}>{editingTag.confirmDelete ? '确认移除' : '删除标签'}</button>
          <span />
          <button data-modal-close onClick={() => setEditingTag(null)}>取消</button>
          <button className="primary" disabled={!editingTag.draft.trim()} onClick={applyTagRename}>保存</button>
        </footer>
      </section>
    </div> : null}</ExitPresence>
  </div> : null}</ExitPresence>;
}
