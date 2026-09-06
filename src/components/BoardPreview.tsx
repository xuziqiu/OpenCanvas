import { WhiteboardIcon } from './icons/ProductIcons';
import { useEffect, useRef, type ReactNode } from 'react';
import type { Board, Card } from '../types';

interface BoardPreviewProps {
  board: Board;
  cardMap: ReadonlyMap<string, Card>;
  boardMap: ReadonlyMap<string, Board>;
  titleSlot?: ReactNode;
  onTitleClick?: () => void;
  onTitleDoubleClick?: () => void;
  actions?: ReactNode;
}

export default function BoardPreview({ board, cardMap, boardMap, titleSlot, onTitleClick, onTitleDoubleClick, actions }: BoardPreviewProps) {
  const titlePointerDownRef = useRef<{ x: number; y: number } | null>(null);
  const titleClickTimerRef = useRef<number | null>(null);
  const titleClickActionRef = useRef(onTitleClick);
  titleClickActionRef.current = onTitleClick;
  useEffect(() => () => {
    if (titleClickTimerRef.current !== null) window.clearTimeout(titleClickTimerRef.current);
  }, []);
  let cardCount = 0;
  let whiteboardCount = 0;
  const items: Array<{ id: string; kind: 'card' | 'board' | 'text'; label: string }> = [];
  for (const placement of board.placements) {
    if (placement.kind === 'card') cardCount += 1;
    if (placement.kind === 'board') whiteboardCount += 1;
    // The preview can display at most sixteen chips. Keep counting the rest,
    // but do not parse thousands of Markdown bodies that can never be shown.
    if (items.length >= 16) continue;
    if (placement.kind === 'card' && placement.entityId) {
      const card = cardMap.get(placement.entityId);
      if (!card) continue;
      let label = card.title.trim();
      if (!label) {
        label = card.body
          .replace(/```[\s\S]*?```/g, ' ')
          .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
          .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
          .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]\s|\d+\.\s)\s*/gm, '')
          .replace(/[*_`~]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 32);
      }
      items.push({ id: placement.id, kind: 'card', label: label || '未命名卡片' });
      continue;
    }
    if (placement.kind === 'board' && placement.entityId) {
      const nested = boardMap.get(placement.entityId);
      if (nested) items.push({ id: placement.id, kind: 'board', label: nested.title });
      continue;
    }
    if (placement.kind === 'text' && placement.text?.trim()) items.push({ id: placement.id, kind: 'text', label: placement.text.trim() });
  }

  return <div className="shared-board-preview">
    <header>
      <WhiteboardIcon size={18} />
      <div className="shared-board-preview-heading">
        {titleSlot ?? <strong
          className={onTitleClick ? 'nested-board-title-action' : undefined}
          onPointerDown={(event) => { titlePointerDownRef.current = { x: event.clientX, y: event.clientY }; }}
          onClick={(event) => {
            const start = titlePointerDownRef.current;
            titlePointerDownRef.current = null;
            if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 3 || !onTitleClick) return;
            event.stopPropagation();
            if (titleClickTimerRef.current !== null) window.clearTimeout(titleClickTimerRef.current);
            if (event.detail > 1) { titleClickTimerRef.current = null; return; }
            titleClickTimerRef.current = window.setTimeout(() => {
              titleClickTimerRef.current = null;
              titleClickActionRef.current?.();
            }, 220);
          }}
          onDoubleClick={(event) => {
            if (!onTitleDoubleClick) return;
            event.stopPropagation();
            if (titleClickTimerRef.current !== null) window.clearTimeout(titleClickTimerRef.current);
            titleClickTimerRef.current = null;
            onTitleDoubleClick();
          }}
        >{board.title}</strong>}
        <small>{cardCount} 张卡片，{whiteboardCount} 个白板</small>
      </div>
      {actions && <div className="shared-board-preview-actions" onDoubleClick={(event) => event.stopPropagation()}>{actions}</div>}
    </header>
    <div className="shared-board-preview-items">
      {items.map((item) => <span key={item.id} className={`kind-${item.kind}`} title={item.label}>{item.kind === 'board' && <WhiteboardIcon size={11} />}<span className="shared-board-preview-label">{item.label}</span></span>)}
    </div>
  </div>;
}
