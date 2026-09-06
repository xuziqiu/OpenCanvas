import {
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  AlignHorizontalSpaceBetween,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  AlignVerticalSpaceBetween,
  Columns2,
  Grid2x2,
  Rows2,
} from 'lucide-react';
import type { TidyAction } from '../domain/tidyLayout';

const groups = [
  {
    label: '对齐',
    items: [
      ['align-left', '左对齐', AlignHorizontalJustifyStart],
      ['align-center', '水平居中', AlignHorizontalJustifyCenter],
      ['align-right', '右对齐', AlignHorizontalJustifyEnd],
      ['align-top', '顶部对齐', AlignVerticalJustifyStart],
      ['align-middle', '垂直居中', AlignVerticalJustifyCenter],
      ['align-bottom', '底部对齐', AlignVerticalJustifyEnd],
    ],
  },
  {
    label: '间距',
    items: [
      ['distribute-horizontal', '水平等距分布', AlignHorizontalSpaceBetween],
      ['distribute-vertical', '垂直等距分布', AlignVerticalSpaceBetween],
    ],
  },
  {
    label: '布局',
    items: [
      ['rack-horizontal', '横向排列', Columns2],
      ['stack-vertical', '纵向堆叠', Rows2],
      ['grid', '网格整理', Grid2x2],
    ],
  },
] satisfies Array<{ label: string; items: Array<[TidyAction, string, typeof Grid2x2]> }>;

export default function TidyMenu({ onAction }: { onAction: (action: TidyAction) => void }) {
  return groups.map((group) => <section key={group.label} className="tidy-group">
    <div>{group.label}</div>
    <div className="tidy-actions">
      {group.items.map(([action, label, Icon]) => <button
        key={action}
        type="button"
        role="menuitem"
        aria-label={label}
        title={label}
        onClick={() => onAction(action)}
      ><Icon size={18} strokeWidth={1.8} /></button>)}
    </div>
  </section>);
}
