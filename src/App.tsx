import { lazy, Suspense, useEffect, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import Canvas from './components/Canvas';
import Sidebar from './components/Sidebar';
import { sealPendingSavesForShutdown, useWorkspaceStore } from './store';
import { hasVisibleModalOrMenu, isCommandSurfaceTarget, isComposingKeyboardEvent, isCreateSectionShortcut, isTextEditingTarget } from './domain/keyboard';
import { installModalFocusManager } from './domain/modalFocus';
import { requestSectionRename } from './domain/sectionEditing';
import { selectActiveBoard } from './store/selectors';
import { isNativeVault, vaultApi } from './vault';
import { LEFT_SIDEBAR_MAX, LEFT_SIDEBAR_MIN, RIGHT_SIDEBAR_MAX, RIGHT_SIDEBAR_MIN, clampPanelWidth, nextPanelWidth, resolvePanelResize } from './domain/panelSizing';

const CardSidePanel = lazy(() => import('./components/CardSidePanel'));
const Desktop = lazy(() => import('./components/Desktop'));
const NoteEditor = lazy(() => import('./components/NoteEditor'));
const QuickOpen = lazy(() => import('./components/QuickOpen'));
const AppNotifications = lazy(() => import('./components/AppNotifications'));
const WelcomeTour = lazy(() => import('./components/WelcomeTour'));

const ONBOARDING_KEY = 'opencanvas:onboarding:v1';

const readStoredWidth = (key: string, fallback: number, min: number, max: number) => {
  const stored = Number(window.localStorage.getItem(key));
  return Number.isFinite(stored) && stored > 0 ? clampPanelWidth(stored, min, max) : fallback;
};

export default function App() {
  const ready = useWorkspaceStore((state) => state.ready);
  const load = useWorkspaceStore((state) => state.load);
  const darkMode = useWorkspaceStore((state) => state.darkMode);
  const sidePanelOpen = useWorkspaceStore((state) => state.sidePanelOpen);
  const focusedCardId = useWorkspaceStore((state) => state.focusedCardId);
  const workspaceView = useWorkspaceStore((state) => state.workspaceView);
  const removeSelection = useWorkspaceStore((state) => state.removeSelection);
  const selection = useWorkspaceStore((state) => state.selection);
  const setSelection = useWorkspaceStore((state) => state.setSelection);
  const setTool = useWorkspaceStore((state) => state.setTool);
  const activeBoard = useWorkspaceStore(selectActiveBoard);
  const undo = useWorkspaceStore((state) => state.undo);
  const redo = useWorkspaceStore((state) => state.redo);
  const copySelection = useWorkspaceStore((state) => state.copySelection);
  const pasteSelection = useWorkspaceStore((state) => state.pasteSelection);
  const duplicateSelection = useWorkspaceStore((state) => state.duplicateSelection);
  const frameSelection = useWorkspaceStore((state) => state.frameSelection);
  const handleExternalVaultChange = useWorkspaceStore((state) => state.handleExternalVaultChange);
  const pushNotice = useWorkspaceStore((state) => state.pushNotice);
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(() => readStoredWidth('opencanvas:left-sidebar-width', 248, LEFT_SIDEBAR_MIN, LEFT_SIDEBAR_MAX));
  const [rightSidebarWidth, setRightSidebarWidth] = useState(() => readStoredWidth('opencanvas:right-sidebar-width', 420, RIGHT_SIDEBAR_MIN, RIGHT_SIDEBAR_MAX));
  const [resizingPanel, setResizingPanel] = useState<'left' | 'right' | null>(null);
  const [welcomeOpen, setWelcomeOpen] = useState(false);

  const startPanelResize = (side: 'left' | 'right', event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = side === 'left' ? leftSidebarWidth : rightSidebarWidth;
    setResizingPanel(side);
    let latestWidth = startWidth;
    let finished = false;
    const move = (next: PointerEvent) => {
      next.preventDefault();
      const delta = side === 'left' ? next.clientX - startX : startX - next.clientX;
      const width = nextPanelWidth(startWidth, delta, side);
      latestWidth = width;
      if (side === 'left') setLeftSidebarWidth(width); else setRightSidebarWidth(width);
    };
    const finish = (next: Event) => {
      if (finished) return;
      finished = true;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', finish);
      window.removeEventListener('keydown', cancelWithEscape);
      setResizingPanel(null);
      const cancelled = next.type === 'pointercancel' || next.type === 'blur';
      const width = resolvePanelResize(startWidth, latestWidth, cancelled);
      if (cancelled) {
        if (side === 'left') setLeftSidebarWidth(width); else setRightSidebarWidth(width);
        return;
      }
      window.localStorage.setItem(side === 'left' ? 'opencanvas:left-sidebar-width' : 'opencanvas:right-sidebar-width', String(width));
    };
    function cancelWithEscape(next: KeyboardEvent) {
      if (next.key !== 'Escape') return;
      next.preventDefault();
      finish(new Event('pointercancel'));
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', finish, { once: true });
    window.addEventListener('blur', finish, { once: true });
    window.addEventListener('keydown', cancelWithEscape);
  };

  const resizePanelWithKeyboard = (side: 'left' | 'right', event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const delta = (side === 'left' ? direction : -direction) * (event.shiftKey ? 32 : 16);
    const current = side === 'left' ? leftSidebarWidth : rightSidebarWidth;
    const width = nextPanelWidth(current, delta, side);
    if (side === 'left') setLeftSidebarWidth(width); else setRightSidebarWidth(width);
    window.localStorage.setItem(side === 'left' ? 'opencanvas:left-sidebar-width' : 'opencanvas:right-sidebar-width', String(width));
  };

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void vaultApi.getAppInfo?.().then((info) => {
      if (!cancelled && !info.automatedTest && !window.localStorage.getItem(ONBOARDING_KEY)) setWelcomeOpen(true);
    });
    const reopen = () => setWelcomeOpen(true);
    window.addEventListener('opencanvas:open-welcome', reopen);
    return () => { cancelled = true; window.removeEventListener('opencanvas:open-welcome', reopen); };
  }, [ready]);

  useEffect(() => installModalFocusManager(), []);

  useEffect(() => vaultApi.onExternalChange?.((event) => { void handleExternalVaultChange(event); }), [handleExternalVaultChange]);

  useEffect(() => {
    if (!isNativeVault) return;
    void vaultApi.setWindowTheme?.(darkMode ? 'dark' : 'light');
  }, [darkMode]);

  useEffect(() => {
    window.__openCanvasFlush = async () => {
      await sealPendingSavesForShutdown();
      await vaultApi.prepareClose?.();
    };
    return () => { delete window.__openCanvasFlush; };
  }, []);

  useEffect(() => {
    const onUnhandled = (event: PromiseRejectionEvent) => {
      event.preventDefault();
      const message = event.reason instanceof Error ? event.reason.message : String(event.reason || '未知错误');
      pushNotice({ tone: 'error', title: '操作没有完成', message });
    };
    const onError = (event: ErrorEvent) => pushNotice({ tone: 'error', title: '应用发生错误', message: event.error instanceof Error ? event.error.message : event.message });
    window.addEventListener('unhandledrejection', onUnhandled);
    window.addEventListener('error', onError);
    return () => { window.removeEventListener('unhandledrejection', onUnhandled); window.removeEventListener('error', onError); };
  }, [pushNotice]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isComposingKeyboardEvent(event)) return;
      const target = event.target;
      const isEditing = isTextEditingTarget(target);
      if (isEditing) {
        if (event.key === 'Escape') {
          (target as HTMLElement).blur();
          setSelection(null);
          setTool('select');
        }
        return;
      }
      if (hasVisibleModalOrMenu() || isCommandSurfaceTarget(target)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        void copySelection();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        void pasteSelection();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        duplicateSelection();
        return;
      }
      if (isCreateSectionShortcut(event)) {
        const ids = selection?.kind === 'placement' ? (selection.ids?.length ? selection.ids : [selection.id]) : [];
        if (workspaceView === 'board' && ids.length > 1) {
          event.preventDefault();
          const section = frameSelection();
          if (section) requestSectionRename(section.id);
        }
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        removeSelection();
      }
      if (event.key === 'Escape') {
        setSelection(null);
        setTool('select');
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        const ids = activeBoard?.placements.map((placement) => placement.id) ?? [];
        if (ids.length) {
          event.preventDefault();
          setSelection({ kind: 'placement', id: ids[0], ids });
        }
      }
      if (event.key.toLowerCase() === 'v' && !event.ctrlKey && !event.metaKey) setTool('select');
      if (event.key.toLowerCase() === 'h' && !event.ctrlKey && !event.metaKey) setTool('pan');
      if (event.key.toLowerCase() === 'c' && !event.ctrlKey && !event.metaKey) setTool('connect');
      if (event.key.toLowerCase() === 'n' && !event.ctrlKey && !event.metaKey) { setSelection(null); setTool('card'); }
      if (event.key.toLowerCase() === 't' && !event.ctrlKey && !event.metaKey) { setSelection(null); setTool('text'); }
      if (event.key.toLowerCase() === 'g' && !event.ctrlKey && !event.metaKey) {
        setSelection(null);
        setTool('section');
      }
      if (event.key.toLowerCase() === 'w' && !event.ctrlKey && !event.metaKey) { setSelection(null); setTool('board'); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeBoard, copySelection, duplicateSelection, frameSelection, pasteSelection, redo, removeSelection, selection, setSelection, setTool, undo, workspaceView]);

  if (!ready) {
    return (
      <div className={`loading-screen ${isNativeVault ? 'native-shell' : ''}`} data-theme={darkMode ? 'dark' : 'light'}>
        <div className="loading-mark">O</div>
        <p>正在打开你的知识空间…</p>
      </div>
    );
  }

  return (
    <main
      className={`app-shell ${isNativeVault ? 'native-shell' : ''} ${sidePanelOpen ? 'side-panel-open' : ''} ${resizingPanel ? `is-resizing-${resizingPanel}-panel` : ''}`}
      data-theme={darkMode ? 'dark' : 'light'}
      style={{ '--sidebar-width': `${leftSidebarWidth}px`, '--card-side-panel-width': `${rightSidebarWidth}px` } as CSSProperties}
    >
      <Sidebar />
      <div className="workspace-panel-resizer workspace-panel-resizer-left" role="separator" aria-label="调整左侧栏宽度" aria-orientation="vertical" aria-valuemin={LEFT_SIDEBAR_MIN} aria-valuemax={LEFT_SIDEBAR_MAX} aria-valuenow={leftSidebarWidth} tabIndex={0} onPointerDown={(event) => startPanelResize('left', event)} onKeyDown={(event) => resizePanelWithKeyboard('left', event)} />
      <Suspense fallback={null}>{workspaceView === 'desktop' ? <Desktop /> : <Canvas />}</Suspense>
      <Suspense fallback={null}><CardSidePanel /><NoteEditor /><QuickOpen /><AppNotifications /></Suspense>
      <Suspense fallback={null}>{welcomeOpen ? <WelcomeTour onDismiss={() => { window.localStorage.setItem(ONBOARDING_KEY, 'complete'); setWelcomeOpen(false); }} /> : null}</Suspense>
      {sidePanelOpen && !focusedCardId && <div className="workspace-panel-resizer workspace-panel-resizer-right" role="separator" aria-label="调整右侧栏宽度" aria-orientation="vertical" aria-valuemin={RIGHT_SIDEBAR_MIN} aria-valuemax={RIGHT_SIDEBAR_MAX} aria-valuenow={rightSidebarWidth} tabIndex={0} onPointerDown={(event) => startPanelResize('right', event)} onKeyDown={(event) => resizePanelWithKeyboard('right', event)} />}
    </main>
  );
}
