import { Eye, EyeOff, Lock, Search, Type, Unlock, X } from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { fixedVirtualRange, scrollTopToRevealFixedRow } from '../domain/fixedVirtualList';
import type { Board, BoardPlacement, Card } from '../types';
import { CardIcon, SectionIcon, WhiteboardIcon } from './icons/ProductIcons';

const LAYER_ROW_HEIGHT = 32;
const LAYER_OVERSCAN = 6;

interface CanvasLayersPanelProps {
  placements: BoardPlacement[];
  cards: Map<string, Card>;
  boards: Map<string, Board>;
  selectedIds: string[];
  onSelect: (placementId: string) => void;
  onReveal: (placementId: string) => void;
  onUpdate: (placementId: string, patch: Partial<BoardPlacement>) => void;
  onClose: () => void;
  'data-presence'?: 'open' | 'exiting';
}

interface LayerEntry {
  placement: BoardPlacement;
  title: string;
}

function layerTitle(placement: BoardPlacement, cards: Map<string, Card>, boards: Map<string, Board>) {
  if (placement.isFrame) return placement.text || '区块';
  if (placement.kind === 'card') return cards.get(placement.entityId || '')?.title || '缺失卡片';
  if (placement.kind === 'board') return boards.get(placement.entityId || '')?.title || '缺失白板';
  return placement.text || '文字';
}

function LayerKind({ placement }: { placement: BoardPlacement }) {
  if (placement.isFrame) return <SectionIcon size={13} />;
  if (placement.kind === 'card') return <CardIcon size={13} />;
  if (placement.kind === 'board') return <WhiteboardIcon size={13} />;
  return <Type size={13} />;
}

export default function CanvasLayersPanel({ placements, cards, boards, selectedIds, onSelect, onReveal, onUpdate, onClose, 'data-presence': presence }: CanvasLayersPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const focusRowRef = useRef(false);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(420);

  const entries = useMemo<LayerEntry[]>(() => placements
    .map((placement) => ({ placement, title: layerTitle(placement, cards, boards) }))
    .sort((a, b) => (b.placement.zIndex ?? 0) - (a.placement.zIndex ?? 0)), [boards, cards, placements]);
  const filteredEntries = useMemo(() => deferredQuery
    ? entries.filter((entry) => entry.title.toLocaleLowerCase().includes(deferredQuery))
    : entries, [deferredQuery, entries]);
  const primarySelectedId = selectedIds[0] ?? null;
  const selectedIndex = primarySelectedId ? filteredEntries.findIndex((entry) => entry.placement.id === primarySelectedId) : -1;
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, selectedIndex));
  const range = fixedVirtualRange(filteredEntries.length, LAYER_ROW_HEIGHT, viewportHeight, scrollTop, LAYER_OVERSCAN);
  const renderedEntries = filteredEntries.slice(range.start, range.end);

  const revealIndex = (index: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const nextScrollTop = scrollTopToRevealFixedRow(index, LAYER_ROW_HEIGHT, viewport.clientHeight, viewport.scrollTop);
    if (Math.abs(nextScrollTop - viewport.scrollTop) > .5) viewport.scrollTop = nextScrollTop;
    setScrollTop(nextScrollTop);
  };

  const focusActiveRow = () => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      if (!focusRowRef.current) return;
      panelRef.current?.querySelector<HTMLElement>('.layer-row[data-active="true"]')?.focus({ preventScroll: true });
      focusRowRef.current = false;
    }));
  };

  const activateIndex = (nextIndex: number, focus = true) => {
    if (!filteredEntries.length) return;
    const index = Math.max(0, Math.min(filteredEntries.length - 1, nextIndex));
    setActiveIndex(index);
    revealIndex(index);
    onSelect(filteredEntries[index].placement.id);
    if (focus) {
      focusRowRef.current = true;
      focusActiveRow();
    }
  };

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => setViewportHeight(viewport.clientHeight || 420);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (selectedIndex < 0) return;
    setActiveIndex(selectedIndex);
    revealIndex(selectedIndex);
  // Selection changes are the signal; list filtering has its own reset below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primarySelectedId]);

  useEffect(() => {
    setActiveIndex(0);
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop = 0;
    setScrollTop(0);
  }, [deferredQuery]);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.layers-panel, .layers-toggle')) return;
      onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (query && (event.target as HTMLElement | null)?.closest('.layers-search')) {
        event.preventDefault();
        setQuery('');
        return;
      }
      event.preventDefault();
      onClose();
      window.setTimeout(() => {
        if (!document.querySelector('.layers-panel[data-presence="open"]')) {
          document.querySelector<HTMLElement>('.layers-toggle')?.focus({ preventScroll: true });
        }
      }, 160);
    };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', escape);
    };
  }, [onClose, query]);

  const handleListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!filteredEntries.length) return;
    const page = Math.max(1, Math.floor(viewportHeight / LAYER_ROW_HEIGHT) - 1);
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = activeIndex + 1;
    if (event.key === 'ArrowUp') next = activeIndex - 1;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = filteredEntries.length - 1;
    if (event.key === 'PageDown') next = activeIndex + page;
    if (event.key === 'PageUp') next = activeIndex - page;
    if (next !== null) {
      event.preventDefault();
      activateIndex(next);
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && filteredEntries[activeIndex]) {
      event.preventDefault();
      onReveal(filteredEntries[activeIndex].placement.id);
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'f') {
      event.preventDefault();
      panelRef.current?.querySelector<HTMLInputElement>('.layers-search input')?.focus();
    }
  };

  return <aside ref={panelRef} className="layers-panel" data-presence={presence} aria-label="白板图层">
    <header>
      <div><strong>图层</strong><span aria-live="polite">{filteredEntries.length === entries.length ? entries.length : `${filteredEntries.length} / ${entries.length}`}</span></div>
      <button aria-label="关闭图层面板" title="关闭" onClick={onClose}><X size={14} /></button>
    </header>
    <label className="layers-search">
      <Search size={13} aria-hidden="true" />
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索图层" aria-label="搜索图层" />
      {query && <button type="button" aria-label="清空图层搜索" onClick={() => setQuery('')}><X size={12} /></button>}
    </label>
    <div
      ref={viewportRef}
      className="layers-list-viewport"
      role="listbox"
      aria-label="图层列表"
      aria-setsize={filteredEntries.length}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      onKeyDown={handleListKeyDown}
    >
      {!filteredEntries.length && <div className="layers-empty">{query ? '没有匹配的图层' : '当前白板没有对象'}</div>}
      <div className="layers-list-spacer" style={{ height: range.totalHeight }}>
        {renderedEntries.map((entry, localIndex) => {
          const index = range.start + localIndex;
          const { placement, title } = entry;
          const selected = selectedIds.includes(placement.id);
          const active = index === activeIndex;
          return <div
            className={`layer-row ${selected ? 'selected' : ''} ${active ? 'active' : ''} ${placement.hidden ? 'is-hidden' : ''}`}
            key={placement.id}
            role="option"
            aria-selected={selected}
            aria-posinset={index + 1}
            aria-setsize={filteredEntries.length}
            data-placement-id={placement.id}
            data-active={active}
            tabIndex={active ? 0 : -1}
            title={`${title} · 双击定位`}
            style={{ transform: `translateY(${index * LAYER_ROW_HEIGHT}px)` }}
            onFocus={() => setActiveIndex(index)}
            onClick={() => { setActiveIndex(index); onSelect(placement.id); }}
            onDoubleClick={() => onReveal(placement.id)}
          >
            <span className="layer-kind"><LayerKind placement={placement} /></span>
            <strong>{title}</strong>
            <button aria-label={`${placement.hidden ? '显示' : '隐藏'} ${title}`} title={placement.hidden ? '显示' : '隐藏'} onClick={(event) => { event.stopPropagation(); onUpdate(placement.id, { hidden: !placement.hidden }); }}>{placement.hidden ? <EyeOff size={13} /> : <Eye size={13} />}</button>
            <button aria-label={`${placement.locked ? '解锁' : '锁定'} ${title}`} title={placement.locked ? '解锁' : '锁定'} onClick={(event) => { event.stopPropagation(); onUpdate(placement.id, { locked: !placement.locked }); }}>{placement.locked ? <Lock size={13} /> : <Unlock size={13} />}</button>
          </div>;
        })}
      </div>
    </div>
    <footer>↑↓ 浏览 · Enter 定位 · Ctrl+F 搜索</footer>
  </aside>;
}
