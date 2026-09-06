import { LocateFixed } from 'lucide-react';
import type { BoardPlacement } from '../types';
import { useWorkspaceStore } from '../store';
import { measureCardContentHeight, measureFoldedCardWidth } from './cardContentMeasurement';

export default function FitContentMenuItem({ placements, onClose }: { placements: BoardPlacement[]; onClose: () => void }) {
  const fitSelectionToContent = useWorkspaceStore((state) => state.fitSelectionToContent);
  const fit = () => {
    const heights: Record<string, number> = {};
    const widths: Record<string, number> = {};
    for (const placement of placements) {
      if (placement.kind !== 'card' || placement.locked) continue;
      if (placement.collapsed) {
        const title = document.querySelector<HTMLElement>(`[data-placement-id="${CSS.escape(placement.id)}"] .card-collapsed-title`);
        if (title) widths[placement.id] = measureFoldedCardWidth(title);
        continue;
      }
      const editor = document.querySelector<HTMLElement>(`[data-placement-id="${CSS.escape(placement.id)}"] .card-inline-editor`);
      if (editor) heights[placement.id] = measureCardContentHeight(editor);
    }
    onClose();
    void fitSelectionToContent(heights, widths);
  };
  return <button role="menuitem" onClick={fit}><LocateFixed size={15} /><span>适应内容</span></button>;
}
