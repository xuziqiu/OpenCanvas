import { ClipboardPaste, Ellipsis, Grid2x2, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { isComposingKeyboardEvent } from '../domain/keyboard';
import { clampOverlayPosition } from '../domain/overlayPosition';
import type { TidyAction } from '../domain/tidyLayout';
import ExitPresence from './ExitPresence';
import TidyMenu from './TidyMenu';
import { SectionIcon } from './icons/ProductIcons';

interface MultiSelectionToolbarProps {
  count: number;
  tidyOpen: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  viewport: { x: number; y: number; zoom: number };
  canvasSize: { width: number; height: number };
  onCreateSection: () => void;
  onToggleTidy: () => void;
  onCloseTidy: () => void;
  onDuplicate: () => void;
  onMore: (anchor: { x: number; y: number }) => void;
  onRemove: () => void;
  onTidy: (action: TidyAction) => void;
}

export default function MultiSelectionToolbar({ count, tidyOpen, bounds, viewport, canvasSize, onCreateSection, onToggleTidy, onCloseTidy, onDuplicate, onMore, onRemove, onTidy }: MultiSelectionToolbarProps) {
  const closeTidyRef = useRef(onCloseTidy);
  const tidyTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreTidyFocusRef = useRef(false);
  closeTidyRef.current = onCloseTidy;
  const closeTidyFromKeyboard = () => {
    restoreTidyFocusRef.current = true;
    closeTidyRef.current();
  };
  useLayoutEffect(() => {
    if (tidyOpen || !restoreTidyFocusRef.current) return;
    restoreTidyFocusRef.current = false;
    tidyTriggerRef.current?.focus({ preventScroll: true });
  }, [tidyOpen]);
  useEffect(() => {
    if (!tidyOpen) return;
    const dismiss = (event: PointerEvent) => { if (!(event.target as HTMLElement | null)?.closest('.multi-selection-ui')) closeTidyRef.current(); };
    const escape = (event: KeyboardEvent) => {
      if (isComposingKeyboardEvent(event) || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeTidyFromKeyboard();
    };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('pointerdown', dismiss); window.removeEventListener('keydown', escape, true); };
  }, [tidyOpen]);
  const width = 186;
  const height = 38;
  const centerX = viewport.x + (bounds.x + bounds.width / 2) * viewport.zoom;
  const selectionTop = viewport.y + bounds.y * viewport.zoom;
  const selectionBottom = viewport.y + (bounds.y + bounds.height) * viewport.zoom;
  const placeBelow = selectionTop < height + 16;
  const position = clampOverlayPosition({ x: centerX - width / 2, y: placeBelow ? selectionBottom + 8 : selectionTop - height - 8, width, height, viewportWidth: canvasSize.width, viewportHeight: canvasSize.height });
  return <div
    className={`multi-selection-ui ${placeBelow ? 'below-selection' : 'above-selection'}`}
    style={{ left: position.x, top: position.y }}
    onPointerDown={(event) => event.stopPropagation()}
    onKeyDownCapture={(event) => {
      if (!tidyOpen || isComposingKeyboardEvent(event.nativeEvent) || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      closeTidyFromKeyboard();
    }}
  >
    <div className="multi-selection-toolbar" role="toolbar" aria-label={`已选择 ${count} 个对象`}>
      <button aria-label="为选择创建区块" title="创建区块" onClick={onCreateSection}><SectionIcon size={16} /></button>
      <button ref={tidyTriggerRef} className={tidyOpen ? 'active' : ''} aria-label="整理选择" title="整理" aria-haspopup="menu" aria-expanded={tidyOpen} onClick={onToggleTidy}><Grid2x2 size={16} /></button>
      <button aria-label="创建选择的分身" title="创建分身" onClick={onDuplicate}><ClipboardPaste size={16} /></button>
      <button aria-label="更多多选操作" title="更多" onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        onMore({ x: rect.left, y: rect.bottom + 7 });
      }}><Ellipsis size={16} /></button>
      <button className="danger" aria-label="从白板移除所选对象" title="移除" onClick={onRemove}><Trash2 size={16} /></button>
    </div>
    <ExitPresence show={tidyOpen} duration={100}>{tidyOpen ? <div className="multi-selection-tidy" role="menu" aria-label="整理选择"><TidyMenu onAction={onTidy} /></div> : null}</ExitPresence>
  </div>;
}
