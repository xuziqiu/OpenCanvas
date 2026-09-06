import {
  ArrowLeft,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Ellipsis,
  ExternalLink,
  FolderKanban,
  FolderOpen,
  Grid2x2,
  Hand,
  LocateFixed,
  Layers3,
  Lock,
  Maximize2,
  Minus,
  MousePointer2,
  PanelRight,
  Pencil,
  Plus,
  Type,
  Trash2,
  Undo2,
  Unlock,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { movingRelationshipFocusIds, transitionCanvasInteraction, type CanvasInteractionEvent } from '../domain/canvasInteractionMachine';
import { idleInteraction, normalizedWheelDelta, screenToWorld, shouldUseInnerScroll, snapBoxToNearbyObjects, snapResizeBoxToNearbyObjects, zoomViewportAtPoint, type AlignmentGuideLine, type CanvasInteraction, type ResizeEdges } from '../domain/interaction';
import { interactionPinnedPlacementIds } from '../domain/interactionPinnedPlacements';
import { prospectiveSectionIdsForPlacements, sectionDragPlacementIds, sectionForPlacement, sectionMembershipSettlementIds, snapBoxToSectionPadding } from '../domain/sectionLayout';
import { automaticLabelCandidates, resolveConnectorLabelLayout, type ConnectorLabelRequest } from '../domain/connectorLabelLayout';
import { connectorLodThresholds, resolveConnectorLod, type ConnectorLodMode } from '../domain/connectorLod';
import { controlPointsForConnectorStyleChange } from '../domain/connectorControlPoints';
import { moveConnectorControlPoint } from '../domain/connectorKeypointMotion';
import { filterConnectorsForViewport, viewportWorldBounds } from '../domain/viewportCulling';
import { buildSpatialGridIndex } from '../domain/spatialIndex';
import { placementBounds, resizePlacementGroup } from '../domain/placementOperations';
import { hasVisibleModalOrMenu, isCommandSurfaceTarget, isComposingKeyboardEvent } from '../domain/keyboard';
import { clampOverlayPosition } from '../domain/overlayPosition';
import { placementColorKey } from '../domain/placementColor';
import { isNativeVault, vaultApi } from '../vault';
import { placementLayerTokens } from '../domain/placementLayers';
import { minimumPlacementDimensions } from '../domain/defaultPlacementSize';
import { createLatestFrameBatch, pointerFrameSample } from '../domain/frameBatch';
import { framePointerIntent } from '../domain/frameInteraction';
import { SECTION_RENAME_REQUEST_EVENT } from '../domain/sectionEditing';
import { hasPointerDragIntent } from '../domain/pointerDragIntent';
import { isAdditivePlacementClick, marqueeHitsPlacement, togglePlacementId } from '../domain/placementSelectionGesture';
import { createMinimapLayout, minimapMeshPaths, minimapViewportRect, worldPointForMinimap, type MinimapLayout } from '../domain/minimap';
import type { TidyAction } from '../domain/tidyLayout';
import { wouldCreateBoardCycle } from '../domain/workspaceIndex';
import type { BoardConnector, BoardPlacement } from '../types';
import { useWorkspaceStore, type Selection } from '../store';
import ExitPresence from './ExitPresence';
import { handleMenuKeyDown } from './menuKeyboard';
import { ANCHOR_CHOICES, CONNECTOR_COLORS, DenseConnectorLayer, DraftEdge, Edge, anchorToward, connectorColor, connectorEndpointPatch, connectorFocusState, connectorRouteGeometry, connectorTargetPortAt, fixedAnchor, portPoint, resolvedConnectorEndpointAnchor, type AnchorChoice, type ConnectorEndpointDrag, type ConnectorHandle, type ConnectorPort } from './canvas/ConnectorLayer';
import { CardIcon, ConnectorIcon, SectionIcon, WhiteboardIcon } from './icons/ProductIcons';

const BookOpen = WhiteboardIcon;
const FileText = CardIcon;
const Frame = SectionIcon;
const SquareDashed = WhiteboardIcon;
const MoveUpRight = ConnectorIcon;

const CardBodyEditor = lazy(() => import('./CardBodyEditor'));
const CardMarkdownPreview = lazy(() => import('./CardMarkdownPreview'));
const CanvasLayersPanel = lazy(() => import('./CanvasLayersPanel'));
const TidyMenu = lazy(() => import('./TidyMenu'));
const MultiSelectionToolbar = lazy(() => import('./MultiSelectionToolbar'));
const BoardPreview = lazy(() => import('./BoardPreview'));
const CardAutoHeightSync = lazy(() => import('./CardAutoHeightSync'));
const FitContentMenuItem = lazy(() => import('./FitContentMenuItem'));
const PlacementArrangeMenu = lazy(() => import('./PlacementArrangeMenu'));
const readWorkspaceCards = () => useWorkspaceStore.getState().cards;

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.4;
type ResizeDirection = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
const RESIZE_HANDLES: Array<{ direction: ResizeDirection; label: string }> = [
  { direction: 'n', label: '从上边调整大小' },
  { direction: 'ne', label: '从右上角调整大小' },
  { direction: 'e', label: '从右边调整大小' },
  { direction: 'se', label: '从右下角调整大小' },
  { direction: 's', label: '从下边调整大小' },
  { direction: 'sw', label: '从左下角调整大小' },
  { direction: 'w', label: '从左边调整大小' },
  { direction: 'nw', label: '从左上角调整大小' },
];

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function cloneSelection(selection: Selection): Selection {
  if (!selection) return null;
  return selection.kind === 'placement'
    ? { ...selection, ids: selection.ids ? [...selection.ids] : undefined }
    : { ...selection };
}

type ContextTarget =
  | { kind: 'canvas' }
  | { kind: 'placement'; id: string }
  | { kind: 'connector'; id: string };

interface CanvasContextMenuState {
  x: number;
  y: number;
  world: { x: number; y: number };
  target: ContextTarget;
}

const CONTEXT_COLORS = ['paper', 'sand', 'yellow', 'blue', 'green', 'rose', 'purple', 'ink'];
const SECTION_CONTEXT_COLORS = ['transparent', ...CONTEXT_COLORS];
const CONTEXT_COLOR_LABELS: Record<string, string> = {
  transparent: '默认灰色',
  paper: '纸白',
  sand: '沙色',
  yellow: '黄色',
  blue: '蓝色',
  green: '绿色',
  rose: '玫瑰',
  purple: '紫色',
  ink: '墨色',
};
function PlacementColorRow({ colors, current, onSelect }: {
  colors: string[];
  current: string | null;
  onSelect: (color: string) => void;
}) {
  return <div className="context-color-row" role="group" aria-label={colors === SECTION_CONTEXT_COLORS ? '区块颜色' : '对象颜色'}>
    <span>颜色</span>
    {colors.map((color) => <button
      key={color}
      className={`context-color color-${color}`}
      role="menuitemradio"
      aria-checked={current === color}
      aria-label={`${CONTEXT_COLOR_LABELS[color]}${current === color ? '，当前颜色' : ''}`}
      onClick={() => onSelect(color)}
    />)}
  </div>;
}
export default function Canvas() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const wheelViewportRef = useRef({ x: 0, y: 0, zoom: 1 });
  const wheelFrameRef = useRef<number | null>(null);
  const pendingWheelViewportRef = useRef<{ x: number; y: number; zoom: number } | null>(null);
  const wheelFeedbackTimerRef = useRef<number | null>(null);
  const activePointerGestureRef = useRef(false);
  const activePointerViewportBeforeRef = useRef<{ x: number; y: number; zoom: number } | null>(null);
  const gestureCleanupFrameRef = useRef<number | null>(null);
  const cancelledViewportFrameRef = useRef<number | null>(null);
  const connectorLodRef = useRef<{ boardId: string | null; mode: ConnectorLodMode }>({ boardId: null, mode: 'detailed' });
  const minimapMeshRef = useRef<{ boardId: string; placements: BoardPlacement[]; layout: MinimapLayout; paths: Map<string, string> } | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 1200, height: 800 });
  const [wheelZooming, setWheelZooming] = useState(false);
  const [minimapDragging, setMinimapDragging] = useState(false);
  const [spacePressed, setSpacePressed] = useState(false);
  const [interaction, setInteraction] = useState<CanvasInteraction>(idleInteraction);
  const dispatchInteraction = (event: CanvasInteractionEvent) => {
    setInteraction((current) => transitionCanvasInteraction(current, event));
  };
  const connectFrom = interaction.mode === 'connecting' ? interaction.fromId : null;
  const [connectFromAnchor, setConnectFromAnchor] = useState<AnchorChoice>('auto');
  const [connectPointer, setConnectPointer] = useState<{ x: number; y: number } | null>(null);
  const [hoveredPort, setHoveredPort] = useState<ConnectorPort | null>(null);
  const [connectorEndpointDrag, setConnectorEndpointDrag] = useState<ConnectorEndpointDrag | null>(null);
  const [newCardId, setNewCardId] = useState<string | null>(null);
  const [editingCardPlacementId, setEditingCardPlacementId] = useState<string | null>(null);
  const [pendingImageSelection, setPendingImageSelection] = useState<{ placementId: string; imageIndex: number } | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [creationDraft, setCreationDraft] = useState<{ tool: 'card' | 'board' | 'section'; left: number; top: number; width: number; height: number } | null>(null);
  const [marqueePreviewIds, setMarqueePreviewIds] = useState<string[]>([]);
  const [snapGuides, setSnapGuides] = useState<AlignmentGuideLine[]>([]);
  const [sectionDropTargetIds, setSectionDropTargetIds] = useState<string[]>([]);
  const [boardDropTarget, setBoardDropTarget] = useState<{ id: string; mode: 'move' | 'copy' | 'invalid' } | null>(null);
  const [contextMenu, setContextMenu] = useState<CanvasContextMenuState | null>(null);
  const [tidyMenuOpen, setTidyMenuOpen] = useState(false);
  const [connectorPanel, setConnectorPanel] = useState<'color' | 'arrow' | 'line' | 'width' | null>(null);
  const [editingConnectorLabelId, setEditingConnectorLabelId] = useState<string | null>(null);
  const [boardTitleDraft, setBoardTitleDraft] = useState('');
  const [editingBoardTitle, setEditingBoardTitle] = useState(false);
  const boardTitleInputRef = useRef<HTMLInputElement>(null);
  const [renamingNestedBoard, setRenamingNestedBoard] = useState<{ placementId: string; boardId: string; draft: string; original: string; created: boolean } | null>(null);
  const nestedBoardTitleInputRef = useRef<HTMLInputElement>(null);
  const cancelNestedBoardRenameRef = useRef(false);
  const nestedBoardRenameReadyRef = useRef(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState('');
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [contextToast, setContextToast] = useState<string | null>(null);
  const [layersOpen, setLayersOpen] = useState(false);
  const [arrangingPlacementIds, setArrangingPlacementIds] = useState<string[]>([]);
  const tidyAnimationFrameRef = useRef<number | null>(null);
  const tidyAnimationTimerRef = useRef<number | null>(null);
  const tidyMenuCloseTimerRef = useRef<number | null>(null);
  const boards = useWorkspaceStore((state) => state.boards);
  const cards = useWorkspaceStore((state) => state.cards);
  const projects = useWorkspaceStore((state) => state.projects);
  const activeBoardId = useWorkspaceStore((state) => state.activeBoardId);
  const sidePanelCardId = useWorkspaceStore((state) => state.sidePanelCardId);
  const sidePanelOpen = useWorkspaceStore((state) => state.sidePanelOpen);
  const history = useWorkspaceStore((state) => state.boardHistory);
  const selection = useWorkspaceStore((state) => state.selection);
  const tool = useWorkspaceStore((state) => state.tool);
  const setTool = useWorkspaceStore((state) => state.setTool);
  const setSelection = useWorkspaceStore((state) => state.setSelection);
  const setViewport = useWorkspaceStore((state) => state.setViewport);
  const updateNode = useWorkspaceStore((state) => state.updatePlacement);
  const updateBoardLayout = useWorkspaceStore((state) => state.updateBoardLayout);
  const settleBoardLayout = useWorkspaceStore((state) => state.settleBoardLayout);
  const transferPlacementsToBoard = useWorkspaceStore((state) => state.transferPlacementsToBoard);
  const createCardPlacement = useWorkspaceStore((state) => state.createCardPlacement);
  const createNestedBoardPlacement = useWorkspaceStore((state) => state.createNestedBoardPlacement);
  const organizeBoardAsProject = useWorkspaceStore((state) => state.organizeBoardAsProject);
  const updateCard = useWorkspaceStore((state) => state.updateCard);
  const updateBoard = useWorkspaceStore((state) => state.updateBoard);
  const addCardPlacement = useWorkspaceStore((state) => state.addCardPlacement);
  const addBoardPlacement = useWorkspaceStore((state) => state.addBoardPlacement);
  const addTextPlacement = useWorkspaceStore((state) => state.addTextPlacement);
  const addSectionPlacement = useWorkspaceStore((state) => state.addSectionPlacement);
  const connectPlacements = useWorkspaceStore((state) => state.connectPlacements);
  const updateConnector = useWorkspaceStore((state) => state.updateConnector);
  const openBoard = useWorkspaceStore((state) => state.openBoard);
  const openBoardPath = useWorkspaceStore((state) => state.openBoardPath);
  const goBack = useWorkspaceStore((state) => state.goBack);
  const focusCard = useWorkspaceStore((state) => state.focusCard);
  const openCardInSidePanel = useWorkspaceStore((state) => state.openCardInSidePanel);
  const beginBoardTransaction = useWorkspaceStore((state) => state.beginBoardTransaction);
  const commitBoardTransaction = useWorkspaceStore((state) => state.commitBoardTransaction);
  const cancelBoardTransaction = useWorkspaceStore((state) => state.cancelBoardTransaction);
  const undo = useWorkspaceStore((state) => state.undo);
  const redo = useWorkspaceStore((state) => state.redo);
  const commandHistory = useWorkspaceStore((state) => state.commandHistory);
  const copySelection = useWorkspaceStore((state) => state.copySelection);
  const pasteSelection = useWorkspaceStore((state) => state.pasteSelection);
  const duplicateSelection = useWorkspaceStore((state) => state.duplicateSelection);
  const duplicateSelectionAsIndependentCards = useWorkspaceStore((state) => state.duplicateSelectionAsIndependentCards);
  const tidySelection = useWorkspaceStore((state) => state.tidySelection);
  const setSelectionColor = useWorkspaceStore((state) => state.setSelectionColor);
  const convertSelectedTextToCards = useWorkspaceStore((state) => state.convertSelectedTextToCards);
  const frameSelection = useWorkspaceStore((state) => state.frameSelection);
  const setSelectionLocked = useWorkspaceStore((state) => state.setSelectionLocked);
  const styleConnectorsForSelection = useWorkspaceStore((state) => state.styleConnectorsForSelection);
  const removeSelection = useWorkspaceStore((state) => state.removeSelection);

  // The placement menu contains lazy and selection-dependent rows, so its
  // measured height can differ from the fast estimate used at pointerdown.
  // Clamp the real layout box before paint and again whenever its rows resize.
  useLayoutEffect(() => {
    const menu = contextMenuRef.current;
    if (!contextMenu || !menu || contextMenu.target.kind === 'connector') return;
    let frame = 0;
    const fitMeasuredMenu = () => {
      frame = 0;
      setContextMenu((current) => {
        if (!current || current.target.kind === 'connector') return current;
        const position = clampOverlayPosition({
          x: current.x,
          y: current.y,
          width: menu.offsetWidth,
          height: menu.offsetHeight,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        });
        return Math.abs(position.x - current.x) < .5 && Math.abs(position.y - current.y) < .5
          ? current
          : { ...current, x: position.x, y: position.y };
      });
    };
    fitMeasuredMenu();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(fitMeasuredMenu);
    });
    observer?.observe(menu);
    return () => {
      observer?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [contextMenu?.x, contextMenu?.y, contextMenu?.target.kind]);

  const clearTransientGestureFeedback = () => {
    setSnapGuides([]);
    setSectionDropTargetIds([]);
    setBoardDropTarget(null);
    setMarquee(null);
    setCreationDraft(null);
    setMarqueePreviewIds([]);
    setConnectorEndpointDrag(null);
    setHoveredPort(null);
    setMinimapDragging(false);
    // Frame-batched movement runs at continuous-event priority. A queued guide
    // update can otherwise commit after the discrete blur/Escape cleanup and
    // leave a one-frame (or persistent) ghost. Clear once more on the next
    // frame; a new pointerdown cancels this deferred cleanup.
    if (gestureCleanupFrameRef.current !== null) window.cancelAnimationFrame(gestureCleanupFrameRef.current);
    gestureCleanupFrameRef.current = window.requestAnimationFrame(() => {
      gestureCleanupFrameRef.current = null;
      setSnapGuides([]);
      setSectionDropTargetIds([]);
      setBoardDropTarget(null);
      setMarquee(null);
      setCreationDraft(null);
      setMarqueePreviewIds([]);
      setConnectorEndpointDrag(null);
      setHoveredPort(null);
      setMinimapDragging(false);
    });
  };

  const restoreViewportAfterCancelledGesture = (value: { x: number; y: number; zoom: number }) => {
    setViewport(value);
    if (cancelledViewportFrameRef.current !== null) window.cancelAnimationFrame(cancelledViewportFrameRef.current);
    cancelledViewportFrameRef.current = window.requestAnimationFrame(() => {
      cancelledViewportFrameRef.current = window.requestAnimationFrame(() => {
        cancelledViewportFrameRef.current = null;
        setViewport(value);
      });
    });
  };

  const board = boards.find((item) => item.id === activeBoardId) ?? null;
  const cardMap = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards]);
  const boardMap = useMemo(() => new Map(boards.map((item) => [item.id, item])), [boards]);
  const placementMap = useMemo(() => new Map(board?.placements.map((placement) => [placement.id, placement]) ?? []), [board?.placements]);
  const spatialIndexRef = useRef<{ boardId: string | null; placements: BoardPlacement[] | undefined; index: ReturnType<typeof buildSpatialGridIndex> }>({ boardId: null, placements: undefined, index: buildSpatialGridIndex([]) });
  const currentProject = board?.projectId ? projects.find((project) => project.id === board.projectId) : undefined;

  useEffect(() => {
    setBoardTitleDraft(board?.title ?? '');
    setEditingBoardTitle(false);
    setEditingConnectorLabelId(null);
  }, [board?.id, board?.title]);

  useEffect(() => {
    const beginRename = (event: Event) => {
      const placementId = (event as CustomEvent<string>).detail;
      if (!placementId) return;
      setEditingCardPlacementId(null);
      setEditingTextId(placementId);
    };
    window.addEventListener(SECTION_RENAME_REQUEST_EVENT, beginRename);
    return () => window.removeEventListener(SECTION_RENAME_REQUEST_EVENT, beginRename);
  }, []);

  useEffect(() => {
    const cancelActivePointerGesture = () => {
      window.dispatchEvent(new Event('pointercancel'));
      clearTransientGestureFeedback();
    };
    window.addEventListener('blur', cancelActivePointerGesture);
    return () => window.removeEventListener('blur', cancelActivePointerGesture);
  }, []);

  useEffect(() => {
    const begin = (event: PointerEvent) => {
      const target = event.target;
      const isCanvasGestureSurface = canvasRef.current?.contains(target as Node)
        || (target instanceof Element && Boolean(target.closest('.canvas-minimap')));
      if ((event.button === 0 || event.button === 1) && isCanvasGestureSurface) {
        if (gestureCleanupFrameRef.current !== null) {
          window.cancelAnimationFrame(gestureCleanupFrameRef.current);
          gestureCleanupFrameRef.current = null;
        }
        if (cancelledViewportFrameRef.current !== null) {
          window.cancelAnimationFrame(cancelledViewportFrameRef.current);
          cancelledViewportFrameRef.current = null;
        }
        const state = useWorkspaceStore.getState();
        const active = state.boards.find((candidate) => candidate.id === state.activeBoardId);
        activePointerViewportBeforeRef.current = active ? { ...active.viewport } : null;
        activePointerGestureRef.current = true;
      }
    };
    const finish = () => { activePointerGestureRef.current = false; };
    window.addEventListener('pointerdown', begin, true);
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', finish, true);
    return () => {
      window.removeEventListener('pointerdown', begin, true);
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', finish, true);
    };
  }, []);

  useEffect(() => {
    const cancelWithEscape = (event: KeyboardEvent) => {
      if (isComposingKeyboardEvent(event)) return;
      if (event.key !== 'Escape') return;
      // A pointer can still be inside its click/drag threshold while the
      // interaction machine intentionally remains idle. Dispatch cancellation
      // for every Escape so those pending clicks, connector handles and the
      // minimap cannot commit after the user has already cancelled them.
      const hadActivePointerGesture = activePointerGestureRef.current;
      const hasPointerInteraction = interaction.mode === 'panning' || interaction.mode === 'marquee' || interaction.mode === 'drawing-section' || interaction.mode === 'moving' || interaction.mode === 'resizing';
      if (hadActivePointerGesture || hasPointerInteraction) {
        window.dispatchEvent(new Event('pointercancel'));
        clearTransientGestureFeedback();
        if (tool === 'card' || tool === 'text' || tool === 'board' || tool === 'section') setTool('select');
        event.preventDefault();
      } else if (interaction.mode === 'connecting') {
        event.preventDefault();
        setConnectPointer(null);
        setHoveredPort(null);
        dispatchInteraction({ type: 'cancel' });
        setTool('select');
      }
    };
    // Capture before the app-level Escape shortcut. A cancelled pointer
    // gesture restores its prior selection; the generic shortcut must not
    // subsequently clear that restored state in the same key event.
    window.addEventListener('keydown', cancelWithEscape, true);
    return () => window.removeEventListener('keydown', cancelWithEscape, true);
  }, [interaction.mode, setTool, tool]);

  useEffect(() => {
    if (!editingBoardTitle) return;
    const input = boardTitleInputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  }, [editingBoardTitle]);

  useEffect(() => {
    if (!editingBoardTitle || !board) return;
    const finishOutside = (event: PointerEvent) => {
      if ((event.target as HTMLElement | null)?.closest('.board-path-title-field')) return;
      const title = boardTitleInputRef.current?.value.trim() || boardTitleDraft.trim() || '未命名白板';
      setBoardTitleDraft(title);
      if (title !== board.title) updateBoard(board.id, { title });
      setEditingBoardTitle(false);
    };
    window.addEventListener('pointerdown', finishOutside, true);
    return () => window.removeEventListener('pointerdown', finishOutside, true);
  }, [board, boardTitleDraft, editingBoardTitle, updateBoard]);

  useLayoutEffect(() => {
    if (!renamingNestedBoard) return;
    let focusFrame = 0;
    let recoveryTimer = 0;
    const claimRenameFocus = () => {
      const input = nestedBoardTitleInputRef.current;
      if (!input || document.activeElement === input) return;
      input.focus({ preventScroll: true });
      input.select();
    };
    // Closing an object menu and mounting its inline editor happen in the same
    // React commit. Claim focus in the layout phase so the dismissed menu never
    // receives a painted focus frame, then verify ownership across the next two
    // next frame without re-selecting once the user is typing. The object menu is
    // retained for its 110 ms exit motion, so recover once after that surface
    // has actually left the focus order as well. This matters on slower
    // Windows renderers where the exit commit can land after the frame.
    claimRenameFocus();
    focusFrame = window.requestAnimationFrame(claimRenameFocus);
    recoveryTimer = window.setTimeout(() => {
      claimRenameFocus();
      nestedBoardRenameReadyRef.current = true;
    }, 140);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.clearTimeout(recoveryTimer);
    };
  }, [renamingNestedBoard?.placementId]);

  const beginNestedBoardRename = (placement: BoardPlacement | null, created = false) => {
    if (!placement?.entityId) return placement;
    // Creation updates the store synchronously, one render before this
    // component's memoized boardMap sees the child. Read the latest snapshot so
    // create-and-rename is deterministic instead of depending on React timing.
    const nested = useWorkspaceStore.getState().boards.find((item) => item.id === placement.entityId);
    if (!nested) return placement;
    nestedBoardRenameReadyRef.current = false;
    cancelNestedBoardRenameRef.current = false;
    setEditingCardPlacementId(null);
    setEditingTextId(null);
    setSelection({ kind: 'placement', id: placement.id, ids: [placement.id] });
    setRenamingNestedBoard({ placementId: placement.id, boardId: nested.id, draft: nested.title, original: nested.title, created });
    return placement;
  };

  const finishNestedBoardRename = (commit: boolean) => {
    if (!renamingNestedBoard) return;
    if (commit) {
      const title = renamingNestedBoard.draft.trim() || '未命名白板';
      if (title !== renamingNestedBoard.original) updateBoard(renamingNestedBoard.boardId, { title }, renamingNestedBoard.created ? { mergeCreated: true } : undefined);
    }
    setRenamingNestedBoard(null);
  };

  useEffect(() => {
    if (!renamingNestedBoard) return;
    const commitOutside = (event: PointerEvent) => {
      if ((event.target as HTMLElement | null)?.closest('.nested-board-title-editor')) return;
      // A canvas background is intentionally not focusable, so browsers do
      // not consistently emit blur when it is clicked. Treat the outside
      // pointer as the authoritative commit and suppress the follow-up blur.
      cancelNestedBoardRenameRef.current = true;
      finishNestedBoardRename(true);
    };
    window.addEventListener('pointerdown', commitOutside, true);
    return () => window.removeEventListener('pointerdown', commitOutside, true);
  }, [renamingNestedBoard]);

  useEffect(() => {
    const isSinglePlacement = selection?.kind === 'placement' && (!selection.ids || selection.ids.length === 1);
    const placement = isSinglePlacement ? board?.placements.find((item) => item.id === selection.id) : null;
    if (sidePanelOpen && placement?.kind === 'card' && placement.entityId) {
      openCardInSidePanel(placement.entityId);
    }
    // Opening or restoring the panel is not itself a selection change. In
    // particular, returning from a full-page editor must keep the card that
    // page came from instead of being overwritten by an older canvas selection.
    // The explicit panel-opening controls already provide their target card.
  }, [activeBoardId, selection, openCardInSidePanel]);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat || isCommandSurfaceTarget(event.target) || hasVisibleModalOrMenu()) return;
      event.preventDefault();
      setSpacePressed(true);
    };
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') setSpacePressed(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  useEffect(() => {
    if (tool !== 'connect') {
      setConnectPointer(null);
      setHoveredPort(null);
      setInteraction((current) => current.mode === 'connecting'
        ? transitionCanvasInteraction(current, { type: 'cancel' })
        : current);
    }
  }, [tool]);

  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const update = () => setCanvasSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [board?.id]);

  useEffect(() => () => {
    if (wheelFrameRef.current !== null) window.cancelAnimationFrame(wheelFrameRef.current);
    if (wheelFeedbackTimerRef.current !== null) window.clearTimeout(wheelFeedbackTimerRef.current);
    if (tidyAnimationFrameRef.current !== null) window.cancelAnimationFrame(tidyAnimationFrameRef.current);
    if (gestureCleanupFrameRef.current !== null) window.cancelAnimationFrame(gestureCleanupFrameRef.current);
    if (cancelledViewportFrameRef.current !== null) window.cancelAnimationFrame(cancelledViewportFrameRef.current);
    if (tidyAnimationTimerRef.current !== null) window.clearTimeout(tidyAnimationTimerRef.current);
    if (tidyMenuCloseTimerRef.current !== null) window.clearTimeout(tidyMenuCloseTimerRef.current);
    wheelFrameRef.current = null;
    pendingWheelViewportRef.current = null;
    wheelFeedbackTimerRef.current = null;
    window.dispatchEvent(new Event('pointercancel'));
  }, [board?.id]);

  const animateTidySelection = (action: TidyAction) => {
    if (selection?.kind !== 'placement') return;
    const ids = selection.ids?.length ? selection.ids : [selection.id];
    if (ids.length < 2) return;
    if (tidyAnimationFrameRef.current !== null) window.cancelAnimationFrame(tidyAnimationFrameRef.current);
    if (tidyAnimationTimerRef.current !== null) window.clearTimeout(tidyAnimationTimerRef.current);
    setArrangingPlacementIds(ids);
    tidyAnimationFrameRef.current = window.requestAnimationFrame(() => {
      tidyAnimationFrameRef.current = null;
      tidySelection(action);
      tidyAnimationTimerRef.current = window.setTimeout(() => {
        tidyAnimationTimerRef.current = null;
        setArrangingPlacementIds([]);
      }, 230);
    });
  };

  const openTidyMenu = () => {
    if (tidyMenuCloseTimerRef.current !== null) window.clearTimeout(tidyMenuCloseTimerRef.current);
    tidyMenuCloseTimerRef.current = null;
    setTidyMenuOpen(true);
  };

  const scheduleTidyMenuClose = () => {
    if (tidyMenuCloseTimerRef.current !== null) window.clearTimeout(tidyMenuCloseTimerRef.current);
    tidyMenuCloseTimerRef.current = window.setTimeout(() => {
      tidyMenuCloseTimerRef.current = null;
      if (document.querySelector('.context-submenu-anchor:hover, .tidy-submenu:hover')) return;
      setTidyMenuOpen(false);
    }, 140);
  };

  useEffect(() => {
    // A board is a separate interaction surface. Transient UI from the
    // previous board must never survive keyboard/quick-open navigation where
    // no outside pointerdown exists to dismiss it incidentally.
    setInteraction(idleInteraction);
    setEditingCardPlacementId(null);
    setEditingTextId(null);
    setEditingConnectorLabelId(null);
    setContextMenu(null);
    setConnectorPanel(null);
    setTidyMenuOpen(false);
    setMarquee(null);
    setMarqueePreviewIds([]);
    setSnapGuides([]);
    setConnectPointer(null);
    setHoveredPort(null);
    setConnectorEndpointDrag(null);
    window.getSelection()?.removeAllRanges();
  }, [board?.id]);

  useEffect(() => {
    if (!editingCardPlacementId) return;
    const stillSelected = selection?.kind === 'placement'
      && selection.id === editingCardPlacementId
      && (!selection.ids || selection.ids.length === 1);
    if (!stillSelected) {
      setEditingCardPlacementId(null);
      window.getSelection()?.removeAllRanges();
    }
  }, [editingCardPlacementId, selection]);

  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = (event: PointerEvent) => {
      if ((event.target as HTMLElement | null)?.closest('.canvas-context-menu')) return;
      setContextMenu(null);
      setConnectorPanel(null);
      setTidyMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (isComposingKeyboardEvent(event) || event.key !== 'Escape') return;
      if (connectorPanel) {
        event.preventDefault();
        event.stopPropagation();
        const triggerLabel = { color: '线条颜色', width: '线条粗细', arrow: '箭头方向', line: '线条类型' }[connectorPanel];
        setConnectorPanel(null);
        window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`.connector-menu [aria-label="${triggerLabel}"]`)?.focus({ preventScroll: true }));
        return;
      }
      setContextMenu(null);
      setTidyMenuOpen(false);
    };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', escape);
    };
  }, [connectorPanel, contextMenu]);

  useEffect(() => {
    if (!connectorPanel) return;
    const frame = window.requestAnimationFrame(() => document.querySelector<HTMLElement>('.connector-compact-panel [role="menuitem"]')?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [connectorPanel]);

  if (!board) return <section className="canvas-empty">没有可打开的白板</section>;
  const viewport = board.viewport;
  const renderPixelRatio = Math.max(1, window.devicePixelRatio || 1);
  const renderedViewport = {
    ...viewport,
    x: Math.round(viewport.x * renderPixelRatio) / renderPixelRatio,
    y: Math.round(viewport.y * renderPixelRatio) / renderPixelRatio,
  };
  // An unrelated render (most notably closing a context menu on the first
  // wheel event) must not overwrite deltas already accumulated for this
  // animation frame. Once the frame commits, the rendered viewport becomes
  // authoritative again.
  if (wheelFrameRef.current === null) wheelViewportRef.current = viewport;
  const selectedIds = selection?.kind === 'placement' ? (selection.ids?.length ? selection.ids : [selection.id]) : [];
  // Relationship focus is a transient drag aid, not a selection state. Once
  // the pointer is released every connector immediately returns to full tone.
  const relationshipFocusPlacementIds = new Set(movingRelationshipFocusIds(interaction));
  const relationshipFocusConnectorId = null;
  const relationshipFocusActive = interaction.mode === 'moving' && relationshipFocusPlacementIds.size > 0;
  const multiSelectionPlacements = selectedIds.length > 1
    ? board.placements.filter((placement) => selectedIds.includes(placement.id) && !placement.locked)
    : [];
  const multiSelectionBounds = placementBounds(multiSelectionPlacements);
  const showMultiSelectionToolbar = Boolean(multiSelectionBounds && interaction.mode === 'idle');
  const pinnedPlacementIds = [...selectedIds, ...interactionPinnedPlacementIds(interaction), editingCardPlacementId, editingTextId, connectFrom, hoveredPort?.placementId].filter((value): value is string => Boolean(value));
  const visibleBounds = viewportWorldBounds(viewport, canvasSize);
  const drawablePlacements = board.placements.filter((placement) => !placement.hidden);
  const placementLayerRange = board.placements.reduce((range, placement) => {
    const layer = placement.zIndex ?? 0;
    return { min: Math.min(range.min, layer), max: Math.max(range.max, layer) };
  }, { min: 0, max: 0 });
  const hiddenPlacementIds = new Set(board.placements.filter((placement) => placement.hidden).map((placement) => placement.id));
  const drawableConnectors = board.connectors.filter((connector) => !hiddenPlacementIds.has(connector.from) && !hiddenPlacementIds.has(connector.to));
  if (spatialIndexRef.current.boardId !== board.id || (interaction.mode === 'idle' && spatialIndexRef.current.placements !== board.placements)) {
    spatialIndexRef.current = { boardId: board.id, placements: board.placements, index: buildSpatialGridIndex(board.placements) };
  }
  const pinnedPlacementSet = new Set(pinnedPlacementIds);
  const visiblePlacements = spatialIndexRef.current.index
    .query(visibleBounds, pinnedPlacementIds)
    .map((placement) => pinnedPlacementSet.has(placement.id) ? board.placements.find((current) => current.id === placement.id) ?? placement : placement)
    .filter((placement) => !placement.hidden);
  const visibleConnectors = drawableConnectors.length < 100 ? drawableConnectors : filterConnectorsForViewport(drawableConnectors, visiblePlacements.map((placement) => placement.id), [selection?.kind === 'connector' ? selection.id : '', editingConnectorLabelId ?? '', connectorEndpointDrag?.connectorId ?? ''], placementMap, visibleBounds);
  const detailedConnectorIds = new Set([selection?.kind === 'connector' ? selection.id : '', editingConnectorLabelId ?? '', connectorEndpointDrag?.connectorId ?? ''].filter(Boolean));
  const previousLodMode = connectorLodRef.current.boardId === board.id ? connectorLodRef.current.mode : 'detailed';
  const connectorLodMode = resolveConnectorLod(previousLodMode, visibleConnectors.length, viewport.zoom);
  connectorLodRef.current = { boardId: board.id, mode: connectorLodMode };
  const denseConnectorMode = connectorLodMode === 'dense';
  // Keep the full aggregate stable while a selected edge is rendered in the
  // detail layer above it. Removing one edge would rebuild thousands of SVG
  // path commands merely because the user opened its menu.
  const denseConnectors = denseConnectorMode ? visibleConnectors : [];
  const detailedConnectors = denseConnectorMode ? visibleConnectors.filter((connector) => detailedConnectorIds.has(connector.id)) : visibleConnectors;
  const lodExpanded = !denseConnectorMode && visibleConnectors.length >= connectorLodThresholds(viewport.zoom).exit * .72;
  const connectorLabelRequests: ConnectorLabelRequest[] = [];
  for (const connector of detailedConnectors) {
    if (!connector.label) continue;
    const controlPoint = connector.controlPoints?.[0];
    if (controlPoint) {
      connectorLabelRequests.push({
        id: connector.id,
        label: connector.label,
        manual: true,
        candidates: [{ point: { x: controlPoint.x, y: controlPoint.y }, insertionIndex: -1 }],
      });
      continue;
    }
    const route = connectorRouteGeometry(connector, placementMap);
    if (!route) continue;
    const preferredInsertionIndex = Math.floor((route.geometry.insertions.length - 1) / 2);
    const preferred = route.geometry.insertions[preferredInsertionIndex]?.point ?? route.geometry.labelPoint;
    connectorLabelRequests.push({
      id: connector.id,
      label: connector.label,
      manual: false,
      candidates: automaticLabelCandidates(route.geometry.hitPoints, preferred, preferredInsertionIndex),
    });
  }
  const connectorLabelLayout = resolveConnectorLabelLayout(connectorLabelRequests, visiblePlacements.map((placement) => ({ x: placement.x, y: placement.y, width: placement.width, height: placement.height })));
  const canUndoCurrentBoard = commandHistory.past.some((entry) => entry.boardId === board?.id);
  const canRedoCurrentBoard = commandHistory.future.some((entry) => entry.boardId === board?.id);

  const worldPoint = (clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return screenToWorld({ x: clientX - rect.left, y: clientY - rect.top }, viewport);
  };

  const targetPortAt = (point: { x: number; y: number }, placements: BoardPlacement[]) => {
    return connectorTargetPortAt(point, placements, viewport.zoom);
  };

  const viewportCenter = () => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 300, y: 180 };
    return worldPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  };

  const contextPosition = (clientX: number, clientY: number, estimatedHeight: number) => {
    const position = clampOverlayPosition({ x: clientX, y: clientY, width: 344, height: estimatedHeight, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
    return { x: position.x, y: position.y };
  };

  const openPlacementContextMenu = (event: React.MouseEvent, placement: BoardPlacement) => {
    event.preventDefault();
    event.stopPropagation();
    setEditingCardPlacementId(null);
    window.getSelection()?.removeAllRanges();
    if (!selectedIds.includes(placement.id)) setSelection({ kind: 'placement', id: placement.id, ids: [placement.id] });
    setConnectorPanel(null);
    setTidyMenuOpen(false);
    setContextMenu({ ...contextPosition(event.clientX, event.clientY, 650), world: worldPoint(event.clientX, event.clientY), target: { kind: 'placement', id: placement.id } });
  };

  const openPlacementContextMenuAt = (placement: BoardPlacement, clientX: number, clientY: number) => {
    setEditingCardPlacementId(null);
    window.getSelection()?.removeAllRanges();
    if (!selectedIds.includes(placement.id)) setSelection({ kind: 'placement', id: placement.id, ids: [placement.id] });
    setConnectorPanel(null);
    setTidyMenuOpen(false);
    setContextMenu({ ...contextPosition(clientX, clientY, 650), world: worldPoint(clientX, clientY), target: { kind: 'placement', id: placement.id } });
  };

  const openConnectorContextMenu = (event: React.PointerEvent | React.MouseEvent | React.KeyboardEvent<SVGPathElement>, connector: BoardConnector) => {
    event.preventDefault();
    event.stopPropagation();
    setEditingCardPlacementId(null);
    window.getSelection()?.removeAllRanges();
    setSelection({ kind: 'connector', id: connector.id });
    const currentTarget = event.currentTarget as SVGGraphicsElement;
    const denseHitSurface = currentTarget.classList?.contains('dense-edge-hitbox');
    const rect = denseHitSurface ? null : currentTarget.getBoundingClientRect?.();
    const eventClientX = 'clientX' in event ? event.clientX : rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const eventClientY = 'clientY' in event ? event.clientY : rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
    const menuWidth = 220;
    const widestPanelWidth = 260;
    const menuHeight = 44;
    const requestedX = rect ? rect.left + rect.width / 2 - menuWidth / 2 : eventClientX - menuWidth / 2;
    const preferredY = rect ? rect.top - menuHeight - 10 : eventClientY - menuHeight - 10;
    const position = clampOverlayPosition({
      x: requestedX,
      y: preferredY >= 8 ? preferredY : (rect?.bottom ?? eventClientY) + 10,
      width: Math.max(menuWidth, widestPanelWidth),
      height: 150,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    setConnectorPanel(null);
    setContextMenu({
      x: position.x,
      y: position.y,
      world: worldPoint(eventClientX, eventClientY),
      target: { kind: 'connector', id: connector.id },
    });
  };

  const openConnectorLabelEditor = (event: React.MouseEvent, connector: BoardConnector) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu(null);
    setConnectorPanel(null);
    setSelection({ kind: 'connector', id: connector.id });
    setEditingConnectorLabelId(connector.id);
  };

  const commitConnectorLabel = (connector: BoardConnector, value: string) => {
    updateConnector(connector.id, { label: value || undefined });
    setEditingConnectorLabelId(null);
  };

  const beginConnectorLabelEditingFromMenu = (connectorId: string) => {
    // Keep the selected line's compact menu available while the label is
    // edited in place. This avoids competing focus teardown and lets the user
    // continue with color/arrow/line changes without selecting the line again.
    setEditingConnectorLabelId(connectorId);
    window.requestAnimationFrame(() => {
      setConnectorPanel(null);
      window.setTimeout(() => {
        document.querySelector<HTMLInputElement>('[aria-label="编辑连线标签"]')?.focus({ preventScroll: true });
      }, 0);
    });
  };

  const commitBoardTitle = () => {
    if (!board) return;
    const title = boardTitleDraft.trim() || '未命名白板';
    setBoardTitleDraft(title);
    if (title !== board.title) updateBoard(board.id, { title });
    setEditingBoardTitle(false);
  };

  const openCanvasContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('.canvas-node, .edge-object, .dense-connector-layer, .canvas-toolbar, .zoom-controls, .canvas-bottom-tools')) return;
    event.preventDefault();
    setEditingCardPlacementId(null);
    window.getSelection()?.removeAllRanges();
    setSelection(null);
    setConnectorPanel(null);
    setContextMenu({ ...contextPosition(event.clientX, event.clientY, 260), world: worldPoint(event.clientX, event.clientY), target: { kind: 'canvas' } });
  };

  const beginPan = (event: React.PointerEvent) => {
    event.preventDefault();
    dispatchInteraction({ type: 'start-pan', pointerId: event.pointerId });
    const liveBoard = useWorkspaceStore.getState().boards.find((candidate) => candidate.id === board.id);
    const start = { x: event.clientX, y: event.clientY, viewport: liveBoard?.viewport ?? viewport };
    const moves = createLatestFrameBatch((next: ReturnType<typeof pointerFrameSample>) => setViewport({ ...start.viewport, x: start.viewport.x + next.clientX - start.x, y: start.viewport.y + next.clientY - start.y }));
    const move = (next: PointerEvent) => { next.preventDefault(); moves.push(pointerFrameSample(next)); };
    const up = (next: Event) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (next.type === 'pointercancel') {
        moves.cancel();
        restoreViewportAfterCancelledGesture(start.viewport);
      } else moves.flush();
      dispatchInteraction({ type: 'finish-pointer', pointerId: event.pointerId });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('pointercancel', up, { once: true });
  };

  const startMarqueeGesture = (event: React.PointerEvent, clickPlacementId?: string, additiveClick = false) => {
    event.preventDefault();
    dispatchInteraction({ type: 'start-marquee', pointerId: event.pointerId });
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) { dispatchInteraction({ type: 'finish' }); return; }
    const start = { x: event.clientX, y: event.clientY };
    const selectionBefore = cloneSelection(useWorkspaceStore.getState().selection);
    const editingCardBefore = editingCardPlacementId;
    let dragged = false;
    const moves = createLatestFrameBatch((next: ReturnType<typeof pointerFrameSample>) => {
      const dx = next.clientX - start.x;
      const dy = next.clientY - start.y;
      if (!dragged && Math.abs(dx) + Math.abs(dy) > 4) {
        dragged = true;
        setEditingCardPlacementId(null);
        window.getSelection()?.removeAllRanges();
      }
      if (dragged) {
        setMarquee({ left: Math.min(start.x, next.clientX) - rect.left, top: Math.min(start.y, next.clientY) - rect.top, width: Math.abs(dx), height: Math.abs(dy) });
        const a = worldPoint(start.x, start.y);
        const b = worldPoint(next.clientX, next.clientY);
        const area = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
        setMarqueePreviewIds(board.placements.filter((item) => marqueeHitsPlacement(area, item)).map((item) => item.id));
      }
    });
    const move = (next: PointerEvent) => { next.preventDefault(); moves.push(pointerFrameSample(next)); };
    const up = (next: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (next.type === 'pointercancel') moves.cancel(); else moves.flush();
      setMarquee(null);
      setMarqueePreviewIds([]);
      dispatchInteraction({ type: 'finish-pointer', pointerId: event.pointerId });
      if (next.type === 'pointercancel') {
        setSelection(selectionBefore);
        setEditingCardPlacementId(editingCardBefore);
        return;
      }
      if (!dragged) {
        setEditingCardPlacementId(null);
        window.getSelection()?.removeAllRanges();
        if (clickPlacementId && additiveClick) {
          const priorIds = selectionBefore?.kind === 'placement'
            ? (selectionBefore.ids?.length ? selectionBefore.ids : [selectionBefore.id])
            : [];
          const ids = togglePlacementId(priorIds, clickPlacementId);
          setSelection(ids.length ? { kind: 'placement', id: ids.at(-1)!, ids } : null);
        } else {
          setSelection(clickPlacementId ? { kind: 'placement', id: clickPlacementId, ids: [clickPlacementId] } : null);
        }
        setNewCardId(null);
        setEditingTextId(null);
        return;
      }
      const a = worldPoint(start.x, start.y);
      const b = worldPoint(next.clientX, next.clientY);
      const left = Math.min(a.x, b.x); const right = Math.max(a.x, b.x);
      const top = Math.min(a.y, b.y); const bottom = Math.max(a.y, b.y);
      const area = { x: left, y: top, width: right - left, height: bottom - top };
      const ids = board.placements.filter((placement) => marqueeHitsPlacement(area, placement)).map((placement) => placement.id);
      setSelection(ids.length ? { kind: 'placement', id: ids[0], ids } : null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('pointercancel', up, { once: true });
  };

  const startCreationGesture = (event: React.PointerEvent, creationTool: 'card' | 'text' | 'board' | 'section') => {
    event.preventDefault();
    event.stopPropagation();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    dispatchInteraction({ type: 'start-section', pointerId: event.pointerId });
    const start = { x: event.clientX, y: event.clientY };
    let dragged = false;
    const moves = createLatestFrameBatch((next: ReturnType<typeof pointerFrameSample>) => {
      if (!dragged && hasPointerDragIntent(start, { x: next.clientX, y: next.clientY })) dragged = true;
      if (!dragged) return;
      if (creationTool === 'text') return;
      setCreationDraft({
        tool: creationTool,
        left: Math.min(start.x, next.clientX) - rect.left,
        top: Math.min(start.y, next.clientY) - rect.top,
        width: Math.abs(next.clientX - start.x),
        height: Math.abs(next.clientY - start.y),
      });
    });
    const move = (next: PointerEvent) => {
      next.preventDefault();
      moves.push(pointerFrameSample(next));
    };
    const up = (next: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (next.type === 'pointercancel') moves.cancel(); else moves.flush();
      setCreationDraft(null);
      dispatchInteraction({ type: 'finish-pointer', pointerId: event.pointerId });
      if (next.type === 'pointercancel') return;
      const a = worldPoint(start.x, start.y);
      const b = worldPoint(next.clientX, next.clientY);
      if (creationTool === 'text') {
        if (dragged) return;
        const createdText = addTextPlacement({ x: a.x - 10, y: a.y - 45 });
        setEditingTextId(createdText?.id ?? null);
        setTool('select');
        return;
      }
      const box = dragged ? {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        width: Math.abs(b.x - a.x),
        height: Math.abs(b.y - a.y),
      } : null;
      let created: BoardPlacement | null = null;
      if (creationTool === 'section') created = addSectionPlacement(box ?? { x: a.x, y: a.y });
      if (creationTool === 'card') {
        created = createCardPlacement(box ?? { x: a.x - 260, y: a.y - 92.5 });
        if (created) { setNewCardId(created.entityId ?? null); setEditingCardPlacementId(created.id); }
      }
      if (creationTool === 'board') {
        created = createNestedBoardPlacement(box ?? { x: a.x - 215, y: a.y - 135 });
      }
      setTool('select');
      if (creationTool === 'section') beginCreatedSectionRename(created);
      if (creationTool === 'board') beginNestedBoardRename(created, true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('pointercancel', up, { once: true });
  };

  const handleCanvasPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // Child interactions (notably a dense connector that is replaced during
    // this very pointer event) mark the gesture handled before bubbling here.
    // Respect that signal even when the original DOM target no longer exists.
    if (event.defaultPrevented) return;
    if (tool === 'pan' || spacePressed || event.button === 1) { beginPan(event); return; }
    const target = event.target as HTMLElement;
    if (['card', 'text', 'board', 'section'].includes(tool) && event.button === 0 && !target.closest('.canvas-toolbar')) {
      startCreationGesture(event, tool as 'card' | 'text' | 'board' | 'section');
      return;
    }
    if (tool === 'connect' && event.button === 0 && !target.closest('.canvas-node')) {
      if (connectFrom && hoveredPort && hoveredPort.placementId !== connectFrom) {
        connectPlacements(connectFrom, hoveredPort.placementId, {
          fromAnchor: fixedAnchor(connectFromAnchor),
          toAnchor: fixedAnchor(hoveredPort.side),
        });
        setConnectPointer(null);
        setHoveredPort(null);
        dispatchInteraction({ type: 'finish' });
        setTool('select');
        return;
      }
      setConnectPointer(null);
      setHoveredPort(null);
      dispatchInteraction({ type: 'cancel' });
      setTool('select');
      return;
    }
    // Dense routes are replaced by a detailed Edge as soon as they are picked.
    // Treat their aggregate SVG as an interactive object before that DOM swap,
    // otherwise the canvas starts a marquee and clears the connector again on
    // pointerup, producing a visible one-frame selection flash.
    if (event.button !== 0 || tool !== 'select' || target.closest('.canvas-node, .edge-object, .dense-connector-layer, .canvas-toolbar')) return;
    startMarqueeGesture(event);
  };

  const focusCardEditorAt = (placementId: string, clientX: number, clientY: number, titleClick: boolean, attempt = 0) => {
    const cardNode = document.querySelector<HTMLElement>(`[data-placement-id="${placementId}"]`);
    const editor = titleClick
      ? cardNode?.querySelector<HTMLTextAreaElement>('.card-inline-title')
      : cardNode?.querySelector<HTMLElement>('[contenteditable="true"]');
    if (!editor) {
      if (attempt < 4) window.requestAnimationFrame(() => focusCardEditorAt(placementId, clientX, clientY, titleClick, attempt + 1));
      return;
    }
    editor.focus({ preventScroll: true });
    if (editor instanceof HTMLTextAreaElement) return;
    const caret = document.caretPositionFromPoint?.(clientX, clientY);
    if (caret && editor.contains(caret.offsetNode)) {
      const range = document.createRange();
      range.setStart(caret.offsetNode, caret.offset);
      range.collapse(true);
      const textSelection = window.getSelection();
      textSelection?.removeAllRanges();
      textSelection?.addRange(range);
      return;
    }
    const legacyRange = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(clientX, clientY);
    if (legacyRange && editor.contains(legacyRange.startContainer)) {
      const textSelection = window.getSelection();
      textSelection?.removeAllRanges();
      textSelection?.addRange(legacyRange);
    }
  };

  const startNodeDrag = (event: React.PointerEvent, placement: BoardPlacement, force = false) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    if (tool === 'card' || tool === 'text' || tool === 'board' || tool === 'section') {
      startCreationGesture(event, tool);
      return;
    }
    if (tool === 'connect') {
      if (!connectFrom) {
        const sourcePort = connectorTargetPortAt(worldPoint(event.clientX, event.clientY), [placement], viewport.zoom);
        if (!sourcePort) return;
        setConnectFromAnchor(sourcePort.side);
        setConnectPointer(sourcePort.point);
        dispatchInteraction({ type: 'start-connect', fromId: placement.id });
      } else {
        if (connectFrom === placement.id) return;
        const targetPort = connectorTargetPortAt(worldPoint(event.clientX, event.clientY), [placement], viewport.zoom);
        connectPlacements(connectFrom, placement.id, {
          fromAnchor: fixedAnchor(connectFromAnchor),
          toAnchor: fixedAnchor(targetPort?.side ?? 'auto'),
        });
        setConnectPointer(null);
        setHoveredPort(null);
        dispatchInteraction({ type: 'finish' });
        setTool('select');
      }
      return;
    }
    if (placement.locked) {
      setSelection({ kind: 'placement', id: placement.id, ids: [placement.id] });
      return;
    }
    const selectionAtPointerDown = useWorkspaceStore.getState().selection;
    const currentIds = selectionAtPointerDown?.kind === 'placement'
      ? (selectionAtPointerDown.ids?.length ? selectionAtPointerDown.ids : [selectionAtPointerDown.id])
      : [];
    const target = event.target as HTMLElement;
    const cardContent = placement.kind === 'card' && !force && Boolean(target.closest('.card-content-shell'));
    const previewImage = target.closest<HTMLImageElement>('.card-markdown-preview img');
    const previewImageIndex = previewImage
      ? [...(previewImage.closest('.card-markdown-preview')?.querySelectorAll('img') ?? [])].indexOf(previewImage)
      : -1;
    const cardLink = cardContent && Boolean(target.closest('a[href], a[data-wiki-link]'));
    const titleClick = Boolean(target.closest('.card-inline-title'));
    const targetIsCardToolbar = Boolean(target.closest('.card-selection-toolbar'));
    const additiveSelectionClick = isAdditivePlacementClick({
      kind: placement.kind,
      targetIsCardToolbar,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
    });
    const editingThisCard = editingCardPlacementId === placement.id;
    const activateEditingOnClick = cardContent && !editingThisCard;

    // Frames behave like transparent canvas regions until explicitly selected:
    // dragging an unselected frame starts a marquee over its contents, while a
    // click selects only the frame. A subsequent drag moves the frame and its
    // grouped contents without visually selecting every child.
    const frameIntent = framePointerIntent(placement.isFrame, placement.id, currentIds);
    if (frameIntent === 'marquee-or-select-frame') {
      startMarqueeGesture(event, placement.id, additiveSelectionClick);
      return;
    }

    if (cardLink && !editingThisCard) {
      if (!currentIds.includes(placement.id)) setSelection({ kind: 'placement', id: placement.id, ids: [placement.id] });
      return;
    }

    if (cardContent && editingThisCard) {
      if (!currentIds.includes(placement.id)) setSelection({ kind: 'placement', id: placement.id, ids: [placement.id] });
      return;
    }

    const exitsEditingWhenGestureCommits = Boolean(force || editingCardPlacementId);
    if (!force && !activateEditingOnClick && target.closest('[data-no-drag], input, textarea, button, a, [contenteditable="true"]')) {
      if (!currentIds.includes(placement.id)) setSelection({ kind: 'placement', id: placement.id, ids: [placement.id] });
      return;
    }
    const legacySection = sectionForPlacement(placement, board.placements);
    const groupIds = placement.groupId && !legacySection ? board.placements.filter((item) => item.groupId === placement.groupId && !item.locked).map((item) => item.id) : [];
    const sectionDragIds = placement.isFrame
      ? sectionDragPlacementIds([placement.id], board.placements)
      : [];
    const multiDrag = currentIds.length > 1 && currentIds.includes(placement.id);
    const requestedDragIds = multiDrag
      ? currentIds.filter((itemId) => !board.placements.find((item) => item.id === itemId)?.locked)
      : sectionDragIds.length > 1
        ? sectionDragIds
        : groupIds.length > 1 ? groupIds : [placement.id];
    const dragIds = sectionDragPlacementIds(requestedDragIds, board.placements);
    const membershipSettleIds = sectionMembershipSettlementIds(dragIds, board.placements);
    const visualSelectionIds = placement.isFrame ? [placement.id] : requestedDragIds;
    const startPlacements = new Map(board.placements.filter((item) => dragIds.includes(item.id)).map((item) => [item.id, item]));
    const startPositions = new Map([...startPlacements].map(([itemId, item]) => [itemId, { x: item.x, y: item.y }]));
    const anchorStart = startPositions.get(placement.id) ?? { x: placement.x, y: placement.y };
    const start = { x: event.clientX, y: event.clientY };
    const selectionBefore = cloneSelection(selectionAtPointerDown);
    const editingCardBefore = editingCardPlacementId;
    let moved = false;
    let activeBoardDropTarget: { placementId: string; boardId: string; mode: 'move' | 'copy' | 'invalid' } | null = null;
    const moves = createLatestFrameBatch((next: ReturnType<typeof pointerFrameSample>) => {
      const screenDx = next.clientX - start.x;
      const screenDy = next.clientY - start.y;
      const dx = screenDx / viewport.zoom;
      const dy = screenDy / viewport.zoom;
      const rawAnchor = { x: anchorStart.x + dx, y: anchorStart.y + dy };
      const liveBoards = useWorkspaceStore.getState().boards;
      const liveBoard = liveBoards.find((candidate) => candidate.id === board.id) ?? board;
      const pointerWorld = worldPoint(next.clientX, next.clientY);
      const movedNestedBoardIds = liveBoard.placements
        .filter((item) => dragIds.includes(item.id) && item.kind === 'board' && item.entityId)
        .map((item) => item.entityId!);
      const nestedBoardUnderPointer = liveBoard.placements
        .filter((item) => item.kind === 'board' && item.entityId && !dragIds.includes(item.id))
        .filter((item) => pointerWorld.x >= item.x && pointerWorld.x <= item.x + item.width && pointerWorld.y >= item.y && pointerWorld.y <= item.y + item.height)
        .sort((left, right) => (right.zIndex ?? 0) - (left.zIndex ?? 0) || left.width * left.height - right.width * right.height)[0];
      const invalidBoardDrop = Boolean(nestedBoardUnderPointer?.entityId && movedNestedBoardIds.some((childId) => wouldCreateBoardCycle(liveBoards, nestedBoardUnderPointer.entityId!, childId)));
      activeBoardDropTarget = nestedBoardUnderPointer?.entityId ? {
        placementId: nestedBoardUnderPointer.id,
        boardId: nestedBoardUnderPointer.entityId,
        mode: invalidBoardDrop ? 'invalid' : next.altKey ? 'copy' : 'move',
      } : null;
      setBoardDropTarget(activeBoardDropTarget ? { id: activeBoardDropTarget.placementId, mode: activeBoardDropTarget.mode } : null);
      const sectionSnapTarget = !nestedBoardUnderPointer ? liveBoard.placements
        .filter((item) => item.isFrame && !dragIds.includes(item.id))
        .filter((item) => pointerWorld.x >= item.x && pointerWorld.x <= item.x + item.width && pointerWorld.y >= item.y && pointerWorld.y <= item.y + item.height)
        .sort((left, right) => left.width * left.height - right.width * right.height)[0] : undefined;
      const nearbySnap = nestedBoardUnderPointer ? { ...rawAnchor, guides: [] as AlignmentGuideLine[] } : snapBoxToNearbyObjects(
        { id: placement.id, x: rawAnchor.x, y: rawAnchor.y, width: placement.width, height: placement.height },
        liveBoard.placements.filter((item) => !dragIds.includes(item.id) && item.id !== sectionSnapTarget?.id),
        { disabled: next.altKey, enhanced: next.shiftKey, zoom: viewport.zoom },
      );
      const sectionSnap = nestedBoardUnderPointer ? { ...rawAnchor, guides: [] as AlignmentGuideLine[] } : snapBoxToSectionPadding(
        { id: placement.id, x: nearbySnap.x, y: nearbySnap.y, width: placement.width, height: placement.height },
        sectionSnapTarget,
        { disabled: next.altKey, zoom: viewport.zoom },
      );
      const snappedAnchor = { ...nearbySnap, x: sectionSnap.x, y: sectionSnap.y };
      setSnapGuides([...nearbySnap.guides, ...sectionSnap.guides]);
      const snapDx = snappedAnchor.x - rawAnchor.x;
      const snapDy = snappedAnchor.y - rawAnchor.y;
      const proposed = Object.fromEntries([...startPositions].map(([id, point]) => {
        const startPlacement = startPlacements.get(id);
        const change: Partial<BoardPlacement> = {
          x: point.x + dx + snapDx,
          y: point.y + dy + snapDy,
        };
        if (startPlacement?.isFrame) {
          const base = startPlacement.sectionBaseBounds ?? {
            x: startPlacement.x,
            y: startPlacement.y,
            width: startPlacement.width,
            height: startPlacement.height,
          };
          change.sectionBaseBounds = {
            ...base,
            x: base.x + dx + snapDx,
            y: base.y + dy + snapDy,
          };
        }
        return [id, change];
      }));
      const previewPlacements = liveBoard.placements.map((item) => proposed[item.id] ? { ...item, ...proposed[item.id] } : item);
      const nextSectionTargets = nestedBoardUnderPointer ? [] : prospectiveSectionIdsForPlacements(previewPlacements, dragIds).filter((id) => !dragIds.includes(id));
      setSectionDropTargetIds((current) => current.length === nextSectionTargets.length && current.every((id, index) => id === nextSectionTargets[index]) ? current : nextSectionTargets);
      updateBoardLayout(proposed, { translateInternalControlPoints: true });
    });
    const move = (next: PointerEvent) => {
      if (!moved && !hasPointerDragIntent(start, { x: next.clientX, y: next.clientY })) return;
      if (!moved) {
        moved = true;
        if (exitsEditingWhenGestureCommits) {
          setEditingCardPlacementId(null);
          window.getSelection()?.removeAllRanges();
        }
        if (!currentIds.includes(placement.id)) setSelection({ kind: 'placement', id: placement.id, ids: visualSelectionIds });
        beginBoardTransaction(dragIds.length > 1 ? '移动多个对象' : '移动对象');
        dispatchInteraction({ type: 'start-move', pointerId: event.pointerId, placementIds: dragIds });
      }
      next.preventDefault();
      moves.push(pointerFrameSample(next));
    };
    const updateBoardDropModifier = (next: KeyboardEvent) => {
      if (next.key !== 'Alt' || !activeBoardDropTarget || activeBoardDropTarget.mode === 'invalid') return;
      const mode = next.type === 'keydown' ? 'copy' : 'move';
      if (activeBoardDropTarget.mode === mode) return;
      activeBoardDropTarget = { ...activeBoardDropTarget, mode };
      setBoardDropTarget({ id: activeBoardDropTarget.placementId, mode });
    };
    const up = (next: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('keydown', updateBoardDropModifier, true);
      window.removeEventListener('keyup', updateBoardDropModifier, true);
      if (moved) {
        if (next.type === 'pointercancel') {
          moves.cancel();
          cancelBoardTransaction();
          setSelection(selectionBefore);
          setEditingCardPlacementId(editingCardBefore);
        }
        else {
          if (activeBoardDropTarget?.mode === 'invalid') {
            moves.cancel();
            cancelBoardTransaction();
            setSelection(selectionBefore);
            useWorkspaceStore.getState().pushNotice({ tone: 'info', title: '无法移入这个白板', message: '移动后会形成循环嵌套，已恢复到原位置。' });
          } else {
            moves.flush();
            // The user may press or release Alt after the pointer has already
            // stopped over the nested board. The release event is the final
            // authority for the transfer semantics.
            const copy = Boolean(activeBoardDropTarget && next.altKey);
            const transferIds = copy ? dragIds.filter((id) => !startPlacements.get(id)?.isFrame) : dragIds;
            if (activeBoardDropTarget && copy && !transferIds.length) {
              moves.cancel();
              cancelBoardTransaction();
              setSelection(selectionBefore);
            } else {
              const transferred = activeBoardDropTarget
                ? transferPlacementsToBoard(activeBoardDropTarget.boardId, transferIds, { copy })
                : false;
              if (!transferred) { settleBoardLayout(membershipSettleIds); commitBoardTransaction(); }
            }
          }
        }
      } else {
        moves.cancel();
        if (next.type !== 'pointercancel' && additiveSelectionClick) {
          setEditingCardPlacementId(null);
          window.getSelection()?.removeAllRanges();
          const ids = togglePlacementId(currentIds, placement.id);
          setSelection(ids.length ? { kind: 'placement', id: ids.at(-1)!, ids } : null);
        } else if (activateEditingOnClick && next.type !== 'pointercancel') {
          setSelection({ kind: 'placement', id: placement.id, ids: [placement.id] });
          if (previewImageIndex >= 0) setPendingImageSelection({ placementId: placement.id, imageIndex: previewImageIndex });
          setEditingCardPlacementId(placement.id);
          dispatchInteraction({ type: 'start-edit', placementId: placement.id });
          if (previewImageIndex < 0) window.requestAnimationFrame(() => focusCardEditorAt(placement.id, start.x, start.y, titleClick));
        } else if (next.type !== 'pointercancel') {
          if (exitsEditingWhenGestureCommits) {
            setEditingCardPlacementId(null);
            window.getSelection()?.removeAllRanges();
          }
          setSelection({ kind: 'placement', id: placement.id, ids: visualSelectionIds });
        }
      }
      setSnapGuides([]);
      setSectionDropTargetIds([]);
      setBoardDropTarget(null);
      if (moved) dispatchInteraction({ type: 'finish-pointer', pointerId: event.pointerId });
      else if (!activateEditingOnClick || additiveSelectionClick || next.type === 'pointercancel') dispatchInteraction({ type: 'finish' });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('pointercancel', up, { once: true });
    window.addEventListener('keydown', updateBoardDropModifier, true);
    window.addEventListener('keyup', updateBoardDropModifier, true);
  };

  const startResize = (event: React.PointerEvent, placement: BoardPlacement, direction: ResizeDirection) => {
    event.stopPropagation(); event.preventDefault();
    if (placement.locked) { setSelection({ kind: 'placement', id: placement.id, ids: [placement.id] }); return; }
    const selectionAtPointerDown = useWorkspaceStore.getState().selection;
    const selectionBefore = cloneSelection(selectionAtPointerDown);
    const liveSelectedIds = selectionAtPointerDown?.kind === 'placement'
      ? (selectionAtPointerDown.ids?.length ? selectionAtPointerDown.ids : [selectionAtPointerDown.id])
      : [];
    const editingCardBefore = editingCardPlacementId;
    setEditingCardPlacementId(null);
    window.getSelection()?.removeAllRanges();
    if (!liveSelectedIds.includes(placement.id)) setSelection({ kind: 'placement', id: placement.id, ids: [placement.id] });
    beginBoardTransaction('调整对象大小');
    dispatchInteraction({ type: 'start-resize', pointerId: event.pointerId, placementId: placement.id });
    const start = { pointerX: event.clientX, pointerY: event.clientY, x: placement.x, y: placement.y, width: placement.width, height: placement.height };
    const edges: ResizeEdges = {
      left: direction.includes('w'),
      right: direction.includes('e'),
      top: direction.includes('n'),
      bottom: direction.includes('s'),
    };
    const moves = createLatestFrameBatch((next: ReturnType<typeof pointerFrameSample>) => {
      const { width: minWidth, height: minHeight } = minimumPlacementDimensions(placement);
      const dx = (next.clientX - start.pointerX) / viewport.zoom;
      const dy = (next.clientY - start.pointerY) / viewport.zoom;
      let rawX = start.x;
      let rawY = start.y;
      let rawWidth = start.width;
      let rawHeight = start.height;
      if (edges.left) {
        rawX = start.x + dx;
        rawWidth = start.width - dx;
        if (rawWidth < minWidth) { rawX = start.x + start.width - minWidth; rawWidth = minWidth; }
      } else if (edges.right) rawWidth = Math.max(minWidth, start.width + dx);
      if (edges.top) {
        rawY = start.y + dy;
        rawHeight = start.height - dy;
        if (rawHeight < minHeight) { rawY = start.y + start.height - minHeight; rawHeight = minHeight; }
      } else if (edges.bottom) rawHeight = Math.max(minHeight, start.height + dy);
      const snapped = snapResizeBoxToNearbyObjects(
        { ...placement, x: rawX, y: rawY, width: rawWidth, height: rawHeight },
        board.placements.filter((item) => item.id !== placement.id),
        { disabled: next.altKey, enhanced: next.shiftKey, edges, zoom: viewport.zoom },
      );
      let { x, y, width, height } = snapped;
      if (width < minWidth) {
        if (edges.left) x = start.x + start.width - minWidth;
        width = minWidth;
      }
      if (height < minHeight) {
        if (edges.top) y = start.y + start.height - minHeight;
        height = minHeight;
      }
      const keptSnap = x === snapped.x && y === snapped.y && width === snapped.width && height === snapped.height;
      setSnapGuides(keptSnap ? snapped.guides : []);
      const rootChanges = { [placement.id]: {
        x,
        y,
        width,
        height,
      } };
      updateBoardLayout(rootChanges);
    });
    const move = (next: PointerEvent) => { next.preventDefault(); moves.push(pointerFrameSample(next)); };
    const up = (next: Event) => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); if (next.type === 'pointercancel') { moves.cancel(); cancelBoardTransaction(); setSelection(selectionBefore); setEditingCardPlacementId(editingCardBefore); } else { moves.flush(); settleBoardLayout(sectionMembershipSettlementIds([placement.id], board.placements)); commitBoardTransaction(); } setSnapGuides([]); dispatchInteraction({ type: 'finish-pointer', pointerId: event.pointerId }); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('pointercancel', up, { once: true });
  };

  const startGroupResize = (event: React.PointerEvent, direction: ResizeDirection) => {
    event.stopPropagation();
    event.preventDefault();
    if (!multiSelectionBounds || multiSelectionPlacements.length < 2) return;
    const selectionBefore = cloneSelection(useWorkspaceStore.getState().selection);
    const editingCardBefore = editingCardPlacementId;
    setEditingCardPlacementId(null);
    window.getSelection()?.removeAllRanges();
    beginBoardTransaction('调整多个对象大小');
    dispatchInteraction({ type: 'start-resize', pointerId: event.pointerId, placementId: selectedIds[0] });
    const start = { pointerX: event.clientX, pointerY: event.clientY, ...multiSelectionBounds };
    const edges: ResizeEdges = {
      left: direction.includes('w'), right: direction.includes('e'),
      top: direction.includes('n'), bottom: direction.includes('s'),
    };
    const minimumScaleX = Math.max(...multiSelectionPlacements.map((placement) => minimumPlacementDimensions(placement).width / placement.width));
    const minimumScaleY = Math.max(...multiSelectionPlacements.map((placement) => minimumPlacementDimensions(placement).height / placement.height));
    const minimumWidth = start.width * minimumScaleX;
    const minimumHeight = start.height * minimumScaleY;
    const moves = createLatestFrameBatch((next: ReturnType<typeof pointerFrameSample>) => {
      const dx = (next.clientX - start.pointerX) / viewport.zoom;
      const dy = (next.clientY - start.pointerY) / viewport.zoom;
      let rawX = start.x; let rawY = start.y; let rawWidth = start.width; let rawHeight = start.height;
      if (edges.left) {
        rawX = start.x + dx; rawWidth = start.width - dx;
        if (rawWidth < minimumWidth) { rawX = start.x + start.width - minimumWidth; rawWidth = minimumWidth; }
      } else if (edges.right) rawWidth = Math.max(minimumWidth, start.width + dx);
      if (edges.top) {
        rawY = start.y + dy; rawHeight = start.height - dy;
        if (rawHeight < minimumHeight) { rawY = start.y + start.height - minimumHeight; rawHeight = minimumHeight; }
      } else if (edges.bottom) rawHeight = Math.max(minimumHeight, start.height + dy);
      const snapped = snapResizeBoxToNearbyObjects(
        { id: '__multi-selection__', x: rawX, y: rawY, width: rawWidth, height: rawHeight },
        board.placements.filter((placement) => !selectedIds.includes(placement.id)),
        { disabled: next.altKey, enhanced: next.shiftKey, edges, zoom: viewport.zoom },
      );
      let { x, y, width, height } = snapped;
      if (width < minimumWidth) { if (edges.left) x = start.x + start.width - minimumWidth; width = minimumWidth; }
      if (height < minimumHeight) { if (edges.top) y = start.y + start.height - minimumHeight; height = minimumHeight; }
      const keptSnap = x === snapped.x && y === snapped.y && width === snapped.width && height === snapped.height;
      setSnapGuides(keptSnap ? snapped.guides : []);
      updateBoardLayout(resizePlacementGroup(multiSelectionPlacements, multiSelectionBounds, { x, y, width, height }));
    });
    const move = (next: PointerEvent) => { next.preventDefault(); moves.push(pointerFrameSample(next)); };
    const up = (next: Event) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (next.type === 'pointercancel') { moves.cancel(); cancelBoardTransaction(); setSelection(selectionBefore); setEditingCardPlacementId(editingCardBefore); } else { moves.flush(); settleBoardLayout(sectionMembershipSettlementIds(selectedIds, board.placements)); commitBoardTransaction(); }
      setSnapGuides([]);
      dispatchInteraction({ type: 'finish-pointer', pointerId: event.pointerId });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('pointercancel', up, { once: true });
  };

  const startConnectorHandleDrag = (
    event: React.PointerEvent,
    connector: BoardConnector,
    handle: ConnectorHandle,
  ) => {
    event.stopPropagation();
    event.preventDefault();
    setContextMenu(null);
    setSelection({ kind: 'connector', id: connector.id });
    if (handle.kind === 'label') {
      const keypoints = (connector.controlPoints ?? []).map((point) => ({ ...point }));
      let dragging = false;
      const start = { x: event.clientX, y: event.clientY };
      const moves = createLatestFrameBatch((next: ReturnType<typeof pointerFrameSample>) => {
        const point = worldPoint(next.clientX, next.clientY);
        keypoints[handle.index] = { ...keypoints[handle.index], x: point.x, y: point.y };
        updateConnector(connector.id, { controlPoints: keypoints });
      });
      const move = (next: PointerEvent) => {
        if (!dragging && !hasPointerDragIntent(start, { x: next.clientX, y: next.clientY })) return;
        if (!dragging) {
          dragging = true;
          beginBoardTransaction(handle.existing ? '移动连接线标签' : '添加连接线标签关键点');
          if (!handle.existing) keypoints.splice(handle.index, 0, { id: crypto.randomUUID(), x: handle.point.x, y: handle.point.y });
        }
        moves.push(pointerFrameSample(next));
      };
      const up = (next: Event) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        if (dragging && next.type === 'pointercancel') { moves.cancel(); cancelBoardTransaction(); }
        else if (dragging) { moves.flush(); commitBoardTransaction(); }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up, { once: true });
      window.addEventListener('pointercancel', up, { once: true });
      return;
    }
    if (handle.kind === 'keypoint' || handle.kind === 'insert') {
      const keypoints = (connector.controlPoints ?? []).map((point) => ({ ...point }));
      const keypointIndex = handle.index;
      const start = { x: event.clientX, y: event.clientY };
      let dragging = handle.kind === 'insert';
      if (handle.kind === 'insert') {
        beginBoardTransaction('添加连接线关键点');
        keypoints.splice(keypointIndex, 0, { id: crypto.randomUUID(), x: handle.point.x, y: handle.point.y, ...(handle.direction ? { direction: handle.direction } : {}) });
        updateConnector(connector.id, { controlPoints: keypoints });
      }
      const moves = createLatestFrameBatch((next: ReturnType<typeof pointerFrameSample>) => {
        const point = worldPoint(next.clientX, next.clientY);
        keypoints[keypointIndex] = moveConnectorControlPoint(keypoints[keypointIndex], point);
        updateConnector(connector.id, { controlPoints: keypoints });
      });
      const move = (next: PointerEvent) => {
        if (!dragging && !hasPointerDragIntent(start, { x: next.clientX, y: next.clientY })) return;
        if (!dragging) {
          dragging = true;
          beginBoardTransaction('移动连接线关键点');
        }
        moves.push(pointerFrameSample(next));
      };
      const up = (next: Event) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        if (!dragging) moves.cancel();
        else if (next.type === 'pointercancel') { moves.cancel(); cancelBoardTransaction(); }
        else { moves.flush(); commitBoardTransaction(); }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up, { once: true });
      window.addEventListener('pointercancel', up, { once: true });
      return;
    }

    const start = { x: event.clientX, y: event.clientY };
    let dragging = false;
    const moves = createLatestFrameBatch((next: ReturnType<typeof pointerFrameSample>) => {
      const rawPoint = worldPoint(next.clientX, next.clientY);
      const oppositeId = handle.kind === 'from' ? connector.to : connector.from;
      const port = targetPortAt(rawPoint, board.placements.filter((placement) => placement.id !== oppositeId));
      const opposite = board.placements.find((placement) => placement.id === oppositeId);
      const targetPlacement = port && board.placements.find((placement) => placement.id === port.placementId);
      const snappedPoint = port && targetPlacement && opposite
        ? resolvedConnectorEndpointAnchor(connector, handle.kind, targetPlacement, opposite, port.side).point
        : rawPoint;
      setConnectorEndpointDrag({ connectorId: connector.id, handle: handle.kind, point: snappedPoint, port: port ?? undefined });
      setHoveredPort(port);
    });
    const move = (next: PointerEvent) => {
      if (!dragging && !hasPointerDragIntent(start, { x: next.clientX, y: next.clientY })) return;
      if (!dragging) {
        dragging = true;
        beginBoardTransaction('重新连接端点');
      }
      moves.push(pointerFrameSample(next));
    };
    const up = (next: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      moves.cancel();
      if (!dragging) {
        setConnectorEndpointDrag(null);
        setHoveredPort(null);
        return;
      }
      const rawPoint = worldPoint(next.clientX, next.clientY);
      const oppositeId = handle.kind === 'from' ? connector.to : connector.from;
      const port = targetPortAt(rawPoint, board.placements.filter((placement) => placement.id !== oppositeId));
      if (port) updateConnector(connector.id, connectorEndpointPatch(handle.kind, port));
      setConnectorEndpointDrag(null);
      setHoveredPort(null);
      commitBoardTransaction();
    };
    const cancel = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      moves.cancel();
      setConnectorEndpointDrag(null);
      setHoveredPort(null);
      if (dragging) cancelBoardTransaction();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('pointercancel', cancel, { once: true });
  };

  const removeConnectorKeypoint = (event: React.MouseEvent, connector: BoardConnector, index: number) => {
    event.preventDefault();
    event.stopPropagation();
    updateConnector(connector.id, { controlPoints: (connector.controlPoints ?? []).filter((_, pointIndex) => pointIndex !== index) });
  };

  const createCardAt = (position = viewportCenter(), sectionId?: string) => {
    const placement = createCardPlacement({
      x: position.x - 260,
      y: position.y - 72,
      ...(sectionId ? { sectionId, sectionIds: [sectionId] } : {}),
    });
    if (placement) setEditingCardPlacementId(placement.id);
    setNewCardId(placement?.entityId ?? null);
  };

  const createNestedBoard = (position = viewportCenter(), sectionId?: string) => {
    beginNestedBoardRename(createNestedBoardPlacement({
      x: position.x - 215,
      y: position.y - 135,
      ...(sectionId ? { sectionId, sectionIds: [sectionId] } : {}),
    }), true);
  };

  const createSectionAt = (position = viewportCenter(), parentSectionId?: string) => addSectionPlacement({
    x: position.x,
    y: position.y,
    ...(parentSectionId ? { sectionId: parentSectionId, sectionIds: [parentSectionId] } : {}),
  });

  const beginCreatedSectionRename = (placement: BoardPlacement | null) => {
    if (!placement) return null;
    setEditingCardPlacementId(null);
    setEditingTextId(placement.id);
    return placement;
  };

  const createSectionFromSelection = () => beginCreatedSectionRename(frameSelection());

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    try {
      const data = JSON.parse(event.dataTransfer.getData('application/x-opencanvas-item')) as { kind: 'card' | 'board'; id: string };
      const point = worldPoint(event.clientX, event.clientY);
      if (data.kind === 'card') addCardPlacement(data.id, point);
      if (data.kind === 'board') addBoardPlacement(data.id, point);
    } catch { /* Ignore unrelated drops. */ }
  };

  const finishWheelFeedback = () => {
    if (wheelFeedbackTimerRef.current !== null) window.clearTimeout(wheelFeedbackTimerRef.current);
    wheelFeedbackTimerRef.current = null;
    setWheelZooming(false);
  };

  const consumePendingWheelViewport = () => {
    const liveViewport = useWorkspaceStore.getState().boards.find((candidate) => candidate.id === board.id)?.viewport ?? viewport;
    const latest = wheelFrameRef.current !== null && pendingWheelViewportRef.current
      ? pendingWheelViewportRef.current
      : liveViewport;
    if (wheelFrameRef.current !== null) window.cancelAnimationFrame(wheelFrameRef.current);
    wheelFrameRef.current = null;
    pendingWheelViewportRef.current = null;
    wheelViewportRef.current = latest;
    finishWheelFeedback();
    return latest;
  };

  const handleWheel = (event: React.WheelEvent) => {
    setContextMenu(null);
    const target = event.target as HTMLElement;
    const scrollable = target.closest<HTMLElement>('.card-inline-editor');
    const editing = Boolean(scrollable?.closest('.canvas-node.card-editing'));
    const horizontalDelta = event.shiftKey && Math.abs(event.deltaX) < .01 ? event.deltaY : event.deltaX;
    const verticalDelta = event.shiftKey && Math.abs(event.deltaX) < .01 ? 0 : event.deltaY;
    if (!event.ctrlKey && scrollable) {
      const nestedScrollable = target.closest<HTMLElement>('.tableWrapper, pre');
      const candidates = nestedScrollable && scrollable.contains(nestedScrollable)
        ? [nestedScrollable, scrollable]
        : [scrollable];
      if (candidates.some((candidate) => shouldUseInnerScroll({
        editing,
        scrollHeight: candidate.scrollHeight,
        clientHeight: candidate.clientHeight,
        scrollWidth: candidate.scrollWidth,
        clientWidth: candidate.clientWidth,
        deltaX: horizontalDelta,
        deltaY: verticalDelta,
      }))) return;
    }
    // A pure horizontal trackpad gesture has no canvas-zoom meaning. Leave it
    // alone instead of flashing the zoom HUD or cancelling native scrolling.
    if (Math.abs(event.deltaY) < .01) return;

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
    const next = zoomViewportAtPoint(wheelViewportRef.current, pointer, normalizedWheelDelta(event.deltaY, event.deltaMode, rect.height), 0.0018, MIN_ZOOM, MAX_ZOOM);
    wheelViewportRef.current = next;
    pendingWheelViewportRef.current = next;
    if (wheelFrameRef.current === null) {
      wheelFrameRef.current = window.requestAnimationFrame(() => {
        wheelFrameRef.current = null;
        const pending = pendingWheelViewportRef.current;
        pendingWheelViewportRef.current = null;
        if (pending) setViewport(pending);
      });
    }
  };

  const zoomAtCenter = (next: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const base = consumePendingWheelViewport();
    const zoom = clamp(next, MIN_ZOOM, MAX_ZOOM);
    const cx = rect.width / 2; const cy = rect.height / 2;
    const wx = (cx - base.x) / base.zoom; const wy = (cy - base.y) / base.zoom;
    setViewport({ zoom, x: cx - wx * zoom, y: cy - wy * zoom });
  };

  const fitObjects = () => {
    const rect = canvasRef.current?.getBoundingClientRect();
    consumePendingWheelViewport();
    if (!rect || !board.placements.length) { setViewport({ x: 120, y: 90, zoom: 0.8 }); return; }
    const minX = Math.min(...board.placements.map((placement) => placement.x)); const minY = Math.min(...board.placements.map((placement) => placement.y));
    const maxX = Math.max(...board.placements.map((placement) => placement.x + placement.width)); const maxY = Math.max(...board.placements.map((placement) => placement.y + placement.height));
    const width = maxX - minX; const height = maxY - minY;
    const zoom = clamp(Math.min((rect.width - 220) / width, (rect.height - 180) / height), MIN_ZOOM, 1);
    setViewport({ zoom, x: (rect.width - width * zoom) / 2 - minX * zoom, y: (rect.height - height * zoom) / 2 - minY * zoom });
  };

  const revealPlacement = (placementId: string) => {
    const placement = board.placements.find((item) => item.id === placementId);
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!placement || !rect) return;
    const base = consumePendingWheelViewport();
    const zoom = clamp(base.zoom, MIN_ZOOM, MAX_ZOOM);
    setSelection({ kind: 'placement', id: placement.id, ids: [placement.id] });
    setViewport({
      zoom,
      x: rect.width / 2 - (placement.x + placement.width / 2) * zoom,
      y: rect.height / 2 - (placement.y + placement.height / 2) * zoom,
    });
  };

  const contextPlacementId = contextMenu && contextMenu.target.kind === 'placement' ? contextMenu.target.id : null;
  const contextPlacement = contextPlacementId
    ? board.placements.find((placement) => placement.id === contextPlacementId)
    : undefined;
  const contextCard = contextPlacement?.kind === 'card' && contextPlacement.entityId ? cardMap.get(contextPlacement.entityId) : undefined;
  const contextBoard = contextPlacement?.kind === 'board' && contextPlacement.entityId ? boardMap.get(contextPlacement.entityId) : undefined;
  const contextConnectorId = contextMenu?.target.kind === 'connector' ? contextMenu.target.id : null;
  const contextConnector = contextConnectorId
    ? board.connectors.find((connector) => connector.id === contextConnectorId)
    : undefined;
  const contextSelectionCount = selection?.kind === 'placement' ? (selection.ids?.length || 1) : 0;
  const contextSelectedPlacements = board.placements.filter((placement) => selectedIds.includes(placement.id));
  const firstContextSelectionColor = placementColorKey(contextSelectedPlacements[0]?.color);
  const contextSelectionColor = contextSelectedPlacements.length > 0
    && contextSelectedPlacements.every((placement) => placementColorKey(placement.color) === firstContextSelectionColor)
    ? firstContextSelectionColor
    : null;
  const contextSelectionLocked = contextSelectedPlacements.length > 0 && contextSelectedPlacements.every((placement) => placement.locked);
  const contextSelectionGrouped = contextSelectedPlacements.some((placement) => placement.groupId);
  const contextConvertibleTextCount = contextSelectedPlacements.filter((placement) => placement.kind === 'text' && !placement.isFrame).length;
  const contextFittableCount = contextSelectedPlacements.filter((placement) => !placement.locked && (placement.kind === 'card' || placement.isFrame)).length;
  const contextResizableToDefaultCount = contextSelectedPlacements.filter((placement) => !placement.isFrame && !placement.locked).length;
  const minimapWidth = 180;
  const minimapHeight = 116;
  let minimapMesh = minimapMeshRef.current;
  if (!minimapMesh || minimapMesh.boardId !== board.id || minimapMesh.placements !== board.placements) {
    const layout = createMinimapLayout(drawablePlacements, minimapWidth, minimapHeight);
    minimapMesh = {
      boardId: board.id,
      placements: board.placements,
      layout,
      paths: minimapMeshPaths(drawablePlacements, layout, (placement) => placement.isFrame ? 'frame' : placement.kind),
    };
    minimapMeshRef.current = minimapMesh;
  }
  const minimapLayout = minimapMesh.layout;
  const selectedMinimapIds = new Set(selectedIds);
  const selectedMinimapPath = selectedMinimapIds.size
    ? minimapMeshPaths(drawablePlacements.filter((placement) => selectedMinimapIds.has(placement.id)), minimapLayout, () => 'selected').get('selected')
    : undefined;
  const currentMinimapViewport = minimapViewportRect(viewport, canvasSize, minimapLayout);

  const startMinimapNavigation = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    const liveBoard = useWorkspaceStore.getState().boards.find((candidate) => candidate.id === board.id);
    const viewportBefore = { ...(activePointerViewportBeforeRef.current ?? liveBoard?.viewport ?? viewport) };
    const base = consumePendingWheelViewport();
    const displayedViewport = minimapViewportRect(base, canvasSize, minimapLayout);
    const grabbedViewport = Boolean((event.target as HTMLElement).closest('.minimap-viewport'));
    const pointerOffset = grabbedViewport ? {
      x: event.clientX - rect.left - (displayedViewport.left + displayedViewport.width / 2),
      y: event.clientY - rect.top - (displayedViewport.top + displayedViewport.height / 2),
    } : { x: 0, y: 0 };
    const navigate = (clientX: number, clientY: number) => {
      const center = worldPointForMinimap({
        x: clientX - rect.left - pointerOffset.x,
        y: clientY - rect.top - pointerOffset.y,
      }, minimapLayout);
      setViewport({
        zoom: base.zoom,
        x: canvasSize.width / 2 - center.x * base.zoom,
        y: canvasSize.height / 2 - center.y * base.zoom,
      });
    };
    if (!grabbedViewport) navigate(event.clientX, event.clientY);
    setMinimapDragging(true);
    element.setPointerCapture?.(event.pointerId);
    const moves = createLatestFrameBatch((sample: ReturnType<typeof pointerFrameSample>) => navigate(sample.clientX, sample.clientY));
    const move = (next: PointerEvent) => { next.preventDefault(); moves.push(pointerFrameSample(next)); };
    let settled = false;
    const lostCapture = () => {
      if (!settled) finish(new Event('pointercancel') as PointerEvent);
    };
    const finish = (next: PointerEvent) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      element.removeEventListener('lostpointercapture', lostCapture);
      if (next.type === 'pointercancel') {
        moves.cancel();
        restoreViewportAfterCancelledGesture(viewportBefore);
      } else moves.flush();
      if (element.hasPointerCapture?.(event.pointerId)) element.releasePointerCapture(event.pointerId);
      setMinimapDragging(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', finish, { once: true });
    element.addEventListener('lostpointercapture', lostCapture, { once: true });
  };

  const handleMinimapKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const distance = event.shiftKey ? 240 : 72;
    if (event.key === 'Home') {
      event.preventDefault();
      fitObjects();
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const base = consumePendingWheelViewport();
    setViewport({
      ...base,
      x: base.x + (event.key === 'ArrowLeft' ? distance : event.key === 'ArrowRight' ? -distance : 0),
      y: base.y + (event.key === 'ArrowUp' ? distance : event.key === 'ArrowDown' ? -distance : 0),
    });
  };
  const projectCardIds = new Set(board.placements.filter((placement) => placement.kind === 'card' && placement.entityId).map((placement) => placement.entityId!));
  const projectCards = cards.filter((card) => projectCardIds.has(card.id));
  const rootProjectCards = projectCards.filter((card) => !card.relativePath.includes('/'));
  const organizedProjectCards = projectCards.filter((card) => card.relativePath.includes('/'));

  const openProjectDialog = () => {
    setProjectNameDraft(currentProject?.name ?? board.title);
    setProjectError(null);
    setProjectDialogOpen(true);
  };

  const confirmOrganizeProject = async () => {
    setProjectBusy(true);
    setProjectError(null);
    try {
      await organizeBoardAsProject(board.id, projectNameDraft);
      setProjectDialogOpen(false);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : '建立项目目录失败');
    } finally {
      setProjectBusy(false);
    }
  };

  const runContextAction = (action: () => unknown) => {
    setContextMenu(null);
    setConnectorPanel(null);
    void action();
  };
  const setContextColor = (color: string) => runContextAction(() => setSelectionColor(color));

  const showContextToast = (message: string) => {
    setContextToast(message);
    window.setTimeout(() => setContextToast(null), 1400);
  };

  const copyEntityLink = async () => {
    if (!contextPlacement?.entityId) return;
    const scheme = contextPlacement.kind === 'card' ? 'card' : 'board';
    await navigator.clipboard.writeText(`opencanvas://${scheme}/${contextPlacement.entityId}`);
    showContextToast('链接已复制');
  };

  const toggleConnectionFromPlacement = (placement: BoardPlacement) => {
    if (placement.isFrame) return;
    if (connectFrom === placement.id) {
      setConnectPointer(null);
      setHoveredPort(null);
      dispatchInteraction({ type: 'cancel' });
      setTool('select');
      return;
    }
    setConnectFromAnchor('auto');
    setConnectPointer(portPoint(placement, 'auto'));
    dispatchInteraction({ type: 'start-connect', fromId: placement.id });
    setTool('connect');
  };

  const renderNode = (node: BoardPlacement) => {
    const selected = selectedIds.includes(node.id);
    const singleSelected = selected && selectedIds.length === 1;
    const cardEditing = singleSelected && node.kind === 'card' && editingCardPlacementId === node.id;
    const card = node.kind === 'card' && node.entityId ? cardMap.get(node.entityId) : undefined;
    const nested = node.kind === 'board' && node.entityId ? boardMap.get(node.entityId) : undefined;
    const objectMenuOpen = contextMenu?.target.kind === 'placement' && contextMenu.target.id === node.id;
    const layers = placementLayerTokens(node.zIndex, node.isFrame, placementLayerRange.min, placementLayerRange.max);
    const nestedDropMode = boardDropTarget?.id === node.id ? boardDropTarget.mode : null;
    const nestedDropAnnouncement = nestedDropMode === 'invalid'
      ? '，不能移入：会形成循环嵌套'
      : nestedDropMode === 'copy'
        ? '，释放后复制到这里'
        : nestedDropMode === 'move'
          ? '，释放后移入这里'
          : '';
    const renderedNodeX = node.isFrame ? node.x : (Math.round((renderedViewport.x + node.x * viewport.zoom) * renderPixelRatio) / renderPixelRatio - renderedViewport.x) / viewport.zoom;
    const renderedNodeY = node.isFrame ? node.y : (Math.round((renderedViewport.y + node.y * viewport.zoom) * renderPixelRatio) / renderPixelRatio - renderedViewport.y) / viewport.zoom;

    return (
      <article
        key={node.id}
        data-placement-id={node.id}
        data-card-id={card?.id}
        aria-label={node.isFrame ? `区块：${node.text || '未命名区块'}${selected ? '，已选择' : ''}${sectionDropTargetIds.includes(node.id) ? '，将包含拖动对象' : ''}` : node.kind === 'card' ? `卡片：${card?.title || '未命名卡片'}${selected ? '，已选择' : ''}` : node.kind === 'board' ? `嵌套白板：${nested?.title || '未命名白板'}${selected ? '，已选择' : ''}${nestedDropAnnouncement}` : `文字：${node.text || '空白文字'}${selected ? '，已选择' : ''}`}
        className={`canvas-node node-${node.kind === 'card' ? 'note' : node.kind} ${node.collapsed ? 'card-collapsed' : ''} ${node.isFrame ? 'node-frame' : ''} ${sectionDropTargetIds.includes(node.id) ? 'section-containment-target' : ''} ${nestedDropMode && nestedDropMode !== 'invalid' ? 'nested-board-drop-target' : ''} ${nestedDropMode === 'copy' ? 'nested-board-drop-copy-target' : ''} ${nestedDropMode === 'invalid' ? 'nested-board-drop-invalid-target' : ''} ${node.locked ? 'node-locked' : ''} node-color-${placementColorKey(node.color)} ${selected ? 'selected' : ''} ${cardEditing ? 'card-editing' : ''} ${arrangingPlacementIds.includes(node.id) ? 'is-arranging' : ''} ${marqueePreviewIds.includes(node.id) ? 'marquee-target' : ''} ${connectFrom === node.id ? 'connection-source' : ''} ${hoveredPort?.placementId === node.id ? 'connection-target' : ''}`}
        style={{
          transform: node.isFrame ? undefined : `translate(${renderedNodeX}px, ${renderedNodeY}px)`,
          left: node.isFrame ? node.x : undefined,
          top: node.isFrame ? node.y : undefined,
          width: node.width,
          height: node.height,
          '--node-resting-z': layers.resting,
          '--node-hover-z': layers.hover,
          '--node-marquee-z': layers.marquee,
          '--node-selected-z': layers.selected,
        } as React.CSSProperties}
        onPointerDown={(event) => startNodeDrag(event, node)}
        onContextMenu={(event) => openPlacementContextMenu(event, node)}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (nested && renamingNestedBoard?.placementId !== node.id) openBoard(nested.id, true);
          if (node.kind === 'text') { setEditingTextId(node.id); dispatchInteraction({ type: 'start-edit', placementId: node.id }); }
        }}
      >
        {node.kind === 'card' && (
          <header
            className={`card-selection-toolbar ${singleSelected ? 'is-visible' : ''}`}
            onPointerDown={(event) => startNodeDrag(event, node, true)}
            onDoubleClick={(event) => {
              if ((event.target as HTMLElement).closest('button')) return;
              event.stopPropagation();
              if (card) openCardInSidePanel(card.id);
            }}
          >
            <>
              <div>
                <button
                  data-no-drag
                  tabIndex={singleSelected ? 0 : -1}
                  aria-label={node.collapsed ? '展开卡片内容' : '折叠卡片内容'}
                  title={node.collapsed ? '展开卡片内容' : '折叠卡片内容'}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => {
                    setEditingCardPlacementId(null);
                    window.getSelection()?.removeAllRanges();
                    void useWorkspaceStore.getState().setCardPlacementsCollapsed([node.id], !node.collapsed);
                  }}
                ><ChevronRight className={`card-fold-icon ${node.collapsed ? 'is-expand' : 'is-fold'}`} size={15} /></button>
                <button data-no-drag tabIndex={singleSelected ? 0 : -1} aria-label="展开卡片" onPointerDown={(event) => event.stopPropagation()} onClick={() => card && focusCard(card.id)}><Maximize2 size={14} /></button>
                <button
                  data-no-drag
                  tabIndex={singleSelected ? 0 : -1}
                  className={`card-panel-toggle ${card && sidePanelOpen && sidePanelCardId === card.id ? 'is-open' : ''}`}
                  aria-label={card && sidePanelOpen && sidePanelCardId === card.id ? '折叠右侧栏' : '展开右侧栏'}
                  aria-pressed={Boolean(card && sidePanelOpen && sidePanelCardId === card.id)}
                  title={card && sidePanelOpen && sidePanelCardId === card.id ? '折叠右侧栏' : '展开右侧栏'}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => card && openCardInSidePanel(sidePanelOpen && sidePanelCardId === card.id ? null : card.id)}
                ><PanelRight size={14} /></button>
              </div>
              <span />
              <div className="card-toolbar-right">
                <button
                  data-no-drag
                  tabIndex={singleSelected ? 0 : -1}
                  aria-label={`${card?.title || '未命名卡片'} 更多操作`}
                  aria-haspopup="menu"
                  aria-expanded={objectMenuOpen}
                  title="更多操作"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    const rect = event.currentTarget.getBoundingClientRect();
                    openPlacementContextMenuAt(node, rect.right + 5, rect.bottom + 5);
                  }}
                ><Ellipsis size={15} /></button>
                <button
                  data-no-drag
                  tabIndex={singleSelected ? 0 : -1}
                  className={connectFrom === node.id ? 'active' : ''}
                  aria-label={connectFrom === node.id ? '取消从此卡片连线' : '从此卡片开始连线'}
                  aria-pressed={connectFrom === node.id}
                  title={connectFrom === node.id ? '取消连线' : '连接卡片'}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => toggleConnectionFromPlacement(node)}
                ><MoveUpRight size={15} /></button>
              </div>
            </>
          </header>
        )}

        {(connectFrom || connectorEndpointDrag) && ANCHOR_CHOICES.map((side) => {
          const active = hoveredPort?.placementId === node.id && hoveredPort.side === side;
          const sourceNode = connectFrom === node.id;
          const source = sourceNode && connectFromAnchor === side;
          const target = hoveredPort?.placementId === node.id;
          if (!sourceNode && !target) return null;
          return (
            <button
              key={`port-${side}`}
              data-no-drag
              className={`connection-port connection-port-${side} ${active ? 'active' : ''} ${source ? 'source' : ''}`}
              aria-label={side === 'auto' ? '自动连接点' : `${side === 'top' ? '上' : side === 'right' ? '右' : side === 'bottom' ? '下' : '左'}侧连接点`}
              onPointerDown={(event) => {
                event.stopPropagation();
                event.preventDefault();
                if (!connectFrom) return;
                if (connectFrom === node.id) {
                  setConnectFromAnchor(side);
                  setConnectPointer(portPoint(node, side));
                  return;
                }
                connectPlacements(connectFrom, node.id, { fromAnchor: fixedAnchor(connectFromAnchor), toAnchor: fixedAnchor(side) });
                setConnectPointer(null);
                setHoveredPort(null);
                dispatchInteraction({ type: 'finish' });
                setTool('select');
              }}
            />
          );
        })}

        {node.kind === 'card' && card && node.collapsed && (
          <div className="card-collapsed-content">
            <span className="card-collapsed-title">{card.title || '未命名卡片'}</span>
          </div>
        )}

        {node.kind === 'card' && card && !node.collapsed && (
          <div className="card-content-shell">
            <div
              className={`card-inline-editor ${cardEditing ? 'is-editing' : 'is-readonly'}`}
              data-no-drag={cardEditing ? '' : undefined}
              ref={(element) => { if (element && Math.abs(element.scrollTop - (node.scrollTop ?? 0)) > 1) element.scrollTop = node.scrollTop ?? 0; }}
              onScroll={(event) => {
                const scrollTop = Math.max(0, Math.round(event.currentTarget.scrollTop));
                if (Math.abs(scrollTop - (node.scrollTop ?? 0)) > 1) updateNode(node.id, { scrollTop });
              }}
            >
              <textarea
                className="card-inline-title"
                rows={1}
                value={card.title}
                readOnly={!cardEditing}
                tabIndex={cardEditing ? 0 : -1}
                onChange={(event) => updateCard(card.id, { title: event.target.value })}
                onKeyDown={(event) => {
                  if (isComposingKeyboardEvent(event.nativeEvent)) return;
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    (event.currentTarget.nextElementSibling as HTMLElement | null)?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus();
                  }
                }}
                placeholder="卡片标题"
                autoFocus={cardEditing && newCardId === card.id}
                onFocus={() => { setEditingCardPlacementId(node.id); setNewCardId(null); }}
              />
              <Suspense fallback={<div className="card-editor-loading" aria-hidden="true"><i /><i /><i /></div>}>
                {cardEditing
                  ? <CardBodyEditor
                    compact
                    editable
                    surface="canvas"
                    card={card}
                    getCards={readWorkspaceCards}
                    updateCard={updateCard}
                    onOpenCard={focusCard}
                    initialImageSelectionIndex={pendingImageSelection?.placementId === node.id ? pendingImageSelection.imageIndex : undefined}
                    onInitialImageSelectionApplied={() => setPendingImageSelection((current) => current?.placementId === node.id ? null : current)}
                  />
                  : <CardMarkdownPreview card={card} cards={cards} onOpenCard={focusCard} />}
              </Suspense>
            </div>
          </div>
        )}

        {node.kind === 'board' && nested && (
          <Suspense fallback={<div className="shared-board-preview board-preview-loading" aria-hidden="true" />}>
            <BoardPreview
              board={nested}
              boardMap={boardMap}
              cardMap={cardMap}
              actions={<>
                <button
                  className="desktop-board-more nested-board-more"
                  data-no-drag
                  aria-label={`${nested.title} 更多操作`}
                  aria-haspopup="menu"
                  aria-expanded={objectMenuOpen}
                  tabIndex={selected ? 0 : -1}
                  title="更多操作"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    const rect = event.currentTarget.getBoundingClientRect();
                    openPlacementContextMenuAt(node, rect.right + 5, rect.bottom + 5);
                  }}
                ><Ellipsis size={16} /></button>
                <button
                  className={`nested-board-connect ${connectFrom === node.id ? 'active' : ''}`}
                  data-no-drag
                  aria-label={connectFrom === node.id ? '取消从此白板连线' : '从此白板开始连线'}
                  aria-pressed={connectFrom === node.id}
                  tabIndex={selected ? 0 : -1}
                  title={connectFrom === node.id ? '取消连线' : '连接白板'}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleConnectionFromPlacement(node);
                  }}
                ><MoveUpRight size={15} /></button>
              </>}
              onTitleClick={selected && renamingNestedBoard?.placementId !== node.id ? () => beginNestedBoardRename(node) : undefined}
              onTitleDoubleClick={() => openBoard(nested.id, true)}
              titleSlot={renamingNestedBoard?.placementId === node.id ? <input
                ref={nestedBoardTitleInputRef}
                className="nested-board-title-editor"
                data-no-drag
                aria-label="嵌套白板名称"
                value={renamingNestedBoard.draft}
                onPointerDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onChange={(event) => setRenamingNestedBoard((current) => current ? { ...current, draft: event.target.value } : current)}
                onBlur={(event) => {
                  if (cancelNestedBoardRenameRef.current) {
                    cancelNestedBoardRenameRef.current = false;
                    return;
                  }
                  // The object menu remains mounted briefly for its exit motion
                  // and can transiently reclaim focus on slower renderers.
                  if (!nestedBoardRenameReadyRef.current) {
                    const input = event.currentTarget;
                    window.requestAnimationFrame(() => input.focus({ preventScroll: true }));
                    return;
                  }
                  finishNestedBoardRename(true);
                }}
                onKeyDown={(event) => {
                  if (isComposingKeyboardEvent(event.nativeEvent)) return;
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    cancelNestedBoardRenameRef.current = true;
                    finishNestedBoardRename(true);
                    event.currentTarget.blur();
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    cancelNestedBoardRenameRef.current = true;
                    finishNestedBoardRename(false);
                    event.currentTarget.blur();
                  }
                }}
              /> : undefined}
            />
          </Suspense>
        )}

        {node.kind === 'text' && editingTextId === node.id && node.isFrame ? (
          <div className="floating-text-preview section-title-chip section-title-chip-editing">
            <textarea
              className="section-title-editor"
              rows={1}
              value={node.text ?? ''}
              aria-label="区块名称"
              onChange={(event) => updateNode(node.id, { text: event.target.value.replace(/[\r\n]+/g, ' ') })}
              onKeyDown={(event) => {
                if (isComposingKeyboardEvent(event.nativeEvent)) return;
                if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
              }}
              onBlur={() => { setEditingTextId(null); setSelection(null); dispatchInteraction({ type: 'finish' }); }}
              autoFocus
            />
            <span className="section-title-editor-spacer" aria-hidden="true"><Ellipsis size={15} /></span>
          </div>
        ) : node.kind === 'text' && editingTextId === node.id ? (
          <textarea className="floating-text-editor" value={node.text ?? ''} onChange={(event) => updateNode(node.id, { text: event.target.value })} onBlur={() => { setEditingTextId(null); setSelection(null); dispatchInteraction({ type: 'finish' }); }} autoFocus />
        ) : node.kind === 'text' ? node.isFrame ? (
          <div className="floating-text-preview section-title-chip">
            <span>{node.text || '未命名区块'}</span>
            <button
              data-no-drag
              aria-label="打开区块菜单"
              title="区块菜单"
              onPointerDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                openPlacementContextMenuAt(node, rect.right, rect.bottom + 4);
              }}
            ><Ellipsis size={15} /></button>
          </div>
        ) : <>
          <div className="floating-text-preview">{node.text || '双击输入文字'}</div>
          {selected && editingTextId !== node.id && <div className="text-selection-toolbar" data-no-drag onPointerDown={(event) => event.stopPropagation()}>
            <button aria-label="转为新卡片" title="转为新卡片" onClick={(event) => { event.stopPropagation(); convertSelectedTextToCards(); }}><FileText size={15} /></button>
          </div>}
        </> : null}

        {RESIZE_HANDLES.filter(({ direction }) => !node.collapsed || direction === 'e' || direction === 'w').map(({ direction }) => (
          <span
            key={direction}
            className={`resize-handle resize-handle-${direction}`}
            onPointerDown={(event) => startResize(event, node, direction)}
            aria-hidden="true"
          />
        ))}
      </article>
    );
  };

  return (
    <section className="canvas-panel">
      <header className="canvas-topbar">
        <div className="board-pathbar">
          <button className="top-icon board-path-back" onClick={goBack} aria-label={history.length ? '返回上层白板' : '返回桌面'} title={history.length ? '返回上层白板' : '返回桌面'}><ArrowLeft size={16} /></button>
          <span className="board-path-kind" aria-hidden="true"><BookOpen size={15} /></span>
          <div className="board-path-trail" aria-label="白板路径">
            {history.map((id, index) => {
              const item = boardMap.get(id);
              if (!item) return null;
              return <span className="board-path-parent" key={`${id}-${index}`}>
                {index > 0 && <ChevronRight size={13} />}
                <button title={item.title} onClick={() => openBoardPath(item.id, history.slice(0, index))}>{item.title}</button>
              </span>;
            })}
            {history.length > 0 && <ChevronRight className="board-path-current-separator" size={13} />}
            <input
              ref={boardTitleInputRef}
              className={`board-path-title board-path-title-field ${editingBoardTitle ? 'is-editing' : 'is-readonly'}`}
              value={editingBoardTitle ? boardTitleDraft : board.title}
              aria-label="白板名称"
              title={editingBoardTitle ? '编辑白板名称' : '点击重命名白板'}
              readOnly={!editingBoardTitle}
              onClick={() => {
                if (!editingBoardTitle) {
                  setBoardTitleDraft(board.title);
                  setEditingBoardTitle(true);
                }
              }}
              onChange={(event) => setBoardTitleDraft(event.target.value)}
              onBlur={() => { if (editingBoardTitle) commitBoardTitle(); }}
              onKeyDown={(event) => {
                if (isComposingKeyboardEvent(event.nativeEvent)) return;
                if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
                if (event.key === 'Escape') { event.preventDefault(); setBoardTitleDraft(board.title); setEditingBoardTitle(false); event.currentTarget.blur(); }
              }}
            />
          </div>
        </div>
        <div className="top-actions" aria-label="历史操作"><button className="history-button" disabled={!canUndoCurrentBoard} onClick={undo} aria-label={canUndoCurrentBoard ? '撤销' : '撤销，暂无可撤销操作'} title={canUndoCurrentBoard ? '撤销 Ctrl+Z' : '暂无可撤销操作'}><Undo2 size={16} /></button><button className="history-button" disabled={!canRedoCurrentBoard} onClick={redo} aria-label={canRedoCurrentBoard ? '重做' : '重做，暂无可重做操作'} title={canRedoCurrentBoard ? '重做 Ctrl+Shift+Z' : '暂无可重做操作'}><Undo2 size={16} style={{ transform: 'scaleX(-1)' }} /></button></div>
      </header>

      <div className="canvas-toolbar" aria-label="白板工具">
        <button className={tool === 'select' ? 'active' : ''} aria-pressed={tool === 'select'} onClick={() => setTool('select')} aria-label="选择工具" aria-keyshortcuts="V" data-tooltip="选择 · V"><MousePointer2 size={18} /></button>
        <button className={tool === 'pan' ? 'active' : ''} aria-pressed={tool === 'pan'} onClick={() => setTool('pan')} aria-label="平移工具" aria-keyshortcuts="H" data-tooltip="平移 · H"><Hand size={18} /></button>
        <button className={tool === 'card' ? 'active' : ''} aria-pressed={tool === 'card'} onClick={() => { setSelection(null); setEditingCardPlacementId(null); setEditingTextId(null); setTool(tool === 'card' ? 'select' : 'card'); }} aria-label="卡片工具" aria-keyshortcuts="N" data-tooltip="卡片 · N"><FileText size={18} /></button>
        <button className={tool === 'connect' ? 'active' : ''} aria-pressed={tool === 'connect'} onClick={() => setTool(tool === 'connect' ? 'select' : 'connect')} aria-label="连接工具" aria-keyshortcuts="C" data-tooltip="连接 · C"><MoveUpRight size={18} /></button>
        <button className={tool === 'section' ? 'active' : ''} aria-pressed={tool === 'section'} onClick={() => { setSelection(null); setEditingCardPlacementId(null); setEditingTextId(null); setTool(tool === 'section' ? 'select' : 'section'); }} aria-label="区块工具" aria-keyshortcuts="G" data-tooltip="区块 · G"><Frame size={18} /></button>
        <button className={tool === 'text' ? 'active' : ''} aria-pressed={tool === 'text'} onClick={() => { setSelection(null); setEditingCardPlacementId(null); setEditingTextId(null); setTool(tool === 'text' ? 'select' : 'text'); }} aria-label="文字工具" aria-keyshortcuts="T" data-tooltip="文字 · T"><Type size={18} /></button>
        <button className={tool === 'board' ? 'active' : ''} aria-pressed={tool === 'board'} onClick={() => { setSelection(null); setEditingCardPlacementId(null); setEditingTextId(null); setTool(tool === 'board' ? 'select' : 'board'); }} aria-label="子白板工具" aria-keyshortcuts="W" data-tooltip="子白板 · W"><SquareDashed size={18} /></button>
      </div>

      {tool === 'connect' && <div className="connect-hint">{connectFrom ? '选择目标对象' : '选择连接起点'} · Esc 取消</div>}
      {tool === 'section' && <div className="connect-hint">拖动绘制区块 · 单击创建默认区块 · Esc 取消</div>}
      {tool === 'card' && <div className="connect-hint">拖动设置卡片尺寸 · 单击创建默认卡片 · Esc 取消</div>}
      {tool === 'text' && <div className="connect-hint">单击放置文字 · Esc 取消</div>}
      {tool === 'board' && <div className="connect-hint">拖动设置子白板尺寸 · 单击创建默认子白板 · Esc 取消</div>}

      <div
        ref={canvasRef}
        className={`infinite-canvas interaction-${interaction.mode} ${tool === 'pan' || spacePressed ? 'is-pannable' : ''} ${tool === 'connect' ? 'is-connecting' : ''} ${tool === 'card' || tool === 'text' || tool === 'board' || tool === 'section' ? 'is-drawing-section' : ''} ${wheelZooming ? 'is-wheel-zooming' : ''}`}
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={(event) => {
          if (!connectFrom) return;
          const point = worldPoint(event.clientX, event.clientY);
          const source = board.placements.find((placement) => placement.id === connectFrom);
          const port = targetPortAt(point, board.placements.filter((placement) => placement.id !== connectFrom));
          const target = port && board.placements.find((placement) => placement.id === port.placementId);
          const snappedPoint = port && target && source
            ? (port.side === 'auto' ? anchorToward(target, portPoint(source, 'auto')) : port.point)
            : point;
          setHoveredPort(port);
          setConnectPointer(snappedPoint);
        }}
        onWheel={handleWheel}
        onContextMenu={openCanvasContextMenu}
        onDoubleClick={(event) => { if (event.target === event.currentTarget && tool === 'select') createCardAt(worldPoint(event.clientX, event.clientY)); }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
      >
        {board.placements.some((placement) => placement.kind === 'card' && placement.autoHeight && !placement.collapsed) && <Suspense fallback={null}><CardAutoHeightSync boardId={board.id} /></Suspense>}
        {board.placements.length === 0 && <div className="empty-board-hint" onPointerDown={(event) => event.stopPropagation()}>
          <strong>开始构建这个白板</strong>
          <span>双击空白处创建卡片，或从左侧拖入内容</span>
          <div className="empty-board-actions">
            <button onClick={() => createCardAt()}><FileText size={15} />新建卡片</button>
            <button onClick={() => createNestedBoard()}><SquareDashed size={15} />嵌套白板</button>
          </div>
        </div>}
        <div className="canvas-scene" style={{ transform: `translate(${renderedViewport.x / viewport.zoom}px, ${renderedViewport.y / viewport.zoom}px)`, zoom: viewport.zoom, '--canvas-inverse-zoom': 1 / viewport.zoom } as React.CSSProperties}>
          {denseConnectorMode && <DenseConnectorLayer connectors={denseConnectors} placementsById={placementMap} bounds={visibleBounds} focusPlacementIds={relationshipFocusPlacementIds} focusActive={relationshipFocusActive} onPick={openConnectorContextMenu} />}
          {detailedConnectors.map((connector) => {
            const focusState = connectorFocusState(connector, relationshipFocusPlacementIds, relationshipFocusConnectorId);
            return <Edge
                key={connector.id}
                connector={connector}
                placementsById={placementMap}
                occlusionPlacements={visiblePlacements}
                automaticLabel={connector.controlPoints?.length || connectorEndpointDrag?.connectorId === connector.id
                  ? undefined
                  : connectorLabelLayout.get(connector.id)}
                selected={selection?.kind === 'connector' && selection.id === connector.id}
                related={focusState.related}
                dimmed={focusState.dimmed}
                editingLabel={editingConnectorLabelId === connector.id}
                lodExpanded={lodExpanded}
                onOpenMenu={openConnectorContextMenu}
                onEditLabel={openConnectorLabelEditor}
                onCommitLabel={commitConnectorLabel}
                onCancelLabelEdit={() => setEditingConnectorLabelId(null)}
                onHandlePointerDown={startConnectorHandleDrag}
                onRemoveKeypoint={removeConnectorKeypoint}
                endpointDrag={connectorEndpointDrag}
                zoom={viewport.zoom}
            />;
          })}
          {connectFrom && connectPointer && (() => {
            const source = board.placements.find((placement) => placement.id === connectFrom);
            return source ? <DraftEdge from={source} fromAnchor={connectFromAnchor} pointer={connectPointer} toSide={hoveredPort?.side} /> : null;
          })()}
          <ExitPresence show={snapGuides.length > 0} duration={90}>{snapGuides.length ? <div className="alignment-guides-layer" aria-hidden="true">
            {snapGuides.map((guide) => guide.axis === 'x' ? (
              <div
                key={`x-${guide.position}-${guide.targetIds.join('-')}`}
                className="alignment-guide alignment-guide-x"
                style={{ left: guide.position, top: guide.from, width: 1 / viewport.zoom, height: guide.to - guide.from }}
              />
            ) : (
              <div
                key={`y-${guide.position}-${guide.targetIds.join('-')}`}
                className="alignment-guide alignment-guide-y"
                style={{ left: guide.from, top: guide.position, width: guide.to - guide.from, height: 1 / viewport.zoom }}
              />
            ))}
          </div> : null}</ExitPresence>
          {visiblePlacements.map(renderNode)}
          {multiSelectionBounds && multiSelectionPlacements.length > 1 && (
            <div
              className="multi-selection-bounds"
              style={{ transform: `translate(${multiSelectionBounds.x}px, ${multiSelectionBounds.y}px)`, width: multiSelectionBounds.width, height: multiSelectionBounds.height }}
              aria-label="多选范围"
            >
              {RESIZE_HANDLES.map(({ direction }) => <span key={direction} className={`resize-handle resize-handle-${direction}`} onPointerDown={(event) => startGroupResize(event, direction)} aria-hidden="true" />)}
            </div>
          )}
        </div>
        {denseConnectorMode && <div className="connector-lod-indicator" role="status">已简化显示 {visibleConnectors.length} 条密集连线 · 点选后查看完整细节</div>}
        {marquee && <div className="selection-marquee" style={marquee} />}
        {creationDraft && <div
          className={`creation-preview ${creationDraft.tool === 'section' ? 'section-creation-preview' : `creation-preview-${creationDraft.tool}`}`}
          aria-label={creationDraft.tool === 'section' ? '区块创建范围' : creationDraft.tool === 'card' ? '卡片创建范围' : '子白板创建范围'}
          style={{ left: creationDraft.left, top: creationDraft.top, width: creationDraft.width, height: creationDraft.height }}
        />}
        {showMultiSelectionToolbar && multiSelectionBounds && multiSelectionPlacements.length > 1 && <Suspense fallback={null}><MultiSelectionToolbar
          count={multiSelectionPlacements.length}
          tidyOpen={tidyMenuOpen && !contextMenu}
          bounds={multiSelectionBounds}
          viewport={viewport}
          canvasSize={canvasSize}
          onCreateSection={() => { setTidyMenuOpen(false); createSectionFromSelection(); }}
          onToggleTidy={() => setTidyMenuOpen((open) => !open)}
          onCloseTidy={() => setTidyMenuOpen(false)}
          onDuplicate={() => { setTidyMenuOpen(false); duplicateSelection(); }}
          onMore={({ x, y }) => {
            const placement = multiSelectionPlacements[0];
            if (placement) openPlacementContextMenuAt(placement, x, y);
          }}
          onRemove={() => { setTidyMenuOpen(false); removeSelection(); }}
          onTidy={animateTidySelection}
        /></Suspense>}
      </div>

      <ExitPresence show={Boolean(contextMenu)} duration={110}>{contextMenu ? (
        <div
          ref={contextMenuRef}
          className={`canvas-context-menu ${contextMenu.target.kind === 'connector' ? `connector-menu ${contextMenu.y > window.innerHeight - 230 ? 'opens-up' : ''}` : ''}`}
          role="menu"
          aria-orientation={contextMenu.target.kind === 'connector' ? 'horizontal' : 'vertical'}
          aria-label={contextMenu.target.kind === 'connector' ? '连接线设置' : undefined}
          onKeyDown={handleMenuKeyDown}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {contextMenu.target.kind === 'canvas' ? (
            <>
              <div className="context-menu-heading">白板</div>
              <button role="menuitem" onClick={() => runContextAction(() => createCardAt(contextMenu.world))}><FileText size={15} /><span>新建卡片</span><kbd>双击</kbd></button>
              <button role="menuitem" onClick={() => runContextAction(() => pasteSelection(contextMenu.world))}><ClipboardPaste size={15} /><span>粘贴</span><kbd>Ctrl V</kbd></button>
              <button role="menuitem" onClick={() => runContextAction(() => addTextPlacement({ x: contextMenu.world.x - 150, y: contextMenu.world.y - 45 }))}><Type size={15} /><span>添加文字</span></button>
              <button role="menuitem" onClick={() => runContextAction(() => createNestedBoard(contextMenu.world))}><SquareDashed size={15} /><span>嵌套白板</span></button>
              <button role="menuitem" onClick={() => runContextAction(() => beginCreatedSectionRename(createSectionAt(contextMenu.world)))}><Frame size={15} /><span>新建区块</span></button>
              <div className="context-menu-separator" />
              <button role="menuitem" onClick={() => runContextAction(() => {
                const ids = board.placements.map((placement) => placement.id);
                if (ids.length) setSelection({ kind: 'placement', id: ids[0], ids });
              })}><MousePointer2 size={15} /><span>全选白板对象</span><kbd>Ctrl A</kbd></button>
              <button role="menuitem" onClick={() => runContextAction(fitObjects)}><LocateFixed size={15} /><span>适应所有对象</span></button>
              <div className="context-menu-separator" />
              <button role="menuitem" onClick={() => runContextAction(openProjectDialog)}><FolderKanban size={15} /><span>{currentProject ? '查看项目目录' : '整理为项目'}</span></button>
            </>
          ) : contextMenu.target.kind === 'connector' ? (
            contextConnector ? <>
              <div className="connector-compact-toolbar" role="group" aria-label="连接线工具栏">
                <button role="menuitem" aria-label="标签文字" title="在线上编辑标签" onClick={() => {
                  beginConnectorLabelEditingFromMenu(contextConnector.id);
                }}><Type size={16} /></button>
                <button role="menuitem" aria-haspopup="true" aria-expanded={connectorPanel === 'color'} className={connectorPanel === 'color' ? 'active' : ''} aria-label="线条颜色" title="颜色" onClick={() => setConnectorPanel(connectorPanel === 'color' ? null : 'color')}><i className="connector-current-color" style={{ background: connectorColor(contextConnector.color) }} /></button>
                <button role="menuitem" aria-haspopup="true" aria-expanded={connectorPanel === 'width'} className={connectorPanel === 'width' ? 'active' : ''} aria-label="线条粗细与虚线" title="粗细与虚线" onClick={() => setConnectorPanel(connectorPanel === 'width' ? null : 'width')}><Minus size={18} strokeWidth={Math.min(5, contextConnector.width ?? 3.5)} /></button>
                <button role="menuitem" aria-haspopup="true" aria-expanded={connectorPanel === 'arrow'} className={connectorPanel === 'arrow' ? 'active' : ''} aria-label="箭头方向" title="箭头" onClick={() => setConnectorPanel(connectorPanel === 'arrow' ? null : 'arrow')}><span className="connector-tool-symbol">{{ none: '—', end: '→', start: '←', both: '↔' }[contextConnector.arrow ?? 'end']}</span></button>
                <button role="menuitem" aria-haspopup="true" aria-expanded={connectorPanel === 'line'} className={connectorPanel === 'line' ? 'active' : ''} aria-label="线条类型" title="线型" onClick={() => setConnectorPanel(connectorPanel === 'line' ? null : 'line')}><span className="connector-tool-symbol">{{ curve: '⌒', orthogonal: '⌞', straight: '—' }[contextConnector.lineStyle ?? 'curve']}</span></button>
                <button role="menuitem" className="connector-delete-compact" aria-label="删除连接" title="删除" onClick={() => runContextAction(removeSelection)}><Trash2 size={15} /></button>
              </div>
              <ExitPresence show={Boolean(connectorPanel)} duration={100}>{connectorPanel ? <div className={`connector-compact-panel connector-panel-${connectorPanel}`} data-panel={connectorPanel} role="group" aria-label={{ color: '选择线条颜色', width: '选择线条粗细', arrow: '选择箭头方向', line: '选择线条类型' }[connectorPanel]}>
                <div key={connectorPanel} className="connector-compact-panel-content">
                {connectorPanel === 'color' && <div className="connector-color-options">
                  {CONNECTOR_COLORS.map((color) => <button role="menuitem" aria-pressed={(contextConnector.color ?? 'neutral') === color.id} key={color.id} className={(contextConnector.color ?? 'neutral') === color.id ? 'active' : ''} aria-label={`线条颜色 ${color.label}`} title={color.label} style={{ background: color.value }} onClick={() => updateConnector(contextConnector.id, { color: color.id })} />)}
                </div>}
                {connectorPanel === 'arrow' && <div className="connector-compact-options">
                  {([['none', '—', '无箭头'], ['start', '←', '反向'], ['end', '→', '正向'], ['both', '↔', '双向']] as const).map(([value, symbol, label]) => <button role="menuitem" aria-pressed={(contextConnector.arrow ?? 'end') === value} key={value} className={(contextConnector.arrow ?? 'end') === value ? 'active' : ''} aria-label={label} title={label} onClick={() => updateConnector(contextConnector.id, { arrow: value })}>{symbol}</button>)}
                </div>}
                {connectorPanel === 'line' && <div className="connector-compact-options connector-line-options">
                  {([['curve', '⌒', '曲线'], ['orthogonal', '⌞', '折线'], ['straight', '—', '直线']] as const).map(([value, symbol, label]) => <button role="menuitem" aria-pressed={(contextConnector.lineStyle ?? 'curve') === value} key={value} className={(contextConnector.lineStyle ?? 'curve') === value ? 'active' : ''} aria-label={label} title={label} onClick={() => updateConnector(contextConnector.id, { lineStyle: value, controlPoints: controlPointsForConnectorStyleChange(contextConnector) })}><b>{symbol}</b><small>{label}</small></button>)}
                </div>}
                {connectorPanel === 'width' && <div className="connector-compact-options connector-width-options">
                  {([[2, '细'], [3.5, '中'], [5, '粗']] as const).map(([value, label]) => <button role="menuitem" aria-pressed={(contextConnector.width ?? 3.5) === value} key={value} className={(contextConnector.width ?? 3.5) === value ? 'active' : ''} aria-label={`${label}线`} onClick={() => updateConnector(contextConnector.id, { width: value })}><i style={{ height: value }} /><small>{label}</small></button>)}
                  <button role="menuitemcheckbox" aria-checked={Boolean(contextConnector.dashed)} className={contextConnector.dashed ? 'active connector-dash-toggle' : 'connector-dash-toggle'} aria-label={contextConnector.dashed ? '关闭虚线' : '开启虚线'} onClick={() => updateConnector(contextConnector.id, { dashed: !contextConnector.dashed })}><i /><small>虚线</small></button>
                </div>}
                </div>
              </div> : null}</ExitPresence>
            </> : null
          ) : contextPlacement?.isFrame && contextSelectionCount === 1 ? (
            <>
              <div className="context-menu-heading">区块</div>
              <button role="menuitem" onClick={() => runContextAction(() => createCardAt(contextMenu.world, contextPlacement.id))}><FileText size={15} /><span>新建卡片</span></button>
              <button role="menuitem" onClick={() => runContextAction(() => addTextPlacement({ x: contextMenu.world.x - 150, y: contextMenu.world.y - 45, sectionId: contextPlacement.id, sectionIds: [contextPlacement.id] }))}><Type size={15} /><span>添加文字</span></button>
              <button role="menuitem" onClick={() => runContextAction(() => createNestedBoard(contextMenu.world, contextPlacement.id))}><SquareDashed size={15} /><span>嵌套白板</span></button>
              <button role="menuitem" onClick={() => runContextAction(() => beginCreatedSectionRename(createSectionAt(contextMenu.world, contextPlacement.id)))}><Frame size={15} /><span>新建区块</span></button>
              <div className="context-menu-separator" />
              <button role="menuitem" onClick={() => runContextAction(() => setEditingTextId(contextPlacement.id))}><Type size={15} /><span>重命名区块</span></button>
              <PlacementColorRow colors={SECTION_CONTEXT_COLORS} current={contextSelectionColor} onSelect={setContextColor} />
              {!contextPlacement.locked && <Suspense fallback={<div className="context-menu-item-loading" aria-hidden="true" />}><FitContentMenuItem placements={[contextPlacement]} onClose={() => runContextAction(() => {})} /></Suspense>}
              <button role="menuitem" onClick={() => runContextAction(() => setSelectionLocked(!contextSelectionLocked))}>{contextSelectionLocked ? <Unlock size={15} /> : <Lock size={15} />}<span>{contextSelectionLocked ? '解锁区块' : '锁定区块'}</span></button>
              <div className="context-menu-separator" />
              <button className="danger" role="menuitem" onClick={() => runContextAction(removeSelection)}><Trash2 size={15} /><span>移除区块</span></button>
            </>
          ) : (
            <>
              <div className="context-menu-heading">
                {contextSelectionCount > 1 ? `${contextSelectionCount} 个对象` : contextCard ? '卡片' : contextBoard ? '嵌套白板' : '文字'}
              </div>
              {contextSelectionCount === 1 && contextCard && <button role="menuitem" onClick={() => runContextAction(() => focusCard(contextCard.id))}><ExternalLink size={15} /><span>打开卡片</span></button>}
              {contextSelectionCount === 1 && contextCard && <button role="menuitem" onClick={() => runContextAction(() => openCardInSidePanel(contextCard.id))}><PanelRight size={15} /><span>在右侧栏打开</span></button>}
              {contextSelectionCount === 1 && contextCard && <button role="menuitem" onClick={() => runContextAction(() => isNativeVault ? vaultApi.revealItem?.(`notes/${contextCard.relativePath}`) : useWorkspaceStore.getState().pushNotice({ tone: 'info', title: '浏览器测试页没有本地文件位置', message: '桌面版会把卡片保存为可定位的 Markdown 文件。' }))}><FolderOpen size={15} /><span>打开本地位置</span></button>}
              {contextSelectionCount === 1 && contextBoard && <button role="menuitem" onClick={() => runContextAction(() => openBoard(contextBoard.id, true))}><ExternalLink size={15} /><span>进入白板</span></button>}
              {contextSelectionCount === 1 && contextBoard && <button role="menuitem" onClick={() => runContextAction(() => isNativeVault ? vaultApi.revealItem?.(`boards/${contextBoard.fileName}`) : useWorkspaceStore.getState().pushNotice({ tone: 'info', title: '浏览器测试页没有本地文件位置', message: '桌面版会把白板保存为可定位的 JSON 文件。' }))}><FolderOpen size={15} /><span>打开本地位置</span></button>}
              {contextSelectionCount === 1 && contextBoard && contextPlacement && <button role="menuitem" onClick={() => runContextAction(() => beginNestedBoardRename(contextPlacement))}><Pencil size={15} /><span>重命名白板</span></button>}
              {contextSelectionCount === 1 && contextPlacement?.kind === 'text' && <button role="menuitem" onClick={() => runContextAction(() => setEditingTextId(contextPlacement.id))}><Type size={15} /><span>编辑文字</span></button>}
              {contextSelectionCount === 1 && contextPlacement && !contextPlacement.isFrame && <button role="menuitem" onClick={() => runContextAction(() => toggleConnectionFromPlacement(contextPlacement))}><MoveUpRight size={15} /><span>{connectFrom === contextPlacement.id ? '取消连线' : '画连线'}</span></button>}
              {contextConvertibleTextCount > 0 && <button role="menuitem" onClick={() => runContextAction(convertSelectedTextToCards)}><FileText size={15} /><span>{contextConvertibleTextCount === 1 ? '转为新卡片' : `转为 ${contextConvertibleTextCount} 张新卡片`}</span></button>}
              {contextSelectionCount === 1 && contextPlacement?.entityId && <button role="menuitem" onClick={() => runContextAction(copyEntityLink)}><Copy size={15} /><span>复制链接</span></button>}
              <button role="menuitem" onClick={() => runContextAction(copySelection)}><Copy size={15} /><span>复制对象</span><kbd>Ctrl C</kbd></button>
              <button role="menuitem" onClick={() => runContextAction(duplicateSelection)}><ClipboardPaste size={15} /><span>创建分身</span><kbd>Ctrl D</kbd></button>
              {contextSelectionCount === 1 && contextCard && <button role="menuitem" onClick={() => runContextAction(duplicateSelectionAsIndependentCards)}><FileText size={15} /><span>复制为独立卡片</span></button>}
              <div className="context-menu-separator" />
              <PlacementColorRow colors={CONTEXT_COLORS} current={contextSelectionColor} onSelect={setContextColor} />
              {contextFittableCount > 0 && <Suspense fallback={<div className="context-menu-item-loading" aria-hidden="true" />}><FitContentMenuItem placements={contextSelectedPlacements} onClose={() => runContextAction(() => {})} /></Suspense>}
              <Suspense fallback={<div
                className="context-menu-arrange-loading"
                style={{ minHeight: 33 * (8 + Number(contextResizableToDefaultCount > 0) + Number(contextSelectionCount > 1)) }}
                aria-hidden="true"
              />}>
                <PlacementArrangeMenu
                  showDefaultSize={contextResizableToDefaultCount > 0}
                  selectionLocked={contextSelectionLocked}
                  showGroupAction={contextSelectionCount > 1}
                  selectionGrouped={contextSelectionGrouped}
                  showFrameAction={contextSelectionCount > 1}
                  placements={contextSelectedPlacements}
                  onClose={() => runContextAction(() => {})}
                  onCreateSection={createSectionFromSelection}
                />
              </Suspense>
              {contextSelectionCount > 1 && <div className="context-batch-connectors" role="group" aria-label="内部连线"><span>内部连线</span><button role="menuitem" aria-label="内部连线改为曲线" title="曲线" onClick={() => styleConnectorsForSelection({ lineStyle: 'curve' })}>⌒</button><button role="menuitem" aria-label="内部连线改为折线" title="折线" onClick={() => styleConnectorsForSelection({ lineStyle: 'orthogonal' })}>⌞</button><button role="menuitem" aria-label="内部连线改为直线" title="直线" onClick={() => styleConnectorsForSelection({ lineStyle: 'straight' })}>—</button><button role="menuitem" aria-label="内部连线改为双向箭头" title="双向箭头" onClick={() => styleConnectorsForSelection({ arrow: 'both' })}>↔</button></div>}
              {contextSelectionCount > 1 && <div
                className="context-submenu-anchor"
                onPointerEnter={openTidyMenu}
                onPointerLeave={scheduleTidyMenuClose}
              >
                <button
                  className={tidyMenuOpen ? 'is-open' : ''}
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={tidyMenuOpen}
                  onClick={openTidyMenu}
                >
                  <Grid2x2 size={15} />
                  <span>整理</span>
                  <ChevronRight size={14} />
                </button>
                <ExitPresence show={tidyMenuOpen} duration={100}>{tidyMenuOpen ? <div
                  className={`tidy-submenu ${window.innerHeight < 560 || window.innerWidth < 500 ? 'opens-inline' : contextMenu.x > window.innerWidth - 380 ? 'opens-left' : 'opens-right'}`}
                  role="menu"
                  aria-label="整理"
                  onPointerEnter={openTidyMenu}
                  onPointerMove={openTidyMenu}
                  onMouseEnter={openTidyMenu}
                  onMouseMove={openTidyMenu}
                >
                  <Suspense fallback={<div className="tidy-menu-loading" aria-label="正在载入整理工具" />}><TidyMenu onAction={animateTidySelection} /></Suspense>
                </div> : null}</ExitPresence>
              </div>}
              <div className="context-menu-separator" />
              <button className="danger" role="menuitem" onClick={() => runContextAction(removeSelection)}><Trash2 size={15} /><span>从白板移除</span><kbd>Delete</kbd></button>
            </>
          )}
        </div>
      ) : null}</ExitPresence>
      <ExitPresence show={projectDialogOpen}>{projectDialogOpen ? (
        <div className="project-dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget && !projectBusy) setProjectDialogOpen(false); }}>
          <section className="project-dialog" role="dialog" aria-modal="true" aria-label={currentProject ? '项目目录' : '整理为项目'}>
            <div className="project-dialog-icon"><FolderKanban size={20} /></div>
            <div className="project-dialog-heading">
              <h2>{currentProject ? '项目目录' : '整理为项目'}</h2>
              <p>{currentProject ? '这个白板的新卡片会默认保存在关联目录中。' : '为此白板建立真实文件目录，白板布局和引用关系保持不变。'}</p>
            </div>
            {currentProject ? (
              <div className="project-bound-summary">
                <span>Notes/</span><strong>{currentProject.relativePath}</strong>
                <small>{projectCards.length} 张引用卡片 · 新卡片默认保存到项目根目录</small>
              </div>
            ) : (
              <>
                <label className="project-name-field"><span>目录名称</span><input value={projectNameDraft} onChange={(event) => setProjectNameDraft(event.target.value)} autoFocus /></label>
                <div className="project-plan-summary">
                  <div><strong>{rootProjectCards.length}</strong><span>张根目录卡片将移入项目</span></div>
                  <div><strong>{organizedProjectCards.length}</strong><span>张已整理卡片保留原位</span></div>
                </div>
              </>
            )}
            {projectError && <p className="project-dialog-error">{projectError}</p>}
            <footer>
              <button data-modal-close onClick={() => setProjectDialogOpen(false)} disabled={projectBusy}>{currentProject ? '关闭' : '取消'}</button>
              {!currentProject && <button className="primary" onClick={() => void confirmOrganizeProject()} disabled={projectBusy || !projectNameDraft.trim()}>{projectBusy ? '正在整理…' : '建立项目目录'}</button>}
            </footer>
          </section>
        </div>
      ) : null}</ExitPresence>
      <ExitPresence show={Boolean(contextToast)} duration={140}>{contextToast ? <div className="context-toast" role="status">{contextToast}</div> : null}</ExitPresence>

      <button className={`layers-toggle ${layersOpen ? 'active' : ''}`} aria-label={layersOpen ? '关闭图层面板' : '打开图层面板'} aria-pressed={layersOpen} onClick={() => setLayersOpen((value) => !value)} title="图层"><Layers3 size={16} /></button>
      <Suspense fallback={null}><ExitPresence show={layersOpen} duration={150}>{layersOpen ? <CanvasLayersPanel
          placements={board.placements}
          cards={cardMap}
          boards={boardMap}
          selectedIds={selectedIds}
          onSelect={(placementId) => setSelection({ kind: 'placement', id: placementId, ids: [placementId] })}
          onReveal={revealPlacement}
          onUpdate={updateNode}
          onClose={() => setLayersOpen(false)}
        /> : null}</ExitPresence></Suspense>

      {board.placements.length > 0 && <div
        className={`canvas-minimap ${wheelZooming ? 'is-zooming' : ''} ${minimapDragging ? 'is-dragging' : ''}`}
        style={{ width: minimapWidth, height: minimapHeight }}
        role="application"
        aria-label="白板小地图，点击或拖动导航"
        title="点击或拖动导航 · 方向键平移 · Home 适应内容"
        tabIndex={0}
        onPointerDown={startMinimapNavigation}
        onKeyDown={handleMinimapKeyDown}
      >
        <svg className="minimap-mesh" viewBox={`0 0 ${minimapWidth} ${minimapHeight}`} aria-hidden="true">
          {['frame', 'card', 'text', 'board'].map((kind) => minimapMesh.paths.get(kind) ? <path key={kind} className={`minimap-mesh-object kind-${kind}`} d={minimapMesh.paths.get(kind)} /> : null)}
          {selectedMinimapPath && <path className="minimap-mesh-object selected" d={selectedMinimapPath} />}
        </svg>
        <i className="minimap-viewport" style={{ left: currentMinimapViewport.left, top: currentMinimapViewport.top, width: currentMinimapViewport.width, height: currentMinimapViewport.height }} />
      </div>}

      <div className={`zoom-controls ${wheelZooming ? 'is-zooming' : ''}`} aria-label="画布缩放控制"><button className="zoom-value" aria-label={`当前缩放 ${Math.round(viewport.zoom * 100)}%，点击恢复到 80%`} title="恢复到 80%" onClick={() => zoomAtCenter(0.8)}>{Math.round(viewport.zoom * 100)}%</button><button aria-label="放大画布" title="放大" onClick={() => zoomAtCenter((pendingWheelViewportRef.current ?? viewport).zoom + 0.05)}><Plus size={17} /></button><button aria-label="缩小画布" title="缩小" onClick={() => zoomAtCenter((pendingWheelViewportRef.current ?? viewport).zoom - 0.05)}><Minus size={17} /></button><button aria-label="适应所有内容" title="适应所有内容" onClick={fitObjects}><LocateFixed size={16} /></button></div>
    </section>
  );
}
