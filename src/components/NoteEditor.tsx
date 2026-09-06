import { ArrowLeft, Info, Link2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { buildWorkspaceIndex } from '../domain/workspaceIndex';
import { isComposingKeyboardEvent } from '../domain/keyboard';
import { recallCardEditorScroll, recallCardEditorSelection, rememberCardEditorScroll, rememberCardEditorSelection } from '../domain/editorViewState';
import { useWorkspaceStore } from '../store';
import CardBodyEditor from './CardBodyEditor';

export default function NoteEditor() {
  const cards = useWorkspaceStore((state) => state.cards);
  const boards = useWorkspaceStore((state) => state.boards);
  const focusedCardId = useWorkspaceStore((state) => state.focusedCardId);
  const focusTransitionSource = useWorkspaceStore((state) => state.focusTransitionSource);
  const updateCard = useWorkspaceStore((state) => state.updateCard);
  const focusCard = useWorkspaceStore((state) => state.focusCard);
  const openBoard = useWorkspaceStore((state) => state.openBoard);
  const [renderedCardId, setRenderedCardId] = useState<string | null>(focusedCardId);
  const [renderedSource, setRenderedSource] = useState<'canvas' | 'side-panel'>('canvas');
  const [isClosing, setIsClosing] = useState(false);
  const documentRef = useRef<HTMLElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const card = cards.find((item) => item.id === renderedCardId);
  const index = useMemo(() => buildWorkspaceIndex(cards, boards), [cards, boards]);

  const closePage = () => {
    if (card && renderedSource === 'side-panel') {
      rememberCardEditorScroll(card.id, 'side-panel', documentRef.current?.scrollTop ?? 0);
      const selection = recallCardEditorSelection(card.id, 'page');
      if (selection) rememberCardEditorSelection(card.id, 'side-panel', selection);
    }
    focusCard(null);
  };

  useEffect(() => {
    if (focusedCardId) {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && !activeElement.closest('.note-page') && activeElement !== document.body) {
        returnFocusRef.current = activeElement;
      }
      setRenderedCardId(focusedCardId);
      setRenderedSource(focusTransitionSource ?? 'canvas');
      setIsClosing(false);
      return;
    }
    if (!renderedCardId) return;
    setIsClosing(true);
    const closingCardId = renderedCardId;
    const closingSource = renderedSource;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const timer = window.setTimeout(() => {
      const rememberedTarget = returnFocusRef.current;
      const sidePanelTarget = closingSource === 'side-panel'
        ? document.querySelector<HTMLElement>('.card-side-panel [aria-label="展开卡片"]')
        : null;
      const canvasTarget = document.querySelector<HTMLElement>(`.canvas-node[data-card-id="${CSS.escape(closingCardId)}"] [aria-label="展开卡片"]`);
      const target = closingSource === 'side-panel'
        ? sidePanelTarget
        : rememberedTarget?.isConnected ? rememberedTarget : canvasTarget;
      // Transfer focus before unmounting the inert closing page. Chromium may
      // otherwise clear focus to <body> in the frame between those two steps.
      target?.focus({ preventScroll: true });
      returnFocusRef.current = null;
      setRenderedCardId(null);
      setIsClosing(false);
    }, reducedMotion ? 0 : 260);
    return () => window.clearTimeout(timer);
  }, [focusedCardId, focusTransitionSource, renderedCardId, renderedSource]);

  useEffect(() => {
    if (!card) return;
    const onKeyDown = (event: KeyboardEvent) => { if (!event.defaultPrevented && !isComposingKeyboardEvent(event) && event.key === 'Escape') closePage(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [card, closePage]);

  useLayoutEffect(() => {
    if (!card || !documentRef.current) return;
    const scrollTop = recallCardEditorScroll(card.id, 'page');
    documentRef.current.scrollTop = scrollTop;
    backButtonRef.current?.focus({ preventScroll: true });
    const frame = window.requestAnimationFrame(() => {
      if (documentRef.current) documentRef.current.scrollTop = scrollTop;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [card?.id]);

  if (!card) return null;
  const backlinks = (index.backlinks.get(card.id) ?? []).map((id) => cards.find((item) => item.id === id)).filter(Boolean);
  const outlinks = (index.outlinks.get(card.id) ?? []).map((id) => cards.find((item) => item.id === id)).filter(Boolean);
  const placements = index.placementsByCard.get(card.id) ?? [];
  const cardTags = [...new Set([...card.body.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)].map((match) => match[1].toLocaleLowerCase()))];

  return (
    <section
      className={`note-page note-page-from-${renderedSource} ${isClosing ? 'is-closing' : ''}`}
      aria-label={`编辑 ${card.title || '未命名卡片'}`}
      aria-hidden={isClosing}
      inert={isClosing}
    >
      <header className="note-page-topbar">
        <button ref={backButtonRef} aria-label={renderedSource === 'side-panel' ? '返回右侧栏' : '返回白板'} title={renderedSource === 'side-panel' ? '返回右侧栏' : '返回白板'} onClick={closePage}><ArrowLeft size={17} /></button>
        <span />
      </header>
      <article ref={documentRef} className="note-page-document" onScroll={(event) => rememberCardEditorScroll(card.id, 'page', event.currentTarget.scrollTop)}>
        <input
          value={card.title}
          aria-label="卡片标题"
          onChange={(event) => updateCard(card.id, { title: event.target.value })}
          placeholder="卡片标题"
        />
        <CardBodyEditor surface="page" card={card} cards={cards} updateCard={updateCard} onOpenCard={(cardId) => focusCard(cardId, renderedSource)} />
        {cardTags.length > 0 && <div className="card-tag-list">{cardTags.map((tag) => <button key={tag} onClick={() => window.dispatchEvent(new CustomEvent('opencanvas:quick-open', { detail: `#${tag}` }))}>#{tag}</button>)}</div>}
        {(backlinks.length > 0 || outlinks.length > 0 || placements.length > 0) && (
          <aside className="card-relations">
            <h3><Link2 size={15} /> 关联</h3>
            {backlinks.map((source) => source && <button key={source.id} onClick={() => focusCard(source.id, renderedSource)}>引用自：{source.title}</button>)}
            {outlinks.map((target) => target && <button key={target.id} onClick={() => focusCard(target.id, renderedSource)}>链接到：{target.title}</button>)}
            {placements.map((placement) => {
              const board = boards.find((item) => item.id === placement.boardId);
              return board ? <button key={placement.placementId} onClick={() => { openBoard(board.id); focusCard(null); }}>位于白板：{board.title}</button> : null;
            })}
          </aside>
        )}
      </article>
      <footer className="note-info-row"><span><Info size={14} /> Markdown 本地源文件 · {placements.length} 处放置</span></footer>
    </section>
  );
}
