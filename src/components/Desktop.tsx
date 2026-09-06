import {
  AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd, AlignHorizontalJustifyStart, AlignHorizontalSpaceBetween,
  AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, AlignVerticalJustifyStart, AlignVerticalSpaceBetween,
  Columns2, FolderKanban, Grid2x2, LocateFixed, Minus, MoreHorizontal, Pencil, Plus, Rows2, Trash2,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { normalizedWheelDelta, rectanglesIntersect, snapBoxToNearbyObjects, snapResizeBoxToNearbyObjects, zoomViewportAtPoint, type AlignmentGuideLine, type ResizeEdges } from '../domain/interaction';
import { emptyDesktopHistory, recordDesktopHistory, redoDesktopHistory, undoDesktopHistory } from '../domain/desktopHistory';
import { desktopBoardKeyboardAction } from '../domain/desktopKeyboard';
import { tidyPlacementPositions, type TidyAction } from '../domain/tidyLayout';
import { isComposingKeyboardEvent } from '../domain/keyboard';
import { clampOverlayPosition } from '../domain/overlayPosition';
import { createLatestFrameBatch, pointerFrameSample } from '../domain/frameBatch';
import { isAdditiveSelectionModifier, togglePlacementId } from '../domain/placementSelectionGesture';
import { hasPointerDragIntent } from '../domain/pointerDragIntent';
import { boardReferenceImpact, findRootBoards } from '../domain/workspaceIndex';
import type { Board, DesktopBoardPlacement } from '../types';
import { useWorkspaceStore } from '../store';
import { isNativeVault, vaultApi } from '../vault';
import ExitPresence from './ExitPresence';
import { handleMenuKeyDown } from './menuKeyboard';
import AsyncActionButton, { useAsyncActionGate } from './AsyncActionButton';
import { DesktopIcon, WhiteboardIcon } from './icons/ProductIcons';

const BookOpen = WhiteboardIcon;

type BoardMenu = { boardId: string; x: number; y: number } | null;
type CanvasMenu = { x: number; y: number; world: { x: number; y: number } } | null;
type ResizeDirection = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

const BoardPreview = lazy(() => import('./BoardPreview'));

const RESIZE_HANDLES: ResizeDirection[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export default function Desktop() {
  const { pendingAction, runAction } = useAsyncActionGate();
  const boards = useWorkspaceStore((state) => state.boards);
  const cards = useWorkspaceStore((state) => state.cards);
  const projects = useWorkspaceStore((state) => state.projects);
  const desktop = useWorkspaceStore((state) => state.desktop);
  const createBoard = useWorkspaceStore((state) => state.createBoard);
  const openBoard = useWorkspaceStore((state) => state.openBoard);
  const updateBoard = useWorkspaceStore((state) => state.updateBoard);
  const deleteBoard = useWorkspaceStore((state) => state.deleteBoard);
  const organizeBoardAsProject = useWorkspaceStore((state) => state.organizeBoardAsProject);
  const unbindBoardProject = useWorkspaceStore((state) => state.unbindBoardProject);
  const exportBoardBundle = useWorkspaceStore((state) => state.exportBoardBundle);
  const updateDesktopPlacement = useWorkspaceStore((state) => state.updateDesktopPlacement);
  const updateDesktopPlacements = useWorkspaceStore((state) => state.updateDesktopPlacements);
  const setDesktopViewport = useWorkspaceStore((state) => state.setDesktopViewport);
  const [menu, setMenu] = useState<BoardMenu>(null);
  const [canvasMenu, setCanvasMenu] = useState<CanvasMenu>(null);
  const [selectedBoardIds, setSelectedBoardIds] = useState<string[]>([]);
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuideLine[]>([]);
  const [editingBoardId, setEditingBoardId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [projectBoard, setProjectBoard] = useState<Board | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Board | null>(null);
  const [arrangingBoardIds, setArrangingBoardIds] = useState<string[]>([]);
  const [wheelZooming, setWheelZooming] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const wheelViewportRef = useRef(desktop.viewport);
  const wheelFrameRef = useRef<number | null>(null);
  const pendingWheelViewportRef = useRef<typeof desktop.viewport | null>(null);
  const wheelFeedbackTimerRef = useRef<number | null>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const spacePressed = useRef(false);
  const desktopHistory = useRef(emptyDesktopHistory());
  const gestureCancelRef = useRef<(() => void) | null>(null);
  const tidyAnimationFrameRef = useRef<number | null>(null);
  const tidyAnimationTimerRef = useRef<number | null>(null);

  const rootBoards = useMemo(() => findRootBoards(boards), [boards]);
  const rootIds = useMemo(() => new Set(rootBoards.map((board) => board.id)), [rootBoards]);
  const cardMap = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards]);
  const boardMap = useMemo(() => new Map(boards.map((board) => [board.id, board])), [boards]);
  const placementMap = useMemo(() => new Map(desktop.placements.map((placement) => [placement.boardId, placement])), [desktop.placements]);
  const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const deleteImpact = deleteTarget ? boardReferenceImpact(boards, deleteTarget.id) : null;
  if (wheelFrameRef.current === null) wheelViewportRef.current = desktop.viewport;
  useEffect(() => () => {
    if (wheelFrameRef.current !== null) window.cancelAnimationFrame(wheelFrameRef.current);
    if (wheelFeedbackTimerRef.current !== null) window.clearTimeout(wheelFeedbackTimerRef.current);
    if (tidyAnimationFrameRef.current !== null) window.cancelAnimationFrame(tidyAnimationFrameRef.current);
    if (tidyAnimationTimerRef.current !== null) window.clearTimeout(tidyAnimationTimerRef.current);
    gestureCancelRef.current?.();
  }, []);

  const finishWheelFeedback = () => {
    if (wheelFeedbackTimerRef.current !== null) window.clearTimeout(wheelFeedbackTimerRef.current);
    wheelFeedbackTimerRef.current = null;
    setWheelZooming(false);
  };
  const consumePendingWheelViewport = () => {
    const liveViewport = useWorkspaceStore.getState().desktop.viewport;
    const latest = wheelFrameRef.current !== null && pendingWheelViewportRef.current
      ? pendingWheelViewportRef.current
      : liveViewport;
    if (wheelFrameRef.current !== null) window.cancelAnimationFrame(wheelFrameRef.current);
    wheelFrameRef.current = null;
    pendingWheelViewportRef.current = null;
    wheelViewportRef.current = latest;
    finishWheelFeedback();
    if (latest !== desktop.viewport) setDesktopViewport(latest);
    return latest;
  };

  useEffect(() => {
    if (!menu && !canvasMenu) return;
    const dismiss = (event: PointerEvent) => {
      if (!(event.target as HTMLElement | null)?.closest('.desktop-board-menu, .desktop-canvas-menu')) { setMenu(null); setCanvasMenu(null); }
    };
    const escape = (event: KeyboardEvent) => { if (!isComposingKeyboardEvent(event) && event.key === 'Escape') { setMenu(null); setCanvasMenu(null); } };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', dismiss); window.removeEventListener('keydown', escape); };
  }, [canvasMenu, menu]);

  useEffect(() => { if (editingBoardId) renameInput.current?.select(); }, [editingBoardId]);

  useEffect(() => {
    const cancel = () => gestureCancelRef.current?.();
    const escape = (event: KeyboardEvent) => { if (!isComposingKeyboardEvent(event) && event.key === 'Escape' && gestureCancelRef.current) { event.preventDefault(); cancel(); } };
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('blur', cancel); window.removeEventListener('keydown', escape); };
  }, []);

  const applyDesktopSnapshot = (snapshot: DesktopBoardPlacement[]) => {
    updateDesktopPlacements(Object.fromEntries(snapshot.map((placement) => [placement.boardId, placement])));
  };
  const commitDesktopTransaction = (before: DesktopBoardPlacement[], label = '调整桌面白板') => {
    const after = useWorkspaceStore.getState().desktop.placements;
    desktopHistory.current = recordDesktopHistory(desktopHistory.current, label, before, after);
  };
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (isComposingKeyboardEvent(event)) return;
      if (event.code === 'Space' && !(event.target as HTMLElement | null)?.closest('input, textarea, [contenteditable="true"]')) {
        spacePressed.current = true;
        event.preventDefault();
      }
      if (!(event.ctrlKey || event.metaKey) || (event.target as HTMLElement | null)?.closest('input, textarea, [contenteditable="true"]')) return;
      const redo = event.key.toLocaleLowerCase() === 'y' || (event.key.toLocaleLowerCase() === 'z' && event.shiftKey);
      const undo = event.key.toLocaleLowerCase() === 'z' && !event.shiftKey;
      if (!undo && !redo) return;
      const current = useWorkspaceStore.getState().desktop.placements;
      const result = redo ? redoDesktopHistory(desktopHistory.current, current) : undoDesktopHistory(desktopHistory.current, current);
      if (!result) return;
      event.preventDefault();
      desktopHistory.current = result.history;
      applyDesktopSnapshot(result.placements);
    };
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') spacePressed.current = false; };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [updateDesktopPlacements]);

  const startRename = (board: Board) => { setMenu(null); setEditingBoardId(board.id); setTitleDraft(board.title); };
  const finishRename = (save = true) => {
    const board = boards.find((item) => item.id === editingBoardId);
    if (save && board) updateBoard(board.id, { title: renameInput.current?.value.trim() || titleDraft.trim() || '未命名白板' });
    setEditingBoardId(null);
  };
  useEffect(() => {
    if (!editingBoardId) return;
    const finishOutside = (event: PointerEvent) => {
      if ((event.target as HTMLElement | null)?.closest('.desktop-board-rename')) return;
      const board = boards.find((item) => item.id === editingBoardId);
      const nextTitle = renameInput.current?.value.trim() || titleDraft.trim() || '未命名白板';
      if (board) updateBoard(board.id, { title: nextTitle });
      setEditingBoardId(null);
    };
    window.addEventListener('pointerdown', finishOutside, true);
    return () => window.removeEventListener('pointerdown', finishOutside, true);
  }, [boards, editingBoardId, titleDraft, updateBoard]);

  const screenToWorld = (clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const viewport = pendingWheelViewportRef.current ?? desktop.viewport;
    return { x: (clientX - rect.left - viewport.x) / viewport.zoom, y: (clientY - rect.top - viewport.y) / viewport.zoom };
  };
  const makeBoard = (position?: { x: number; y: number }) => {
    const board = createBoard('未命名白板');
    const rect = canvasRef.current?.getBoundingClientRect();
    const center = position ?? (rect ? screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2) : { x: 160, y: 120 });
    updateDesktopPlacement(board.id, { x: center.x - 215, y: center.y - 135, width: 430, height: 270 });
    setSelectedBoardIds([board.id]);
    setEditingBoardId(board.id);
    setTitleDraft(board.title);
  };
  const startNodeDrag = (event: React.PointerEvent, placement: DesktopBoardPlacement) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button, input')) return;
    event.preventDefault();
    event.stopPropagation();
    const gestureViewport = consumePendingWheelViewport();
    gestureCancelRef.current?.();
    const initiallySelected = selectedBoardIds.includes(placement.boardId);
    const selectionBefore = [...selectedBoardIds];
    const dragIds = initiallySelected ? selectedBoardIds : [placement.boardId];
    const additiveSelectionClick = isAdditiveSelectionModifier(event);
    const before = useWorkspaceStore.getState().desktop.placements.map((item) => ({ ...item }));
    const starts = new Map(before.filter((item) => dragIds.includes(item.boardId)).map((item) => [item.boardId, item]));
    const start = { x: event.clientX, y: event.clientY, placement: starts.get(placement.boardId) ?? placement };
    let moved = false;
    const moves = createLatestFrameBatch((next: ReturnType<typeof pointerFrameSample>) => {
      const dx = (next.clientX - start.x) / gestureViewport.zoom;
      const dy = (next.clientY - start.y) / gestureViewport.zoom;
      const rawAnchor = { id: placement.boardId, x: start.placement.x + dx, y: start.placement.y + dy, width: start.placement.width, height: start.placement.height };
      const candidates = before.filter((item) => rootIds.has(item.boardId) && !dragIds.includes(item.boardId)).map((item) => ({ ...item, id: item.boardId }));
      const snapped = snapBoxToNearbyObjects(rawAnchor, candidates, { disabled: next.altKey, enhanced: next.shiftKey, zoom: gestureViewport.zoom });
      const snapDx = snapped.x - rawAnchor.x;
      const snapDy = snapped.y - rawAnchor.y;
      setAlignmentGuides(snapped.guides);
      updateDesktopPlacements(Object.fromEntries([...starts].map(([boardId, item]) => [boardId, { x: item.x + dx + snapDx, y: item.y + dy + snapDy }])));
    });
    const move = (next: PointerEvent) => {
      if (!moved && !hasPointerDragIntent(start, { x: next.clientX, y: next.clientY })) return;
      if (!moved) {
        moved = true;
        if (!initiallySelected) setSelectedBoardIds([placement.boardId]);
      }
      next.preventDefault();
      moves.push(pointerFrameSample(next));
    };
    const cancel = () => {
      moves.cancel();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      setAlignmentGuides([]);
      if (moved) applyDesktopSnapshot(before);
      setSelectedBoardIds(selectionBefore);
      gestureCancelRef.current = null;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      setAlignmentGuides([]);
      if (moved) { moves.flush(); commitDesktopTransaction(before, '移动白板'); }
      else {
        moves.cancel();
        if (additiveSelectionClick) setSelectedBoardIds((current) => togglePlacementId(current, placement.boardId));
        else setSelectedBoardIds([placement.boardId]);
      }
      gestureCancelRef.current = null;
    };
    gestureCancelRef.current = cancel;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel, { once: true });
  };
  const startPan = (event: React.PointerEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('.desktop-board-node, .desktop-floating-header, .desktop-zoom-controls')) return;
    event.preventDefault();
    const gestureViewport = consumePendingWheelViewport();
    gestureCancelRef.current?.();
    setMenu(null);
    setCanvasMenu(null);
    const shouldPan = event.button === 1 || (event.button === 0 && spacePressed.current);
    if (!shouldPan && event.button !== 0) return;
    if (!shouldPan) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const origin = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const selectionBefore = [...selectedBoardIds];
      const additiveMarquee = isAdditiveSelectionModifier(event);
      const existing = additiveMarquee ? selectedBoardIds : [];
      if (!additiveMarquee) setSelectedBoardIds([]);
      const moves = createLatestFrameBatch((next: ReturnType<typeof pointerFrameSample>) => {
        const point = { x: next.clientX - rect.left, y: next.clientY - rect.top };
        const box = { left: Math.min(origin.x, point.x), top: Math.min(origin.y, point.y), width: Math.abs(point.x - origin.x), height: Math.abs(point.y - origin.y) };
        setMarquee(box);
        const world = { x: (box.left - desktop.viewport.x) / desktop.viewport.zoom, y: (box.top - desktop.viewport.y) / desktop.viewport.zoom, width: box.width / desktop.viewport.zoom, height: box.height / desktop.viewport.zoom };
        const hits = desktop.placements.filter((placement) => rootIds.has(placement.boardId) && rectanglesIntersect(world, placement)).map((placement) => placement.boardId);
        setSelectedBoardIds([...new Set([...existing, ...hits])]);
      });
      const move = (next: PointerEvent) => { next.preventDefault(); moves.push(pointerFrameSample(next)); };
      const cancel = () => { moves.cancel(); setMarquee(null); setSelectedBoardIds(selectionBefore); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); gestureCancelRef.current = null; };
      const up = () => { moves.flush(); setMarquee(null); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); gestureCancelRef.current = null; };
      gestureCancelRef.current = cancel;
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel, { once: true });
      return;
    }
    const start = { x: event.clientX, y: event.clientY, viewport: gestureViewport };
    const moves = createLatestFrameBatch((next: ReturnType<typeof pointerFrameSample>) => setDesktopViewport({ ...start.viewport, x: start.viewport.x + next.clientX - start.x, y: start.viewport.y + next.clientY - start.y }));
    const move = (next: PointerEvent) => { next.preventDefault(); moves.push(pointerFrameSample(next)); };
    const cancel = () => { moves.cancel(); setDesktopViewport(start.viewport); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); gestureCancelRef.current = null; };
    const up = () => { moves.flush(); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); gestureCancelRef.current = null; };
    gestureCancelRef.current = cancel;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel, { once: true });
  };
  const handleWheel = (event: React.WheelEvent) => {
    event.preventDefault();
    setWheelZooming(true);
    if (wheelFeedbackTimerRef.current !== null) window.clearTimeout(wheelFeedbackTimerRef.current);
    wheelFeedbackTimerRef.current = window.setTimeout(() => {
      wheelFeedbackTimerRef.current = null;
      setWheelZooming(false);
    }, 170);
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const next = zoomViewportAtPoint(wheelViewportRef.current, pointer, normalizedWheelDelta(event.deltaY, event.deltaMode, rect.height), .0012, .25, 2.2);
    wheelViewportRef.current = next;
    pendingWheelViewportRef.current = next;
    if (wheelFrameRef.current === null) {
      wheelFrameRef.current = window.requestAnimationFrame(() => {
        wheelFrameRef.current = null;
        const pending = pendingWheelViewportRef.current;
        pendingWheelViewportRef.current = null;
        if (pending) setDesktopViewport(pending);
      });
    }
  };
  const zoomDesktopAtCenter = (nextZoom: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const base = consumePendingWheelViewport();
    const zoom = clamp(nextZoom, .25, 2.2);
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const wx = (cx - base.x) / base.zoom;
    const wy = (cy - base.y) / base.zoom;
    setDesktopViewport({ zoom, x: cx - wx * zoom, y: cy - wy * zoom });
  };
  const startResize = (event: React.PointerEvent, placement: DesktopBoardPlacement, direction: ResizeDirection) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const gestureViewport = consumePendingWheelViewport();
    gestureCancelRef.current?.();
    const before = useWorkspaceStore.getState().desktop.placements.map((item) => ({ ...item }));
    const start = { x: event.clientX, y: event.clientY, placement: { ...placement } };
    const edges: ResizeEdges = { left: direction.includes('w'), right: direction.includes('e'), top: direction.includes('n'), bottom: direction.includes('s') };
    const moves = createLatestFrameBatch((next: ReturnType<typeof pointerFrameSample>) => {
      const dx = (next.clientX - start.x) / gestureViewport.zoom;
      const dy = (next.clientY - start.y) / gestureViewport.zoom;
      let x = start.placement.x;
      let y = start.placement.y;
      let width = start.placement.width;
      let height = start.placement.height;
      if (edges.left) { x += dx; width -= dx; }
      if (edges.right) width += dx;
      if (edges.top) { y += dy; height -= dy; }
      if (edges.bottom) height += dy;
      if (width < 240) { if (edges.left) x -= 240 - width; width = 240; }
      if (height < 170) { if (edges.top) y -= 170 - height; height = 170; }
      const candidates = before.filter((item) => rootIds.has(item.boardId) && item.boardId !== placement.boardId).map((item) => ({ ...item, id: item.boardId }));
      const snapped = snapResizeBoxToNearbyObjects({ id: placement.boardId, x, y, width, height }, candidates, { edges, disabled: next.altKey, enhanced: next.shiftKey, zoom: gestureViewport.zoom });
      setAlignmentGuides(snapped.guides);
      updateDesktopPlacement(placement.boardId, { x: snapped.x, y: snapped.y, width: snapped.width, height: snapped.height });
    });
    const move = (next: PointerEvent) => { next.preventDefault(); moves.push(pointerFrameSample(next)); };
    const cancel = () => {
      moves.cancel();
      setAlignmentGuides([]);
      applyDesktopSnapshot(before);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      gestureCancelRef.current = null;
    };
    const up = () => {
      setAlignmentGuides([]);
      moves.flush();
      commitDesktopTransaction(before, '调整白板大小');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      gestureCancelRef.current = null;
    };
    gestureCancelRef.current = cancel;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel, { once: true });
  };
  const tidyDesktopSelection = (action: TidyAction) => {
    const before = useWorkspaceStore.getState().desktop.placements.map((item) => ({ ...item }));
    const selected = before.filter((item) => selectedBoardIds.includes(item.boardId)).map((item) => ({ ...item, id: item.boardId }));
    const positions = tidyPlacementPositions(selected, action);
    if (tidyAnimationFrameRef.current !== null) window.cancelAnimationFrame(tidyAnimationFrameRef.current);
    if (tidyAnimationTimerRef.current !== null) window.clearTimeout(tidyAnimationTimerRef.current);
    setArrangingBoardIds(selectedBoardIds);
    tidyAnimationFrameRef.current = window.requestAnimationFrame(() => {
      tidyAnimationFrameRef.current = null;
      updateDesktopPlacements(positions);
      commitDesktopTransaction(before, '整理桌面白板');
      tidyAnimationTimerRef.current = window.setTimeout(() => {
        tidyAnimationTimerRef.current = null;
        setArrangingBoardIds([]);
      }, 230);
    });
    setMenu(null);
  };
  const fitBoards = () => {
    consumePendingWheelViewport();
    const placements = desktop.placements.filter((placement) => rootIds.has(placement.boardId));
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || !placements.length) return;
    const minX = Math.min(...placements.map((item) => item.x));
    const minY = Math.min(...placements.map((item) => item.y));
    const maxX = Math.max(...placements.map((item) => item.x + item.width));
    const maxY = Math.max(...placements.map((item) => item.y + item.height));
    const zoom = clamp(Math.min((rect.width - 150) / Math.max(1, maxX - minX), (rect.height - 150) / Math.max(1, maxY - minY)), .25, 1.15);
    setDesktopViewport({ x: (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom, y: (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom, zoom });
  };
  const tidyGroups: Array<{ label: string; items: Array<{ action: TidyAction; label: string; Icon: typeof AlignHorizontalJustifyStart }> }> = [
    { label: '对齐', items: [
      { action: 'align-left', label: '左对齐', Icon: AlignHorizontalJustifyStart },
      { action: 'align-center', label: '水平居中', Icon: AlignHorizontalJustifyCenter },
      { action: 'align-right', label: '右对齐', Icon: AlignHorizontalJustifyEnd },
      { action: 'align-top', label: '顶部对齐', Icon: AlignVerticalJustifyStart },
      { action: 'align-middle', label: '垂直居中', Icon: AlignVerticalJustifyCenter },
      { action: 'align-bottom', label: '底部对齐', Icon: AlignVerticalJustifyEnd },
    ] },
    { label: '间距', items: [
      { action: 'distribute-horizontal', label: '水平等距', Icon: AlignHorizontalSpaceBetween },
      { action: 'distribute-vertical', label: '垂直等距', Icon: AlignVerticalSpaceBetween },
    ] },
    { label: '布局', items: [
      { action: 'rack-horizontal', label: '横向排列', Icon: Columns2 },
      { action: 'stack-vertical', label: '纵向堆叠', Icon: Rows2 },
      { action: 'grid', label: '网格整理', Icon: Grid2x2 },
    ] },
  ];
  return <section className="desktop-view desktop-spatial-view">
    <div ref={canvasRef} className={`desktop-infinite-canvas ${wheelZooming ? 'is-wheel-zooming' : ''}`} onPointerDown={startPan} onWheel={handleWheel} onContextMenu={(event) => {
      if ((event.target as HTMLElement).closest('.desktop-board-node')) return;
      event.preventDefault();
      setSelectedBoardIds([]);
      const position = clampOverlayPosition({ x: event.clientX, y: event.clientY, width: 220, height: 150, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
      setCanvasMenu({ x: position.x, y: position.y, world: screenToWorld(event.clientX, event.clientY) });
    }}>
      <header className="desktop-floating-header">
        <span className="desktop-heading-icon"><DesktopIcon size={18} /></span>
        <div><h1>桌面</h1><p>根白板空间</p></div>
        <button className="desktop-new-board" onClick={() => makeBoard()}><Plus size={16} />新建白板</button>
      </header>
      <div className="desktop-scene" style={{ transform: `translate(${desktop.viewport.x}px, ${desktop.viewport.y}px) scale(${desktop.viewport.zoom})` }}>
        {rootBoards.map((board) => {
          const placement = placementMap.get(board.id);
          if (!placement) return null;
          const project = board.projectId ? projectMap.get(board.projectId) : undefined;
          return <article
            className={`desktop-board-node ${selectedBoardIds.includes(board.id) ? 'selected' : ''} ${arrangingBoardIds.includes(board.id) ? 'is-arranging' : ''}`}
            key={board.id}
            tabIndex={0}
            aria-label={`白板：${board.title}${selectedBoardIds.includes(board.id) ? '，已选择' : ''}`}
            style={{ left: placement.x, top: placement.y, width: placement.width, height: placement.height }}
            onPointerDown={(event) => startNodeDrag(event, placement)}
            onDoubleClick={(event) => { if (!(event.target as HTMLElement).closest('input, .desktop-board-more')) openBoard(board.id); }}
            onKeyDown={(event) => {
              const action = desktopBoardKeyboardAction(event.key, event.shiftKey, event.target === event.currentTarget);
              if (!action) return;
              event.preventDefault();
              if (action === 'open') { openBoard(board.id); return; }
              if (action === 'select') { setSelectedBoardIds([board.id]); return; }
              if (action === 'menu') {
                if (!selectedBoardIds.includes(board.id)) setSelectedBoardIds([board.id]);
                const rect = event.currentTarget.getBoundingClientRect();
                const position = clampOverlayPosition({ x: rect.left + 22, y: rect.top + 36, width: 270, height: 410, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
                setMenu({ boardId: board.id, x: position.x, y: position.y });
              }
            }}
            onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); if (!selectedBoardIds.includes(board.id)) setSelectedBoardIds([board.id]); const position = clampOverlayPosition({ x: event.clientX, y: event.clientY, width: 270, height: 410, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight }); setMenu({ boardId: board.id, x: position.x, y: position.y }); }}
          >
            <Suspense fallback={<div className="shared-board-preview board-preview-loading" aria-hidden="true" />}>
              <BoardPreview
                board={board}
                boardMap={boardMap}
                cardMap={cardMap}
                titleSlot={editingBoardId === board.id ? <input ref={renameInput} className="desktop-board-rename" value={titleDraft} aria-label="重命名白板" onPointerDown={(event) => event.stopPropagation()} onChange={(event) => setTitleDraft(event.target.value)} onBlur={() => finishRename(true)} onKeyDown={(event) => { if (isComposingKeyboardEvent(event.nativeEvent)) return; if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { event.preventDefault(); finishRename(false); } }} /> : undefined}
                actions={<>{project && <span className="desktop-project-badge" title={`项目目录：${project.relativePath}`}><FolderKanban size={12} /></span>}<button className="desktop-board-more" aria-label={`${board.title} 更多操作`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { if (!selectedBoardIds.includes(board.id)) setSelectedBoardIds([board.id]); const rect = event.currentTarget.getBoundingClientRect(); const position = clampOverlayPosition({ x: rect.right - 210, y: rect.bottom + 5, width: 210, height: 250, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight }); setMenu({ boardId: board.id, x: position.x, y: position.y }); }}><MoreHorizontal size={16} /></button></>}
              />
            </Suspense>
            {selectedBoardIds.length === 1 && selectedBoardIds[0] === board.id && RESIZE_HANDLES.map((direction) => <span key={direction} className={`desktop-resize-handle desktop-resize-${direction}`} aria-hidden="true" onPointerDown={(event) => startResize(event, placement, direction)} />)}
          </article>;
        })}
        <ExitPresence show={alignmentGuides.length > 0} duration={90}>{alignmentGuides.length ? <div className="desktop-alignment-guides-layer" aria-hidden="true">
          {alignmentGuides.map((guide, index) => guide.axis === 'x'
            ? <i key={`x-${guide.position}-${index}`} className="desktop-alignment-guide desktop-alignment-guide-x" style={{ left: guide.position, top: guide.from, height: guide.to - guide.from }} />
            : <i key={`y-${guide.position}-${index}`} className="desktop-alignment-guide desktop-alignment-guide-y" style={{ left: guide.from, top: guide.position, width: guide.to - guide.from }} />)}
        </div> : null}</ExitPresence>
      </div>
      {marquee && <div className="selection-marquee desktop-selection-marquee" style={marquee} />}
      {!rootBoards.length && <button className="desktop-empty-create" onClick={() => makeBoard()}><Plus size={20} /><strong>新建第一个根白板</strong></button>}
      <div className={`desktop-zoom-controls ${wheelZooming ? 'is-zooming' : ''}`} aria-label="桌面缩放控制"><button className="desktop-zoom-value" aria-label={`当前桌面缩放 ${Math.round(desktop.viewport.zoom * 100)}%，点击恢复到 90%`} title="恢复到 90%" onClick={() => zoomDesktopAtCenter(.9)}>{Math.round(desktop.viewport.zoom * 100)}%</button><button aria-label="放大桌面" title="放大" onClick={() => zoomDesktopAtCenter((pendingWheelViewportRef.current ?? desktop.viewport).zoom + .1)}><Plus size={16} /></button><button aria-label="缩小桌面" title="缩小" onClick={() => zoomDesktopAtCenter((pendingWheelViewportRef.current ?? desktop.viewport).zoom - .1)}><Minus size={16} /></button><button aria-label="适应所有白板" title="适应所有白板" onClick={fitBoards}><LocateFixed size={15} /></button></div>
    </div>

    <ExitPresence show={Boolean(canvasMenu)} duration={110}>{canvasMenu ? <div className="canvas-context-menu desktop-canvas-menu" role="menu" aria-label="桌面操作" onKeyDown={handleMenuKeyDown} style={{ left: canvasMenu.x, top: canvasMenu.y }}><div className="context-menu-heading">桌面</div><button role="menuitem" onClick={() => { makeBoard(canvasMenu.world); setCanvasMenu(null); }}><Plus size={15} /><span>在这里新建白板</span></button><button role="menuitem" onClick={() => { fitBoards(); setCanvasMenu(null); }}><LocateFixed size={15} /><span>适应所有白板</span></button></div> : null}</ExitPresence>
    <ExitPresence show={Boolean(menu)} duration={110}>{menu ? (() => {
      const board = boards.find((item) => item.id === menu.boardId);
      if (!board) return null;
      const project = board.projectId ? projectMap.get(board.projectId) : undefined;
      return <div className="canvas-context-menu desktop-board-menu" role="menu" aria-label={`${board.title} 操作`} onKeyDown={handleMenuKeyDown} style={{ left: menu.x, top: menu.y }}>
        <div className="context-menu-heading">{selectedBoardIds.length > 1 ? `已选择 ${selectedBoardIds.length} 个白板` : board.title}</div>
        {selectedBoardIds.length === 1 && <><button role="menuitem" onClick={() => openBoard(board.id)}><BookOpen size={15} /><span>打开白板</span></button><button role="menuitem" onClick={() => { setMenu(null); if (isNativeVault) void vaultApi.revealItem?.(`boards/${board.fileName}`); else useWorkspaceStore.getState().pushNotice({ tone: 'info', title: '浏览器测试页没有本地文件位置', message: '桌面版会把白板保存为可定位的 JSON 文件。' }); }}><FolderKanban size={15} /><span>打开本地位置</span></button><button role="menuitem" onClick={() => startRename(board)}><Pencil size={15} /><span>重命名</span></button></>}
        {selectedBoardIds.length > 1 && <div className="desktop-tidy-panel">{tidyGroups.map((group) => <section key={group.label} className="tidy-group"><span>{group.label}</span><div className="tidy-actions">{group.items.map(({ action, label, Icon }) => <button key={action} title={label} aria-label={label} onClick={() => tidyDesktopSelection(action)}><Icon size={15} /></button>)}</div></section>)}</div>}
        {selectedBoardIds.length === 1 && <><div className="context-menu-separator" /><button role="menuitem" onClick={() => { setMenu(null); setProjectBoard(board); }}><FolderKanban size={15} /><span>{project ? '查看项目目录' : '整理为项目'}</span></button><div className="context-menu-separator" /><button className="danger" role="menuitem" onClick={() => { setMenu(null); setDeleteTarget(board); }}><Trash2 size={15} /><span>删除白板</span></button></>}
      </div>;
    })() : null}</ExitPresence>
    <ExitPresence show={Boolean(projectBoard)}>{projectBoard ? <div className="project-dialog-backdrop" onPointerDown={(event) => { if (!pendingAction && event.target === event.currentTarget) setProjectBoard(null); }}><section className="project-dialog" role="dialog" aria-modal="true" aria-label={projectBoard.projectId ? '项目目录' : '整理为项目'}><div className="project-dialog-icon"><FolderKanban size={20} /></div><div className="project-dialog-heading"><h2>{projectBoard.projectId ? '项目目录' : '整理为项目'}</h2><p>{projectBoard.projectId ? '白板引用已绑定到真实目录；文件层级仍可独立整理。' : '为这个白板建立真实项目目录；已有文件组织保持不变。'}</p></div>{projectBoard.projectId ? <div className="project-bound-summary"><span>Notes/</span><strong>{projectMap.get(projectBoard.projectId)?.relativePath}</strong><small>解除绑定不会移动或删除任何 Markdown 文件。</small></div> : <div className="project-plan-summary"><div><strong>{projectBoard.placements.filter((item) => item.kind === 'card').length}</strong><span>张引用卡片将按现有位置整理</span></div></div>}<footer><button data-modal-close disabled={Boolean(pendingAction)} onClick={() => setProjectBoard(null)}>取消</button>{projectBoard.projectId ? <>{isNativeVault && <AsyncActionButton actionKey="desktop-project:export" pendingAction={pendingAction} runAction={runAction} busyLabel="正在导出…" action={async () => { await exportBoardBundle(projectBoard.id); setProjectBoard(null); }}>导出项目</AsyncActionButton>}<AsyncActionButton className="danger-subtle" actionKey="desktop-project:unbind" pendingAction={pendingAction} runAction={runAction} busyLabel="正在解除…" action={async () => { await unbindBoardProject(projectBoard.id); setProjectBoard(null); }}>解除目录绑定</AsyncActionButton></> : <AsyncActionButton className="primary" actionKey="desktop-project:create" pendingAction={pendingAction} runAction={runAction} busyLabel="正在整理…" action={async () => { await organizeBoardAsProject(projectBoard.id, projectBoard.title); setProjectBoard(null); }}>建立项目目录</AsyncActionButton>}</footer></section></div> : null}</ExitPresence>
    <ExitPresence show={Boolean(deleteTarget)}>{deleteTarget ? <div className="project-dialog-backdrop" onPointerDown={(event) => { if (!pendingAction && event.target === event.currentTarget) setDeleteTarget(null); }}><section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-label="删除白板"><h2>删除“{deleteTarget.title}”？</h2><p>白板文件会移入 OpenCanvas 回收目录；卡片 Markdown 不会被删除。</p>{deleteImpact && <div className="delete-impact-summary"><span>{deleteImpact.parents.length ? `${deleteImpact.parents.length} 个父白板中的引用会移除：${deleteImpact.parents.map((item) => item.boardTitle).join('、')}` : '没有其他白板引用它'}</span><span>{deleteImpact.children.length ? `${deleteImpact.children.length} 个下级白板仍会保留，并在需要时出现在桌面：${deleteImpact.children.map((item) => item.boardTitle).join('、')}` : '不包含下级白板'}</span></div>}<footer><button data-modal-close disabled={Boolean(pendingAction)} onClick={() => setDeleteTarget(null)}>取消</button><AsyncActionButton className="danger" actionKey="desktop-board:delete" pendingAction={pendingAction} runAction={runAction} busyLabel="正在移动…" action={async () => { await deleteBoard(deleteTarget.id); setDeleteTarget(null); }}>移入回收目录</AsyncActionButton></footer></section></div> : null}</ExitPresence>
  </section>;
}
