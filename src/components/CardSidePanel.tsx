import { Maximize2, PanelRightClose } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { buildWorkspaceIndex } from '../domain/workspaceIndex';
import { recallCardEditorScroll, recallCardEditorSelection, rememberCardEditorScroll, rememberCardEditorSelection } from '../domain/editorViewState';
import { useWorkspaceStore } from '../store';
import CardBodyEditor from './CardBodyEditor';
import { CardIcon } from './icons/ProductIcons';

export default function CardSidePanel() {
  const cards = useWorkspaceStore((state) => state.cards);
  const boards = useWorkspaceStore((state) => state.boards);
  const cardId = useWorkspaceStore((state) => state.sidePanelCardId);
  const sidePanelOpen = useWorkspaceStore((state) => state.sidePanelOpen);
  const focusedCardId = useWorkspaceStore((state) => state.focusedCardId);
  const focusTransitionSource = useWorkspaceStore((state) => state.focusTransitionSource);
  const updateCard = useWorkspaceStore((state) => state.updateCard);
  const focusCard = useWorkspaceStore((state) => state.focusCard);
  const openCardInSidePanel = useWorkspaceStore((state) => state.openCardInSidePanel);
  const card = cards.find((item) => item.id === cardId);
  const index = useMemo(() => buildWorkspaceIndex(cards, boards), [cards, boards]);
  const [contentMounted, setContentMounted] = useState(sidePanelOpen);
  const [editorMounted, setEditorMounted] = useState(false);
  const documentRef = useRef<HTMLDivElement>(null);
  const focusDocumentAfterCardSwitchRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (sidePanelOpen && !wasOpenRef.current) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body && !active.closest('.card-side-panel')) returnFocusRef.current = active;
    }
    wasOpenRef.current = sidePanelOpen;
  }, [sidePanelOpen]);

  useEffect(() => {
    if (cardId && !card) openCardInSidePanel(null);
  }, [card, cardId, openCardInSidePanel]);

  useEffect(() => {
    const retainedBehindExpandedPage = focusTransitionSource === 'side-panel' && focusedCardId === card?.id;
    if ((sidePanelOpen || retainedBehindExpandedPage) && card) {
      setContentMounted(true);
      // Commit and paint the panel shell before constructing TipTap. On a
      // large workspace, editor setup must never hold the slide-in transform
      // at its off-screen start position.
      let secondFrame = 0;
      const firstFrame = window.requestAnimationFrame(() => {
        secondFrame = window.requestAnimationFrame(() => setEditorMounted(true));
      });
      return () => {
        window.cancelAnimationFrame(firstFrame);
        if (secondFrame) window.cancelAnimationFrame(secondFrame);
      };
    }
    // A page expanded from the side panel keeps this document as its visual
    // source until it returns. Ordinary panel closing still releases the hidden
    // ProseMirror instance after the slide-out animation.
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const timer = window.setTimeout(() => {
      setContentMounted(false);
      setEditorMounted(false);
    }, reducedMotion ? 0 : 240);
    return () => window.clearTimeout(timer);
  }, [card?.id, focusTransitionSource, focusedCardId, sidePanelOpen]);

  useLayoutEffect(() => {
    if (!card || !documentRef.current) return;
    const scrollTop = recallCardEditorScroll(card.id, 'side-panel');
    documentRef.current.scrollTop = scrollTop;
    const frame = window.requestAnimationFrame(() => {
      if (documentRef.current) documentRef.current.scrollTop = scrollTop;
      if (focusDocumentAfterCardSwitchRef.current) {
        focusDocumentAfterCardSwitchRef.current = false;
        documentRef.current?.focus({ preventScroll: true });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [card?.id, sidePanelOpen]);

  const openLinkedCard = (nextCardId: string) => {
    focusDocumentAfterCardSwitchRef.current = true;
    openCardInSidePanel(nextCardId);
  };

  const closePanel = () => {
    const closingCardId = card?.id;
    openCardInSidePanel(null);
    window.requestAnimationFrame(() => {
      const selector = closingCardId ? `.canvas-node[data-card-id="${CSS.escape(closingCardId)}"] .card-panel-toggle` : '';
      const target = (selector ? document.querySelector<HTMLElement>(selector) : null)
        ?? (returnFocusRef.current?.isConnected ? returnFocusRef.current : null)
        ?? document.querySelector<HTMLElement>('.board-path-title-field, .layers-toggle');
      target?.focus({ preventScroll: true });
      returnFocusRef.current = null;
    });
  };

  const expandCard = () => {
    if (!card) return;
    rememberCardEditorScroll(card.id, 'page', documentRef.current?.scrollTop ?? 0);
    const selection = recallCardEditorSelection(card.id, 'side-panel');
    if (selection) rememberCardEditorSelection(card.id, 'page', selection);
    focusCard(card.id, 'side-panel');
  };

  if (!card || (!sidePanelOpen && !contentMounted)) return <aside className="card-side-panel card-side-panel-collapsed" aria-hidden="true" />;
  const tags = [...new Set([...card.body.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)].map((match) => match[1].toLocaleLowerCase()))];
  const backlinks = (index.backlinks.get(card.id) ?? []).map((id) => cards.find((item) => item.id === id)).filter(Boolean);
  const outlinks = (index.outlinks.get(card.id) ?? []).map((id) => cards.find((item) => item.id === id)).filter(Boolean);

  return (
    <aside
      className={`card-side-panel ${sidePanelOpen ? '' : 'card-side-panel-collapsed'}`}
      aria-label={`侧栏卡片 ${card.title || '未命名卡片'}`}
      aria-hidden={!sidePanelOpen}
      inert={!sidePanelOpen}
    >
      <header className="card-side-panel-header">
        <span><CardIcon size={14} />卡片详情</span>
        <div>
          <button aria-label="展开卡片" title="展开卡片" onClick={expandCard}><Maximize2 size={16} /></button>
          <button aria-label="关闭卡片侧栏" title="关闭卡片侧栏" onClick={closePanel}><PanelRightClose size={17} /></button>
        </div>
      </header>
      <div
        ref={documentRef}
        className="card-side-panel-document"
        role="region"
        aria-label={`卡片内容 ${card.title || '未命名卡片'}`}
        tabIndex={-1}
        onScroll={(event) => rememberCardEditorScroll(card.id, 'side-panel', event.currentTarget.scrollTop)}
      >
        <input
          className="card-side-panel-title"
          value={card.title}
          aria-label="卡片标题"
          onChange={(event) => updateCard(card.id, { title: event.target.value })}
          placeholder="卡片标题"
        />
        {editorMounted ? <CardBodyEditor
          card={card}
          cards={cards}
          surface="side-panel"
          updateCard={updateCard}
          onOpenCard={openLinkedCard}
        /> : <div className="card-editor-loading card-editor-loading-document" aria-label="正在准备编辑器"><i /><i /><i /></div>}
        {tags.length > 0 && <div className="card-tag-list side-panel-tags">{tags.map((tag) => <button key={tag} onClick={() => window.dispatchEvent(new CustomEvent('opencanvas:quick-open', { detail: `#${tag}` }))}>#{tag}</button>)}</div>}
        {backlinks.length > 0 && <aside className="side-panel-backlinks"><strong>反向链接</strong>{backlinks.map((source) => source && <button key={source.id} onClick={() => openLinkedCard(source.id)}>{source.title || '未命名卡片'}</button>)}</aside>}
        {outlinks.length > 0 && <aside className="side-panel-backlinks"><strong>出链</strong>{outlinks.map((target) => target && <button key={target.id} onClick={() => openLinkedCard(target.id)}>{target.title || '未命名卡片'}</button>)}</aside>}
      </div>
    </aside>
  );
}
