import { useEffect } from 'react';
import { useWorkspaceStore } from '../store';
import { measureCardContentHeight } from './cardContentMeasurement';

export default function CardAutoHeightSync({ boardId }: { boardId: string }) {
  const board = useWorkspaceStore((state) => state.boards.find((candidate) => candidate.id === boardId));
  const cards = useWorkspaceStore((state) => state.cards);
  const syncAutoHeightPlacements = useWorkspaceStore((state) => state.syncAutoHeightPlacements);

  useEffect(() => {
    const placementIds = board?.placements
      .filter((placement) => placement.kind === 'card' && placement.autoHeight && !placement.collapsed && !placement.locked)
      .map((placement) => placement.id) ?? [];
    if (!placementIds.length) return;
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const heights: Record<string, number> = {};
      for (const placementId of placementIds) {
        const editor = document.querySelector<HTMLElement>(`[data-placement-id="${CSS.escape(placementId)}"] .card-inline-editor`);
        if (editor) heights[placementId] = measureCardContentHeight(editor);
      }
      if (Object.keys(heights).length) void syncAutoHeightPlacements(heights);
    };
    const schedule = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };
    const resizeObserver = new ResizeObserver(schedule);
    const mutationObserver = new MutationObserver(schedule);
    for (const placementId of placementIds) {
      const editor = document.querySelector<HTMLElement>(`[data-placement-id="${CSS.escape(placementId)}"] .card-inline-editor`);
      if (!editor) continue;
      resizeObserver.observe(editor);
      const content = editor.querySelector<HTMLElement>('.card-markdown-preview, .structured-card-editor, .card-editor-loading');
      if (content) resizeObserver.observe(content);
      mutationObserver.observe(editor, { childList: true, subtree: true, characterData: true });
    }
    schedule();
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [board?.placements, cards, syncAutoHeightPlacements]);

  return null;
}
