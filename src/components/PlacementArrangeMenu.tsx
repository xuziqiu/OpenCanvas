import {
  ArrowDown,
  ArrowUp,
  BringToFront,
  ChevronsDown,
  ChevronsUp,
  Group,
  Lock,
  Maximize2,
  SendToBack,
  Ungroup,
  Unlock,
} from 'lucide-react';
import { useWorkspaceStore } from '../store';
import type { BoardPlacement } from '../types';
import { SectionIcon } from './icons/ProductIcons';

interface PlacementArrangeMenuProps {
  showDefaultSize: boolean;
  selectionLocked: boolean;
  showGroupAction: boolean;
  selectionGrouped: boolean;
  showFrameAction: boolean;
  placements: BoardPlacement[];
  onClose: () => void;
  onCreateSection: () => unknown;
}

export default function PlacementArrangeMenu({
  showDefaultSize,
  selectionLocked,
  showGroupAction,
  selectionGrouped,
  showFrameAction,
  placements,
  onClose,
  onCreateSection,
}: PlacementArrangeMenuProps) {
  const resetSelectionSize = useWorkspaceStore((state) => state.resetSelectionSize);
  const arrangeSelection = useWorkspaceStore((state) => state.arrangeSelection);
  const setSelectionLocked = useWorkspaceStore((state) => state.setSelectionLocked);
  const groupSelection = useWorkspaceStore((state) => state.groupSelection);
  const ungroupSelection = useWorkspaceStore((state) => state.ungroupSelection);
  const setCardPlacementsCollapsed = useWorkspaceStore((state) => state.setCardPlacementsCollapsed);
  const cards = placements.filter((placement) => placement.kind === 'card' && !placement.locked);
  const cardPlacementIds = cards.map((placement) => placement.id);
  const showFoldAction = cards.some((placement) => !placement.collapsed);
  const showExpandAction = cards.some((placement) => placement.collapsed);
  const run = (action: () => unknown) => {
    onClose();
    void action();
  };

  return <>
    {showDefaultSize && <button role="menuitem" onClick={() => run(resetSelectionSize)}><Maximize2 size={15} /><span>恢复默认尺寸</span></button>}
    {showFoldAction && <button role="menuitem" onClick={() => run(() => setCardPlacementsCollapsed(cardPlacementIds, true))}><ChevronsUp size={15} /><span>折叠卡片</span></button>}
    {showExpandAction && <button role="menuitem" onClick={() => run(() => setCardPlacementsCollapsed(cardPlacementIds, false))}><ChevronsDown size={15} /><span>展开卡片</span></button>}
    <button role="menuitem" onClick={() => run(() => arrangeSelection('front'))}><BringToFront size={15} /><span>移到最上层</span></button>
    <button role="menuitem" onClick={() => run(() => arrangeSelection('forward'))}><ArrowUp size={15} /><span>上移一层</span></button>
    <button role="menuitem" onClick={() => run(() => arrangeSelection('backward'))}><ArrowDown size={15} /><span>下移一层</span></button>
    <button role="menuitem" onClick={() => run(() => arrangeSelection('back'))}><SendToBack size={15} /><span>移到最下层</span></button>
    <button role="menuitem" onClick={() => run(() => setSelectionLocked(!selectionLocked))}>{selectionLocked ? <Unlock size={15} /> : <Lock size={15} />}<span>{selectionLocked ? '解锁对象' : '锁定对象'}</span></button>
    {showGroupAction && <button role="menuitem" onClick={() => run(selectionGrouped ? ungroupSelection : groupSelection)}>{selectionGrouped ? <Ungroup size={15} /> : <Group size={15} />}<span>{selectionGrouped ? '取消组合' : '组合对象'}</span></button>}
    {showFrameAction && <button role="menuitem" onClick={() => run(onCreateSection)}><SectionIcon size={15} /><span>为选择创建区块</span><kbd>Ctrl G</kbd></button>}
  </>;
}
